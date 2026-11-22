import assert from "node:assert/strict";
import test from "node:test";
import { profileRowsSnapshot, type ReadOnlyQueryExecutor } from "../profiler";
import {
  buildPeriodWindow,
  buildScopedColumnsQuerySql,
  resolveComparisonWindow,
  runDynamicAnalysisFromRows,
  runDynamicAnalysisWithExecutor,
  type MetricResult
} from "../metrics";

function metricById(metrics: MetricResult[], id: string): MetricResult {
  const found = metrics.find(m => m.metricId === id);
  assert.ok(found, `Expected metric "${id}" to exist in result`);
  return found;
}

test("Sales & E-commerce: computes completed sales, excludes cancelled/returned, repeat rate, CLV estimate, and breakdowns", () => {
  const rows = [
    // Prior history for repeat customer & CLV
    { order_id: "ORD-01", order_date: "2026-11-10", customer_id: "C-1", product_name: "Laptop", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 1000, unit_cost: 600, discount_amount: 50, order_status: "Completed" },
    // Current period: 2026-11-21
    { order_id: "ORD-02", order_date: "2026-11-21", customer_id: "C-1", product_name: "Mouse", category: "Electronics", region: "Dhaka", sales_channel: "Web", quantity: 2, total_revenue: 200, unit_cost: 50, discount_amount: 10, order_status: "Completed" },
    { order_id: "ORD-03", order_date: "2026-11-21", customer_id: "C-2", product_name: "Desk", category: "Furniture", region: "Chattogram", sales_channel: "POS", quantity: 1, total_revenue: 400, unit_cost: 250, discount_amount: 20, order_status: "Completed" },
    { order_id: "ORD-04", order_date: "2026-11-21", customer_id: "C-3", product_name: "Chair", category: "Furniture", region: "Dhaka", sales_channel: "Web", quantity: 1, total_revenue: 300, unit_cost: 150, discount_amount: 0, order_status: "Cancelled" },
    { order_id: "ORD-05", order_date: "2026-11-21", customer_id: "C-4", product_name: "Lamp", category: "Furniture", region: "Sylhet", sales_channel: "POS", quantity: 1, total_revenue: 150, unit_cost: 80, discount_amount: 0, order_status: "Returned" }
  ];

  const profile = profileRowsSnapshot({
    name: "sales_orders",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true },
      { name: "order_date", dataType: "date" },
      { name: "customer_id", dataType: "text" },
      { name: "product_name", dataType: "text" },
      { name: "category", dataType: "text" },
      { name: "region", dataType: "text" },
      { name: "sales_channel", dataType: "text" },
      { name: "quantity", dataType: "integer" },
      { name: "total_revenue", dataType: "numeric" },
      { name: "unit_cost", dataType: "numeric" },
      { name: "discount_amount", dataType: "numeric" },
      { name: "order_status", dataType: "text" }
    ]
  }, rows);

  const result = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_30_days"
  });

  // Completed revenue excludes Cancelled (300) and Returned (150): 200 + 400 = 600
  assert.equal(metricById(result.metrics, "totalRevenue").value, 600);
  assert.equal(metricById(result.metrics, "totalOrders").value, 2);
  assert.equal(metricById(result.metrics, "unitsSold").value, 3);
  // Gross profit: (200 - 50*2) + (400 - 250*1) = 100 + 150 = 250
  assert.equal(metricById(result.metrics, "grossProfit").value, 250);
  assert.equal(metricById(result.metrics, "grossProfitMargin").value, 41.67);
  assert.equal(metricById(result.metrics, "averageOrderValue").value, 300);
  assert.equal(metricById(result.metrics, "averageSellingPrice").value, 200);
  assert.equal(metricById(result.metrics, "totalDiscounts").value, 30);
  // 1 cancelled of 4 total orders = 25%, 1 returned of 4 = 25%
  assert.equal(metricById(result.metrics, "cancellationRate").value, 25);
  assert.equal(metricById(result.metrics, "returnRate").value, 25);
  // C-1 has 2 completed orders, C-2 has 1 => 50% repeat rate
  assert.equal(metricById(result.metrics, "repeatCustomerRate").value, 50);
  // CLV estimate across C-1 (1200) and C-2 (400) => 800
  assert.equal(metricById(result.metrics, "customerLifetimeValueEstimate").value, 800);

  // Breakdowns exist for product, category, region, channel
  assert.deepEqual(result.breakdowns.map(b => b.dimensionId), ["product", "category", "region", "channel"]);
});

test("Sales & E-commerce: different column names with identical semantic meaning produce identical metrics; missing cost marks profit unavailable", () => {
  const rows = [
    { invoice_id: "I-1", purchase_timestamp: "2026-11-21T10:00:00Z", selling_price: 500, units_sold: 2, product_title: "Monitor" }
  ];
  const profile = profileRowsSnapshot({
    name: "store_sales",
    columns: [
      { name: "invoice_id", dataType: "text", isPrimaryKey: true },
      { name: "purchase_timestamp", dataType: "timestamptz" },
      { name: "selling_price", dataType: "numeric" },
      { name: "units_sold", dataType: "integer" },
      { name: "product_title", dataType: "text" }
    ]
  }, rows);

  const result = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "none"
  });

  assert.equal(metricById(result.metrics, "totalRevenue").value, 500);
  assert.equal(metricById(result.metrics, "unitsSold").value, 2);
  assert.equal(metricById(result.metrics, "averageSellingPrice").value, 250);
  // Cost/profit missing => MUST be unavailable with null value, NOT 0
  const profit = metricById(result.metrics, "grossProfit");
  assert.equal(profit.availability, "unavailable");
  assert.equal(profit.value, null);
  assert.ok(profit.missingRequiredFields.length > 0);
});

test("Inventory & Supply Chain: deduplicates multi-warehouse snapshots, prevents turnover from single snapshot, computes DOI and reorder alerts", () => {
  // Single snapshot date: turnover MUST NOT be computed from current stock alone
  const singleSnapRows = [
    { sku_id: "SKU-1", snapshot_date: "2026-11-21", stock_on_hand: 100, reorder_point: 30, quantity_sold: 10, warehouse_name: "Dhaka" }
  ];
  const invSchema = {
    name: "warehouse_inventory",
    columns: [
      { name: "sku_id", dataType: "text" },
      { name: "snapshot_date", dataType: "date" },
      { name: "stock_on_hand", dataType: "integer" },
      { name: "reorder_point", dataType: "integer" },
      { name: "quantity_received", dataType: "integer" },
      { name: "quantity_shipped", dataType: "integer" },
      { name: "quantity_sold", dataType: "integer" },
      { name: "warehouse_name", dataType: "text" },
      { name: "supplier_name", dataType: "text" }
    ]
  };

  const singleProfile = profileRowsSnapshot(invSchema, singleSnapRows);
  const singleResult = runDynamicAnalysisFromRows(singleProfile, singleSnapRows, {
    domainId: "inventory_supply_chain",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "none"
  });
  assert.equal(metricById(singleResult.metrics, "availableStock").value, 100);
  assert.equal(metricById(singleResult.metrics, "stockTurnover").availability, "insufficient_data");
  assert.equal(metricById(singleResult.metrics, "stockTurnover").value, null);

  // Multi-day snapshots + multiple warehouses: latest snapshot per (SKU, warehouse) prevents double-counting
  const multiRows = [
    { sku_id: "SKU-1", snapshot_date: "2026-11-20", stock_on_hand: 80, reorder_point: 30, quantity_received: 20, quantity_shipped: 10, quantity_sold: 10, warehouse_name: "Dhaka", supplier_name: "Apex" },
    { sku_id: "SKU-1", snapshot_date: "2026-11-21", stock_on_hand: 60, reorder_point: 30, quantity_received: 0, quantity_shipped: 20, quantity_sold: 20, warehouse_name: "Dhaka", supplier_name: "Apex" },
    { sku_id: "SKU-2", snapshot_date: "2026-11-21", stock_on_hand: 10, reorder_point: 25, quantity_received: 5, quantity_shipped: 0, quantity_sold: 0, warehouse_name: "Chattogram", supplier_name: "Beta" }
  ];
  const multiProfile = profileRowsSnapshot(invSchema, multiRows);
  const multiResult = runDynamicAnalysisFromRows(multiProfile, multiRows, {
    domainId: "inventory_supply_chain",
    periodStart: "2026-11-20",
    periodEnd: "2026-11-21",
    comparisonPreset: "none"
  });

  // Deduplicated available stock: SKU-1 Dhaka latest (60) + SKU-2 Chattogram (10) = 70 (NOT 80+60+10=150!)
  assert.equal(metricById(multiResult.metrics, "availableStock").value, 70);
  // Net movement: received (25) - shipped (30) = -5
  assert.equal(metricById(multiResult.metrics, "stockMovement").value, -5);
  // Turnover available now (>= 2 snapshot dates)
  assert.equal(metricById(multiResult.metrics, "stockTurnover").availability, "available");
  // DOI: availableStock (70) / avgDailyDemand (30 / 2 = 15) = 4.7 days
  assert.equal(metricById(multiResult.metrics, "daysOfInventory").value, 4.7);
  // Reorder Alerts: SKU-2 (10 <= 25) => 1 alert, 50% stockout risk
  assert.equal(metricById(multiResult.metrics, "reorderAlerts").value, 1);
  assert.equal(metricById(multiResult.metrics, "stockoutRisk").value, 50);
  // Slow-moving products: SKU-2 has stock 10 and 0 demand => 1
  assert.equal(metricById(multiResult.metrics, "slowMovingProducts").value, 1);
  assert.ok(multiResult.breakdowns.some(b => b.dimensionId === "warehouse"));
  assert.ok(multiResult.breakdowns.some(b => b.dimensionId === "supplier"));
});

test("Marketing & Campaigns: verifies exact CTR, CPC, Conversion Rate, CPA, ROAS formulas and division-by-zero protection", () => {
  const rows = [
    { campaign_id: "CMP-1", campaign_date: "2026-11-21", campaign_name: "Winter Sale", channel: "Meta", ad_spend: 500, impressions: 10000, clicks: 250, leads: 50, conversions: 25, attributed_revenue: 2000 },
    { campaign_id: "CMP-2", campaign_date: "2026-11-21", campaign_name: "Brand Awareness", channel: "Google", ad_spend: 0, impressions: 0, clicks: 0, leads: 0, conversions: 0, attributed_revenue: 0 }
  ];
  const profile = profileRowsSnapshot({
    name: "marketing_campaigns",
    columns: [
      { name: "campaign_id", dataType: "text", isPrimaryKey: true },
      { name: "campaign_date", dataType: "date" },
      { name: "campaign_name", dataType: "text" },
      { name: "channel", dataType: "text" },
      { name: "ad_spend", dataType: "numeric" },
      { name: "impressions", dataType: "integer" },
      { name: "clicks", dataType: "integer" },
      { name: "leads", dataType: "integer" },
      { name: "conversions", dataType: "integer" },
      { name: "attributed_revenue", dataType: "numeric" }
    ]
  }, rows);

  const result = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "marketing_campaigns",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "none"
  });

  assert.equal(metricById(result.metrics, "campaignSpend").value, 500);
  assert.equal(metricById(result.metrics, "impressions").value, 10000);
  assert.equal(metricById(result.metrics, "clicks").value, 250);
  assert.equal(metricById(result.metrics, "leads").value, 50);
  assert.equal(metricById(result.metrics, "conversions").value, 25);
  assert.equal(metricById(result.metrics, "clickThroughRate").value, 2.5); // 250/10000*100
  assert.equal(metricById(result.metrics, "costPerClick").value, 2); // 500/250
  assert.equal(metricById(result.metrics, "conversionRate").value, 10); // 25/250*100
  assert.equal(metricById(result.metrics, "costPerAcquisition").value, 20); // 500/25
  assert.equal(metricById(result.metrics, "attributedRevenue").value, 2000);
  assert.equal(metricById(result.metrics, "returnOnAdSpend").value, 4); // 2000/500
  assert.ok(metricById(result.metrics, "returnOnAdSpend").warnings.some(w => w.includes("profit/ROI")));

  // Pure zero-denominator rows must return insufficient_data (null), never Infinity or NaN
  const zeroResult = runDynamicAnalysisFromRows(profile, [rows[1]], {
    domainId: "marketing_campaigns",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "none"
  });
  assert.equal(metricById(zeroResult.metrics, "clickThroughRate").value, null);
  assert.equal(metricById(zeroResult.metrics, "costPerClick").value, null);
  assert.equal(metricById(zeroResult.metrics, "returnOnAdSpend").value, null);
});

test("Finance & Expenses: distinguishes Income, Expenses, OpEx, Cash Flow, Overdue AR/AP, and Net Income", () => {
  const rows = [
    // Comparison period expense
    { ledger_id: "L-0", posting_date: "2026-11-20", amount: 500, transaction_type: "expense", expense_category: "Cloud", department: "Engineering", payment_status: "paid", due_date: "2026-11-20", budget_amount: 600 },
    // Current period: 2026-11-21
    { ledger_id: "L-1", posting_date: "2026-11-21", amount: 3000, transaction_type: "income", expense_category: "Subscription", department: "Sales", payment_status: "paid", due_date: "2026-11-20", budget_amount: 0 },
    { ledger_id: "L-2", posting_date: "2026-11-21", amount: 1000, transaction_type: "income", expense_category: "Consulting", department: "Sales", payment_status: "unpaid", due_date: "2026-11-15", budget_amount: 0 },
    { ledger_id: "L-3", posting_date: "2026-11-21", amount: 600, transaction_type: "expense", expense_category: "Cloud Hosting", department: "Engineering", payment_status: "paid", due_date: "2026-11-21", budget_amount: 800 },
    { ledger_id: "L-4", posting_date: "2026-11-21", amount: 400, transaction_type: "expense", expense_category: "Corporate Tax", department: "Finance", payment_status: "unpaid", due_date: "2026-11-18", budget_amount: 500 }
  ];

  const profile = profileRowsSnapshot({
    name: "finance_ledger",
    columns: [
      { name: "ledger_id", dataType: "text", isPrimaryKey: true },
      { name: "posting_date", dataType: "date" },
      { name: "amount", dataType: "numeric" },
      { name: "transaction_type", dataType: "text" },
      { name: "expense_category", dataType: "text" },
      { name: "department", dataType: "text" },
      { name: "payment_status", dataType: "text" },
      { name: "due_date", dataType: "date" },
      { name: "budget_amount", dataType: "numeric" }
    ]
  }, rows);

  const result = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "finance_expenses",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });

  // Total Income = 3000 + 1000 = 4000; Cash Inflow (paid only) = 3000
  assert.equal(metricById(result.metrics, "totalIncome").value, 4000);
  assert.equal(metricById(result.metrics, "cashInflow").value, 3000);
  // Total Expenses = 600 + 400 = 1000; Operating Expenses excludes Corporate Tax = 600
  assert.equal(metricById(result.metrics, "totalExpenses").value, 1000);
  assert.equal(metricById(result.metrics, "operatingExpenses").value, 600);
  // Cash Outflow (paid only) = 600 => Net Cash Flow = 3000 - 600 = 2400 (distinct from Net Income!)
  assert.equal(metricById(result.metrics, "cashOutflow").value, 600);
  assert.equal(metricById(result.metrics, "netCashFlow").value, 2400);
  // Net Income = 4000 - 1000 = 3000
  assert.equal(metricById(result.metrics, "netIncome").value, 3000);
  // Budget Variance = (800 + 500) - 1000 = 300 under budget
  assert.equal(metricById(result.metrics, "budgetVariance").value, 300);
  // Expense growth vs previous day (500 -> 1000) = +100%
  assert.equal(metricById(result.metrics, "expenseGrowth").value, 100);
  // Overdue Receivables (L-2: unpaid, due 11-15 < 11-21) = 1000; Overdue Payables (L-4: unpaid, due 11-18 < 11-21) = 400
  assert.equal(metricById(result.metrics, "overdueReceivables").value, 1000);
  assert.equal(metricById(result.metrics, "overduePayables").value, 400);
  assert.ok(result.breakdowns.some(b => b.dimensionId === "department"));

  // Income-only dataset MUST NOT compute Net Income from revenue/income alone
  const incomeOnlyRows = [rows[1]];
  const incomeOnlyResult = runDynamicAnalysisFromRows(profile, incomeOnlyRows, {
    domainId: "finance_expenses",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "none"
  });
  assert.equal(metricById(incomeOnlyResult.metrics, "netIncome").availability, "insufficient_data");
  assert.equal(metricById(incomeOnlyResult.metrics, "netIncome").value, null);
});

test("Customers & CRM: computes retention, confirmed churn (not missing activity), RFM, and actual vs estimated CLV", () => {
  const rows = [
    // Prior period cohort: C-1, C-2
    { customer_id: "C-1", signup_date: "2026-11-10", last_activity_at: "2026-11-21", customer_segment: "Enterprise", customer_status: "Active", total_spent: 500 },
    { customer_id: "C-2", signup_date: "2026-11-12", last_activity_at: "2026-11-14", customer_segment: "SMB", customer_status: "Churned", total_spent: 200 },
    // New in current period: C-3
    { customer_id: "C-3", signup_date: "2026-11-21", last_activity_at: "2026-11-21", customer_segment: "SMB", customer_status: "Active", total_spent: 300 }
  ];

  const profile = profileRowsSnapshot({
    name: "customers_crm",
    columns: [
      { name: "customer_id", dataType: "text", isPrimaryKey: true },
      { name: "signup_date", dataType: "date" },
      { name: "last_activity_at", dataType: "date" },
      { name: "customer_segment", dataType: "text" },
      { name: "customer_status", dataType: "text" },
      { name: "total_spent", dataType: "numeric" }
    ]
  }, rows);

  const result = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "customers_crm",
    periodStart: "2026-11-20",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_30_days"
  });

  assert.equal(metricById(result.metrics, "newCustomers").value, 1); // C-3
  assert.equal(metricById(result.metrics, "activeCustomers").value, 2); // C-1, C-3
  assert.equal(metricById(result.metrics, "repeatCustomers").value, 1); // C-1 has 2 dates
  assert.equal(metricById(result.metrics, "customerRetention").value, 50); // 1 of 2 prior cohort (C-1 retained, C-2 not)
  assert.equal(metricById(result.metrics, "customerChurn").value, 33.33); // 1 confirmed churned of 3
  assert.equal(metricById(result.metrics, "customerLifetimeValue").value, 333.33);
  assert.equal((result.domainSpecificData as { clvMethod?: string })?.clvMethod, "actual");
  assert.equal((result.domainSpecificData as { rfm?: { available?: boolean } })?.rfm?.available, true);

  // Without explicit churn column, churn MUST be unavailable (missing activity != confirmed churn)
  const noChurnProfile = profileRowsSnapshot({
    name: "customers_basic",
    columns: [
      { name: "customer_id", dataType: "text", isPrimaryKey: true },
      { name: "signup_date", dataType: "date" }
    ]
  }, [{ customer_id: "C-1", signup_date: "2026-11-21" }]);
  const noChurnResult = runDynamicAnalysisFromRows(noChurnProfile, [{ customer_id: "C-1", signup_date: "2026-11-21" }], {
    domainId: "customers_crm",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "none"
  });
  assert.equal(metricById(noChurnResult.metrics, "customerChurn").availability, "unavailable");
  assert.equal(metricById(noChurnResult.metrics, "customerChurn").value, null);
});

test("Operations & Fulfillment: validates timestamp sequences, excludes incomplete/invalid deliveries, computes SLA and backlog", () => {
  const rows = [
    // Valid on-time delivered shipment: proc = 2h, delivery = 2d
    { shipment_id: "S-1", order_created_at: "2026-11-21T08:00:00Z", shipped_at: "2026-11-21T10:00:00Z", delivered_at: "2026-11-23T10:00:00Z", promised_date: "2026-11-24T00:00:00Z", fulfillment_status: "Delivered", carrier: "DHL", region: "Dhaka" },
    // Valid delayed delivered shipment: proc = 4h, delivery = 4d
    { shipment_id: "S-2", order_created_at: "2026-11-21T06:00:00Z", shipped_at: "2026-11-21T10:00:00Z", delivered_at: "2026-11-25T10:00:00Z", promised_date: "2026-11-23T00:00:00Z", fulfillment_status: "Delivered", carrier: "FedEx", region: "Chattogram" },
    // Invalid timestamp sequence (delivered BEFORE shipped): MUST be ignored with warning!
    { shipment_id: "S-3", order_created_at: "2026-11-21T12:00:00Z", shipped_at: "2026-11-21T10:00:00Z", delivered_at: "2026-11-20T10:00:00Z", promised_date: "2026-11-23T00:00:00Z", fulfillment_status: "Delivered", carrier: "DHL", region: "Dhaka" },
    // Pending backlog (incomplete)
    { shipment_id: "S-4", order_created_at: "2026-11-21T09:00:00Z", shipped_at: "2026-11-21T11:00:00Z", delivered_at: null, promised_date: "2026-11-24T00:00:00Z", fulfillment_status: "Pending", carrier: "DHL", region: "Dhaka" },
    // Cancelled
    { shipment_id: "S-5", order_created_at: "2026-11-21T09:00:00Z", shipped_at: "2026-11-21T10:00:00Z", delivered_at: null, promised_date: "2026-11-24T00:00:00Z", fulfillment_status: "Cancelled", carrier: "FedEx", region: "Sylhet" }
  ];

  const profile = profileRowsSnapshot({
    name: "fulfillment_shipments",
    columns: [
      { name: "shipment_id", dataType: "text", isPrimaryKey: true },
      { name: "order_created_at", dataType: "timestamptz" },
      { name: "shipped_at", dataType: "timestamptz" },
      { name: "delivered_at", dataType: "timestamptz" },
      { name: "promised_date", dataType: "timestamptz" },
      { name: "fulfillment_status", dataType: "text" },
      { name: "carrier", dataType: "text" },
      { name: "region", dataType: "text" }
    ]
  }, rows);

  const result = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "operations_fulfillment",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "none"
  });

  // Processing hours avg across valid S-1(2h), S-2(4h), S-4(2h), S-5(1h) = 9/4 = 2.25h (S-3 negative ignored!)
  assert.equal(metricById(result.metrics, "orderProcessingTime").value, 2.25);
  // Delivery days avg across valid delivered S-1(2d), S-2(4d) = 3d (S-3 negative & S-4/S-5 incomplete ignored!)
  assert.equal(metricById(result.metrics, "averageDeliveryTime").value, 3);
  // Fulfillment rate: 3 delivered / 5 = 60%; Cancellation rate: 1 / 5 = 20%; Pending backlog = 1
  assert.equal(metricById(result.metrics, "fulfillmentRate").value, 60);
  assert.equal(metricById(result.metrics, "cancellationRate").value, 20);
  assert.equal(metricById(result.metrics, "pendingOrderBacklog").value, 1);
  assert.ok(result.dataQualityWarnings.some(w => w.includes("invalid timestamp")));
  assert.ok(result.breakdowns.some(b => b.dimensionId === "carrier"));
  assert.ok(result.breakdowns.some(b => b.dimensionId === "region"));
});

test("Product Usage & SaaS: computes DAU/WAU/MAU, Feature Adoption, enforces explicit activation rule, excludes one-time charges from MRR/ARR", () => {
  const rows = [
    { user_id: "U-1", event_timestamp: "2026-11-01T10:00:00Z", feature_name: "Dashboard", event_name: "login", subscription_id: "SUB-1", subscription_status: "active", billing_interval: "monthly", mrr: 50, plan_tier: "Pro" },
    { user_id: "U-2", event_timestamp: "2026-11-18T10:00:00Z", feature_name: "PDF Export", event_name: "export_pdf", subscription_id: "SUB-2", subscription_status: "active", billing_interval: "monthly", mrr: 100, plan_tier: "Enterprise" },
    { user_id: "U-1", event_timestamp: "2026-11-21T09:00:00Z", feature_name: "Daily Alerts", event_name: "onboarding_complete", subscription_id: "SUB-1", subscription_status: "active", billing_interval: "monthly", mrr: 50, plan_tier: "Pro" },
    { user_id: "U-3", event_timestamp: "2026-11-21T11:00:00Z", feature_name: "Dashboard", event_name: "login", subscription_id: "SUB-3", subscription_status: "cancelled", billing_interval: "monthly", mrr: 30, plan_tier: "Starter" },
    // One-time setup fee MUST be excluded from MRR/ARR
    { user_id: "U-4", event_timestamp: "2026-11-21T12:00:00Z", feature_name: "Dashboard", event_name: "login", subscription_id: "SUB-4", subscription_status: "active", billing_interval: "one_time", mrr: 999, plan_tier: "Starter" }
  ];

  const profile = profileRowsSnapshot({
    name: "product_events",
    columns: [
      { name: "user_id", dataType: "text" },
      { name: "event_timestamp", dataType: "timestamptz" },
      { name: "feature_name", dataType: "text" },
      { name: "event_name", dataType: "text" },
      { name: "subscription_id", dataType: "text" },
      { name: "subscription_status", dataType: "text" },
      { name: "billing_interval", dataType: "text" },
      { name: "mrr", dataType: "numeric" },
      { name: "plan_tier", dataType: "text" }
    ]
  }, rows);

  // Without explicit activationEventName => activationRate MUST be unavailable
  const withoutRule = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "product_usage_saas",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_30_days"
  });
  assert.equal(metricById(withoutRule.metrics, "dau").value, 3); // U-1, U-3, U-4
  assert.equal(metricById(withoutRule.metrics, "wau").value, 4); // U-1, U-2, U-3, U-4
  assert.equal(metricById(withoutRule.metrics, "mau").value, 4);
  assert.equal(metricById(withoutRule.metrics, "featureAdoption").value, 100);
  assert.equal(metricById(withoutRule.metrics, "activationRate").availability, "unavailable");
  // MRR includes ONLY active recurring SUB-1 (50); excludes cancelled SUB-3 (30) and one_time SUB-4 (999)
  assert.equal(metricById(withoutRule.metrics, "mrr").value, 50);
  assert.equal(metricById(withoutRule.metrics, "arr").value, 600);
  assert.ok(withoutRule.dataQualityWarnings.some(w => w.includes("non-recurring")));
  // SaaS Churn: SUB-3 cancelled out of 3 period subs (SUB-1, SUB-3, SUB-4) = 33.33%
  assert.equal(metricById(withoutRule.metrics, "saasChurn").value, 33.33);

  // With explicit activationEventName => activationRate computed accurately (1 of 3 = 33.33%)
  const withRule = runDynamicAnalysisFromRows(profile, rows, {
    domainId: "product_usage_saas",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "none",
    activationEventName: "onboarding_complete"
  });
  assert.equal(metricById(withRule.metrics, "activationRate").value, 33.33);
});

test("Historical comparisons resolve all required presets accurately and guard against zero baselines", () => {
  const period = buildPeriodWindow("2026-11-21", "2026-11-21", "Asia/Dhaka");
  assert.equal(resolveComparisonWindow(period, "previous_day")?.start, "2026-11-20");
  assert.equal(resolveComparisonWindow(period, "previous_7_days")?.start, "2026-11-14");
  assert.equal(resolveComparisonWindow(period, "previous_30_days")?.start, "2026-10-22");
  assert.equal(resolveComparisonWindow(period, "previous_90_days")?.start, "2026-08-23");
  assert.equal(resolveComparisonWindow(period, "previous_365_days")?.start, "2025-11-21");
  assert.equal(resolveComparisonWindow(period, "previous_month")?.start, "2026-10-01");
  assert.equal(resolveComparisonWindow(period, "previous_month")?.end, "2026-10-31");
  assert.equal(resolveComparisonWindow(period, "previous_week")?.dayCount, 7);
  const sameWeekday = resolveComparisonWindow(period, "same_weekday_previous_weeks");
  assert.deepEqual(sameWeekday?.matchingDates, ["2026-10-24", "2026-10-31", "2026-11-07", "2026-11-14"]);
  const custom = resolveComparisonWindow(period, "custom", "2026-11-01", "2026-11-07");
  assert.equal(custom?.dayCount, 7);

  // Zero comparison baseline MUST produce changePercent: null (never Infinity)
  const zeroBaselineRows = [
    { order_id: "O-0", order_date: "2026-11-20", total_revenue: 0, order_status: "Completed" },
    { order_id: "O-1", order_date: "2026-11-21", total_revenue: 500, order_status: "Completed" }
  ];
  const profile = profileRowsSnapshot({
    name: "orders",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true },
      { name: "order_date", dataType: "date" },
      { name: "total_revenue", dataType: "numeric" },
      { name: "order_status", dataType: "text" }
    ]
  }, zeroBaselineRows);
  const result = runDynamicAnalysisFromRows(profile, zeroBaselineRows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });
  const rev = metricById(result.metrics, "totalRevenue");
  assert.equal(rev.value, 500);
  assert.equal(rev.comparisonValue, 0);
  assert.equal(rev.changePercent, null);
  assert.equal(rev.trendDirection, "unavailable");
  assert.ok(rev.warnings.some(w => w.includes("zero")));
});

test("Handles empty datasets, null values, invalid dates, and read-only database execution without SELECT * or PII", async () => {
  const emptyProfile = profileRowsSnapshot({
    name: "orders",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true },
      { name: "order_date", dataType: "date" },
      { name: "total_revenue", dataType: "numeric" },
      { name: "customer_email", dataType: "text" }
    ]
  }, []);

  const emptyResult = runDynamicAnalysisFromRows(emptyProfile, [], {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });
  assert.equal(emptyResult.source.rowCountInPeriod, 0);
  assert.equal(emptyResult.comparisonSummary.available, false);
  assert.ok(emptyResult.dataQualityWarnings.length > 0);

  // Invalid date rows are skipped safely with warning
  const invalidDateRows = [
    { order_id: "O-1", order_date: "not-a-date", total_revenue: 100 },
    { order_id: "O-2", order_date: "2026-11-21", total_revenue: null }
  ];
  const dirtyResult = runDynamicAnalysisFromRows(emptyProfile, invalidDateRows, {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "none"
  });
  assert.ok(dirtyResult.dataQualityWarnings.some(w => w.includes("invalid dates")));

  // Scoped SQL refuses sensitive PII columns
  assert.throws(
    () => buildScopedColumnsQuerySql(emptyProfile, ["order_id", "customer_email"], "order_date", "2026-11-01", "2026-11-21"),
    /not present in the discovered schema/
  );

  // Database executor test: verifies no SELECT *, no PII columns queried, and large-table aggregate fallback
  const executedSql: string[] = [];
  const mockExecutor: ReadOnlyQueryExecutor = async (sql: string) => {
    executedSql.push(sql);
    if (sql.includes("FROM information_schema.columns")) {
      return [
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "order_id", data_type: "text", udt_name: "text", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "order_date", data_type: "date", udt_name: "date", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "total_revenue", data_type: "numeric", udt_name: "numeric", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "customer_email", data_type: "text", udt_name: "text", is_nullable: "YES" }
      ];
    }
    if (sql.includes("FROM information_schema.table_constraints")) {
      return [{ table_schema: "public", table_name: "orders", constraint_name: "orders_pkey", constraint_type: "PRIMARY KEY", column_name: "order_id" }];
    }
    if (sql.includes("SELECT COUNT(*) AS row_count") && !sql.includes("WHERE")) {
      return [{ row_count: 50 }];
    }
    if (sql.includes("c0_non_null")) {
      return [{ c0_non_null: 50, c0_distinct: 50, c1_non_null: 50, c1_distinct: 5, c1_min: "2026-11-17", c1_max: "2026-11-21", c2_non_null: 50, c2_distinct: 40, c2_min: 10, c2_max: 500, c2_avg: 200, c2_neg: 0, c2_zero: 0, c2_int_only: false, c3_non_null: 50, c3_distinct: 50 }];
    }
    if (sql.includes("AS dup_check")) {
      return [{ duplicate_groups: 0, duplicate_rows: 0 }];
    }
    if (sql.includes("SELECT COUNT(*) AS row_count") && sql.includes("WHERE")) {
      return [{ row_count: 2 }];
    }
    if (sql.includes("ORDER BY \"order_date\" ASC LIMIT")) {
      return [
        { order_id: "O-10", order_date: "2026-11-20", total_revenue: 100 },
        { order_id: "O-11", order_date: "2026-11-21", total_revenue: 150 }
      ];
    }
    return [];
  };

  const dbRun = await runDynamicAnalysisWithExecutor(mockExecutor, "orders", {
    domainId: "sales_ecommerce",
    periodStart: "2026-11-21",
    periodEnd: "2026-11-21",
    comparisonPreset: "previous_day"
  });

  assert.ok(executedSql.every(q => !/SELECT\s+\*/i.test(q)));
  const dataFetchSql = executedSql.find(q => q.includes("ORDER BY \"order_date\" ASC LIMIT"));
  assert.ok(dataFetchSql);
  assert.doesNotMatch(dataFetchSql, /customer_email/);
  assert.equal(metricById(dbRun.analysis.metrics, "totalRevenue").value, 150);
  assert.equal(metricById(dbRun.analysis.metrics, "totalRevenue").changePercent, 50);
});
