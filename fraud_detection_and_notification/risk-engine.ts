/**
 * QueryPilot-X — Multi-Factor Anomaly & Fraud Risk Scoring Engine
 * 
 * Evaluates database change events against heuristic rules, numerical velocity,
 * sensitive column registries, and temporal anomalies to calculate an actionable
 * risk score (0-100) and severity classification.
 */

import type { BusinessProfileType } from "./types";

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
  changedAt?: string | Date,
  profile: BusinessProfileType = "universal",
  sensitivity: "low" | "medium" | "high" = "medium"
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

  // 2b. Adaptive Business Profile Context Rules
  if (profile === "fintech") {
    if (colLower.includes("balance") || colLower.includes("amount") || colLower.includes("transfer") || colLower.includes("fee")) {
      factors.push({
        factor: "Fintech Strict Fiscal Rule",
        weight: 20,
        description: "Fintech profile enforces zero-tolerance on unverified ledger and balance manipulations.",
      });
      rawScore += 20;
    }
  } else if (profile === "ecommerce") {
    if (colLower.includes("discount") || colLower.includes("refund") || colLower.includes("coupon") || colLower.includes("shipping")) {
      factors.push({
        factor: "E-Commerce Discount & Refund Rule",
        weight: 20,
        description: "E-Commerce profile flags potential checkout abuse, coupon stacking, or unauthorized refund shifts.",
      });
      rawScore += 20;
    }
  } else if (profile === "saas" || profile === "social_platform") {
    if (colLower.includes("role") || colLower.includes("plan") || colLower.includes("tier") || colLower.includes("permission")) {
      factors.push({
        factor: "SaaS / Platform Role Escalation Rule",
        weight: 25,
        description: "Platform profile flags potential account takeover, privilege escalation, or plan bypass.",
      });
      rawScore += 25;
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

  // Determine Dynamic Severity Thresholds based on Sensitivity
  const criticalThreshold = sensitivity === "high" ? 60 : sensitivity === "low" ? 85 : 75;
  const highThreshold = sensitivity === "high" ? 40 : sensitivity === "low" ? 65 : 50;
  const mediumThreshold = sensitivity === "high" ? 20 : sensitivity === "low" ? 35 : 25;

  let severity: RiskSeverity = "LOW";
  let recommendation = "Routine record mutation. Continue standard monitoring.";

  if (finalScore >= criticalThreshold) {
    severity = "CRITICAL";
    recommendation = "Immediate investigation required. Verify actor identity, check authorization logs, and consider immediate rollback if unauthorized.";
  } else if (finalScore >= highThreshold) {
    severity = "HIGH";
    recommendation = "High-impact modification detected. Review change context with system administrators or team lead.";
  } else if (finalScore >= mediumThreshold) {
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

/**
 * Generates an automated, safe, deterministic SQL Rollback statement for any audited mutation.
 * Enables 1-click remediation without manual SQL drafting.
 */
export function generateSafeSqlRollback(
  tableName: string,
  recordId: string,
  columnName: string,
  oldValue: unknown,
  newValue: unknown,
  eventType = "UPDATE",
  pkColumn = "id"
): {
  sql: string;
  isDestructive: boolean;
  summary: string;
} {
  const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, "");
  const safeCol = columnName.replace(/[^a-zA-Z0-9_]/g, "");
  const safePk = pkColumn.replace(/[^a-zA-Z0-9_]/g, "");
  const safeId = String(recordId).replace(/'/g, "''");

  if (eventType === "INSERT") {
    return {
      sql: `DELETE FROM "${safeTable}" WHERE "${safePk}" = '${safeId}';`,
      isDestructive: true,
      summary: `Removes inserted record #${recordId} from table '${tableName}'.`,
    };
  }

  // UPDATE rollback: Revert current column back to oldValue
  let formattedOldVal: string;
  if (oldValue === null || oldValue === undefined || String(oldValue).toUpperCase() === "NULL") {
    formattedOldVal = "NULL";
  } else if (typeof oldValue === "number") {
    formattedOldVal = String(oldValue);
  } else if (typeof oldValue === "boolean") {
    formattedOldVal = oldValue ? "TRUE" : "FALSE";
  } else {
    formattedOldVal = `'${String(oldValue).replace(/'/g, "''")}'`;
  }

  return {
    sql: `UPDATE "${safeTable}"\nSET "${safeCol}" = ${formattedOldVal}\nWHERE "${safePk}" = '${safeId}';`,
    isDestructive: false,
    summary: `Reverts column '${columnName}' from '${String(newValue)}' back to previous value: ${formattedOldVal}.`,
  };
}

export interface BlastRadiusEstimate {
  impactScope: "SYSTEM_WIDE" | "CROSS_TABLE" | "LOCAL_RECORD";
  estimatedDownstreamCount: number;
  cascadingEntities: string[];
  isolationAdvice: string;
}

/**
 * Calculates the relational blast radius and downstream dependency impact
 * when a table record or column is altered.
 */
export function estimateBlastRadius(
  tableName: string,
  columnName: string,
  knownTables: string[] = []
): BlastRadiusEstimate {
  const tLower = tableName.toLowerCase();
  const cLower = columnName.toLowerCase();

  // 1. Identity & Auth Tables (Highest blast radius)
  if (tLower === "users" || tLower === "accounts" || tLower === "auth_users" || tLower === "profiles") {
    const dependents = knownTables.filter(t => {
      const tl = t.toLowerCase();
      return tl !== tLower && (tl.includes("order") || tl.includes("sale") || tl.includes("invoice") || tl.includes("session") || tl.includes("wallet") || tl.includes("log"));
    });
    const defaultDeps = ["orders", "user_sessions", "wallets", "invoices", "audit_trail"];
    const entities = dependents.length > 0 ? dependents : defaultDeps;

    return {
      impactScope: "SYSTEM_WIDE",
      estimatedDownstreamCount: Math.max(5, entities.length),
      cascadingEntities: entities.slice(0, 5),
      isolationAdvice: "Critical identity node altered. Recommend session token revocation and cross-checking linked transaction ledgers.",
    };
  }

  // 2. Financial / Transaction Ledgers (High cross-table cascade)
  if (tLower === "orders" || tLower === "sales" || tLower === "transactions" || tLower === "wallets" || tLower === "payments") {
    const dependents = knownTables.filter(t => {
      const tl = t.toLowerCase();
      return tl !== tLower && (tl.includes("item") || tl.includes("invoice") || tl.includes("ledger") || tl.includes("payout") || tl.includes("balance"));
    });
    const defaultDeps = ["order_items", "tax_records", "ledger_journal", "payouts"];
    const entities = dependents.length > 0 ? dependents : defaultDeps;

    return {
      impactScope: "CROSS_TABLE",
      estimatedDownstreamCount: Math.max(3, entities.length),
      cascadingEntities: entities.slice(0, 4),
      isolationAdvice: "Fiscal mutation detected. Verify double-entry ledger balance and review downstream invoice states.",
    };
  }

  // 3. Products / Pricing (Catalog cascade)
  if (tLower === "products" || tLower === "items" || tLower === "plans") {
    return {
      impactScope: "CROSS_TABLE",
      estimatedDownstreamCount: 2,
      cascadingEntities: ["order_items", "cart_sessions", "price_history"],
      isolationAdvice: "Catalog pricing modified. Validate checkout cache and actively open shopping sessions.",
    };
  }

  // 4. Default: Local Record Mutation
  return {
    impactScope: "LOCAL_RECORD",
    estimatedDownstreamCount: 1,
    cascadingEntities: ["audit_log"],
    isolationAdvice: "Localized record modification. Standard operational monitoring applies.",
  };
}
