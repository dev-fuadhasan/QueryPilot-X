import type { BusinessDomainId, ColumnSemanticMatch, DomainTableUnderstanding } from "../profiler/types";
import type { ComparisonPreset, DynamicAnalysisResult, MetricResult } from "../metrics/types";
import type { DailyReportAlert } from "../notifications";
import type {
  ManualQuickRange,
  PersistentReportPdfStatus,
  PersistentReportStatusFilter,
  PersistentReportSummary,
  ReportFrequency,
  ReportFrequencyOrManual,
  StorageCapabilityStatus
} from "../storage/types";
import type { ScheduleRuntimeSummary } from "../storage/schedule-provider";

export type DashboardSectionTab = "daily_report" | "manual_report" | "tools" | "historical" | "history";

export type ToolPanelId =
  | "brief"
  | "comparison"
  | "alerts"
  | "root_cause"
  | "recommendations"
  | "data_health"
  | "archive";

export type AlertFilterMode = "all" | "unread" | "critical" | "warning" | "positive" | "info";

export type DomainUiMeta = {
  id: BusinessDomainId;
  name: string;
  shortName: string;
  focusSummary: string;
  exampleSignals: string[];
};

export const DOMAIN_UI_CATALOG: readonly DomainUiMeta[] = [
  {
    id: "sales_ecommerce",
    name: "Sales & E-commerce",
    shortName: "Sales",
    focusSummary: "Revenue changes, product & category contributors, cancellation alerts, and margin health.",
    exampleSignals: ["Revenue shifts", "Category & product drivers", "Cancellation spikes"]
  },
  {
    id: "inventory_supply_chain",
    name: "Inventory & Supply Chain",
    shortName: "Inventory",
    focusSummary: "Stockout risk, low inventory alerts, warehouse contributors, and reorder priorities.",
    exampleSignals: ["Low stock alerts", "Warehouse & supplier drivers", "Reorder recommendations"]
  },
  {
    id: "marketing_campaigns",
    name: "Marketing & Campaigns",
    shortName: "Marketing",
    focusSummary: "Ad spend efficiency, CTR, conversion shifts, ROAS, and campaign contributors.",
    exampleSignals: ["Campaign spend shifts", "CTR & conversion changes", "Channel optimization"]
  },
  {
    id: "finance_expenses",
    name: "Finance & Expenses",
    shortName: "Finance",
    focusSummary: "Expense spikes, budget variance, cash flow, overdue payables/receivables, and department drivers.",
    exampleSignals: ["Expense spikes", "Budget threshold risks", "Department contributors"]
  },
  {
    id: "customers_crm",
    name: "Customers & CRM",
    shortName: "Customers & CRM",
    focusSummary: "Customer inactivity, retention changes, segment contributors, RFM groups, and engagement actions.",
    exampleSignals: ["Retention & churn signals", "Segment contributors", "Engagement actions"]
  },
  {
    id: "operations_fulfillment",
    name: "Operations & Fulfillment",
    shortName: "Operations",
    focusSummary: "Delivery delays, SLA compliance, processing times, backlog, and carrier or region contributors.",
    exampleSignals: ["Delivery delays", "SLA & processing time", "Carrier/region drivers"]
  },
  {
    id: "product_usage_saas",
    name: "Product Usage & SaaS Analytics",
    shortName: "Product & SaaS",
    focusSummary: "DAU/WAU/MAU changes, feature adoption, activation findings, and subscription MRR/ARR shifts.",
    exampleSignals: ["DAU/WAU/MAU trends", "Feature adoption", "Subscription changes"]
  }
];

export function getDomainUiMeta(domainId: BusinessDomainId): DomainUiMeta {
  return DOMAIN_UI_CATALOG.find(item => item.id === domainId) || DOMAIN_UI_CATALOG[0];
}

export const DAILY_FREQUENCY_OPTIONS: ReadonlyArray<{
  value: ReportFrequency;
  label: string;
  explanation: string;
  incompleteNote: string;
}> = [
  {
    value: "daily",
    label: "Daily",
    explanation: "The report will contain the previous completed day's data.",
    incompleteNote: "The current incomplete day is excluded so figures remain final."
  },
  {
    value: "weekly",
    label: "Weekly",
    explanation: "The report will contain the previous completed Monday–Sunday week.",
    incompleteNote: "The current in-progress week is excluded."
  },
  {
    value: "monthly",
    label: "Monthly",
    explanation: "The report will contain the previous completed calendar month.",
    incompleteNote: "The current incomplete month is excluded."
  }
];

export function getFrequencyOption(frequency: ReportFrequency) {
  return DAILY_FREQUENCY_OPTIONS.find(item => item.value === frequency) || DAILY_FREQUENCY_OPTIONS[0];
}

export const COMMON_TIMEZONES: readonly string[] = [
  "Asia/Dhaka",
  "UTC",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Australia/Sydney"
];

export const MANUAL_QUICK_RANGE_OPTIONS: ReadonlyArray<{
  value: ManualQuickRange;
  label: string;
  hint: string;
}> = [
  { value: "last_7_days", label: "Last 7 Days", hint: "7-day rolling window" },
  { value: "last_30_days", label: "Last 30 Days", hint: "30-day rolling window" },
  { value: "last_90_days", label: "Last 90 Days", hint: "Quarter-scale history" },
  { value: "last_365_days", label: "Last 365 Days", hint: "Full trailing year" },
  { value: "all_history", label: "All Available History", hint: "Earliest to latest dataset date" },
  { value: "custom", label: "Custom Date Range", hint: "Choose start and end dates" }
];

export const COMPARISON_PRESET_OPTIONS: ReadonlyArray<{
  value: ComparisonPreset;
  label: string;
}> = [
  { value: "previous_day", label: "Previous Day" },
  { value: "same_weekday_previous_weeks", label: "Same Weekday (4-Week Avg)" },
  { value: "previous_week", label: "Previous Week" },
  { value: "previous_month", label: "Previous Month" },
  { value: "previous_7_days", label: "Previous 7 Days" },
  { value: "previous_30_days", label: "Previous 30 Days" },
  { value: "previous_90_days", label: "Previous 3 Months" },
  { value: "previous_180_days", label: "Previous 6 Months" },
  { value: "previous_365_days", label: "Previous 1 Year" },
  { value: "none", label: "All Data (Full Dataset)" }
];

export function isValidIsoDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function todayIsoInTimezone(timeZone = "Asia/Dhaka", now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(now).reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function validateScheduleFormInput(input: {
  frequency: string;
  scheduledTime: string;
  timezone: string;
  selectedDataset: string | null;
  autoReportEnabled: boolean;
}): { valid: boolean; error: string | null } {
  if (!["daily", "weekly", "monthly"].includes(input.frequency)) {
    return { valid: false, error: "Select Daily, Weekly, or Monthly frequency." };
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test((input.scheduledTime || "").trim())) {
    return { valid: false, error: "Select a valid generation time in HH:mm (24-hour) format." };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(new Date());
  } catch {
    return { valid: false, error: `Unsupported timezone "${input.timezone}".` };
  }
  if (input.autoReportEnabled && !input.selectedDataset) {
    return { valid: false, error: "Select a connected dataset before enabling automatic scheduled reports." };
  }
  return { valid: true, error: null };
}

export function validateManualRangeSelection(input: {
  quickRange: ManualQuickRange;
  startDate: string;
  endDate: string;
  timezone?: string;
  earliestAvailableDate?: string | null;
  latestAvailableDate?: string | null;
  now?: Date;
}): { valid: boolean; error: string | null; warning: string | null } {
  const tz = input.timezone || "Asia/Dhaka";
  const today = todayIsoInTimezone(tz, input.now);

  if (input.quickRange !== "custom") {
    if (input.quickRange === "all_history" && !input.earliestAvailableDate && !input.latestAvailableDate) {
      return {
        valid: true,
        error: null,
        warning: "Dataset date boundaries will be resolved automatically from the connected database."
      };
    }
    return { valid: true, error: null, warning: null };
  }

  const start = (input.startDate || "").trim();
  const end = (input.endDate || "").trim();
  if (!start || !end) {
    return { valid: false, error: "Select both a Start Date and an End Date.", warning: null };
  }
  if (!isValidIsoDateString(start) || !isValidIsoDateString(end)) {
    return { valid: false, error: "Enter valid calendar dates in YYYY-MM-DD format.", warning: null };
  }
  if (start > end) {
    return { valid: false, error: "Start Date cannot be after End Date.", warning: null };
  }
  if (end > today) {
    return { valid: false, error: `End Date (${end}) cannot be in the future beyond ${today} (${tz}).`, warning: null };
  }

  const earliest = input.earliestAvailableDate?.slice(0, 10) || null;
  const latest = input.latestAvailableDate?.slice(0, 10) || null;
  if (earliest && latest && (end < earliest || start > latest)) {
    return {
      valid: false,
      error: `Selected range (${start} to ${end}) falls outside the connected dataset's available history (${earliest} to ${latest}).`,
      warning: null
    };
  }

  let warning: string | null = null;
  if (earliest && start < earliest) {
    warning = `Dataset history begins on ${earliest}. Dates before ${earliest} contain no source records.`;
  } else if (latest && end > latest) {
    warning = `Latest source record is dated ${latest}. Dates after ${latest} contain no source records yet.`;
  }

  return { valid: true, error: null, warning };
}

export type AutoReportUiStatus = {
  code:
    | "scheduled"
    | "running"
    | "generated"
    | "failed"
    | "pdf_unavailable"
    | "storage_not_configured"
    | "paused";
  label: string;
  tone: "positive" | "info" | "warning" | "critical" | "neutral";
  detail: string;
};

export function resolveAutoReportDisplayState(input: {
  autoReportEnabled: boolean;
  saving: boolean;
  storageStatus: StorageCapabilityStatus | null;
  scheduleSummary: ScheduleRuntimeSummary | null;
  latestReport: PersistentReportSummary | null;
}): AutoReportUiStatus {
  if (input.saving) {
    return {
      code: "running",
      label: "Running",
      tone: "info",
      detail: "Updating schedule configuration with the backend..."
    };
  }

  if (input.storageStatus && !input.storageStatus.databaseProductionReady && input.storageStatus.pdfBackend === "unconfigured") {
    return {
      code: "storage_not_configured",
      label: "Storage not configured",
      tone: "warning",
      detail: `Missing production configuration: ${input.storageStatus.missingProductionConfig.join(", ")}.`
    };
  }

  if (input.latestReport) {
    if (input.latestReport.status === "failed") {
      return {
        code: "failed",
        label: "Failed",
        tone: "critical",
        detail: input.latestReport.errorMessage || "Most recent automatic report failed."
      };
    }
    if (input.latestReport.pdfStatus === "failed") {
      return {
        code: "pdf_unavailable",
        label: "PDF unavailable",
        tone: "warning",
        detail: input.latestReport.pdfError || "Report metadata saved, but PDF generation or storage failed."
      };
    }
    if (input.latestReport.pdfStatus === "generated") {
      return {
        code: "generated",
        label: "Generated",
        tone: "positive",
        detail: `Latest ${input.latestReport.frequency} report (${input.latestReport.periodStart} to ${input.latestReport.periodEnd}) is ready for download.`
      };
    }
    if (input.latestReport.pdfStatus === "not_generated") {
      return {
        code: "pdf_unavailable",
        label: "PDF unavailable",
        tone: "warning",
        detail: "Report data is saved, but no PDF artifact has been stored yet."
      };
    }
  }

  if (!input.autoReportEnabled) {
    return {
      code: "paused",
      label: "Paused",
      tone: "neutral",
      detail: "Automatic report generation is turned off for this organisation."
    };
  }

  if (input.storageStatus && !input.storageStatus.schedulerProductionReady && input.storageStatus.pdfBackend === "unconfigured") {
    return {
      code: "storage_not_configured",
      label: "Storage not configured",
      tone: "warning",
      detail: `Schedule saved locally. Configure ${input.storageStatus.missingProductionConfig.join(", ")} for unattended production execution.`
    };
  }

  return {
    code: "scheduled",
    label: input.storageStatus && !input.storageStatus.pdfProductionReady ? "Scheduled (Local)" : "Scheduled",
    tone: "info",
    detail: input.scheduleSummary?.nextExecution
      ? `Next scheduled target period: ${input.scheduleSummary.nextExecution.targetPeriod.periodStart} to ${input.scheduleSummary.nextExecution.targetPeriod.periodEnd}.`
      : "Automatic schedule is active and waiting for the next completed period."
  };
}

export function mergeToolAlertsWithReadState(
  backendAlerts: DailyReportAlert[],
  readIds: ReadonlySet<string>
): DailyReportAlert[] {
  return backendAlerts.map(alert => ({
    ...alert,
    isRead: readIds.has(alert.id) || Boolean(alert.isRead)
  }));
}

export function filterDomainAlerts(alerts: DailyReportAlert[], filter: AlertFilterMode): DailyReportAlert[] {
  if (filter === "all") return alerts;
  if (filter === "unread") return alerts.filter(item => !item.isRead);
  return alerts.filter(item => item.severity === filter);
}

export function getAmbiguousColumnMatches(understanding: DomainTableUnderstanding | null): ColumnSemanticMatch[] {
  if (!understanding) return [];
  return understanding.columnMatches.filter(match => match.ambiguous || match.needsConfirmation);
}

export function formatShortTimestamp(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "Not available";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(parsed);
  } catch {
    return parsed.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

export function formatSignedPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

export function formatArrowPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  if (Math.abs(value) < 0.05) return `→ ${Math.abs(value).toFixed(1)}%`;
  return `${value > 0 ? "↑" : "↓"} ${Math.abs(value).toFixed(1)}%`;
}

export function formatArrowNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  const formatted = Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(value) < 0.005) return `→ ${formatted}`;
  return `${value > 0 ? "↑" : "↓"} ${formatted}`;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function createStaleResetSnapshot() {
  return {
    intelligence: null,
    historicalAnalysis: null,
    manualResult: null,
    archiveComparison: null,
    error: ""
  };
}

export type ReportHistoryFilterState = {
  search: string;
  startDate: string;
  endDate: string;
  includeAllDates: boolean;
  frequency: "" | ReportFrequencyOrManual;
  domainId: "" | BusinessDomainId;
  status: "" | PersistentReportStatusFilter;
  pdfStatus: "" | PersistentReportPdfStatus;
  page: number;
  pageSize: number;
};

export const DEFAULT_REPORT_HISTORY_FILTERS: ReportHistoryFilterState = {
  search: "",
  startDate: "",
  endDate: "",
  includeAllDates: false,
  frequency: "",
  domainId: "",
  status: "",
  pdfStatus: "",
  page: 1,
  pageSize: 10
};

export function buildReportHistoryQueryString(filters: ReportHistoryFilterState): string {
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Math.trunc(filters.page || 1))));
  params.set("pageSize", String(Math.max(1, Math.min(100, Math.trunc(filters.pageSize || 10)))));
  if (filters.includeAllDates) params.set("all", "true");
  if (filters.startDate && isValidIsoDateString(filters.startDate)) params.set("start", filters.startDate);
  if (filters.endDate && isValidIsoDateString(filters.endDate)) params.set("end", filters.endDate);
  if (filters.frequency) params.set("frequency", filters.frequency);
  if (filters.domainId) params.set("domain", filters.domainId);
  if (filters.status) params.set("status", filters.status);
  if (filters.pdfStatus) params.set("pdfStatus", filters.pdfStatus);
  if (filters.search.trim()) params.set("search", filters.search.trim().slice(0, 120));
  return params.toString();
}

/**
 * A persisted report is directly downloadable ONLY when generation succeeded AND its PDF
 * artifact is genuinely stored and verified (`pdfStatus === "generated"`).
 */
export function isReportPdfDownloadable(
  report: Pick<PersistentReportSummary, "status" | "pdfStatus"> | null | undefined
): boolean {
  return Boolean(report && report.status === "generated" && report.pdfStatus === "generated");
}

export function canCompareArchivedReports(
  left: Pick<PersistentReportSummary, "id" | "status" | "domainId"> | null | undefined,
  right: Pick<PersistentReportSummary, "id" | "status" | "domainId"> | null | undefined
): { allowed: boolean; reason: string | null } {
  if (!left || !right) {
    return { allowed: false, reason: "Select two persisted reports to compare." };
  }
  if (left.id === right.id) {
    return { allowed: false, reason: "Choose two different reports to run a comparison." };
  }
  if (left.status === "failed" || right.status === "failed") {
    return { allowed: false, reason: "Failed reports cannot be compared." };
  }
  return { allowed: true, reason: null };
}

export type HistoricalSeriesOption = {
  metricKey: string;
  label: string;
};

export function extractHistoricalSeriesOptions(analysis: DynamicAnalysisResult | null): HistoricalSeriesOption[] {
  if (!analysis || !analysis.timeSeries.length || analysis.source.rowCountInPeriod === 0) return [];
  const labelMap = new Map<string, string>();
  for (const metric of analysis.availableMetrics) {
    labelMap.set(metric.metricId, metric.name);
  }
  const discoveredKeys = new Set<string>();
  for (const point of analysis.timeSeries) {
    for (const [key, val] of Object.entries(point.metrics)) {
      if (val !== null && Number.isFinite(val)) {
        discoveredKeys.add(key);
      }
    }
  }
  return Array.from(discoveredKeys).map(key => ({
    metricKey: key,
    label: labelMap.get(key) || key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
  }));
}

export function extractSignificantHistoricalChanges(
  analysis: DynamicAnalysisResult | null,
  limit = 4
): MetricResult[] {
  if (!analysis) return [];
  return [...analysis.availableMetrics]
    .filter(metric => metric.changePercent !== null && Number.isFinite(metric.changePercent) && Math.abs(metric.changePercent) >= 1)
    .sort((a, b) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0))
    .slice(0, Math.max(1, limit));
}

export function computeHistoricalCoverageSummary(analysis: DynamicAnalysisResult | null): {
  periodDays: number;
  observedDays: number;
  missingDays: number;
  coveragePercent: number;
  rowCountInPeriod: number;
  isEmpty: boolean;
} {
  if (!analysis) {
    return {
      periodDays: 0,
      observedDays: 0,
      missingDays: 0,
      coveragePercent: 0,
      rowCountInPeriod: 0,
      isEmpty: true
    };
  }
  const periodDays = Math.max(1, analysis.reportingPeriod.dayCount || 1);
  const observedDays = analysis.timeSeries.filter(point => point.recordCount > 0).length;
  const missingDays = Math.max(0, periodDays - observedDays);
  const coveragePercent = Math.min(100, Math.round((observedDays / periodDays) * 100));
  return {
    periodDays,
    observedDays,
    missingDays,
    coveragePercent,
    rowCountInPeriod: analysis.source.rowCountInPeriod,
    isEmpty: analysis.source.rowCountInPeriod === 0
  };
}

