/**
 * QueryPilot-X — Multi-Factor Anomaly & Fraud Risk Scoring Engine
 * 
 * Evaluates database change events against heuristic rules, numerical velocity,
 * sensitive column registries, and temporal anomalies to calculate an actionable
 * risk score (0-100) and severity classification.
 */

export type RiskSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface RiskFactor {
  factor: string;
  weight: number;
  description: string;
}

export interface RiskAssessment {
  score: number; // 0 to 100
  severity: RiskSeverity;
  factors: RiskFactor[];
  recommendation: string;
}

// Highly sensitive database column patterns
const SENSITIVE_PATTERNS: Record<string, { weight: number; category: string }> = {
  // Authentication & Credentials
  password: { weight: 55, category: "Security & Authentication" },
  passwd: { weight: 55, category: "Security & Authentication" },
  hash: { weight: 45, category: "Security & Authentication" },
  token: { weight: 50, category: "Security & Authentication" },
  secret: { weight: 50, category: "Security & Authentication" },
  api_key: { weight: 50, category: "Security & Authentication" },
  private_key: { weight: 55, category: "Security & Authentication" },

  // Privilege & Access Control
  role: { weight: 45, category: "Privilege Escalation" },
  is_admin: { weight: 50, category: "Privilege Escalation" },
  permission: { weight: 45, category: "Privilege Escalation" },
  is_superuser: { weight: 50, category: "Privilege Escalation" },
  access_level: { weight: 40, category: "Privilege Escalation" },

  // Financial & Monetary
  balance: { weight: 40, category: "Financial Integrity" },
  amount: { weight: 35, category: "Financial Integrity" },
  price: { weight: 35, category: "Financial Integrity" },
  salary: { weight: 40, category: "Financial Integrity" },
  total: { weight: 30, category: "Financial Integrity" },
  cost: { weight: 30, category: "Financial Integrity" },
  discount: { weight: 35, category: "Financial Integrity" },
  refund: { weight: 45, category: "Financial Integrity" },
  fee: { weight: 30, category: "Financial Integrity" },

  // Transaction & Life-cycle State
  status: { weight: 25, category: "Workflow & State" },
  is_active: { weight: 20, category: "Workflow & State" },
  deleted_at: { weight: 30, category: "Data Lifecycle" },
  is_deleted: { weight: 30, category: "Data Lifecycle" },
};

/**
 * Assesses an individual change event and produces a comprehensive risk evaluation.
 */
export function evaluateChangeRisk(
  tableName: string,
  columnName: string,
  oldVal: unknown,
  newVal: unknown,
  changedAt?: string | Date
): RiskAssessment {
  const factors: RiskFactor[] = [];
  let rawScore = 10; // Baseline score for any mutation

  const colLower = columnName.toLowerCase();
  const tableLower = tableName.toLowerCase();

  // 1. Sensitive Column Analysis
  let matchedSensitive = false;
  for (const [key, meta] of Object.entries(SENSITIVE_PATTERNS)) {
    if (colLower === key || colLower.includes(key)) {
      factors.push({
        factor: `Sensitive Field (${meta.category})`,
        weight: meta.weight,
        description: `Modification involves high-impact column '${columnName}' categorized under ${meta.category}.`,
      });
      rawScore += meta.weight;
      matchedSensitive = true;
      break;
    }
  }

  // 2. High-Risk Table Analysis
  const sensitiveTableKeywords = ["auth", "user", "admin", "payment", "payout", "wallet", "invoice", "order", "audit", "credential"];
  for (const kw of sensitiveTableKeywords) {
    if (tableLower.includes(kw)) {
      factors.push({
        factor: "Critical Business Entity",
        weight: 15,
        description: `Table '${tableName}' holds core identity, access, or fiscal records.`,
      });
      rawScore += 15;
      break;
    }
  }

  // 3. Numeric Magnitude Jump & Anomaly Analysis
  const numOld = typeof oldVal === "number" ? oldVal : parseFloat(String(oldVal));
  const numNew = typeof newVal === "number" ? newVal : parseFloat(String(newVal));

  if (!isNaN(numOld) && !isNaN(numNew)) {
    // Negative balance / price anomaly
    if (numNew < 0 && numOld >= 0 && (colLower.includes("balance") || colLower.includes("price") || colLower.includes("amount"))) {
      factors.push({
        factor: "Negative Value Violation",
        weight: 45,
        description: `Numeric value shifted from non-negative (${numOld}) to negative (${numNew}) in monetary column '${columnName}'.`,
      });
      rawScore += 45;
    }

    // Relative percentage magnitude surge
    if (numOld !== 0) {
      const pctChange = Math.abs((numNew - numOld) / numOld) * 100;
      if (pctChange >= 500) {
        factors.push({
          factor: "Extreme Magnitude Spike (>500%)",
          weight: 40,
          description: `Value surged or dropped by ${Math.round(pctChange)}% (from ${numOld} to ${numNew}).`,
        });
        rawScore += 40;
      } else if (pctChange >= 200) {
        factors.push({
          factor: "Substantial Magnitude Jump (>200%)",
          weight: 25,
          description: `Value shifted by ${Math.round(pctChange)}% (from ${numOld} to ${numNew}).`,
        });
        rawScore += 25;
      }
    } else if (numNew > 1000) {
      // Zero to large jump
      factors.push({
        factor: "Zero-to-High Baseline Jump",
        weight: 30,
        description: `Value jumped from 0 to ${numNew}.`,
      });
      rawScore += 30;
    }
  }

  // 4. Critical State Transition
  const strOld = String(oldVal || "").toLowerCase();
  const strNew = String(newVal || "").toLowerCase();
  if (
    (strOld.includes("user") || strOld.includes("member")) &&
    (strNew.includes("admin") || strNew.includes("superuser") || strNew.includes("owner"))
  ) {
    factors.push({
      factor: "Direct Role Privilege Escalation",
      weight: 50,
      description: `Role elevated directly from '${strOld}' to '${strNew}'.`,
    });
    rawScore += 50;
  }

  // 5. Temporal / Off-hours Anomaly (11 PM - 5 AM UTC/Local)
  if (changedAt) {
    try {
      const date = new Date(changedAt);
      const hour = date.getHours();
      if (hour >= 23 || hour < 5) {
        factors.push({
          factor: "Off-Hours Activity",
          weight: 15,
          description: `Modification executed at ${hour.toString().padStart(2, "0")}:00, outside regular operational business hours.`,
        });
        rawScore += 15;
      }
    } catch {
      // Ignored
    }
  }

  // Clamp final score between 0 and 100
  const finalScore = Math.min(100, Math.max(5, rawScore));

  // Determine Severity
  let severity: RiskSeverity = "LOW";
  let recommendation = "Routine record mutation. Continue standard monitoring.";

  if (finalScore >= 75) {
    severity = "CRITICAL";
    recommendation = "Immediate investigation required. Verify actor identity, check authorization logs, and consider immediate rollback if unauthorized.";
  } else if (finalScore >= 50) {
    severity = "HIGH";
    recommendation = "High-impact modification detected. Review change context with system administrators or team lead.";
  } else if (finalScore >= 25) {
    severity = "MEDIUM";
    recommendation = "Moderate operational change. Validate against planned system updates or scheduled maintenance.";
  }

  return {
    score: finalScore,
    severity,
    factors,
    recommendation,
  };
}
