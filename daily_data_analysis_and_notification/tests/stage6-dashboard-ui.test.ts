import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Database from "better-sqlite3";
import { profileRowsSnapshot, type ReadOnlyQueryExecutor } from "../profiler";
import { runUnifiedDailyAnalysisFromRows } from "../intelligence";
import {
  assertValidPdfBuffer,
  buildTimezoneCronExpression,
  computeNextScheduledExecution,
  generateAndPersistManualReport,
  getDefaultDailySettings,
  InMemoryDynamicScheduleProvider,
  LocalPrivatePdfStorage,
  SqliteReportRepository,
  validateAndMergeSettings,
  VercelHobbyCronFallbackProvider,
  type PersistentReportSummary,
  type StorageCapabilityStatus
} from "../storage";
import {
  createStaleResetSnapshot,
  DAILY_FREQUENCY_OPTIONS,
  DOMAIN_UI_CATALOG,
  filterDomainAlerts,
  getAmbiguousColumnMatches,
  getFrequencyOption,
  MANUAL_QUICK_RANGE_OPTIONS,
  mergeToolAlertsWithReadState,
  resolveAutoReportDisplayState,
  validateManualRangeSelection,
  validateScheduleFormInput
} from "../components/dashboard-helpers";
import { DEFAULT_ALERT_RULES } from "../notifications";

// Register test-only React global and CSS Module stub for Node SSR component tests under tsx
(globalThis as unknown as { React: typeof React }).React = React;
const requireFromTest = createRequire(import.meta.url);
const ModuleCtor = requireFromTest("node:module") as { _extensions?: Record<string, (mod: { exports: unknown }) => void> };
if (ModuleCtor._extensions) {
  ModuleCtor._extensions[".css"] = (mod: { exports: unknown }) => {
    const classProxy = new Proxy({}, { get: (_target, prop) => String(prop) });
    mod.exports = { __esModule: true, default: classProxy };
  };
}

const migrationDir = path.join(process.cwd(), "daily_data_analysis_and_notification", "database", "migrations");

const mockUnconfiguredStorage: StorageCapabilityStatus = {
  databaseBackend: "sqlite",
  databaseProductionReady: false,
  pdfBackend: "unconfigured",
  pdfProductionReady: false,
  schedulerSecretConfigured: false,
  schedulerProductionReady: false,
  missingProductionConfig: [
    "QUERYPILOT_APP_DATABASE_URL",
    "QUERYPILOT_STORAGE_SUPABASE_URL",
    "QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY",
    "QUERYPILOT_STORAGE_BUCKET",
    "CRON_SECRET"
  ]
};

const mockProdStorage: StorageCapabilityStatus = {
  databaseBackend: "postgres",
  databaseProductionReady: true,
  pdfBackend: "supabase_private_storage",
  pdfProductionReady: true,
  schedulerSecretConfigured: true,
  schedulerProductionReady: true,
  missingProductionConfig: []
};

test("Daily Report UI: frequency options, explanations, time validation, and all 6 status states", () => {
  assert.equal(DAILY_FREQUENCY_OPTIONS.length, 3);
  assert.equal(getFrequencyOption("daily").explanation, "The report will contain the previous completed day's data.");
  assert.equal(getFrequencyOption("weekly").explanation, "The report will contain the previous completed Monday–Sunday week.");
  assert.equal(getFrequencyOption("monthly").explanation, "The report will contain the previous completed calendar month.");

  // Time & schedule validation
  assert.equal(validateScheduleFormInput({ frequency: "daily", scheduledTime: "00:15", timezone: "Asia/Dhaka", selectedDataset: "orders", autoReportEnabled: true }).valid, true);
  assert.equal(validateScheduleFormInput({ frequency: "weekly", scheduledTime: "25:99", timezone: "Asia/Dhaka", selectedDataset: "orders", autoReportEnabled: true }).valid, false);
  assert.equal(validateScheduleFormInput({ frequency: "monthly", scheduledTime: "08:30", timezone: "Invalid/Zone", selectedDataset: "orders", autoReportEnabled: true }).valid, false);
  assert.equal(validateScheduleFormInput({ frequency: "daily", scheduledTime: "00:15", timezone: "Asia/Dhaka", selectedDataset: null, autoReportEnabled: true }).valid, false);

  // All required display states
  const baseReport: PersistentReportSummary = {
    id: "rep-1",
    organizationId: "org_1",
    ownerRef: "scheduler",
    domainId: "sales_ecommerce",
    domainName: "Sales & E-commerce",
    datasetTable: "orders",
    reportingDate: "2026-11-22",
    periodStart: "2026-11-22",
    periodEnd: "2026-11-22",
    comparisonStart: "2026-11-21",
    comparisonEnd: "2026-11-21",
    comparisonPreset: "previous_day",
    frequency: "daily",
    generationType: "automatic",
    executionKey: "sched|org_1|daily|2026-11-22",
    status: "generated",
    summaryText: "Daily summary",
    pdfStatus: "generated",
    pdfStorageKey: "org_1/rep-1/report.pdf",
    pdfFilename: "report.pdf",
    pdfGeneratedAt: "2026-11-23T00:16:00Z",
    pdfSizeBytes: 18400,
    pdfError: null,
    errorMessage: null,
    generatedAt: "2026-11-23T00:15:30Z",
    createdAt: "2026-11-23T00:15:30Z"
  };

  assert.equal(resolveAutoReportDisplayState({ autoReportEnabled: true, saving: true, storageStatus: mockProdStorage, scheduleSummary: null, latestReport: null }).code, "running");
  assert.equal(resolveAutoReportDisplayState({ autoReportEnabled: true, saving: false, storageStatus: mockUnconfiguredStorage, scheduleSummary: null, latestReport: null }).code, "storage_not_configured");
  assert.equal(resolveAutoReportDisplayState({ autoReportEnabled: true, saving: false, storageStatus: mockProdStorage, scheduleSummary: null, latestReport: null }).code, "scheduled");
  assert.equal(resolveAutoReportDisplayState({ autoReportEnabled: true, saving: false, storageStatus: mockProdStorage, scheduleSummary: null, latestReport: baseReport }).code, "generated");
  assert.equal(resolveAutoReportDisplayState({ autoReportEnabled: true, saving: false, storageStatus: mockProdStorage, scheduleSummary: null, latestReport: { ...baseReport, status: "failed", errorMessage: "DB timeout" } }).code, "failed");
  assert.equal(resolveAutoReportDisplayState({ autoReportEnabled: true, saving: false, storageStatus: mockProdStorage, scheduleSummary: null, latestReport: { ...baseReport, pdfStatus: "failed", pdfError: "Bucket denied" } }).code, "pdf_unavailable");
});

test("Manual Report UI: quick ranges, custom date validation, future rejection, and dataset history bounds", () => {
  const keys = MANUAL_QUICK_RANGE_OPTIONS.map(o => o.value);
  assert.deepEqual(keys, ["last_7_days", "last_30_days", "last_90_days", "last_365_days", "all_history", "custom"]);

  const now = new Date("2026-11-23T04:00:00.000Z"); // 2026-11-23 in Asia/Dhaka
  assert.equal(validateManualRangeSelection({ quickRange: "last_7_days", startDate: "", endDate: "", now }).valid, true);
  assert.equal(validateManualRangeSelection({ quickRange: "all_history", startDate: "", endDate: "", earliestAvailableDate: "2026-01-01", latestAvailableDate: "2026-11-22", now }).valid, true);

  // Valid custom range inside history
  assert.equal(validateManualRangeSelection({
    quickRange: "custom",
    startDate: "2026-11-01",
    endDate: "2026-11-20",
    earliestAvailableDate: "2026-10-01",
    latestAvailableDate: "2026-11-22",
    now
  }).valid, true);

  // Inverted range rejected
  const inverted = validateManualRangeSelection({ quickRange: "custom", startDate: "2026-11-20", endDate: "2026-11-10", now });
  assert.equal(inverted.valid, false);
  assert.match(inverted.error || "", /Start Date cannot be after End Date/);

  // Future end date rejected
  const future = validateManualRangeSelection({ quickRange: "custom", startDate: "2026-11-20", endDate: "2026-12-01", now });
  assert.equal(future.valid, false);
  assert.match(future.error || "", /future/);

  // Range completely outside dataset history rejected
  const outside = validateManualRangeSelection({
    quickRange: "custom",
    startDate: "2025-01-01",
    endDate: "2025-01-31",
    earliestAvailableDate: "2026-06-01",
    latestAvailableDate: "2026-11-22",
    now
  });
  assert.equal(outside.valid, false);
  assert.match(outside.error || "", /outside the connected dataset/);
});

test("Domain catalog covers all 7 domains without Sales-only wording; stale reset & alert filtering work cleanly", () => {
  assert.equal(DOMAIN_UI_CATALOG.length, 7);
  for (const domain of DOMAIN_UI_CATALOG) {
    if (domain.id !== "sales_ecommerce") {
      assert.ok(!/\bSales\b/i.test(domain.focusSummary), `Non-sales domain ${domain.id} should not contain Sales-only copy`);
    }
  }

  const reset = createStaleResetSnapshot();
  assert.equal(reset.intelligence, null);
  assert.equal(reset.manualResult, null);
  assert.equal(reset.archiveComparison, null);

  const sampleAlerts = [
    {
      id: "a1",
      reportKey: "inv|2026-11-22",
      reportingDate: "2026-11-22",
      periodLabel: "2026-11-22",
      code: "STOCKOUT_RISK" as const,
      severity: "critical" as const,
      title: "Stockout risk",
      message: "Low stock",
      metricLabel: "Stock on Hand",
      metricValue: "12 units",
      createdAt: "2026-11-23T00:00:00Z",
      isRead: false
    },
    {
      id: "a2",
      reportKey: "ops|2026-11-22",
      reportingDate: "2026-11-22",
      periodLabel: "2026-11-22",
      code: "HEALTHY_SUMMARY" as const,
      severity: "positive" as const,
      title: "Healthy fulfillment",
      message: "SLA 99%",
      metricLabel: "On-Time Rate",
      metricValue: "99%",
      createdAt: "2026-11-23T00:00:00Z",
      isRead: false
    }
  ];
  const merged = mergeToolAlertsWithReadState(sampleAlerts, new Set(["a1"]));
  assert.equal(merged[0].isRead, true);
  assert.equal(merged[1].isRead, false);
  assert.equal(filterDomainAlerts(merged, "unread").length, 1);
  assert.equal(filterDomainAlerts(merged, "critical").length, 1);
});

test("Scheduler provider: dynamic create/update/cancel, tenant isolation, duplicate prevention, and honest Hobby fallback", async () => {
  // Cron translation in org timezone
  assert.equal(buildTimezoneCronExpression("daily", "00:15"), "15 0 * * *");
  assert.equal(buildTimezoneCronExpression("weekly", "06:30"), "30 6 * * 1");
  assert.equal(buildTimezoneCronExpression("monthly", "09:00"), "0 9 1 * *");

  // Next execution never includes incomplete current day/week/month
  const now = new Date("2026-11-23T04:00:00.000Z"); // Monday 2026-11-23 10:00 Asia/Dhaka
  const dailyNext = computeNextScheduledExecution(
    { autoReportEnabled: true, frequency: "daily", scheduledTime: "00:15", timezone: "Asia/Dhaka" },
    "2026-11-22",
    now
  );
  assert.ok(dailyNext);
  assert.equal(dailyNext.targetPeriod.periodStart, "2026-11-23");
  assert.equal(dailyNext.nextNominalRunDate, "2026-11-24");

  // Dynamic provider enforces tenant isolation and prevents duplicates on frequency change
  const dynamicProvider = new InMemoryDynamicScheduleProvider();
  const orgASettings = { ...getDefaultDailySettings("org_alpha"), autoReportEnabled: true, frequency: "daily" as const, scheduledTime: "07:00" };
  const orgBSettings = { ...getDefaultDailySettings("org_beta"), autoReportEnabled: true, frequency: "weekly" as const, scheduledTime: "08:30" };

  await dynamicProvider.upsertSchedule(orgASettings, mockProdStorage);
  await dynamicProvider.upsertSchedule({ ...orgASettings, frequency: "monthly", scheduledTime: "09:15" }, mockProdStorage);
  await dynamicProvider.upsertSchedule(orgBSettings, mockProdStorage);

  // org_alpha has exactly 1 active schedule (monthly replaced daily -> no duplicates)
  const alphaSchedules = dynamicProvider.listForOrganization("org_alpha");
  assert.equal(alphaSchedules.length, 1);
  assert.equal(alphaSchedules[0].frequency, "monthly");
  assert.equal(alphaSchedules[0].cronExpression, "15 9 1 * *");

  // Disabling org_alpha does NOT affect org_beta (tenant isolation)
  await dynamicProvider.disableSchedule("org_alpha", "monthly", "Asia/Dhaka");
  assert.equal(dynamicProvider.listForOrganization("org_alpha").length, 0);
  assert.equal(dynamicProvider.listForOrganization("org_beta").length, 1);

  // Honest Hobby fallback reports actual limitations & Vercel Schedules blocker
  const fallback = new VercelHobbyCronFallbackProvider();
  const prodFallbackStatus = fallback.getProviderStatus(mockProdStorage);
  assert.equal(prodFallbackStatus.engine, "vercel_hobby_daily_cron");
  assert.equal(prodFallbackStatus.supportsExactMinutePrecision, false);
  assert.match(prodFallbackStatus.precisionNotice, /15 18 \* \* \*/);
  assert.ok(prodFallbackStatus.vercelSchedules.blocker);
  assert.deepEqual(prodFallbackStatus.vercelSchedules.requiredPackages, ["@vercel/schedules", "@vercel/queue"]);
});

test("React UI components render real multi-domain backend intelligence without static Sales demo data", async () => {
  const [
    { default: DailyReportPanel },
    { default: ManualReportPanel },
    { default: DomainDatasetBar },
    { default: DailyToolsSection }
  ] = await Promise.all([
    import("../components/DailyReportPanel"),
    import("../components/ManualReportPanel"),
    import("../components/DomainDatasetBar"),
    import("../components/DailyToolsSection")
  ]);

  const inventoryRows = [
    { sku_id: "SKU-10", snapshot_date: "2026-11-21", stock_on_hand: 80, reorder_point: 30, quantity_sold: 15, warehouse_name: "Dhaka Central", supplier_name: "Apex Supply" },
    { sku_id: "SKU-10", snapshot_date: "2026-11-22", stock_on_hand: 12, reorder_point: 30, quantity_sold: 40, warehouse_name: "Dhaka Central", supplier_name: "Apex Supply" }
  ];
  const tableProfile = profileRowsSnapshot({
    name: "warehouse_stock",
    columns: [
      { name: "sku_id", dataType: "text" },
      { name: "snapshot_date", dataType: "date" },
      { name: "stock_on_hand", dataType: "integer" },
      { name: "reorder_point", dataType: "integer" },
      { name: "quantity_sold", dataType: "integer" },
      { name: "warehouse_name", dataType: "text" },
      { name: "supplier_name", dataType: "text" }
    ]
  }, inventoryRows);

  const unified = runUnifiedDailyAnalysisFromRows(tableProfile, inventoryRows, {
    domainId: "inventory_supply_chain",
    periodStart: "2026-11-22",
    periodEnd: "2026-11-22",
    comparisonPreset: "previous_day"
  });

  // Render DomainDatasetBar
  const barHtml = renderToStaticMarkup(React.createElement(DomainDatasetBar, {
    selectedDomain: "inventory_supply_chain",
    selectedDataset: "warehouse_stock",
    profile: null,
    availableTables: [tableProfile],
    understanding: null,
    columnOverrides: {},
    loadingProfile: false,
    loadingAnalysis: false,
    onDomainChange: () => undefined,
    onDatasetChange: () => undefined,
    onOverrideChange: () => undefined,
    onClearOverrides: () => undefined,
    onApplyOverrides: () => undefined,
    onRefreshAll: () => undefined
  }));
  assert.match(barHtml, /Inventory &amp; Supply Chain/);
  assert.match(barHtml, /warehouse_stock/);
  assert.match(barHtml, /Column Understanding/);

  // Render DailyReportPanel
  const fallback = new VercelHobbyCronFallbackProvider();
  const dailyHtml = renderToStaticMarkup(React.createElement(DailyReportPanel, {
    settings: { ...getDefaultDailySettings("org_1"), selectedDataset: "warehouse_stock", autoReportEnabled: true },
    selectedDataset: "warehouse_stock",
    storageStatus: mockUnconfiguredStorage,
    scheduleSummary: {
      active: false,
      persisted: true,
      providerStatus: fallback.getProviderStatus(mockUnconfiguredStorage),
      nextExecution: computeNextScheduledExecution(
        { autoReportEnabled: true, frequency: "daily", scheduledTime: "00:15", timezone: "Asia/Dhaka" },
        null,
        new Date("2026-11-23T02:00:00Z")
      ),
      latestAutomaticReport: null,
      lastSync: null
    },
    loadingSettings: false,
    savingSchedule: false,
    downloadingReportId: null,
    saveFeedback: null,
    onSaveSchedule: async () => undefined,
    onDownloadPdf: async () => undefined
  }));
  assert.match(dailyHtml, /Daily Report Automation/);
  assert.match(dailyHtml, /The report will contain the previous completed day&#x27;s data\./);
  assert.match(dailyHtml, /Asia\/Dhaka/);
  assert.match(dailyHtml, /Storage not configured/);

  // Render ManualReportPanel
  const manualHtml = renderToStaticMarkup(React.createElement(ManualReportPanel, {
    selectedDomain: "inventory_supply_chain",
    selectedDataset: "warehouse_stock",
    timezone: "Asia/Dhaka",
    earliestAvailableDate: "2026-11-21",
    latestAvailableDate: "2026-11-22",
    generating: false,
    downloadingReportId: null,
    error: null,
    generatedReport: null,
    onGenerateManualReport: async () => undefined,
    onDownloadPdf: async () => undefined
  }));
  assert.match(manualHtml, /Manual Report Generation/);
  assert.match(manualHtml, /Last 7 Days/);
  assert.match(manualHtml, /All Available History/);
  assert.match(manualHtml, /Generate Report/);

  // Render DailyToolsSection with real backend Inventory intelligence
  const toolsHtml = renderToStaticMarkup(React.createElement(DailyToolsSection, {
    intelligence: unified,
    loadingIntelligence: false,
    intelligenceError: null,
    comparisonPreset: "previous_day",
    onComparisonPresetChange: () => undefined,
    alerts: unified.tools.alerts,
    alertRules: DEFAULT_ALERT_RULES,
    savingAlertRules: false,
    onToggleAlertRead: () => undefined,
    onMarkAllAlertsRead: () => undefined,
    onSaveAlertRules: async () => undefined,
    archivedReports: [],
    loadingArchive: false,
    archiveComparison: null,
    comparingArchive: false,
    archiveCompareError: null,
    downloadingReportId: null,
    timezone: "Asia/Dhaka",
    onCompareArchivedReports: async () => undefined,
    onDownloadReportPdf: async () => undefined
  }));
  assert.match(toolsHtml, /Intelligence Brief/);
  assert.match(toolsHtml, /Smart Comparison/);
  assert.match(toolsHtml, /Root Cause/);
  assert.match(toolsHtml, /Recommendations/);
  assert.match(toolsHtml, /Data Health/);
  assert.match(toolsHtml, /Archive &amp; Compare/);
  assert.match(toolsHtml, /Inventory &amp; Supply Chain/);
  assert.equal(getAmbiguousColumnMatches(null).length, 0);
});

test("Settings persistence + Manual Report generation + Private PDF validation work end-to-end", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "querypilot-stage6-"));
  const db = new Database(path.join(dir, "app.sqlite"));
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of readdirSync(migrationDir).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    db.exec(readFileSync(path.join(migrationDir, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(Number(name.split("_", 1)[0]), name);
  }
  const repository = new SqliteReportRepository(db);
  const pdfStorage = new LocalPrivatePdfStorage(path.join(dir, "private-pdfs"));

  try {
    const merged = validateAndMergeSettings(
      "org_stage6",
      {
        selectedDomain: "marketing_campaigns",
        selectedDataset: "campaigns",
        autoReportEnabled: true,
        frequency: "weekly",
        scheduledTime: "06:45",
        timezone: "Asia/Dhaka"
      },
      getDefaultDailySettings("org_stage6")
    );
    const savedSettings = await repository.saveSettings(merged);
    assert.equal(savedSettings.frequency, "weekly");
    assert.equal(savedSettings.scheduledTime, "06:45");
    assert.equal(savedSettings.selectedDomain, "marketing_campaigns");

    const mockExecutor: ReadOnlyQueryExecutor = async (sql: string) => {
      if (sql.includes("FROM information_schema.columns")) {
        return [
          { table_schema: "public", table_name: "campaigns", table_type: "BASE TABLE", column_name: "campaign_id", data_type: "text", udt_name: "text", is_nullable: "NO" },
          { table_schema: "public", table_name: "campaigns", table_type: "BASE TABLE", column_name: "campaign_date", data_type: "date", udt_name: "date", is_nullable: "NO" },
          { table_schema: "public", table_name: "campaigns", table_type: "BASE TABLE", column_name: "ad_spend", data_type: "numeric", udt_name: "numeric", is_nullable: "NO" },
          { table_schema: "public", table_name: "campaigns", table_type: "BASE TABLE", column_name: "clicks", data_type: "integer", udt_name: "int4", is_nullable: "NO" },
          { table_schema: "public", table_name: "campaigns", table_type: "BASE TABLE", column_name: "impressions", data_type: "integer", udt_name: "int4", is_nullable: "NO" },
          { table_schema: "public", table_name: "campaigns", table_type: "BASE TABLE", column_name: "conversions", data_type: "integer", udt_name: "int4", is_nullable: "NO" }
        ];
      }
      if (sql.includes("FROM information_schema.table_constraints")) {
        return [{ table_schema: "public", table_name: "campaigns", constraint_name: "campaigns_pkey", constraint_type: "PRIMARY KEY", column_name: "campaign_id" }];
      }
      if (sql.includes("SELECT COUNT(*) AS row_count") && !sql.includes("WHERE")) return [{ row_count: 2 }];
      if (sql.includes("c0_non_null")) {
        return [{ c0_non_null: 2, c0_distinct: 2, c1_non_null: 2, c1_distinct: 2, c1_min: "2026-11-15", c1_max: "2026-11-22", c2_non_null: 2, c2_distinct: 2, c2_min: 100, c2_max: 250, c2_avg: 175, c2_neg: 0, c2_zero: 0, c2_int_only: true, c3_non_null: 2, c3_distinct: 2, c3_min: 50, c3_max: 120, c3_avg: 85, c3_neg: 0, c3_zero: 0, c3_int_only: true, c4_non_null: 2, c4_distinct: 2, c4_min: 1000, c4_max: 2500, c4_avg: 1750, c4_neg: 0, c4_zero: 0, c4_int_only: true, c5_non_null: 2, c5_distinct: 2, c5_min: 5, c5_max: 12, c5_avg: 8.5, c5_neg: 0, c5_zero: 0, c5_int_only: true }];
      }
      if (sql.includes("AS dup_check")) return [{ duplicate_groups: 0, duplicate_rows: 0 }];
      if (sql.includes("SELECT COUNT(*) AS row_count") && sql.includes("WHERE")) return [{ row_count: 2 }];
      if (sql.includes("ORDER BY \"campaign_date\" ASC LIMIT")) {
        return [
          { campaign_id: "C1", campaign_date: "2026-11-15", ad_spend: 100, clicks: 50, impressions: 1000, conversions: 5 },
          { campaign_id: "C2", campaign_date: "2026-11-22", ad_spend: 250, clicks: 120, impressions: 2500, conversions: 12 }
        ];
      }
      return [];
    };

    const manual = await generateAndPersistManualReport({
      organizationId: "org_stage6",
      executor: mockExecutor,
      repository,
      pdfStorage,
      tableName: "campaigns",
      domainId: "marketing_campaigns",
      quickRange: "all_history",
      earliestAvailableDate: "2026-11-15",
      latestAvailableDate: "2026-11-22",
      now: new Date("2026-11-23T04:00:00Z")
    });

    assert.equal(manual.record.domainId, "marketing_campaigns");
    assert.equal(manual.record.periodStart, "2026-11-15");
    assert.equal(manual.record.periodEnd, "2026-11-22");
    assert.equal(manual.record.pdfStatus, "generated");
    assert.match(manual.downloadUrl, /^\/api\/daily-analysis\/reports\/.+\/pdf$/);

    const pdfBytes = await pdfStorage.readPdf(manual.record.pdfStorageKey!);
    assert.ok(pdfBytes);
    assertValidPdfBuffer(pdfBytes);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
