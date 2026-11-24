export const BUSINESS_DOMAIN_IDS = [
  "sales_ecommerce",
  "inventory_supply_chain",
  "marketing_campaigns",
  "finance_expenses",
  "customers_crm",
  "operations_fulfillment",
  "product_usage_saas"
] as const;

export type BusinessDomainId = (typeof BUSINESS_DOMAIN_IDS)[number];

export type SemanticCategory =
  | "temporal"
  | "numeric"
  | "text"
  | "categorical"
  | "boolean"
  | "identifier"
  | "unsupported";

export type ConfidenceLevel = "high" | "medium" | "low";

export type DatabaseRelation = {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  constraintName?: string;
  inferred: boolean;
};

export type NumericColumnStats = {
  min: number | null;
  max: number | null;
  avg: number | null;
  negativeCount: number;
  zeroCount: number;
  isIntegerOnly: boolean | null;
};

export type TemporalColumnStats = {
  earliest: string | null;
  latest: string | null;
  spanDays: number | null;
  freshnessHours: number | null;
  invalidDateCount?: number;
  ambiguousDateCount?: number;
  inferredFromText?: boolean;
  detectedFormat?: string | null;
};

export type ColumnValueHints = {
  isBetweenZeroAndFive?: boolean;
  isBetweenZeroAndHundred?: boolean;
  booleanTrueRatio?: number | null;
  safeLowCardinalityTokens?: string[];
};

export type ColumnProfile = {
  name: string;
  rawDataType: string;
  udtName?: string;
  category: SemanticCategory;
  supported: boolean;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  references?: { table: string; column: string };
  isSensitive: boolean;
  rowCount: number;
  nonNullCount: number;
  nullCount: number;
  nullPercent: number;
  distinctCount: number | null;
  cardinalityRatio: number | null;
  numericStats: NumericColumnStats | null;
  temporalStats: TemporalColumnStats | null;
  valueHints: ColumnValueHints;
};

export type DuplicateCheckResult = {
  keyColumns: string[];
  source: "primary_key" | "detected_key" | "none";
  duplicateRowCount: number | null;
  duplicateGroupCount: number | null;
  hasDuplicates: boolean | null;
};

export type DataFreshnessStatus = "fresh" | "recent" | "stale" | "empty" | "unknown";

export type DataFreshness = {
  primaryDateColumn: string | null;
  earliestDate: string | null;
  latestDate: string | null;
  ageHours: number | null;
  status: DataFreshnessStatus;
};

export type TableProfile = {
  schema: string;
  name: string;
  tableType: "BASE TABLE" | "VIEW";
  rowCount: number;
  isEmpty: boolean;
  primaryKeys: string[];
  foreignKeys: DatabaseRelation[];
  columns: ColumnProfile[];
  dateColumns: string[];
  numericColumns: string[];
  textColumns: string[];
  categoricalColumns: string[];
  booleanColumns: string[];
  unsupportedColumns: string[];
  duplicates: DuplicateCheckResult;
  freshness: DataFreshness;
  profiledAt: string;
  warnings: string[];
};

export type SemanticRoleValueConstraints = {
  min?: number;
  max?: number;
  preferInteger?: boolean;
  preferLowCardinality?: boolean;
  preferHighCardinality?: boolean;
  expectedTokens?: string[];
};

export type SemanticRoleDefinition = {
  role: string;
  label: string;
  description: string;
  required: boolean;
  expectedCategories: SemanticCategory[];
  aliases: string[];
  genericAliases?: string[];
  tokenHints?: string[];
  negativeTokens?: string[];
  valueConstraints?: SemanticRoleValueConstraints;
};

export type DomainRelationshipHint = {
  fromRole: string;
  toDomain: BusinessDomainId;
  toRole: string;
  description: string;
};

export type DomainMetricCapability = {
  id: string;
  label: string;
  description: string;
  requiredRoles: string[];
  anyOfRoleGroups?: string[][];
};

export type BusinessDomainProfile = {
  id: BusinessDomainId;
  name: string;
  shortName: string;
  description: string;
  tableKeywords: string[];
  fields: SemanticRoleDefinition[];
  expectedRelationships: DomainRelationshipHint[];
  metrics: DomainMetricCapability[];
};

export type ColumnRoleCandidate = {
  role: string;
  score: number;
  confidence: ConfidenceLevel;
  reasons: string[];
};

export type ColumnSemanticMatch = {
  columnName: string;
  rawDataType: string;
  category: SemanticCategory;
  assignedRole: string | null;
  suggestedRole: string | null;
  confidence: ConfidenceLevel;
  score: number;
  ambiguous: boolean;
  needsConfirmation: boolean;
  candidates: ColumnRoleCandidate[];
  reasons: string[];
};

export type RoleAssignment = {
  role: string;
  columnName: string;
  rawDataType: string;
  confidence: ConfidenceLevel;
  score: number;
  needsConfirmation: boolean;
  ambiguous: boolean;
  reasons: string[];
};

export type MetricAvailability = {
  metricId: string;
  label: string;
  available: boolean;
  confidence: ConfidenceLevel | "unavailable";
  missingRoles: string[];
  requiresConfirmationRoles: string[];
};

export type DomainTableUnderstanding = {
  tableName: string;
  domainId: BusinessDomainId;
  domainName: string;
  isSelectedDomain: boolean;
  roleAssignments: Record<string, RoleAssignment>;
  columnMatches: ColumnSemanticMatch[];
  missingRequiredRoles: string[];
  ambiguousColumns: string[];
  availableMetrics: MetricAvailability[];
  domainFitScore: number;
  domainFitConfidence: ConfidenceLevel;
  readyForAnalysis: boolean;
};

export type DomainSuggestion = {
  domainId: BusinessDomainId;
  domainName: string;
  score: number;
  confidence: ConfidenceLevel;
  matchedTables: string[];
  reasons: string[];
};

export type DatabaseProfile = {
  profiledAt: string;
  selectedDomain: BusinessDomainId | null;
  suggestedDomain: DomainSuggestion | null;
  domainSuggestions: DomainSuggestion[];
  isDomainAmbiguous: boolean;
  tables: TableProfile[];
  relationships: DatabaseRelation[];
  tableUnderstandings: Record<string, DomainTableUnderstanding>;
  warnings: string[];
};

export type ReadOnlyQueryExecutor = (sql: string) => Promise<Array<Record<string, unknown>>>;
