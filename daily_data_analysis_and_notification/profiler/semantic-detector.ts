import type { DatasetMapping } from "../database/dataset-mapping";
import { BUSINESS_DOMAIN_PROFILES, listDomainProfiles } from "./domain-profiles";
import { normalizeName, tokenizeName } from "./sql-safety";
import type {
  BusinessDomainId,
  BusinessDomainProfile,
  ColumnProfile,
  ColumnRoleCandidate,
  ColumnSemanticMatch,
  ConfidenceLevel,
  DatabaseProfile,
  DatabaseRelation,
  DomainMetricCapability,
  DomainSuggestion,
  DomainTableUnderstanding,
  MetricAvailability,
  RoleAssignment,
  SemanticRoleDefinition,
  TableProfile
} from "./types";

const HIGH_CONFIDENCE_THRESHOLD = 0.75;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.48;
const AMBIGUITY_MARGIN = 0.10;

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

export function confidenceFromScore(score: number, ambiguous = false): ConfidenceLevel {
  if (!ambiguous && score >= HIGH_CONFIDENCE_THRESHOLD) return "high";
  if (score >= MEDIUM_CONFIDENCE_THRESHOLD) return "medium";
  return "low";
}

function tableMatchesDomain(tableName: string, domain: BusinessDomainProfile): boolean {
  const normTable = normalizeName(tableName);
  const tableTokens = new Set(tokenizeName(tableName));
  return domain.tableKeywords.some(keyword => {
    const normKeyword = normalizeName(keyword);
    return tableTokens.has(keyword.toLowerCase()) || normTable.includes(normKeyword);
  });
}

function isCategoryCompatible(column: ColumnProfile, role: SemanticRoleDefinition): { match: "exact" | "fallback" | "incompatible" } {
  if (!column.supported || column.category === "unsupported") {
    return { match: "incompatible" };
  }
  if (role.expectedCategories.includes(column.category)) {
    return { match: "exact" };
  }
  // Allow categorical <-> text interchangeability when text or categorical is expected
  if (
    (column.category === "categorical" && role.expectedCategories.includes("text"))
    || (column.category === "text" && role.expectedCategories.includes("categorical"))
  ) {
    return { match: "exact" };
  }
  // Allow identifier columns to satisfy text/numeric ID roles when expected
  if (column.category === "identifier" && role.expectedCategories.includes("identifier")) {
    return { match: "exact" };
  }
  // Allow numeric primary/foreign keys for identifier-only roles as fallback
  if (column.category === "numeric" && role.expectedCategories.includes("identifier") && (column.isPrimaryKey || column.isForeignKey)) {
    return { match: "fallback" };
  }
  // Allow text column with temporal stats (ISO date strings stored as text) for temporal roles
  if (column.category === "text" && role.expectedCategories.includes("temporal") && column.temporalStats?.latest) {
    return { match: "fallback" };
  }
  return { match: "incompatible" };
}

function countSupportingDomainColumns(table: TableProfile, domain: BusinessDomainProfile, excludeColumn: string): number {
  let hits = 0;
  for (const col of table.columns) {
    if (col.name === excludeColumn || !col.supported) continue;
    const normCol = normalizeName(col.name);
    const matched = domain.fields.some(field =>
      field.aliases.some(alias => normalizeName(alias) === normCol)
    );
    if (matched) hits += 1;
  }
  return hits;
}

function scoreColumnForRole(
  column: ColumnProfile,
  role: SemanticRoleDefinition,
  table: TableProfile,
  domain: BusinessDomainProfile,
  tableDomainMatch: boolean,
  siblingDomainHits: number
): ColumnRoleCandidate {
  const reasons: string[] = [];
  const compatibility = isCategoryCompatible(column, role);

  if (compatibility.match === "incompatible") {
    return {
      role: role.role,
      score: 0,
      confidence: "low",
      reasons: [`Data type "${column.rawDataType}" (${column.category}) is incompatible with ${role.label}.`]
    };
  }

  const normCol = normalizeName(column.name);
  const colTokens = tokenizeName(column.name);
  const colTokenSet = new Set(colTokens);

  let score = 0;
  let matchedName = false;
  let usedGenericAlias = false;

  // 1. Exact alias match
  const exactAlias = role.aliases.find(alias => normalizeName(alias) === normCol);
  if (exactAlias) {
    score += 0.56;
    matchedName = true;
    reasons.push(`Exact alias match "${exactAlias}".`);
  } else {
    const genericAlias = (role.genericAliases || []).find(alias => normalizeName(alias) === normCol);
    if (genericAlias) {
      score += 0.34;
      matchedName = true;
      usedGenericAlias = true;
      reasons.push(`Generic column name "${genericAlias}" requires domain or data confirmation.`);
    }
  }

  // 2. Token / partial name matching when not an exact alias
  if (!exactAlias && role.tokenHints && role.tokenHints.length > 0) {
    const matchedHints = role.tokenHints.filter(hint => {
      const normHint = normalizeName(hint);
      return colTokenSet.has(hint.toLowerCase()) || normCol.includes(normHint);
    });
    if (matchedHints.length > 0) {
      const tokenBonus = Math.min(0.42, 0.24 + (matchedHints.length - 1) * 0.12);
      if (!usedGenericAlias || tokenBonus > 0.34) {
        score = Math.max(score, tokenBonus);
        matchedName = true;
        reasons.push(`Column name contains semantic hint(s): ${matchedHints.join(", ")}.`);
      }
    }
  }

  // 3. Negative token penalties (prevents e.g. unit_cost matching revenue or updated_at beating order_date)
  if (role.negativeTokens && role.negativeTokens.length > 0) {
    const hitNegatives = role.negativeTokens.filter(neg => {
      const normNeg = normalizeName(neg);
      return colTokenSet.has(neg.toLowerCase()) || normCol.includes(normNeg);
    });
    if (hitNegatives.length > 0) {
      score -= 0.45;
      reasons.push(`Penalized due to conflicting token(s): ${hitNegatives.join(", ")}.`);
    }
  }

  // If neither name nor strong value/key signal matches, keep score low
  if (!matchedName && !column.isPrimaryKey && !(role.valueConstraints?.expectedTokens?.length)) {
    return {
      role: role.role,
      score: 0,
      confidence: "low",
      reasons: ["No semantic name or pattern match."]
    };
  }

  // 4. Data type compatibility bonus
  if (compatibility.match === "exact") {
    // Only grant full type bonus when there is a meaningful name or token match
    if (matchedName) {
      score += 0.22;
      reasons.push(`Compatible data type (${column.rawDataType}).`);
    }
  } else {
    score += 0.10;
    reasons.push(`Fallback-compatible data type (${column.rawDataType}).`);
  }

  // 5. Key & relationship signals
  if (role.expectedCategories.includes("identifier")) {
    if (column.isPrimaryKey && role.required) {
      score += matchedName ? 0.14 : 0.38;
      reasons.push("Column is a primary key.");
    } else if (column.isForeignKey) {
      const refTable = column.references?.table ? normalizeName(column.references.table) : "";
      const roleTokens = tokenizeName(role.role);
      if (refTable && roleTokens.some(token => refTable.includes(token))) {
        score += 0.18;
        reasons.push(`Foreign key references "${column.references?.table}".`);
      } else if (matchedName) {
        score += 0.06;
        reasons.push("Foreign key identifier.");
      }
    }
  }

  // 6. Data pattern & value constraints
  const constraints = role.valueConstraints;
  if (constraints) {
    if (column.numericStats && column.numericStats.min !== null && column.numericStats.max !== null) {
      if (constraints.min !== undefined && column.numericStats.min < constraints.min) {
        score -= 0.20;
        reasons.push(`Minimum value (${column.numericStats.min}) falls below expected minimum (${constraints.min}).`);
      }
      if (constraints.max !== undefined && column.numericStats.max > constraints.max) {
        score -= 0.28;
        reasons.push(`Maximum value (${column.numericStats.max}) exceeds expected maximum (${constraints.max}).`);
      } else if (constraints.min !== undefined && constraints.max !== undefined && matchedName) {
        score += 0.08;
        reasons.push(`Numeric range (${column.numericStats.min}..${column.numericStats.max}) matches expected bounds.`);
      }
      if (constraints.preferInteger && column.numericStats.isIntegerOnly === true && matchedName) {
        score += 0.06;
        reasons.push("Values are whole integers.");
      }
    }

    if (constraints.preferLowCardinality && column.cardinalityRatio !== null && column.nonNullCount >= 5) {
      if (column.cardinalityRatio <= 0.35 || (column.distinctCount !== null && column.distinctCount <= 25)) {
        score += 0.06;
        reasons.push("Low cardinality fits categorical/status role.");
      } else if (column.cardinalityRatio > 0.85) {
        score -= 0.12;
        reasons.push("High cardinality is unusual for a categorical role.");
      }
    }

    if (constraints.expectedTokens && column.valueHints.safeLowCardinalityTokens?.length) {
      const expectedSet = new Set(constraints.expectedTokens.map(t => t.toLowerCase()));
      const tokenMatches = column.valueHints.safeLowCardinalityTokens.filter(token => expectedSet.has(token));
      if (tokenMatches.length > 0) {
        score += matchedName ? 0.14 : 0.44;
        reasons.push(`Observed safe category values match domain tokens (${tokenMatches.slice(0, 3).join(", ")}).`);
      }
    }
  }

  // 7. Temporal signal boost when actual temporal data is present
  if (role.expectedCategories.includes("temporal") && column.category === "temporal" && matchedName) {
    if (column.temporalStats?.latest) {
      score += 0.05;
      reasons.push("Contains populated temporal values.");
    }
  }

  // 8. Domain context reinforcement (crucial for disambiguating generic names like `amount`, `date`, `id`, `status`)
  if (matchedName) {
    if (tableDomainMatch) {
      score += usedGenericAlias ? 0.12 : 0.06;
      reasons.push(`Table name "${table.name}" aligns with ${domain.name}.`);
    }
    if (siblingDomainHits >= 2) {
      score += usedGenericAlias ? 0.10 : 0.05;
      reasons.push(`Supported by ${siblingDomainHits} domain-specific sibling columns.`);
    } else if (usedGenericAlias && !tableDomainMatch && siblingDomainHits < 2) {
      // Keep generic aliases (like bare `amount` on a generic table) at medium confidence
      score = Math.min(score, 0.68);
      reasons.push("Insufficient surrounding domain signals for automatic high-confidence assignment.");
    }
  }

  // 9. Penalize completely null columns slightly so populated columns win ties
  if (column.rowCount > 0 && column.nonNullCount === 0 && score > 0) {
    score -= 0.10;
    reasons.push("Column is currently 100% null.");
  }

  const finalScore = roundScore(score);
  return {
    role: role.role,
    score: finalScore,
    confidence: confidenceFromScore(finalScore),
    reasons
  };
}

function evaluateMetricAvailability(
  metrics: DomainMetricCapability[],
  assignments: Record<string, RoleAssignment>
): MetricAvailability[] {
  return metrics.map(metric => {
    const missingRoles: string[] = [];
    const requiresConfirmationRoles: string[] = [];
    let minConf: ConfidenceLevel = "high";

    const trackRole = (role: string) => {
      const assigned = assignments[role];
      if (!assigned || assigned.confidence === "low") {
        missingRoles.push(role);
        return false;
      }
      if (assigned.needsConfirmation || assigned.confidence === "medium") {
        requiresConfirmationRoles.push(role);
        minConf = "medium";
      }
      return true;
    };

    let allRequiredMet = true;
    for (const reqRole of metric.requiredRoles) {
      if (!trackRole(reqRole)) allRequiredMet = false;
    }

    let anyGroupMet = true;
    if (metric.anyOfRoleGroups && metric.anyOfRoleGroups.length > 0) {
      anyGroupMet = false;
      let bestGroupMissing: string[] = metric.anyOfRoleGroups[0];
      let bestGroupConfirm: string[] = [];

      for (const group of metric.anyOfRoleGroups) {
        const groupMissing = group.filter(role => !assignments[role] || assignments[role].confidence === "low");
        if (groupMissing.length === 0) {
          anyGroupMet = true;
          const groupConfirm = group.filter(role => assignments[role]?.needsConfirmation || assignments[role]?.confidence === "medium");
          if (groupConfirm.length === 0) {
            bestGroupConfirm = [];
            break;
          }
          bestGroupConfirm = groupConfirm;
        } else if (groupMissing.length < bestGroupMissing.length) {
          bestGroupMissing = groupMissing;
        }
      }

      if (anyGroupMet) {
        if (bestGroupConfirm.length > 0) {
          requiresConfirmationRoles.push(...bestGroupConfirm);
          minConf = "medium";
        }
      } else {
        missingRoles.push(...bestGroupMissing);
      }
    }

    const available = allRequiredMet && anyGroupMet;
    return {
      metricId: metric.id,
      label: metric.label,
      available,
      confidence: available ? minConf : "unavailable",
      missingRoles: [...new Set(missingRoles)],
      requiresConfirmationRoles: [...new Set(requiresConfirmationRoles)]
    };
  });
}

export function understandTableForDomain(
  table: TableProfile,
  domainId: BusinessDomainId,
  options: { isSelectedDomain?: boolean; overrides?: Record<string, string> } = {}
): DomainTableUnderstanding {
  const domain = BUSINESS_DOMAIN_PROFILES[domainId];
  const tableDomainMatch = tableMatchesDomain(table.name, domain);
  const overrides = options.overrides || {};
  const overrideRoleByColumn = new Map<string, string>();
  const validColumnNames = new Set(table.columns.map(col => col.name));

  for (const [role, columnName] of Object.entries(overrides)) {
    if (columnName && validColumnNames.has(columnName) && domain.fields.some(f => f.role === role)) {
      overrideRoleByColumn.set(columnName, role);
    }
  }

  // Step 1: Score every column against every role in the selected domain
  const rawMatches: ColumnSemanticMatch[] = table.columns.map(column => {
    const manualRole = overrideRoleByColumn.get(column.name);
    if (manualRole) {
      return {
        columnName: column.name,
        rawDataType: column.rawDataType,
        category: column.category,
        assignedRole: manualRole,
        suggestedRole: manualRole,
        confidence: "high",
        score: 1,
        ambiguous: false,
        needsConfirmation: false,
        candidates: [{ role: manualRole, score: 1, confidence: "high", reasons: ["Explicit user/organisation override."] }],
        reasons: ["Explicit user/organisation override."]
      };
    }

    if (!column.supported || column.category === "unsupported") {
      return {
        columnName: column.name,
        rawDataType: column.rawDataType,
        category: column.category,
        assignedRole: null,
        suggestedRole: null,
        confidence: "low",
        score: 0,
        ambiguous: false,
        needsConfirmation: false,
        candidates: [],
        reasons: [`Unsupported database type "${column.rawDataType}" skipped safely.`]
      };
    }

    const siblingHits = countSupportingDomainColumns(table, domain, column.name);
    const candidates = domain.fields
      .map(role => scoreColumnForRole(column, role, table, domain, tableDomainMatch, siblingHits))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));

    const top = candidates[0];
    const second = candidates[1];

    if (!top || top.score < MEDIUM_CONFIDENCE_THRESHOLD) {
      return {
        columnName: column.name,
        rawDataType: column.rawDataType,
        category: column.category,
        assignedRole: null,
        suggestedRole: null,
        confidence: "low",
        score: top?.score || 0,
        ambiguous: false,
        needsConfirmation: false,
        candidates: candidates.slice(0, 3),
        reasons: top ? top.reasons : ["No matching semantic role in this domain."]
      };
    }

    const ambiguous = Boolean(second && second.score >= MEDIUM_CONFIDENCE_THRESHOLD && (top.score - second.score) < AMBIGUITY_MARGIN);
    const confidence = confidenceFromScore(top.score, ambiguous);
    const needsConfirmation = confidence === "medium" || ambiguous;
    const assignedRole = confidence === "high" && !ambiguous ? top.role : null;

    return {
      columnName: column.name,
      rawDataType: column.rawDataType,
      category: column.category,
      assignedRole,
      suggestedRole: top.role,
      confidence,
      score: top.score,
      ambiguous,
      needsConfirmation,
      candidates: candidates.slice(0, 3),
      reasons: ambiguous
        ? [...top.reasons, `Ambiguous between "${top.role}" (${top.score}) and "${second.role}" (${second.score}).`]
        : top.reasons
    };
  });

  // Step 2: Resolve role assignments cleanly (avoid assigning two columns to the exact same role)
  const roleAssignments: Record<string, RoleAssignment> = {};
  const candidatesByRole = new Map<string, Array<{ match: ColumnSemanticMatch; candidate: ColumnRoleCandidate }>>();

  for (const match of rawMatches) {
    const chosenRole = match.assignedRole || match.suggestedRole;
    if (!chosenRole) continue;
    const candidate = match.candidates.find(c => c.role === chosenRole) || {
      role: chosenRole,
      score: match.score,
      confidence: match.confidence,
      reasons: match.reasons
    };
    const list = candidatesByRole.get(chosenRole) || [];
    list.push({ match, candidate });
    candidatesByRole.set(chosenRole, list);
  }

  for (const [role, entries] of candidatesByRole.entries()) {
    entries.sort((a, b) => b.candidate.score - a.candidate.score || a.match.columnName.localeCompare(b.match.columnName));
    const winner = entries[0];
    const runnerUp = entries[1];
    const closeCompetition = Boolean(
      runnerUp
      && runnerUp.candidate.score >= MEDIUM_CONFIDENCE_THRESHOLD
      && (winner.candidate.score - runnerUp.candidate.score) < 0.08
    );

    const ambiguous = winner.match.ambiguous || closeCompetition;
    const confidence = ambiguous && winner.candidate.score < 0.99 ? "medium" : winner.match.confidence;
    const needsConfirmation = winner.match.needsConfirmation || closeCompetition;

    roleAssignments[role] = {
      role,
      columnName: winner.match.columnName,
      rawDataType: winner.match.rawDataType,
      confidence,
      score: winner.candidate.score,
      needsConfirmation,
      ambiguous,
      reasons: closeCompetition
        ? [...winner.match.reasons, `Competes closely with column "${runnerUp.match.columnName}" (${runnerUp.candidate.score}).`]
        : winner.match.reasons
    };

    // Update the match list for losing duplicate candidates so they aren't double-assigned
    for (const loser of entries.slice(1)) {
      if (loser.match.assignedRole === role) {
        loser.match.assignedRole = null;
        loser.match.needsConfirmation = true;
        loser.match.reasons = [
          ...loser.match.reasons,
          `Role "${role}" was assigned to higher-scoring column "${winner.match.columnName}".`
        ];
      }
    }
  }

  const requiredRoles = domain.fields.filter(f => f.required).map(f => f.role);
  const missingRequiredRoles = requiredRoles.filter(role => !roleAssignments[role]);
  const ambiguousColumns = rawMatches.filter(m => m.ambiguous).map(m => m.columnName);
  const availableMetrics = evaluateMetricAvailability(domain.metrics, roleAssignments);

  // Domain fit score for this table
  const requiredCovered = requiredRoles.length > 0
    ? (requiredRoles.length - missingRequiredRoles.length) / requiredRoles.length
    : 1;
  const assignedCount = Object.keys(roleAssignments).length;
  const highConfCount = Object.values(roleAssignments).filter(a => a.confidence === "high").length;
  const optionalCoverage = Math.min(1, assignedCount / Math.max(3, Math.min(6, domain.fields.length)));
  const highConfRatio = assignedCount > 0 ? highConfCount / assignedCount : 0;

  let fitScore = requiredCovered * 0.48 + optionalCoverage * 0.28 + highConfRatio * 0.14 + (tableDomainMatch ? 0.14 : 0);
  if (missingRequiredRoles.length > 0) {
    fitScore = Math.min(fitScore, 0.52);
  }
  const domainFitScore = roundScore(fitScore);
  const domainFitConfidence = confidenceFromScore(domainFitScore);
  const readyForAnalysis = missingRequiredRoles.length === 0 && !table.isEmpty;

  return {
    tableName: table.name,
    domainId,
    domainName: domain.name,
    isSelectedDomain: Boolean(options.isSelectedDomain),
    roleAssignments,
    columnMatches: rawMatches,
    missingRequiredRoles,
    ambiguousColumns,
    availableMetrics,
    domainFitScore,
    domainFitConfidence,
    readyForAnalysis
  };
}

export function suggestBusinessDomains(tables: TableProfile[]): {
  suggestions: DomainSuggestion[];
  suggestedDomain: DomainSuggestion | null;
  isDomainAmbiguous: boolean;
} {
  if (!tables.length) {
    return { suggestions: [], suggestedDomain: null, isDomainAmbiguous: true };
  }

  const suggestions: DomainSuggestion[] = listDomainProfiles().map(domain => {
    const evaluations = tables.map(table => understandTableForDomain(table, domain.id));
    evaluations.sort((a, b) => b.domainFitScore - a.domainFitScore);

    const bestTable = evaluations[0];
    const matchedTables = evaluations.filter(ev => ev.domainFitScore >= 0.55).map(ev => ev.tableName);
    const score = roundScore(
      (bestTable?.domainFitScore || 0) * 0.85
      + Math.min(0.15, Math.max(0, matchedTables.length - 1) * 0.05)
    );

    const reasons: string[] = [];
    if (bestTable && bestTable.domainFitScore > 0) {
      reasons.push(`Strongest table match: "${bestTable.tableName}" (fit ${(bestTable.domainFitScore * 100).toFixed(0)}%).`);
      const highRoles = Object.values(bestTable.roleAssignments).filter(r => r.confidence === "high").map(r => r.role);
      if (highRoles.length) {
        reasons.push(`High-confidence fields detected: ${highRoles.slice(0, 5).join(", ")}.`);
      }
      if (bestTable.missingRequiredRoles.length) {
        reasons.push(`Missing required field(s): ${bestTable.missingRequiredRoles.join(", ")}.`);
      }
    } else {
      reasons.push("No matching tables detected for this domain.");
    }

    return {
      domainId: domain.id,
      domainName: domain.name,
      score,
      confidence: confidenceFromScore(score),
      matchedTables,
      reasons
    };
  }).sort((a, b) => b.score - a.score || a.domainId.localeCompare(b.domainId));

  const top = suggestions[0];
  const second = suggestions[1];
  const isDomainAmbiguous = !top
    || top.score < 0.55
    || Boolean(second && second.score >= 0.45 && (top.score - second.score) < 0.12);

  return {
    suggestions,
    suggestedDomain: top && !isDomainAmbiguous ? top : null,
    isDomainAmbiguous
  };
}

export function analyzeDatabaseSemantics(
  tables: TableProfile[],
  relationships: DatabaseRelation[],
  options: {
    selectedDomain?: BusinessDomainId | null;
    tableOverrides?: Record<string, Record<string, string>>;
    warnings?: string[];
  } = {}
): DatabaseProfile {
  const { suggestions, suggestedDomain, isDomainAmbiguous } = suggestBusinessDomains(tables);
  const selectedDomain = options.selectedDomain || null;
  const tableUnderstandings: Record<string, DomainTableUnderstanding> = {};

  for (const table of tables) {
    let targetDomain: BusinessDomainId;
    let isSelected = false;

    if (selectedDomain) {
      targetDomain = selectedDomain;
      isSelected = true;
    } else {
      // Multi-domain database support: pick the best-fitting domain per table when no global override is selected
      const perTableRanked = listDomainProfiles()
        .map(profile => understandTableForDomain(table, profile.id, { overrides: options.tableOverrides?.[table.name] }))
        .sort((a, b) => b.domainFitScore - a.domainFitScore);
      targetDomain = perTableRanked[0]?.domainId || suggestedDomain?.domainId || "sales_ecommerce";
    }

    tableUnderstandings[table.name] = understandTableForDomain(table, targetDomain, {
      isSelectedDomain: isSelected,
      overrides: options.tableOverrides?.[table.name]
    });
  }

  return {
    profiledAt: new Date().toISOString(),
    selectedDomain,
    suggestedDomain,
    domainSuggestions: suggestions,
    isDomainAmbiguous,
    tables,
    relationships,
    tableUnderstandings,
    warnings: options.warnings || []
  };
}

/**
 * Compatibility bridge: converts a `sales_ecommerce` DomainTableUnderstanding
 * into the existing legacy `DatasetMapping` structure used by Sales reports & PDFs.
 */
export function toLegacySalesMapping(
  understanding: DomainTableUnderstanding,
  options: { includeMediumConfidence?: boolean } = {}
): Partial<DatasetMapping> {
  const allowMedium = options.includeMediumConfidence ?? true;
  const pick = (role: string): string | undefined => {
    const assignment = understanding.roleAssignments[role];
    if (!assignment) return undefined;
    if (assignment.confidence === "high") return assignment.columnName;
    if (allowMedium && assignment.confidence === "medium" && !assignment.ambiguous) return assignment.columnName;
    return undefined;
  };

  const result: Partial<DatasetMapping> = {
    orderId: pick("orderId"),
    orderDate: pick("transactionDate"),
    product: pick("product"),
    category: pick("category"),
    quantity: pick("quantity"),
    revenue: pick("revenue"),
    cost: pick("cost"),
    profit: pick("profit"),
    discount: pick("discount"),
    status: pick("status"),
    gender: pick("gender"),
    region: pick("region"),
    rating: pick("rating")
  };

  return Object.fromEntries(Object.entries(result).filter(([, value]) => Boolean(value))) as Partial<DatasetMapping>;
}
