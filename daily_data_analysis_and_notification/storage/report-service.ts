import { randomUUID } from "node:crypto";
import { getLocalDatabase } from "../database/sqlite-client";
import {
  renderAnalysisReport,
  renderDynamicAnalysisPdf,
  type DynamicPdfReportInput,
  type HistoricalContextBundle,
  type PdfReportMetadata
} from "../pdf/report-pdf";
import type { AnalysisReport, DailyPerformance, AnalysisDimension } from "../types";
import { BUSINESS_DOMAIN_IDS, isValidIdentifier, type BusinessDomainId, type ReadOnlyQueryExecutor } from "../profiler";
import { addDaysToDate, assertValidTimezone, runDynamicAnalysisWithExecutor, type ComparisonPreset, type DynamicAnalysisResult } from "../metrics";
import {
  runUnifiedDailyAnalysisWithExecutor,
  toArchivedReportFromDynamic,
  type ArchivedReportRecord,
  type ExpectedReportingCadence,
  type ReportArchiveComparisonResult,
  type UnifiedDailyAnalysisResult
} from "../intelligence";
import { sanitizeAlertRules } from "../notifications";
import {
  assertValidPdfBuffer,
  createDefaultPdfStorage,
  getStorageCapabilityStatus,
  resolveAppDatabaseUrl
} from "./pdf-storage";
import { PostgresReportRepository } from "./postgres-report-repository";
import {
  buildScheduledExecutionKey,
  DEFAULT_SCHEDULE_TIME,
  DEFAULT_SCHEDULE_TIMEZONE,
  enumerateDuePeriods,
  isScheduleDueNow,
  resolveManualReportPeriod,
  validateScheduledTime
} from "./schedule-periods";
import { SqliteReportRepository } from "./sqlite-report-repository";
import type {
  ManualQuickRange,
  PdfStorageAdapter,
  PersistentDailySettings,
  PersistentReportRecord,
  PersistentReportRepository,
  ReportFrequency
} from "./types";

const ALLOWED_FREQUENCIES = new Set<ReportFrequency>(["daily", "weekly", "monthly"]);
const ALLOWED_CADENCES = new Set<ExpectedReportingCadence>(["daily", "weekdays", "weekly", "irregular"]);
const ALLOWED_PRESETS = new Set<ComparisonPreset>([
  "previous_day",
  "previous_week",
  "previous_month",
  "previous_7_days",
  "previous_30_days",
  "previous_90_days",
  "previous_365_days",
  "same_weekday_previous_weeks",
  "custom",
  "none"
]);

let cachedRepository: PersistentReportRepository | null = null;

export function getDefaultDailySettings(organizationId: string): PersistentDailySettings {
  const capability = getStorageCapabilityStatus();
  return {
    organizationId,
    selectedDomain: "sales_ecommerce",
    selectedDataset: null,
    // Daily automatic reporting is enabled by default ONLY when a valid durable schedule & storage stack exists
    autoReportEnabled: capability.schedulerProductionReady,
    frequency: "daily",
    scheduledTime: DEFAULT_SCHEDULE_TIME,
    timezone: DEFAULT_SCHEDULE_TIMEZONE,
    comparisonPreset: "previous_30_days",
    comparisonDays: 30,
    expectedCadence: "irregular",
    alertRules: sanitizeAlertRules(null),
    columnOverrides: {}
  };
}

export function validateAndMergeSettings(
  organizationId: string,
  body: unknown,
  current: PersistentDailySettings
): PersistentDailySettings {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("A JSON object is required for settings.");
  }
  const input = body as Record<string, unknown>;

  let selectedDomain = current.selectedDomain;
  if (input.selectedDomain !== undefined) {
    if (typeof input.selectedDomain !== "string" || !(BUSINESS_DOMAIN_IDS as readonly string[]).includes(input.selectedDomain)) {
      throw new Error(`selectedDomain must be one of: ${BUSINESS_DOMAIN_IDS.join(", ")}.`);
    }
    selectedDomain = input.selectedDomain as BusinessDomainId;
  }

  let selectedDataset = current.selectedDataset;
  if (input.selectedDataset !== undefined) {
    if (input.selectedDataset === null || input.selectedDataset === "") {
      selectedDataset = null;
    } else if (typeof input.selectedDataset === "string" && isValidIdentifier(input.selectedDataset.trim())) {
      selectedDataset = input.selectedDataset.trim();
    } else {
      throw new Error("selectedDataset must be a valid table or view identifier.");
    }
  }

  let autoReportEnabled = current.autoReportEnabled;
  if (input.autoReportEnabled !== undefined) {
    if (typeof input.autoReportEnabled !== "boolean") {
      throw new Error("autoReportEnabled must be a boolean.");
    }
    autoReportEnabled = input.autoReportEnabled;
  }

  let frequency = current.frequency;
  if (input.frequency !== undefined) {
    if (typeof input.frequency !== "string" || !ALLOWED_FREQUENCIES.has(input.frequency as ReportFrequency)) {
      throw new Error("frequency must be 'daily', 'weekly', or 'monthly'.");
    }
    frequency = input.frequency as ReportFrequency;
  }

  const scheduledTime = input.scheduledTime === undefined
    ? current.scheduledTime
    : validateScheduledTime(String(input.scheduledTime));

  const timezone = input.timezone === undefined
    ? current.timezone
    : assertValidTimezone(String(input.timezone));

  let comparisonPreset = current.comparisonPreset;
  if (input.comparisonPreset !== undefined) {
    if (typeof input.comparisonPreset !== "string" || !ALLOWED_PRESETS.has(input.comparisonPreset as ComparisonPreset)) {
      throw new Error("Invalid comparisonPreset.");
    }
    comparisonPreset = input.comparisonPreset as ComparisonPreset;
  }

  let comparisonDays = current.comparisonDays;
  if (input.comparisonDays !== undefined) {
    const days = Number(input.comparisonDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error("comparisonDays must be a whole number between 1 and 3650.");
    }
    comparisonDays = days;
  }

  let expectedCadence = current.expectedCadence;
  if (input.expectedCadence !== undefined) {
    if (typeof input.expectedCadence !== "string" || !ALLOWED_CADENCES.has(input.expectedCadence as ExpectedReportingCadence)) {
      throw new Error("expectedCadence must be 'daily', 'weekdays', 'weekly', or 'irregular'.");
    }
    expectedCadence = input.expectedCadence as ExpectedReportingCadence;
  }

  const alertRules = input.alertRules !== undefined && input.alertRules && typeof input.alertRules === "object"
    ? sanitizeAlertRules(input.alertRules as Partial<PersistentDailySettings["alertRules"]>)
    : current.alertRules;

  let columnOverrides = current.columnOverrides;
  if (input.columnOverrides !== undefined) {
    if (!input.columnOverrides || typeof input.columnOverrides !== "object" || Array.isArray(input.columnOverrides)) {
      throw new Error("columnOverrides must be a key-value map.");
    }
    const clean: Record<string, string> = {};
    for (const [role, col] of Object.entries(input.columnOverrides as Record<string, unknown>)) {
      if (typeof col === "string" && col.trim() && isValidIdentifier(col.trim())) {
        clean[role] = col.trim();
      }
    }
    columnOverrides = clean;
  }

  return {
    organizationId,
    selectedDomain,
    selectedDataset,
    autoReportEnabled,
    frequency,
    scheduledTime,
    timezone,
    comparisonPreset,
    comparisonDays,
    expectedCadence,
    alertRules,
    columnOverrides
  };
}

export function getPersistentReportRepository(): PersistentReportRepository {
  if (cachedRepository) return cachedRepository;
  const appDbUrl = resolveAppDatabaseUrl();
  if (appDbUrl) {
    cachedRepository = new PostgresReportRepository(appDbUrl);
    return cachedRepository;
  }
  // Local development fallback using application-owned SQLite DB (NEVER writes to connected org DB)
  cachedRepository = new SqliteReportRepository(getLocalDatabase());
  return cachedRepository;
}

/**
 * Adapts a multi-domain DynamicAnalysisResult / UnifiedDailyAnalysisResult into the existing
 * PDFKit `renderAnalysisReport` renderer so every scheduled and manual report produces a valid
 * PDF right away in Stage 4 (Stage 5 will expand the PDF layout with full multi-domain sections).
 */
export function adaptDynamicAnalysisForPdf(
  unified: UnifiedDailyAnalysisResult,
  reportKind: "automatic" | "historical"
): AnalysisReport {
  const analysis = unified.analysis;
  const val = (id: string): number => analysis.availableMetrics.find(m => m.metricId === id)?.value ?? 0;
  const compVal = (id: string): number => analysis.availableMetrics.find(m => m.metricId === id)?.comparisonValue ?? 0;

  // Map primary domain KPIs cleanly onto the existing PDF summary cards without inventing fake data
  const primaryNumericMetrics = analysis.availableMetrics.filter(m => m.value !== null);
  const revenueVal = val("totalRevenue") || val("attributedRevenue") || val("totalIncome") || val("mrr") || primaryNumericMetrics[0]?.value || 0;
  const ordersVal = val("totalOrders") || val("conversions") || val("activeCustomers") || val("dau") || analysis.source.rowCountInPeriod;
  const unitsVal = val("unitsSold") || val("availableStock") || val("clicks") || val("totalShipments") || 0;
  const profitVal = val("grossProfit") || val("netIncome") || val("netCashFlow") || 0;
  const marginVal = val("grossProfitMargin") || val("fulfillmentRate") || val("onTimeDeliveryRate") || val("customerRetention") || 0;
  const aovVal = val("averageOrderValue") || val("averageSellingPrice") || val("costPerAcquisition") || 0;

  const dailyPerformance: DailyPerformance[] = analysis.timeSeries.map(pt => {
    const firstVal = Object.values(pt.metrics).find(v => typeof v === "number" && Number.isFinite(v)) ?? 0;
    return {
      date: pt.date,
      totalRevenue: pt.metrics.totalRevenue ?? pt.metrics.attributedRevenue ?? pt.metrics.totalIncome ?? firstVal,
      totalOrders: pt.metrics.totalOrders ?? pt.metrics.conversions ?? pt.metrics.activeCustomers ?? pt.metrics.dau ?? pt.recordCount,
      totalUnitsSold: pt.metrics.unitsSold ?? pt.metrics.clicks ?? pt.recordCount,
      totalProductLines: pt.recordCount,
      grossProfit: pt.metrics.grossProfit ?? pt.metrics.netCashFlow ?? 0,
      grossProfitMargin: 0,
      totalDiscounts: 0,
      averageOrderValue: 0,
      averageCustomerRating: null
    };
  });

  const firstBreakdown = analysis.breakdowns[0];
  const categoryPerformance: AnalysisDimension[] = (firstBreakdown?.items || []).map(item => ({
    label: item.label,
    revenue: Math.max(0, item.primaryValue),
    orders: item.recordCount,
    units: item.recordCount,
    productLines: item.recordCount,
    grossProfit: 0,
    discounts: 0,
    averageRating: null
  }));

  const availableMetrics: string[] = [];
  if (analysis.availableMetrics.some(m => ["totalRevenue", "attributedRevenue", "totalIncome", "mrr"].includes(m.metricId)) || primaryNumericMetrics.length > 0) {
    availableMetrics.push("totalRevenue");
  }
  if (ordersVal > 0 || analysis.availableMetrics.some(m => ["totalOrders", "conversions", "activeCustomers", "dau"].includes(m.metricId))) {
    availableMetrics.push("totalOrders");
  }
  if (analysis.availableMetrics.some(m => ["unitsSold", "availableStock", "clicks"].includes(m.metricId))) {
    availableMetrics.push("totalUnitsSold");
  }
  if (analysis.availableMetrics.some(m => ["grossProfit", "netIncome", "netCashFlow"].includes(m.metricId))) {
    availableMetrics.push("grossProfit");
  }
  if (analysis.availableMetrics.some(m => ["grossProfitMargin", "fulfillmentRate", "onTimeDeliveryRate", "customerRetention"].includes(m.metricId))) {
    availableMetrics.push("grossProfitMargin");
  }
  if (analysis.availableMetrics.some(m => ["averageOrderValue", "averageSellingPrice", "costPerAcquisition"].includes(m.metricId))) {
    availableMetrics.push("averageOrderValue");
  }

  return {
    availableMetrics,
    dataset: { table: analysis.tableName },
    reportKind,
    reportingDate: analysis.reportingPeriod.end,
    periodStart: analysis.reportingPeriod.start,
    periodEnd: analysis.reportingPeriod.end,
    comparisonDays: analysis.comparisonPeriod?.dayCount ?? null,
    comparisonStart: analysis.comparisonPeriod?.start ?? null,
    comparisonEnd: analysis.comparisonPeriod?.end ?? null,
    current: {
      periodStart: analysis.reportingPeriod.start,
      periodEnd: analysis.reportingPeriod.end,
      totalRevenue: revenueVal,
      totalOrders: ordersVal,
      totalUnitsSold: unitsVal,
      totalProductLines: analysis.source.rowCountInPeriod,
      grossProfit: profitVal,
      grossProfitMargin: marginVal,
      totalDiscounts: val("totalDiscounts"),
      averageOrderValue: aovVal,
      averageCustomerRating: null,
      statusDistribution: { Pending: 0, Processing: 0, Confirmed: 0, Completed: Math.max(0, Math.round(ordersVal)), Cancelled: 0, Returned: 0 }
    },
    comparisonDailyAverage: analysis.comparisonSummary.available && analysis.comparisonPeriod
      ? {
          totalRevenue: compVal("totalRevenue") || compVal("attributedRevenue") || compVal("totalIncome") || 0,
          totalOrders: compVal("totalOrders") || compVal("conversions") || compVal("activeCustomers") || 0,
          totalUnitsSold: compVal("unitsSold") || compVal("clicks") || 0,
          totalProductLines: analysis.source.rowCountInComparison,
          grossProfit: compVal("grossProfit") || compVal("netIncome") || compVal("netCashFlow") || 0,
          grossProfitMargin: compVal("grossProfitMargin") || compVal("fulfillmentRate") || 0,
          totalDiscounts: compVal("totalDiscounts"),
          averageOrderValue: compVal("averageOrderValue"),
          averageCustomerRating: null
        }
      : null,
    comparison: null,
    dailyPerformance,
    productPerformance: categoryPerformance,
    categoryPerformance,
    regionPerformance: [],
    genderPerformance: [],
    generatedAt: unified.generatedAt,
    status: "generated"
  };
}

export function buildPdfMetadataFromRecord(
  record: Pick<
    PersistentReportRecord,
    | "id"
    | "organizationId"
    | "domainId"
    | "domainName"
    | "datasetTable"
    | "generationType"
    | "frequency"
    | "periodStart"
    | "periodEnd"
    | "comparisonStart"
    | "comparisonEnd"
    | "generatedAt"
  > & { reportPayload?: Record<string, unknown> },
  organizationLabel?: string,
  quickRangeLabel?: string | null
): PdfReportMetadata {
  const payload = record.reportPayload || {};
  const analysisTimezone = (payload.analysis as DynamicAnalysisResult | undefined)?.timezone || DEFAULT_SCHEDULE_TIMEZONE;
  const periodLabel = record.periodStart === record.periodEnd
    ? record.periodStart
    : `${record.periodStart} to ${record.periodEnd}`;
  const comparisonLabel = record.comparisonStart && record.comparisonEnd
    ? (record.comparisonStart === record.comparisonEnd
        ? record.comparisonStart
        : `${record.comparisonStart} to ${record.comparisonEnd}`)
    : null;

  return {
    reportId: record.id,
    organizationLabel: organizationLabel || record.organizationId,
    domainId: record.domainId,
    domainName: record.domainName,
    datasetTable: record.datasetTable,
    generationType: record.generationType,
    frequency: record.frequency,
    quickRangeLabel: quickRangeLabel ?? null,
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    periodLabel,
    comparisonStart: record.comparisonStart,
    comparisonEnd: record.comparisonEnd,
    comparisonLabel,
    timezone: analysisTimezone,
    generatedAt: record.generatedAt
  };
}

/**
 * Computes a clearly separated Historical Dashboard Context bundle (default previous 30 days
 * for Daily reports; prior historical reference for Weekly/Monthly reports) using read-only
 * Stage 2 aggregation without altering the primary reporting period.
 */
export async function buildHistoricalContextForReport(input: {
  executor: ReadOnlyQueryExecutor;
  tableName: string;
  domainId: BusinessDomainId;
  periodStart: string;
  periodEnd: string;
  frequency: ReportFrequency;
  timezone?: string;
  overrides?: Record<string, string>;
  now?: Date;
}): Promise<HistoricalContextBundle | null> {
  const tz = assertValidTimezone(input.timezone || DEFAULT_SCHEDULE_TIMEZONE);
  const contextEnd = input.periodEnd;
  const contextStart = input.frequency === "daily"
    ? addDaysToDate(contextEnd, -29)
    : input.frequency === "weekly"
      ? addDaysToDate(contextEnd, -29)
      : addDaysToDate(contextEnd, -89);

  const label = input.frequency === "daily"
    ? "Previous 30-Day Context"
    : input.frequency === "weekly"
      ? "30-Day Rolling Context"
      : "90-Day Rolling Context";

  try {
    const { analysis } = await runDynamicAnalysisWithExecutor(input.executor, input.tableName, {
      domainId: input.domainId,
      periodStart: contextStart,
      periodEnd: contextEnd,
      timezone: tz,
      comparisonPreset: "none",
      overrides: input.overrides,
      now: input.now
    });

    return {
      label,
      periodStart: analysis.reportingPeriod.start,
      periodEnd: analysis.reportingPeriod.end,
      dayCount: analysis.reportingPeriod.dayCount,
      rowCount: analysis.source.rowCountInPeriod,
      metrics: analysis.availableMetrics,
      timeSeries: analysis.timeSeries,
      breakdowns: analysis.breakdowns,
      sourceNote: `Separate historical reference window (${analysis.reportingPeriod.start} to ${analysis.reportingPeriod.end}) preserved alongside the primary ${input.frequency} reporting period (${input.periodStart} to ${input.periodEnd}).`
    };
  } catch {
    return null;
  }
}

export async function renderValidatedPdfForPayload(
  payload: Record<string, unknown>,
  reportKind: "automatic" | "historical",
  options: {
    metadata?: PdfReportMetadata;
    historicalContext?: HistoricalContextBundle | null;
    archivedComparison?: ReportArchiveComparisonResult | null;
  } = {}
): Promise<Buffer> {
  // Primary Stage 5 Dynamic Multi-Domain PDF Builder for all UnifiedDailyAnalysisResult payloads
  if (payload.analysis && payload.tools) {
    const unified = payload as unknown as UnifiedDailyAnalysisResult;
    const analysis = unified.analysis;
    const metadata: PdfReportMetadata = options.metadata || {
      reportId: String(payload.reportId || `${analysis.domainId}-${analysis.reportingPeriod.end}`),
      organizationLabel: String(payload.organizationLabel || "QueryPilot-X Organisation"),
      domainId: analysis.domainId,
      domainName: analysis.domainName,
      datasetTable: analysis.tableName,
      generationType: reportKind === "automatic" ? "automatic" : "manual",
      frequency: reportKind === "automatic" ? "daily" : "manual",
      periodStart: analysis.reportingPeriod.start,
      periodEnd: analysis.reportingPeriod.end,
      periodLabel: analysis.reportingPeriod.label,
      comparisonStart: analysis.comparisonPeriod?.start ?? null,
      comparisonEnd: analysis.comparisonPeriod?.end ?? null,
      comparisonLabel: analysis.comparisonPeriod?.label ?? null,
      timezone: analysis.timezone,
      generatedAt: unified.generatedAt
    };

    const historicalContext = options.historicalContext !== undefined
      ? options.historicalContext
      : ((payload.historicalContext as HistoricalContextBundle | null | undefined) ?? null);

    const pdfInput: DynamicPdfReportInput = {
      metadata,
      unified,
      historicalContext,
      archivedComparison: options.archivedComparison ?? null
    };
    const buffer = await renderDynamicAnalysisPdf(pdfInput);
    assertValidPdfBuffer(buffer);
    return buffer;
  }

  // Legacy Sales AnalysisReport compatibility path
  if (payload.current && Array.isArray(payload.dailyPerformance)) {
    const buffer = await renderAnalysisReport(payload as unknown as AnalysisReport);
    assertValidPdfBuffer(buffer);
    return buffer;
  }

  throw new Error("Unsupported report payload for PDF rendering.");
}

export function buildReportPdfFilename(record: Pick<PersistentReportRecord, "domainId" | "frequency" | "periodStart" | "periodEnd">): string {
  const safe = (v: string) => v.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "report";
  return `querypilot-x-${safe(record.domainId)}-${safe(record.frequency)}-${safe(record.periodStart)}-to-${safe(record.periodEnd)}.pdf`;
}

export function toArchivedReportFromPersistent(record: PersistentReportRecord): ArchivedReportRecord {
  const payload = record.reportPayload;
  if (payload && typeof payload === "object" && payload.analysis) {
    return toArchivedReportFromDynamic(payload.analysis as DynamicAnalysisResult, {
      id: record.id,
      storageSource: "durable_repository"
    });
  }
  if (payload && typeof payload === "object" && Array.isArray(payload.metrics) && payload.reportingPeriod) {
    return toArchivedReportFromDynamic(payload as unknown as DynamicAnalysisResult, {
      id: record.id,
      storageSource: "durable_repository"
    });
  }
  return {
    id: record.id,
    reportingDate: record.reportingDate,
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    domainId: record.domainId,
    domainName: record.domainName,
    tableName: record.datasetTable,
    generatedAt: record.generatedAt,
    storageSource: "durable_repository",
    metrics: [],
    summary: record.summaryText
  };
}

/**
 * Generates a user-requested MANUAL report for a quick range (7/30/90/365/all_history) or
 * custom date range, renders & validates the PDF, saves it privately, and persists metadata
 * in the durable application repository (distinct from scheduled reports).
 */
export async function generateAndPersistManualReport(input: {
  organizationId: string;
  ownerRef?: string | null;
  storageUserId?: string;
  executor: ReadOnlyQueryExecutor;
  repository: PersistentReportRepository;
  pdfStorage?: PdfStorageAdapter;
  tableName: string;
  domainId?: BusinessDomainId;
  quickRange: ManualQuickRange;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  comparisonPreset?: ComparisonPreset;
  overrides?: Record<string, string>;
  earliestAvailableDate?: string | null;
  latestAvailableDate?: string | null;
  now?: Date;
}): Promise<{ record: PersistentReportRecord; downloadUrl: string }> {
  const pdfStorage = input.pdfStorage || createDefaultPdfStorage();
  const tz = assertValidTimezone(input.timezone || DEFAULT_SCHEDULE_TIMEZONE);
  const { periodStart, periodEnd, reportingDate } = resolveManualReportPeriod({
    quickRange: input.quickRange,
    startDate: input.startDate,
    endDate: input.endDate,
    timezone: tz,
    earliestAvailableDate: input.earliestAvailableDate,
    latestAvailableDate: input.latestAvailableDate,
    now: input.now
  });

  const unified = await runUnifiedDailyAnalysisWithExecutor(input.executor, input.tableName, {
    domainId: input.domainId,
    periodStart,
    periodEnd,
    timezone: tz,
    comparisonPreset: input.comparisonPreset ?? (input.quickRange === "all_history" ? "none" : "previous_30_days"),
    overrides: input.overrides,
    now: input.now
  });

  const reportId = randomUUID();
  const summaryText = unified.tools.intelligenceBrief?.executiveSummary
    || `${unified.domainName} manual report (${periodStart} to ${periodEnd})`;

  let saved = await input.repository.saveReport({
    id: reportId,
    organizationId: input.organizationId,
    ownerRef: input.ownerRef ?? null,
    domainId: unified.domainId,
    domainName: unified.domainName,
    datasetTable: unified.tableName,
    reportingDate,
    periodStart,
    periodEnd,
    comparisonStart: unified.comparisonPeriod?.start ?? null,
    comparisonEnd: unified.comparisonPeriod?.end ?? null,
    comparisonPreset: unified.comparisonPeriod?.preset ?? null,
    frequency: "manual",
    generationType: "manual",
    executionKey: null, // Manual reports remain distinct from scheduled deduplication keys
    status: "generated",
    summaryText,
    reportPayload: unified as unknown as Record<string, unknown>,
    pdfStatus: "not_generated",
    pdfStorageKey: null,
    pdfFilename: null,
    pdfGeneratedAt: null,
    pdfSizeBytes: null,
    pdfError: null,
    errorMessage: null,
    generatedAt: unified.generatedAt
  });

  const filename = buildReportPdfFilename(saved);
  try {
    const pdfBytes = await renderValidatedPdfForPayload(saved.reportPayload, "historical", {
      metadata: buildPdfMetadataFromRecord(saved, input.ownerRef || input.organizationId, input.quickRange)
    });
    const stored = await pdfStorage.savePdf({
      organizationId: input.organizationId,
      storageUserId: input.storageUserId,
      reportId: saved.id,
      filename,
      bytes: pdfBytes
    });
    const verifyBytes = await pdfStorage.readPdf(stored.storageKey);
    if (!verifyBytes) throw new Error("PDF persistence verification failed: stored file could not be read back.");
    assertValidPdfBuffer(verifyBytes);

    const pdfGeneratedAt = new Date().toISOString();
    await input.repository.updateReportPdfMetadata(input.organizationId, saved.id, {
      pdfStatus: "generated",
      pdfStorageKey: stored.storageKey,
      pdfFilename: stored.filename,
      pdfGeneratedAt,
      pdfSizeBytes: stored.sizeBytes,
      pdfError: null
    });
    saved = (await input.repository.getReportById(input.organizationId, saved.id)) || saved;
  } catch (error) {
    const message = error instanceof Error ? error.message : "PDF generation or storage failed.";
    await input.repository.updateReportPdfMetadata(input.organizationId, saved.id, {
      pdfStatus: "failed",
      pdfError: message
    });
    saved = (await input.repository.getReportById(input.organizationId, saved.id)) || saved;
  }

  return {
    record: saved,
    downloadUrl: `/api/daily-analysis/reports/${saved.id}/pdf`
  };
}

export type ScheduledRunOutcome = {
  organizationId: string;
  frequency: ReportFrequency;
  periodStart: string;
  periodEnd: string;
  executionKey: string;
  status: "generated" | "retried_pdf" | "skipped" | "failed";
  reportId: string | null;
  error?: string;
};

export type SchedulerBatchResult = {
  ranAt: string;
  checkedSchedules: number;
  outcomes: ScheduledRunOutcome[];
};

export type OrganizationSourceResolver = (organizationId: string) => Promise<ReadOnlyQueryExecutor | null>;

/**
 * Server-side one-shot scheduler for Daily, Weekly (Mon-Sun), and Monthly automatic reports.
 * Runs independently of any browser session; uses durable execution leases to prevent overlaps,
 * catches up missed periods chronologically, prevents duplicate reports, and retries failed PDFs
 * without duplicating report records.
 */
export async function runScheduledReports(input: {
  repository: PersistentReportRepository;
  pdfStorage?: PdfStorageAdapter;
  resolveSourceExecutor: OrganizationSourceResolver;
  now?: Date;
  forceDue?: boolean;
  organizationIdFilter?: string;
}): Promise<SchedulerBatchResult> {
  const now = input.now || new Date();
  const pdfStorage = input.pdfStorage || createDefaultPdfStorage();
  const activeSettings = await input.repository.listActiveScheduledSettings();
  const filtered = input.organizationIdFilter
    ? activeSettings.filter(s => s.organizationId === input.organizationIdFilter)
    : activeSettings;

  const outcomes: ScheduledRunOutcome[] = [];

  for (const settings of filtered) {
    if (!settings.selectedDataset) continue;
    const cursor = await input.repository.getScheduleCursor(settings.organizationId, settings.frequency);
    const dueNow = input.forceDue || isScheduleDueNow(settings, cursor, now);
    if (!dueNow) continue;

    const periods = enumerateDuePeriods(settings.frequency, cursor, settings.timezone, now);
    if (!periods.length) continue;

    for (const period of periods) {
      const executionKey = buildScheduledExecutionKey({
        organizationId: settings.organizationId,
        frequency: settings.frequency,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        domainId: settings.selectedDomain,
        datasetTable: settings.selectedDataset
      });

      const claim = await input.repository.claimExecution({
        executionKey,
        organizationId: settings.organizationId,
        scheduleId: `${settings.organizationId}:${settings.frequency}`,
        frequency: settings.frequency,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        leaseMinutes: 15,
        now
      });

      if (claim.outcome === "already_succeeded" || claim.outcome === "in_progress") {
        outcomes.push({
          organizationId: settings.organizationId,
          frequency: settings.frequency,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          executionKey,
          status: "skipped",
          reportId: claim.record.reportId
        });
        continue;
      }

      let persistedReport: PersistentReportRecord | null = null;
      try {
        // Check if report already exists (e.g. previous run saved report but failed PDF upload -> PDF-only retry!)
        persistedReport = await input.repository.getReportByExecutionKey(settings.organizationId, executionKey);
        const isPdfRetry = Boolean(persistedReport && persistedReport.pdfStatus !== "generated");

        if (!persistedReport) {
          const executor = await input.resolveSourceExecutor(settings.organizationId);
          if (!executor) {
            throw new Error(`No configured read-only source database connector is available for organisation "${settings.organizationId}".`);
          }

          const comparisonPreset: ComparisonPreset = settings.frequency === "daily"
            ? settings.comparisonPreset || "previous_day"
            : settings.frequency === "weekly"
              ? "previous_week"
              : "previous_month";

          const unified = await runUnifiedDailyAnalysisWithExecutor(executor, settings.selectedDataset, {
            domainId: settings.selectedDomain,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            timezone: settings.timezone,
            comparisonPreset,
            overrides: settings.columnOverrides,
            alertRules: settings.alertRules,
            expectedCadence: settings.expectedCadence,
            now
          });

          const historicalContext = await buildHistoricalContextForReport({
            executor,
            tableName: settings.selectedDataset,
            domainId: unified.domainId,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            frequency: settings.frequency,
            timezone: settings.timezone,
            overrides: settings.columnOverrides,
            now
          });

          const reportPayloadWithContext: Record<string, unknown> = {
            ...(unified as unknown as Record<string, unknown>),
            ...(historicalContext ? { historicalContext } : {})
          };

          persistedReport = await input.repository.saveReport({
            id: randomUUID(),
            organizationId: settings.organizationId,
            ownerRef: "scheduler",
            domainId: unified.domainId,
            domainName: unified.domainName,
            datasetTable: unified.tableName,
            reportingDate: period.reportingDate,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            comparisonStart: unified.comparisonPeriod?.start ?? null,
            comparisonEnd: unified.comparisonPeriod?.end ?? null,
            comparisonPreset: unified.comparisonPeriod?.preset ?? null,
            frequency: settings.frequency,
            generationType: "automatic",
            executionKey,
            status: "generated",
            summaryText: unified.tools.intelligenceBrief?.executiveSummary
              || `${unified.domainName} ${settings.frequency} report (${period.periodStart} to ${period.periodEnd})`,
            reportPayload: reportPayloadWithContext,
            pdfStatus: "not_generated",
            pdfStorageKey: null,
            pdfFilename: null,
            pdfGeneratedAt: null,
            pdfSizeBytes: null,
            pdfError: null,
            errorMessage: null,
            generatedAt: unified.generatedAt
          });
        }

        // Verify existing PDF or generate & store privately
        let hasValidPdf = false;
        if (persistedReport.pdfStatus === "generated" && persistedReport.pdfStorageKey) {
          const existingBytes = await pdfStorage.readPdf(persistedReport.pdfStorageKey);
          if (existingBytes) {
            try {
              assertValidPdfBuffer(existingBytes);
              hasValidPdf = true;
            } catch {
              hasValidPdf = false;
            }
          }
        }

        if (!hasValidPdf) {
          const filename = buildReportPdfFilename(persistedReport);
          const storedHistoricalContext =
            (persistedReport.reportPayload?.historicalContext as HistoricalContextBundle | null | undefined) ?? null;
          const pdfBytes = await renderValidatedPdfForPayload(persistedReport.reportPayload, "automatic", {
            metadata: buildPdfMetadataFromRecord(persistedReport),
            historicalContext: storedHistoricalContext
          });
          const ownerStorageUserId = persistedReport.ownerRef && /^(?:usr|pgusr)_[a-f0-9]+$/i.test(persistedReport.ownerRef)
            ? persistedReport.ownerRef
            : undefined;
          const stored = await pdfStorage.savePdf({
            organizationId: settings.organizationId,
            storageUserId: ownerStorageUserId,
            reportId: persistedReport.id,
            filename,
            bytes: pdfBytes
          });
          // Confirm saved bytes are readable & valid before marking succeeded
          const verifyBytes = await pdfStorage.readPdf(stored.storageKey);
          if (!verifyBytes) throw new Error("PDF persistence verification failed: stored file could not be read back.");
          assertValidPdfBuffer(verifyBytes);

          await input.repository.updateReportPdfMetadata(settings.organizationId, persistedReport.id, {
            pdfStatus: "generated",
            pdfStorageKey: stored.storageKey,
            pdfFilename: stored.filename,
            pdfGeneratedAt: now.toISOString(),
            pdfSizeBytes: stored.sizeBytes,
            pdfError: null
          });
        }

        // Only mark execution succeeded & advance cursor after BOTH report and PDF persistence succeeded
        await input.repository.completeExecution({
          executionKey,
          status: "succeeded",
          reportId: persistedReport.id,
          now
        });
        await input.repository.setScheduleCursor(settings.organizationId, settings.frequency, period.periodEnd);

        outcomes.push({
          organizationId: settings.organizationId,
          frequency: settings.frequency,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          executionKey,
          status: isPdfRetry ? "retried_pdf" : "generated",
          reportId: persistedReport.id
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Scheduled report execution failed.";
        if (persistedReport) {
          await input.repository.updateReportPdfMetadata(settings.organizationId, persistedReport.id, {
            pdfStatus: "failed",
            pdfError: message
          }).catch(() => undefined);
        }
        const retryAt = new Date(now.getTime() + 15 * 60_000).toISOString();
        await input.repository.completeExecution({
          executionKey,
          status: "failed",
          reportId: persistedReport?.id ?? null,
          errorMessage: message,
          nextRetryAt: retryAt,
          now
        });
        outcomes.push({
          organizationId: settings.organizationId,
          frequency: settings.frequency,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          executionKey,
          status: "failed",
          reportId: persistedReport?.id ?? null,
          error: message
        });
      }
    }
  }

  return {
    ranAt: now.toISOString(),
    checkedSchedules: filtered.length,
    outcomes
  };
}
