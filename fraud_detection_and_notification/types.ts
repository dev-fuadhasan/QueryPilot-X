export type Severity = "critical" | "high" | "medium" | "low";

export type BusinessProfileType =
  | "ecommerce"
  | "social_platform"
  | "fintech"
  | "saas"
  | "universal";

export type RuleCategory =
  | "OUTLIER_AMOUNT"
  | "VELOCITY_SPIKE"
  | "DUPLICATE_TRANSACTION"
  | "ABNORMAL_DISCOUNT"
  | "ROLE_ESCALATION"
  | "STATUS_ANOMALY"
  | "AUDIT_TAMPER"
  | "RECORD_DELETED";

export type ColumnInfo = {
  name: string;
  dataType: string;
  isNumeric: boolean;
  isIdentity: boolean;
  isTimestamp: boolean;
  isCategorical: boolean;
  isSensitive: boolean;
};

export type TableProfile = {
  name: string;
  rowCount: number;
  columns: ColumnInfo[];
  suggestedRole: "transactions" | "users" | "accounts" | "audit" | "other";
  idColumn: string | null;
  amountColumn: string | null;
  actorColumn: string | null;
  timestampColumn: string | null;
  statusColumn: string | null;
  roleColumn: string | null;
};

export type UniversalAlert = {
  id: string;
  ruleCategory: RuleCategory;
  title: string;
  severity: Severity;
  tableName: string;
  recordId: string;
  columnName?: string;
  oldValue?: unknown;
  newValue?: unknown;
  actor?: string | null;
  timestamp: string;
  reason: string;
  recommendation: string;
  metadata?: Record<string, unknown>;
  eventType?: "INSERT" | "UPDATE" | "DELETE" | "SCAN_ANOMALY" | string;
};

export type ChangeNotification = {
  id: string;
  tableName: string;
  recordId: string;
  columnName: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy?: string | null;
  timestamp: string;
  changeType: "UPDATE" | "INSERT" | "DELETE" | string;
  reason?: string;
  isRead?: boolean;
  riskScore?: number;
  riskSeverity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  riskAssessment?: {
    score: number;
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    factors: Array<{ factor: string; weight: number; description: string }>;
    recommendation: string;
  };
};

export type BusinessProfile = {
  id: BusinessProfileType;
  name: string;
  tagline: string;
  description: string;
  targetTables: string[];
  rules: RuleCategory[];
  defaultThreshold: number;
};

export type ScanOptions = {
  profile?: BusinessProfileType;
  tableNames?: string[];
  sensitivity?: "low" | "medium" | "high";
  thresholdPercent?: number;
  limitPerTable?: number;
};

export type ScanSummary = {
  totalAlerts: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  scannedTables: string[];
  totalRecordsAnalyzed: number;
  detectedAt: string;
  hasAuditTable: boolean;
  auditTableName?: string;
};
