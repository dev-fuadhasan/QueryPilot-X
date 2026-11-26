import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { verifySchedulerSecret } from "../api-helpers";
import {
  isCompositeColumnName,
  isDateLikeColumnName,
  parseReliableDateString,
  profileDatabaseWithExecutor,
  profileRowsSnapshot,
  understandTableForDomain,
  type ReadOnlyQueryExecutor
} from "../profiler";
import { runDynamicAnalysisFromRows, type MetricResult } from "../metrics";
import { runUnifiedDailyAnalysisFromRows } from "../intelligence";
import { renderDynamicAnalysisPdf } from "../pdf/report-pdf";
import {
  assertValidPdfBuffer,
  buildPrivatePdfStorageKey,
  getStorageCapabilityStatus,
  inspectSchedulerOrgDbMap,
  type PersistentReportRecord,
  type StorageCapabilityStatus
} from "../storage";
import { DEFAULT_REPORT_HISTORY_FILTERS } from "../components/dashboard-helpers";

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

function metricById(metrics: MetricResult[], id: string): MetricResult {
  const found = metrics.find(m => m.metricId === id);
  assert.ok(found, `Expected metric "${id}" to exist`);
  return found;
}

test("Priority Fix A: reliable text-based date detection handles ISO, timestamps, invalid, mixed, ambiguous, and empty values", async () => {
  // Parser unit checks
  assert.equal(parseReliableDateString("2026-11-21").status, "valid");
  assert.equal(parseReliableDateString("2026-11-21T14:30:00Z").status, "valid");
  assert.equal(parseReliableDateString("2026/11/21").status, "valid");
  assert.equal(parseReliableDateString("15 Jan 2026").status, "valid");
  assert.equal(parseReliableDateString("Jan 15, 2026").status, "valid");
  // Invalid calendar dates MUST be rejected
  assert.equal(parseReliableDateString("2026-02-30").status, "invalid");
  assert.equal(parseReliableDateString("2026-13-01").status, "invalid");
  assert.equal(parseReliableDateString("not-a-date").status, "invalid");
  // Ambiguous DD/MM/YYYY vs MM/DD/YYYY MUST NOT be silently guessed
  assert.equal(parseReliableDateString("03/04/2026").status, "ambiguous");
  assert.equal(parseReliableDateString("12-05-2026").status, "ambiguous");

  // Column-name safety
  assert.equal(isDateLikeColumnName("Sale_Date"), true);
  assert.equal(isDateLikeColumnName("Date"), true);
  assert.equal(isDateLikeColumnName("Product_Category"), false);
  assert.equal(isDateLikeColumnName("Sales_Rep"), false);
  assert.equal(isDateLikeColumnName("date_of_birth"), false); // sensitive PII skipped

  // Ambiguous slash-date column does NOT invent earliest/latest dates
  const ambProfile = profileRowsSnapshot({
    name: "ambiguous_dates",
    columns: [
      { name: "Sale_Date", dataType: "text" },
      { name: "Sales_Amount", dataType: "numeric" }
    ]
  }, [
    { Sale_Date: "03/04/2026", Sales_Amount: 100 },
    { Sale_Date: "05/06/2026", Sales_Amount: 200 }
  ]);
  assert.equal(ambProfile.freshness.earliestDate, null);
  assert.equal(ambProfile.freshness.latestDate, null);
  assert.equal(ambProfile.columns[0].temporalStats?.ambiguousDateCount, 2);

  // Mixed valid + invalid ISO dates compute range from valid values and track invalid count
  const mixedProfile = profileRowsSnapshot({
    name: "mixed_dates",
    columns: [
      { name: "Sale_Date", dataType: "text" },
      { name: "Notes", dataType: "text" }
    ]
  }, [
    { Sale_Date: "2026-11-01", Notes: "ok" },
    { Sale_Date: "2026-11-10T09:15:00Z", Notes: "ok" },
    { Sale_Date: "2026-11-20", Notes: "ok" },
    { Sale_Date: "2026-02-30", Notes: "bad date" }
  ]);
  assert.equal(mixedProfile.freshness.earliestDate?.slice(0, 10), "2026-11-01");
  assert.equal(mixedProfile.freshness.latestDate?.slice(0, 10), "2026-11-20");
  assert.equal(mixedProfile.columns[0].category, "temporal");
  assert.equal(mixedProfile.columns[0].temporalStats?.invalidDateCount, 1);
  assert.equal(mixedProfile.columns[1].category, "categorical"); // Notes NOT promoted to date

  // Empty text date column stays empty with null range
  const emptyProfile = profileRowsSnapshot({
    name: "empty_dates",
    columns: [{ name: "Sale_Date", dataType: "text" }]
  }, [{ Sale_Date: null }, { Sale_Date: "" }]);
  assert.equal(emptyProfile.freshness.earliestDate, null);
  assert.equal(emptyProfile.freshness.latestDate, null);

  // Database executor profiling detects text `Sale_Date` without SELECT *
  const executedSql: string[] = [];
  const executor: ReadOnlyQueryExecutor = async (sql: string) => {
    executedSql.push(sql);
    if (sql.includes("FROM information_schema.columns")) {
      return [
        { table_schema: "public", table_name: "data_set_2", table_type: "BASE TABLE", column_name: "Sale_Date", data_type: "text", udt_name: "text", is_nullable: "NO" },
        { table_schema: "public", table_name: "data_set_2", table_type: "BASE TABLE", column_name: "Sales_Amount", data_type: "numeric", udt_name: "numeric", is_nullable: "NO" }
      ];
    }
    if (sql.includes("FROM information_schema.table_constraints")) return [];
    if (sql.includes("SELECT COUNT(*) AS row_count")) return [{ row_count: 1000 }];
    if (sql.includes("c0_non_null")) {
      return [{ c0_non_null: 1000, c0_distinct: 365, c1_non_null: 1000, c1_distinct: 950, c1_min: 10, c1_max: 5000, c1_avg: 800, c1_neg: 0, c1_zero: 0, c1_int_only: false }];
    }
    if (sql.includes("AS iso_count")) {
      return [{ non_empty_count: 1000, iso_count: 1000, ymd_slash_count: 0, ambiguous_count: 0, iso_min: "2023-01-01", iso_max: "2023-12-31", ymd_min: null, ymd_max: null }];
    }
    return [];
  };

  const dbProfile = await profileDatabaseWithExecutor(executor, { selectedDomain: "sales_ecommerce", tableNames: ["data_set_2"] });
  assert.ok(executedSql.every(sql => !/SELECT\s+\*/i.test(sql)), "Profiler must never execute SELECT *");
  const t = dbProfile.tables[0];
  assert.equal(t.freshness.primaryDateColumn, "Sale_Date");
  assert.equal(t.freshness.earliestDate?.slice(0, 10), "2023-01-01");
  assert.equal(t.freshness.latestDate?.slice(0, 10), "2023-12-31");
  assert.ok(t.dateColumns.includes("Sale_Date"));
});

test("Priority Fixes B & C: data_set_2 (1,000-row fixture) maps semantics accurately and computes independent Sales metrics without orderId", async () => {
  assert.equal(isCompositeColumnName("Region_and_Sales_Rep"), true);
  assert.equal(isCompositeColumnName("Region"), false);

  const regions = ["North", "South", "East", "West"];
  const reps = ["Alice", "Bob", "Charlie", "Diana", "Eve"];
  const categories = ["Electronics", "Clothing", "Food", "Furniture"];
  const channels = ["Online", "Retail"];
  const customerTypes = ["New", "Returning"];

  // Build deterministic 1,000-row fixture matching data_set_2 schema
  const rows: Array<Record<string, unknown>> = [];
  let expectedRevenue = 0;
  let expectedUnits = 0;
  let expectedDiscounts = 0;
  let expectedProfit = 0;

  for (let i = 0; i < 1000; i += 1) {
    const dayOffset = i % 30; // 2026-10-25 .. 2026-11-23
    const dt = new Date(Date.UTC(2026, 9, 25 + dayOffset)).toISOString().slice(0, 10);
    const qty = (i % 5) + 1;
    const unitPrice = 50 + (i % 10) * 10;
    const unitCost = 30 + (i % 5) * 5;
    const discount = (i % 4) * 5;
    const salesAmount = qty * unitPrice - discount;
    const reg = regions[i % regions.length];
    const rep = reps[i % reps.length];

    expectedRevenue += salesAmount;
    expectedUnits += qty;
    expectedDiscounts += discount;
    expectedProfit += salesAmount - unitCost * qty;

    rows.push({
      Sale_Date: dt,
      Sales_Rep: rep,
      Region: reg,
      Sales_Amount: salesAmount,
      Quantity_Sold: qty,
      Product_Category: categories[i % categories.length],
      Unit_Cost: unitCost,
      Unit_Price: unitPrice,
      Customer_Type: customerTypes[i % customerTypes.length],
      Discount: discount,
      Sales_Channel: channels[i % channels.length],
      Region_and_Sales_Rep: `${reg}-${rep}`
    });
  }

  const profile = profileRowsSnapshot({
    name: "data_set_2",
    columns: [
      { name: "Sale_Date", dataType: "text" },
      { name: "Sales_Rep", dataType: "text" },
      { name: "Region", dataType: "text" },
      { name: "Sales_Amount", dataType: "numeric" },
      { name: "Quantity_Sold", dataType: "integer" },
      { name: "Product_Category", dataType: "text" },
      { name: "Unit_Cost", dataType: "numeric" },
      { name: "Unit_Price", dataType: "numeric" },
      { name: "Customer_Type", dataType: "text" },
      { name: "Discount", dataType: "numeric" },
      { name: "Sales_Channel", dataType: "text" },
      { name: "Region_and_Sales_Rep", dataType: "text" }
    ]
  }, rows);

  // Text date range detected reliably
  assert.equal(profile.rowCount, 1000);
  assert.equal(profile.freshness.primaryDateColumn, "Sale_Date");
  assert.equal(profile.freshness.earliestDate?.slice(0, 10), "2026-10-25");
  assert.equal(profile.freshness.latestDate?.slice(0, 10), "2026-11-23");

  // Semantic mapping verification (Priority Fix C)
  const understanding = understandTableForDomain(profile, "sales_ecommerce", { isSelectedDomain: true });
  assert.equal(understanding.roleAssignments.transactionDate?.columnName, "Sale_Date");
  assert.equal(understanding.roleAssignments.transactionDate?.confidence, "high");
  assert.equal(understanding.roleAssignments.revenue?.columnName, "Sales_Amount");
  assert.equal(understanding.roleAssignments.revenue?.confidence, "high");
  assert.equal(understanding.roleAssignments.unitPrice?.columnName, "Unit_Price");
  assert.equal(understanding.roleAssignments.quantity?.columnName, "Quantity_Sold");
  assert.equal(understanding.roleAssignments.cost?.columnName, "Unit_Cost");
  assert.equal(understanding.roleAssignments.discount?.columnName, "Discount");
  assert.equal(understanding.roleAssignments.category?.columnName, "Product_Category");
  assert.equal(understanding.roleAssignments.region?.columnName, "Region");
  assert.equal(understanding.roleAssignments.channel?.columnName, "Sales_Channel");

  // Questionable live candidates MUST NOT be assigned
  assert.equal(understanding.roleAssignments.orderId, undefined, "Sales_Rep must NOT map to orderId");
  assert.equal(understanding.roleAssignments.customerId, undefined, "Customer_Type must NOT map to customerId");
  const salesRepMatch = understanding.columnMatches.find(m => m.columnName === "Sales_Rep");
  const custTypeMatch = understanding.columnMatches.find(m => m.columnName === "Customer_Type");
  const compositeMatch = understanding.columnMatches.find(m => m.columnName === "Region_and_Sales_Rep");
  assert.equal(salesRepMatch?.assignedRole, null);
  assert.equal(custTypeMatch?.assignedRole, null);
  assert.equal(compositeMatch?.assignedRole, null);
  assert.notEqual(understanding.roleAssignments.region?.columnName, "Region_and_Sales_Rep");

  // Metrics verification (Priority Fix B)
  const unified = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-10-25",
    periodEnd: "2026-11-23",
    comparisonPreset: "none"
  });
  const metrics = unified.analysis.metrics;

  // Independent metrics MUST succeed accurately without orderId
  assert.equal(metricById(metrics, "totalRevenue").availability, "available");
  assert.equal(metricById(metrics, "totalRevenue").value, expectedRevenue);
  assert.equal(metricById(metrics, "unitsSold").availability, "available");
  assert.equal(metricById(metrics, "unitsSold").value, expectedUnits);
  assert.equal(metricById(metrics, "totalDiscounts").availability, "available");
  assert.equal(metricById(metrics, "totalDiscounts").value, expectedDiscounts);
  assert.equal(metricById(metrics, "grossProfit").availability, "available");
  assert.equal(metricById(metrics, "grossProfit").value, expectedProfit);
  assert.equal(metricById(metrics, "grossProfitMargin").availability, "available");
  assert.equal(metricById(metrics, "averageSellingPrice").availability, "available");

  // Order-dependent & customer-dependent metrics MUST remain unavailable (NEVER fabricated zeros)
  for (const depId of ["totalOrders", "averageOrderValue", "cancellationRate", "returnRate", "repeatCustomerRate", "customerLifetimeValueEstimate"]) {
    const m = metricById(metrics, depId);
    assert.equal(m.availability, "unavailable", `${depId} must remain unavailable without orderId/customerId`);
    assert.equal(m.value, null);
  }

  // Stage 5 Dynamic PDF renders cleanly for data_set_2
  const pdfBuffer = await renderDynamicAnalysisPdf({
    metadata: {
      reportId: "rep-ds2",
      organizationLabel: "Practice Org",
      domainId: "sales_ecommerce",
      domainName: "Sales & E-commerce",
      datasetTable: "data_set_2",
      generationType: "manual",
      frequency: "manual",
      periodStart: "2026-10-25",
      periodEnd: "2026-11-23",
      periodLabel: "2026-10-25 to 2026-11-23",
      comparisonStart: null,
      comparisonEnd: null,
      comparisonLabel: null,
      timezone: "Asia/Dhaka",
      generatedAt: unified.generatedAt
    },
    unified
  });
  assertValidPdfBuffer(pdfBuffer);
});

test("Priority Fix B: sales_data (20-row fixture) handles UnitPrice properly, never assumes UnitPrice alone = total revenue, and prevents order-total double-counting", () => {
  // 1. sales_data (20 rows: Date, Product, Quantity, UnitPrice)
  const salesDataRows = Array.from({ length: 20 }, (_, i) => ({
    Date: `2026-11-${String((i % 20) + 1).padStart(2, "0")}`,
    Product: i % 2 === 0 ? "Laptop" : "Mouse",
    Quantity: (i % 3) + 1,
    UnitPrice: i % 2 === 0 ? 500 : 25
  }));
  const expectedLineRev = salesDataRows.reduce((acc, r) => acc + r.Quantity * r.UnitPrice, 0);
  const expectedQty = salesDataRows.reduce((acc, r) => acc + r.Quantity, 0);

  const salesDataProfile = profileRowsSnapshot({
    name: "sales_data",
    columns: [
      { name: "Date", dataType: "text" },
      { name: "Product", dataType: "text" },
      { name: "Quantity", dataType: "integer" },
      { name: "UnitPrice", dataType: "numeric" }
    ]
  }, salesDataRows);

  assert.equal(salesDataProfile.freshness.earliestDate?.slice(0, 10), "2026-11-01");
  assert.equal(salesDataProfile.freshness.latestDate?.slice(0, 10), "2026-11-20");

  const understanding = understandTableForDomain(salesDataProfile, "sales_ecommerce", { isSelectedDomain: true });
  assert.equal(understanding.roleAssignments.unitPrice?.columnName, "UnitPrice");
  assert.equal(understanding.roleAssignments.revenue, undefined, "UnitPrice must map to unitPrice, not directly to revenue");
  assert.equal(understanding.roleAssignments.quantity?.columnName, "Quantity");
  assert.equal(understanding.roleAssignments.product?.columnName, "Product");

  const res = runDynamicAnalysisFromRows(salesDataProfile, salesDataRows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-20",
    comparisonPreset: "none"
  });
  assert.equal(metricById(res.metrics, "unitsSold").value, expectedQty);
  assert.equal(metricById(res.metrics, "totalRevenue").value, expectedLineRev);
  assert.ok(metricById(res.metrics, "totalRevenue").warnings.some(w => /Unit Price/i.test(w)));
  assert.equal(metricById(res.metrics, "grossProfit").availability, "unavailable");
  assert.equal(metricById(res.metrics, "totalOrders").availability, "unavailable");
  assert.equal(metricById(res.metrics, "repeatCustomerRate").availability, "unavailable");

  // 2. UnitPrice WITHOUT Quantity MUST NOT assume UnitPrice means total revenue!
  const priceOnlyProfile = profileRowsSnapshot({
    name: "catalog_prices",
    columns: [
      { name: "Date", dataType: "date" },
      { name: "UnitPrice", dataType: "numeric" }
    ]
  }, [{ Date: "2026-11-20", UnitPrice: 100 }]);
  const priceOnlyRes = runDynamicAnalysisFromRows(priceOnlyProfile, [{ Date: "2026-11-20", UnitPrice: 100 }], {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-20",
    periodEnd: "2026-11-20",
    comparisonPreset: "none"
  });
  assert.equal(metricById(priceOnlyRes.metrics, "totalRevenue").availability, "unavailable");
  assert.equal(metricById(priceOnlyRes.metrics, "totalRevenue").value, null);

  // 3. Repeated order_total across multi-line order must NOT double-count revenue
  const multiLineRows = [
    { order_id: "ORD-1", order_date: "2026-11-20", product_name: "Item A", order_total: 500, quantity: 1 },
    { order_id: "ORD-1", order_date: "2026-11-20", product_name: "Item B", order_total: 500, quantity: 2 }
  ];
  const multiLineProfile = profileRowsSnapshot({
    name: "order_lines",
    columns: [
      { name: "order_id", dataType: "text" },
      { name: "order_date", dataType: "date" },
      { name: "product_name", dataType: "text" },
      { name: "order_total", dataType: "numeric" },
      { name: "quantity", dataType: "integer" }
    ]
  }, multiLineRows);
  const multiLineRes = runDynamicAnalysisFromRows(multiLineProfile, multiLineRows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-20",
    periodEnd: "2026-11-20",
    comparisonPreset: "none"
  });
  assert.equal(metricById(multiLineRes.metrics, "totalOrders").value, 1);
  assert.equal(metricById(multiLineRes.metrics, "totalRevenue").value, 500, "Repeated order_total across lines of same order must not double-count");
  assert.equal(metricById(multiLineRes.metrics, "unitsSold").value, 3);
});

test("Priority Fix D: scheduler production readiness validates QUERYPILOT_SCHEDULER_ORG_DB_MAP & cron authentication safely", () => {
  // Missing map
  assert.equal(inspectSchedulerOrgDbMap(undefined, "org_a").status, "missing");
  // Invalid JSON
  assert.equal(inspectSchedulerOrgDbMap("{bad json", "org_a").status, "invalid_json");
  assert.equal(inspectSchedulerOrgDbMap("[]", "org_a").status, "invalid_json");
  // Invalid URI (must never leak credentials in diagnostic error)
  const secretUri = "mysql://secret_user:top_secret_pw@db.example.com/prod";
  const badUriCheck = inspectSchedulerOrgDbMap(JSON.stringify({ org_a: secretUri }), "org_a");
  assert.equal(badUriCheck.status, "invalid_uri");
  assert.ok(!(badUriCheck.error || "").includes("top_secret_pw"), "Error must never expose credentials");
  // Missing organization mapping
  const unmapped = inspectSchedulerOrgDbMap(JSON.stringify({ org_b: "postgresql://ro:pass@db.example.com:5432/app" }), "org_a");
  assert.equal(unmapped.status, "org_not_mapped");
  assert.equal(unmapped.organizationMapped, false);
  // Valid mapping
  const valid = inspectSchedulerOrgDbMap(JSON.stringify({ org_a: "postgresql://ro:pass@db.example.com:5432/app" }), "org_a");
  assert.equal(valid.status, "valid");
  assert.equal(valid.organizationMapped, true);

  // Save/restore env vars around getStorageCapabilityStatus check
  const envKeys = [
    "QUERYPILOT_APP_DATABASE_URL",
    "DATABASE_URL",
    "QUERYPILOT_STORAGE_SUPABASE_URL",
    "QUERYPILOT_CORE_SUPABASE_URL",
    "QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "QUERYPILOT_CORE_SUPABASE_ANON_KEY",
    "QUERYPILOT_STORAGE_BUCKET",
    "CRON_SECRET",
    "QUERYPILOT_SCHEDULER_ORG_DB_MAP"
  ] as const;
  const backup: Record<string, string | undefined> = {};
  for (const k of envKeys) backup[k] = process.env[k];

  try {
    for (const k of envKeys) delete process.env[k];
    const allMissing = getStorageCapabilityStatus("org_a");
    assert.equal(allMissing.databaseProductionReady, false);
    assert.equal(allMissing.pdfProductionReady, false);
    assert.equal(allMissing.schedulerProductionReady, false);
    assert.ok(allMissing.missingProductionConfig.includes("QUERYPILOT_SCHEDULER_ORG_DB_MAP"));
    assert.equal(allMissing.missingProductionConfig.length, 6);

    // Main branch shared env setup (DATABASE_URL + QUERYPILOT_STORAGE_*) enables DB + PDF cloud storage
    process.env.DATABASE_URL = "postgresql://shared:pw@db.example.com:6543/postgres";
    process.env.QUERYPILOT_STORAGE_SUPABASE_URL = "https://storage.example.supabase.co";
    process.env.QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.QUERYPILOT_STORAGE_BUCKET = "querypilotx-storage";
    const sharedEnvStatus = getStorageCapabilityStatus("org_a");
    assert.equal(sharedEnvStatus.databaseProductionReady, true);
    assert.equal(sharedEnvStatus.pdfProductionReady, true);
    assert.equal(sharedEnvStatus.pdfBackend, "supabase_private_storage");

    // Shared user-isolated storage key matches src/lib/storage/validation.ts pattern ({userId}/reports/{prefix}-{filename})
    const sharedKey = buildPrivatePdfStorageKey("org_a", "12345678-abcd-efgh", "daily-report.pdf", "usr_abc12345");
    assert.equal(sharedKey, "usr_abc12345/reports/12345678-daily-report.pdf");
    delete process.env.DATABASE_URL;

    // DB + PDF + CRON set, but ORG_DB_MAP still missing => DB & PDF ready, Scheduler NOT ready!
    process.env.QUERYPILOT_APP_DATABASE_URL = "postgresql://app:pw@db.example.com:5432/qp";
    process.env.CRON_SECRET = "cron-test-secret";
    const missingMap = getStorageCapabilityStatus("org_a");
    assert.equal(missingMap.databaseProductionReady, true);
    assert.equal(missingMap.pdfProductionReady, true);
    assert.equal(missingMap.schedulerProductionReady, false);
    assert.deepEqual(missingMap.missingProductionConfig, ["QUERYPILOT_SCHEDULER_ORG_DB_MAP"]);

    // Unauthorized cron request rejected (401)
    const unauthReq = new NextRequest("http://localhost/api/daily-analysis/scheduler/run", {
      headers: { authorization: "Bearer wrong-secret" }
    });
    const unauthCheck = verifySchedulerSecret(unauthReq);
    assert.equal(unauthCheck.ok, false);
    if (!unauthCheck.ok) assert.equal(unauthCheck.response.status, 401);

    // Valid cron request authorized
    const authReq = new NextRequest("http://localhost/api/daily-analysis/scheduler/run", {
      headers: { authorization: "Bearer cron-test-secret" }
    });
    assert.equal(verifySchedulerSecret(authReq).ok, true);

    // Add valid ORG_DB_MAP for org_a => schedulerProductionReady becomes true for org_a, false for org_other
    process.env.QUERYPILOT_SCHEDULER_ORG_DB_MAP = JSON.stringify({ org_a: "postgresql://ro:pw@org-a.example.com:5432/db" });
    assert.equal(getStorageCapabilityStatus("org_a").schedulerProductionReady, true);
    assert.equal(getStorageCapabilityStatus("org_other").schedulerProductionReady, false);
  } finally {
    for (const k of envKeys) {
      if (backup[k] === undefined) delete process.env[k];
      else process.env[k] = backup[k];
    }
  }
});

test("Priority Fix E: Report History distinguishes all 4 storage states and Manual Report hides fake PDF downloads when storage fails", async () => {
  const [{ default: ReportHistoryPanel }, { default: ManualReportPanel }] = await Promise.all([
    import("../components/ReportHistoryPanel"),
    import("../components/ManualReportPanel")
  ]);

  const unconfiguredStatus: StorageCapabilityStatus = {
    databaseBackend: "sqlite",
    databaseProductionReady: false,
    pdfBackend: "unconfigured",
    pdfProductionReady: false,
    schedulerSecretConfigured: false,
    schedulerOrgDbMapConfigured: false,
    schedulerOrgDbMapStatus: "missing",
    schedulerOrgMappedForCurrentOrg: false,
    schedulerOrgDbMapError: "QUERYPILOT_SCHEDULER_ORG_DB_MAP missing",
    schedulerProductionReady: false,
    missingProductionConfig: ["QUERYPILOT_APP_DATABASE_URL", "QUERYPILOT_STORAGE_BUCKET"]
  };

  const renderHistoryState = (state: "storage_unavailable" | "empty_no_reports" | "empty_filtered" | "error", error: string | null = null) =>
    renderToStaticMarkup(React.createElement(ReportHistoryPanel, {
      reports: [],
      pagination: { total: 0, page: 1, pageSize: 10, totalPages: 1, appliedStartDate: null, appliedEndDate: null },
      filters: DEFAULT_REPORT_HISTORY_FILTERS,
      loading: false,
      storageState: state,
      storageStatus: unconfiguredStatus,
      error,
      warning: null,
      timezone: "Asia/Dhaka",
      downloadingReportId: null,
      comparison: null,
      comparing: false,
      compareError: null,
      inspectedReport: null,
      loadingInspect: false,
      onFiltersChange: () => undefined,
      onRefresh: () => undefined,
      onInspectReport: async () => undefined,
      onCloseInspect: () => undefined,
      onCompareReports: async () => undefined,
      onClearComparison: () => undefined,
      onDownloadPdf: async () => undefined
    }));

  // 1. Storage unavailable
  const htmlUnavail = renderHistoryState("storage_unavailable", "The local SQLite database is available only in development mode.");
  assert.match(htmlUnavail, /Persistent Report Storage Is Not Configured/);
  assert.match(htmlUnavail, /QUERYPILOT_APP_DATABASE_URL/);

  // 2. Storage available, no reports generated yet
  const htmlNoReports = renderHistoryState("empty_no_reports");
  assert.match(htmlNoReports, /No reports have been generated yet/);

  // 3. Reports exist, filters match none
  const htmlFiltered = renderHistoryState("empty_filtered");
  assert.match(htmlFiltered, /No reports match your active filters/);
  assert.match(htmlFiltered, /Reset All Filters/);

  // 4. Retrieval error
  const htmlErr = renderHistoryState("error", "Database connection refused");
  assert.match(htmlErr, /Failed to Retrieve Report History/);
  assert.match(htmlErr, /Database connection refused/);

  // ManualReportPanel with failed PDF storage MUST NOT show fake Download PDF button or green success banner
  const failedPdfRecord: PersistentReportRecord = {
    id: "rep-nopdf",
    organizationId: "org_1",
    ownerRef: "u1",
    domainId: "sales_ecommerce",
    domainName: "Sales & E-commerce",
    datasetTable: "data_set_2",
    reportingDate: "2026-11-23",
    periodStart: "2026-10-25",
    periodEnd: "2026-11-23",
    comparisonStart: null,
    comparisonEnd: null,
    comparisonPreset: null,
    frequency: "manual",
    generationType: "manual",
    executionKey: null,
    status: "generated",
    summaryText: "Manual report summary",
    reportPayload: {},
    pdfStatus: "failed",
    pdfStorageKey: null,
    pdfFilename: null,
    pdfGeneratedAt: null,
    pdfSizeBytes: null,
    pdfError: "Permanent private PDF storage is not configured for production.",
    errorMessage: null,
    generatedAt: "2026-11-24T04:00:00Z",
    createdAt: "2026-11-24T04:00:00Z"
  };

  const manualHtml = renderToStaticMarkup(React.createElement(ManualReportPanel, {
    selectedDomain: "sales_ecommerce",
    selectedDataset: "data_set_2",
    timezone: "Asia/Dhaka",
    earliestAvailableDate: "2026-10-25",
    latestAvailableDate: "2026-11-23",
    generating: false,
    downloadingReportId: null,
    error: null,
    generatedReport: failedPdfRecord,
    onGenerateManualReport: async () => undefined,
    onDownloadPdf: async () => undefined
  }));
  assert.doesNotMatch(manualHtml, /Download PDF/);
  assert.match(manualHtml, /PDF download unavailable/);
  assert.match(manualHtml, /PDF Storage Error/);
});

test("Direct dataset-column mode runs all 7 tools on arbitrary custom columns without any column mapping", () => {
  const rows = [
    { recorded_at: "2026-11-21", zone: "North", temperature_c: 24.5, power_watts: 420 },
    { recorded_at: "2026-11-21", zone: "South", temperature_c: 26.0, power_watts: 380 },
    { recorded_at: "2026-11-22", zone: "North", temperature_c: 27.5, power_watts: 610 },
    { recorded_at: "2026-11-22", zone: "South", temperature_c: 25.0, power_watts: 390 }
  ];
  const profile = profileRowsSnapshot({
    name: "iot_sensors",
    columns: [
      { name: "recorded_at", dataType: "date" },
      { name: "zone", dataType: "text" },
      { name: "temperature_c", dataType: "numeric" },
      { name: "power_watts", dataType: "numeric" }
    ]
  }, rows);

  const unified = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-22",
    periodEnd: "2026-11-22",
    comparisonPreset: "previous_day",
    includeAllDatasetColumns: true
  });

  const metricNames = unified.analysis.availableMetrics.map(m => m.name);
  assert.ok(metricNames.includes("Power Watts"), `Expected Power Watts metric, got: ${metricNames.join(", ")}`);
  assert.ok(metricNames.includes("Avg Temperature C"), `Expected Avg Temperature C metric, got: ${metricNames.join(", ")}`);
  assert.ok(unified.tools.smartComparison && unified.tools.smartComparison.metrics.length >= 2);
  assert.ok(unified.tools.rootCause?.available, "Root Cause should decompose directly by custom categorical column 'zone'");
  assert.ok(unified.tools.intelligenceBrief && unified.tools.intelligenceBrief.executiveSummary.length > 10);
  assert.ok(unified.tools.dataHealth && unified.tools.dataHealth.healthScore > 0);
});

test("Historical dataset-date anchoring automatically uses the dataset's own latest and previous active dates", () => {
  const rows = [
    { campaign_date: "2024-03-10", channel: "Search", ad_spend: 200, clicks: 120, conversions: 12 },
    { campaign_date: "2024-03-17", channel: "Search", ad_spend: 300, clicks: 180, conversions: 18 },
    { campaign_date: "2024-03-24", channel: "Search", ad_spend: 450, clicks: 260, conversions: 30 }
  ];
  const profile = profileRowsSnapshot({
    name: "Marketing",
    columns: [
      { name: "campaign_date", dataType: "date" },
      { name: "channel", dataType: "text" },
      { name: "ad_spend", dataType: "numeric" },
      { name: "clicks", dataType: "integer" },
      { name: "conversions", dataType: "integer" }
    ]
  }, rows);

  // Even when caller passes today's calendar date (2026-11-25), anchorToDatasetDates anchors to 2024-03-24 vs 2024-03-17!
  const unified = runUnifiedDailyAnalysisFromRows(profile, rows, {
    domainId: "marketing_campaigns",
    periodStart: "2026-11-25",
    periodEnd: "2026-11-25",
    comparisonPreset: "previous_day",
    includeAllDatasetColumns: true,
    anchorToDatasetDates: true
  });

  assert.equal(unified.reportingPeriod.start, "2024-03-24");
  assert.equal(unified.reportingPeriod.end, "2024-03-24");
  assert.equal(unified.comparisonPeriod?.start, "2024-03-17");
  assert.equal(unified.comparisonPeriod?.end, "2024-03-17");
  assert.ok(unified.analysis.availableMetrics.length > 0);
  assert.equal(unified.analysis.comparisonSummary.available, true);
  assert.ok(unified.tools.smartComparison && unified.tools.smartComparison.metrics.length > 0);
});

test("Proven MDY and DMY slash/hyphen text dates parse cleanly across entire dataset while truly ambiguous samples stay protected", () => {
  // 1. Proven MM/DD/YYYY (e.g. Marketing dataset with days > 12 in 2nd position)
  const mdyRows = [
    { Date: "1/15/2024", Channel: "Email", Spend: 150, Clicks: 90 },
    { Date: "2/4/2024", Channel: "Email", Spend: 220, Clicks: 140 },
    { Date: "2/28/2024", Channel: "Social", Spend: 410, Clicks: 290 }
  ];
  const mdyProfile = profileRowsSnapshot({
    name: "Marketing",
    columns: [
      { name: "Date", dataType: "text" },
      { name: "Channel", dataType: "text" },
      { name: "Spend", dataType: "numeric" },
      { name: "Clicks", dataType: "integer" }
    ]
  }, mdyRows);

  assert.equal(mdyProfile.freshness.earliestDate?.slice(0, 10), "2024-01-15");
  assert.equal(mdyProfile.freshness.latestDate?.slice(0, 10), "2024-02-28");

  const mdyUnified = runUnifiedDailyAnalysisFromRows(mdyProfile, mdyRows, {
    domainId: "marketing_campaigns",
    periodStart: "2026-11-25",
    periodEnd: "2026-11-25",
    comparisonPreset: "previous_day",
    includeAllDatasetColumns: true,
    anchorToDatasetDates: true
  });
  assert.equal(mdyUnified.reportingPeriod.start, "2024-02-28");
  assert.equal(mdyUnified.comparisonPeriod?.start, "2024-02-04");
  assert.equal(mdyUnified.analysis.source.rowCountInPeriod, 1);
  assert.equal(mdyUnified.analysis.source.rowCountInComparison, 1);
  assert.equal(mdyUnified.analysis.comparisonSummary.available, true);
  assert.ok(!mdyUnified.analysis.dataQualityWarnings.some(w => w.includes("unparseable or invalid dates")));

  // 2. Proven DD-MM-YYYY (e.g. 15-03-2024, 29-03-2024)
  const dmyRows = [
    { Dt_Customer: "15-03-2024", Segment: "VIP", Income: 50000 },
    { Dt_Customer: "29-03-2024", Segment: "VIP", Income: 62000 }
  ];
  const dmyProfile = profileRowsSnapshot({
    name: "Marketing_DMY",
    columns: [
      { name: "Dt_Customer", dataType: "text" },
      { name: "Segment", dataType: "text" },
      { name: "Income", dataType: "numeric" }
    ]
  }, dmyRows);
  assert.equal(dmyProfile.freshness.earliestDate?.slice(0, 10), "2024-03-15");
  assert.equal(dmyProfile.freshness.latestDate?.slice(0, 10), "2024-03-29");
});
