import type { BusinessDomainId } from "../profiler/types";
import type { ComparisonPreset } from "../metrics/types";
import type { AlertRules } from "../notifications";
import type { ExpectedReportingCadence } from "../intelligence/types";

export type ReportFrequency = "daily" | "weekly" | "monthly";
export type ReportGenerationType = "automatic" | "manual";
export type ReportFrequencyOrManual = ReportFrequency | "manual";

export type ManualQuickRange =
  | "last_7_days"
  | "last_30_days"
  | "last_90_days"
  | "last_365_days"
  | "all_history"
  | "custom";

export type PersistentDailySettings = {
  organizationId: string;
  selectedDomain: BusinessDomainId;
  selectedDataset: string | null;
  autoReportEnabled: boolean;
  frequency: ReportFrequency;
  scheduledTime: string; // HH:mm
  timezone: string;
  comparisonPreset: ComparisonPreset;
  comparisonDays: number;
  expectedCadence: ExpectedReportingCadence;
  alertRules: Partial<AlertRules>;
  columnOverrides: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
};

export type PersistentReportPdfStatus = "not_generated" | "generated" | "failed";

export type PersistentReportRecord = {
  id: string;
  organizationId: string;
  ownerRef: string | null;
  domainId: BusinessDomainId;
  domainName: string;
  datasetTable: string;
  reportingDate: string;
  periodStart: string;
  periodEnd: string;
  comparisonStart: string | null;
  comparisonEnd: string | null;
  comparisonPreset: string | null;
  frequency: ReportFrequencyOrManual;
  generationType: ReportGenerationType;
  executionKey: string | null;
  status: "generated" | "failed";
  summaryText: string;
  /** Serialized structured report payload (UnifiedDailyAnalysisResult / DynamicAnalysisResult / AnalysisReport). */
  reportPayload: Record<string, unknown>;
  pdfStatus: PersistentReportPdfStatus;
  pdfStorageKey: string | null;
  pdfFilename: string | null;
  pdfGeneratedAt: string | null;
  pdfSizeBytes: number | null;
  pdfError: string | null;
  errorMessage: string | null;
  generatedAt: string;
  createdAt: string;
};

export type PersistentReportSummary = Omit<PersistentReportRecord, "reportPayload">;

export type PersistentReportListQuery = {
  organizationId: string;
  startDate?: string;
  endDate?: string;
  /** Defaults to 30 days when no explicit startDate/endDate is passed. Set 0 to disable default window. */
  defaultDays?: number;
  referenceDate?: string;
  domainId?: BusinessDomainId;
  datasetTable?: string;
  generationType?: ReportGenerationType;
  frequency?: ReportFrequencyOrManual;
  page?: number;
  pageSize?: number;
};

export type PaginatedReportList = {
  items: PersistentReportSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  appliedStartDate: string | null;
  appliedEndDate: string | null;
};

export type ScheduleExecutionStatus = "running" | "succeeded" | "failed";

export type ScheduleExecutionRecord = {
  executionKey: string;
  organizationId: string;
  scheduleId: string;
  frequency: ReportFrequency;
  periodStart: string;
  periodEnd: string;
  reportId: string | null;
  attemptCount: number;
  status: ScheduleExecutionStatus;
  startedAt: string | null;
  completedAt: string | null;
  leaseExpiresAt: string | null;
  nextRetryAt: string | null;
  errorMessage: string | null;
};

export type ClaimExecutionResult =
  | { outcome: "claimed"; record: ScheduleExecutionRecord }
  | { outcome: "in_progress"; record: ScheduleExecutionRecord }
  | { outcome: "already_succeeded"; record: ScheduleExecutionRecord };

export type PdfMetadataUpdate = {
  pdfStatus: PersistentReportPdfStatus;
  pdfStorageKey?: string | null;
  pdfFilename?: string | null;
  pdfGeneratedAt?: string | null;
  pdfSizeBytes?: number | null;
  pdfError?: string | null;
};

export interface PersistentReportRepository {
  readonly backendName: "postgres" | "sqlite";
  readonly isProductionPersistent: boolean;

  // Settings
  getSettings(organizationId: string): Promise<PersistentDailySettings | null>;
  saveSettings(settings: PersistentDailySettings): Promise<PersistentDailySettings>;
  listActiveScheduledSettings(): Promise<PersistentDailySettings[]>;

  // Reports (always tenant-isolated by organizationId)
  saveReport(record: Omit<PersistentReportRecord, "createdAt">): Promise<PersistentReportRecord>;
  getReportById(organizationId: string, reportId: string): Promise<PersistentReportRecord | null>;
  getReportByExecutionKey(organizationId: string, executionKey: string): Promise<PersistentReportRecord | null>;
  listReports(query: PersistentReportListQuery): Promise<PaginatedReportList>;
  updateReportPdfMetadata(organizationId: string, reportId: string, update: PdfMetadataUpdate): Promise<void>;

  // Schedule execution ledger & concurrency lease control
  claimExecution(input: {
    executionKey: string;
    organizationId: string;
    scheduleId: string;
    frequency: ReportFrequency;
    periodStart: string;
    periodEnd: string;
    leaseMinutes?: number;
    now?: Date;
  }): Promise<ClaimExecutionResult>;
  completeExecution(input: {
    executionKey: string;
    status: "succeeded" | "failed";
    reportId?: string | null;
    errorMessage?: string | null;
    nextRetryAt?: string | null;
    now?: Date;
  }): Promise<void>;
  getExecution(executionKey: string): Promise<ScheduleExecutionRecord | null>;

  // Schedule catch-up cursor
  getScheduleCursor(organizationId: string, frequency: ReportFrequency): Promise<string | null>;
  setScheduleCursor(organizationId: string, frequency: ReportFrequency, lastCompletedPeriodEnd: string): Promise<void>;
}

export type StoredPdfDescriptor = {
  storageKey: string;
  filename: string;
  sizeBytes: number;
  backend: "supabase_private_storage" | "local_private_fs";
};

export interface PdfStorageAdapter {
  readonly backendName: "supabase_private_storage" | "local_private_fs" | "unconfigured";
  readonly isProductionPersistent: boolean;
  savePdf(input: {
    organizationId: string;
    reportId: string;
    filename: string;
    bytes: Buffer;
  }): Promise<StoredPdfDescriptor>;
  readPdf(storageKey: string): Promise<Buffer | null>;
}

export type StorageCapabilityStatus = {
  databaseBackend: "postgres" | "sqlite";
  databaseProductionReady: boolean;
  pdfBackend: "supabase_private_storage" | "local_private_fs" | "unconfigured";
  pdfProductionReady: boolean;
  schedulerSecretConfigured: boolean;
  schedulerProductionReady: boolean;
  missingProductionConfig: string[];
};
