import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeDatabaseSemantics,
  buildColumnBatchAggregateSql,
  buildDuplicateCheckSql,
  buildSafeTokenQuerySql,
  BUSINESS_DOMAIN_IDS,
  classifyPostgresDataType,
  isSensitiveColumnName,
  listDomainProfiles,
  profileDatabaseWithExecutor,
  profileRowsSnapshot,
  quoteIdentifier,
  suggestBusinessDomains,
  toLegacySalesMapping,
  understandTableForDomain,
  validateIdentifier,
  type ReadOnlyQueryExecutor
} from "../profiler";
import { availableMetricsForMapping, detectDatasetColumns, suggestDatasetMapping } from "../database/dataset-mapping";

test("all seven business domain profiles are defined with required fields and metrics", () => {
  const profiles = listDomainProfiles();
  assert.equal(profiles.length, 7);
  assert.deepEqual(profiles.map(p => p.id), [...BUSINESS_DOMAIN_IDS]);
  for (const profile of profiles) {
    assert.ok(profile.fields.some(f => f.required), `${profile.id} must define at least one required role`);
    assert.ok(profile.metrics.length >= 5, `${profile.id} must define calculable metrics`);
  }
});

test("detects semantic aliases across different column names with identical meanings", () => {
  const tableA = profileRowsSnapshot(
    {
      name: "orders",
      columns: [
        { name: "order_id", dataType: "text", isPrimaryKey: true },
        { name: "order_date", dataType: "date" },
        { name: "revenue", dataType: "numeric" },
        { name: "quantity", dataType: "integer" },
        { name: "product_name", dataType: "text" },
        { name: "customer_id", dataType: "uuid" }
      ]
    },
    [
      { order_id: "O-1", order_date: "2026-11-20", revenue: 250.5, quantity: 2, product_name: "Keyboard", customer_id: "11111111-1111-1111-1111-111111111111" },
      { order_id: "O-2", order_date: "2026-11-21", revenue: 120.0, quantity: 1, product_name: "Mouse", customer_id: "22222222-2222-2222-2222-222222222222" }
    ]
  );

  const tableB = profileRowsSnapshot(
    {
      name: "store_checkout_sales",
      columns: [
        { name: "invoice_id", dataType: "text", isPrimaryKey: true },
        { name: "purchase_timestamp", dataType: "timestamp with time zone" },
        { name: "selling_price", dataType: "numeric" },
        { name: "units_sold", dataType: "integer" },
        { name: "product_title", dataType: "text" },
        { name: "client_id", dataType: "text" }
      ]
    },
    [
      { invoice_id: "INV-1", purchase_timestamp: "2026-11-20T10:00:00Z", selling_price: 250.5, units_sold: 2, product_title: "Keyboard", client_id: "C-1" },
      { invoice_id: "INV-2", purchase_timestamp: "2026-11-21T12:30:00Z", selling_price: 120.0, units_sold: 1, product_title: "Mouse", client_id: "C-2" }
    ]
  );

  const understandingA = understandTableForDomain(tableA, "sales_ecommerce", { isSelectedDomain: true });
  const understandingB = understandTableForDomain(tableB, "sales_ecommerce", { isSelectedDomain: true });

  assert.equal(understandingA.roleAssignments.orderId?.columnName, "order_id");
  assert.equal(understandingA.roleAssignments.transactionDate?.columnName, "order_date");
  assert.equal(understandingA.roleAssignments.revenue?.columnName, "revenue");
  assert.equal(understandingA.roleAssignments.quantity?.columnName, "quantity");
  assert.equal(understandingA.roleAssignments.product?.columnName, "product_name");
  assert.equal(understandingA.roleAssignments.customerId?.columnName, "customer_id");

  // Different column names map to identical semantic roles while preserving original DB names
  assert.equal(understandingB.roleAssignments.orderId?.columnName, "invoice_id");
  assert.equal(understandingB.roleAssignments.transactionDate?.columnName, "purchase_timestamp");
  assert.equal(understandingB.roleAssignments.revenue?.columnName, "selling_price");
  assert.equal(understandingB.roleAssignments.quantity?.columnName, "units_sold");
  assert.equal(understandingB.roleAssignments.product?.columnName, "product_title");
  assert.equal(understandingB.roleAssignments.customerId?.columnName, "client_id");

  assert.equal(understandingB.roleAssignments.revenue?.confidence, "high");
  assert.equal(understandingB.roleAssignments.transactionDate?.confidence, "high");
  assert.equal(understandingB.readyForAnalysis, true);
});

test("interprets generic `amount` differently depending on selected domain and supporting context", () => {
  const expensesTable = profileRowsSnapshot(
    {
      name: "company_expenses",
      columns: [
        { name: "expense_id", dataType: "integer", isPrimaryKey: true },
        { name: "expense_date", dataType: "date" },
        { name: "amount", dataType: "numeric" },
        { name: "expense_category", dataType: "text" },
        { name: "vendor_name", dataType: "text" },
        { name: "department", dataType: "text" }
      ]
    },
    [
      { expense_id: 1, expense_date: "2026-11-20", amount: 1500, expense_category: "Cloud", vendor_name: "AWS", department: "Engineering" },
      { expense_id: 2, expense_date: "2026-11-21", amount: 400, expense_category: "Travel", vendor_name: "Airline", department: "Sales" }
    ]
  );

  // Under Finance & Expenses, `amount` is high-confidence financial amount
  const financeView = understandTableForDomain(expensesTable, "finance_expenses", { isSelectedDomain: true });
  assert.equal(financeView.roleAssignments.amount?.columnName, "amount");
  assert.equal(financeView.roleAssignments.amount?.confidence, "high");

  // Under Sales & E-commerce, `amount` on an expenses table must NOT be auto-assigned as high-confidence sales revenue
  const salesView = understandTableForDomain(expensesTable, "sales_ecommerce", { isSelectedDomain: false });
  const amountMatchInSales = salesView.columnMatches.find(m => m.columnName === "amount");
  assert.ok(amountMatchInSales);
  assert.notEqual(amountMatchInSales.confidence, "high");
  assert.equal(amountMatchInSales.assignedRole, null);
  assert.equal(amountMatchInSales.needsConfirmation, true);

  // Under generic ambiguous table `records`, `amount` also preserves medium-confidence uncertainty
  const genericTable = profileRowsSnapshot(
    {
      name: "records",
      columns: [
        { name: "id", dataType: "integer", isPrimaryKey: true },
        { name: "created_at", dataType: "timestamp" },
        { name: "amount", dataType: "numeric" }
      ]
    },
    [{ id: 1, created_at: "2026-11-21T08:00:00Z", amount: 99.5 }]
  );
  const genericSales = understandTableForDomain(genericTable, "sales_ecommerce");
  const genericAmount = genericSales.columnMatches.find(m => m.columnName === "amount");
  assert.equal(genericAmount?.confidence, "medium");
  assert.equal(genericAmount?.assignedRole, null);
  assert.equal(genericAmount?.suggestedRole, "revenue");
  assert.equal(genericAmount?.needsConfirmation, true);
});

test("detects ambiguous columns and competing candidates without blind auto-assignment", () => {
  const ambiguousTable = profileRowsSnapshot(
    {
      name: "orders",
      columns: [
        { name: "order_id", dataType: "text", isPrimaryKey: true },
        { name: "order_date", dataType: "date" },
        { name: "total_revenue", dataType: "numeric" },
        { name: "gross_sales", dataType: "numeric" },
        { name: "misc_blob_field", dataType: "text" }
      ]
    },
    [
      { order_id: "1", order_date: "2026-11-20", total_revenue: 100, gross_sales: 120, misc_blob_field: "abc" }
    ]
  );

  const understanding = understandTableForDomain(ambiguousTable, "sales_ecommerce");
  // Two competing revenue columns should flag confirmation needed
  assert.equal(understanding.roleAssignments.revenue?.needsConfirmation, true);
  assert.equal(understanding.roleAssignments.revenue?.ambiguous, true);

  // Unknown column gets low confidence and stays unassigned
  const misc = understanding.columnMatches.find(m => m.columnName === "misc_blob_field");
  assert.equal(misc?.confidence, "low");
  assert.equal(misc?.assignedRole, null);
  assert.equal(misc?.suggestedRole, null);
});

test("reports missing required fields and unavailable metrics without inventing values", () => {
  const partialTable = profileRowsSnapshot(
    {
      name: "orders_minimal",
      columns: [
        { name: "order_id", dataType: "text", isPrimaryKey: true },
        { name: "product_name", dataType: "text" }
      ]
    },
    [{ order_id: "O-1", product_name: "Desk" }]
  );

  const understanding = understandTableForDomain(partialTable, "sales_ecommerce");
  assert.ok(understanding.missingRequiredRoles.includes("transactionDate"));
  assert.equal(understanding.readyForAnalysis, false);

  const revenueMetric = understanding.availableMetrics.find(m => m.metricId === "totalRevenue");
  assert.equal(revenueMetric?.available, false);
  assert.equal(revenueMetric?.confidence, "unavailable");
  assert.ok(revenueMetric?.missingRoles.includes("revenue"));
  assert.ok(revenueMetric?.missingRoles.includes("transactionDate"));
});

test("handles unsupported data types, empty tables, null values, and PII protection gracefully", () => {
  assert.equal(classifyPostgresDataType("jsonb", "jsonb").supported, false);
  assert.equal(classifyPostgresDataType("bytea", "bytea").supported, false);
  assert.equal(classifyPostgresDataType("ARRAY", "_text").supported, false);
  assert.equal(classifyPostgresDataType("USER-DEFINED", "geometry").supported, false);
  assert.equal(classifyPostgresDataType("timestamp with time zone", "timestamptz").category, "temporal");

  // Empty table
  const emptyTable = profileRowsSnapshot(
    {
      name: "product_events",
      columns: [
        { name: "user_id", dataType: "uuid" },
        { name: "event_timestamp", dataType: "timestamptz" },
        { name: "payload", dataType: "jsonb" },
        { name: "raw_bytes", dataType: "bytea" }
      ]
    },
    []
  );
  assert.equal(emptyTable.isEmpty, true);
  assert.equal(emptyTable.rowCount, 0);
  assert.equal(emptyTable.freshness.status, "empty");
  assert.deepEqual(emptyTable.unsupportedColumns, ["payload", "raw_bytes"]);
  assert.equal(emptyTable.columns[0].nullPercent, 0);

  // Null values + sensitive PII columns
  const withNullsAndPii = profileRowsSnapshot(
    {
      name: "customers",
      columns: [
        { name: "customer_id", dataType: "integer", isPrimaryKey: true },
        { name: "signup_date", dataType: "date" },
        { name: "customer_email", dataType: "text" },
        { name: "phone_number", dataType: "text" },
        { name: "password_hash", dataType: "text" },
        { name: "customer_status", dataType: "text" },
        { name: "csat_score", dataType: "numeric" },
        { name: "metadata", dataType: "jsonb" }
      ]
    },
    [
      { customer_id: 1, signup_date: "2026-11-20", customer_email: "alice@secret.com", phone_number: "01711111111", password_hash: "hash1", customer_status: "Active", csat_score: 4.5, metadata: { a: 1 } },
      { customer_id: 2, signup_date: "2026-11-21", customer_email: "bob@secret.com", phone_number: null, password_hash: "hash2", customer_status: null, csat_score: null, metadata: null }
    ]
  );

  const emailCol = withNullsAndPii.columns.find(c => c.name === "customer_email");
  const phoneCol = withNullsAndPii.columns.find(c => c.name === "phone_number");
  const statusCol = withNullsAndPii.columns.find(c => c.name === "customer_status");
  const csatCol = withNullsAndPii.columns.find(c => c.name === "csat_score");
  const metaCol = withNullsAndPii.columns.find(c => c.name === "metadata");

  assert.equal(emailCol?.isSensitive, true);
  assert.equal(emailCol?.valueHints.safeLowCardinalityTokens, undefined);
  assert.equal(phoneCol?.isSensitive, true);
  assert.equal(phoneCol?.nullPercent, 50);
  assert.equal(statusCol?.isSensitive, false);
  assert.deepEqual(statusCol?.valueHints.safeLowCardinalityTokens, ["active"]);
  assert.equal(csatCol?.nullCount, 1);
  assert.equal(csatCol?.nullPercent, 50);
  assert.equal(csatCol?.numericStats?.avg, 4.5);
  assert.equal(metaCol?.supported, false);
});

test("enforces strict SQL identifier safety and prevents SQL injection and PII sampling", () => {
  assert.equal(quoteIdentifier("daily_sales_orders"), "\"daily_sales_orders\"");
  assert.throws(() => validateIdentifier("orders; DROP TABLE users;--"), /Unsafe or invalid/);
  assert.throws(() => validateIdentifier("users", new Set(["orders"])), /not present in the discovered schema/);
  assert.equal(isSensitiveColumnName("user_email"), true);
  assert.equal(isSensitiveColumnName("api_key"), true);
  assert.equal(isSensitiveColumnName("order_status"), false);

  assert.throws(
    () => buildSafeTokenQuerySql("public", "customers", "customer_email", new Set(["customers"]), new Set(["customer_email"])),
    /Refusing to sample values from sensitive column/
  );

  const aggSql = buildColumnBatchAggregateSql(
    "public",
    "orders",
    [
      { name: "total_revenue", category: "numeric", supported: true, rawDataType: "numeric", isIntegerType: false },
      { name: "payload", category: "unsupported", supported: false, rawDataType: "jsonb", isIntegerType: false }
    ],
    new Set(["orders"]),
    new Set(["total_revenue", "payload"])
  );
  assert.doesNotMatch(aggSql, /SELECT \*/i);
  assert.match(aggSql, /MIN\("total_revenue"::double precision\)/);
  assert.doesNotMatch(aggSql, /DISTINCT "payload"/);

  const dupSql = buildDuplicateCheckSql("public", "orders", ["order_id"], new Set(["orders"]), new Set(["order_id"]));
  assert.match(dupSql, /GROUP BY "order_id" HAVING COUNT\(\*\) > 1/);
});

test("profiles a connected multi-domain database via read-only SQL aggregates without SELECT *", async () => {
  const executedQueries: string[] = [];

  const mockExecutor: ReadOnlyQueryExecutor = async (sql: string) => {
    executedQueries.push(sql);
    if (sql.includes("FROM information_schema.columns")) {
      return [
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "order_id", data_type: "text", udt_name: "text", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "order_date", data_type: "date", udt_name: "date", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "total_revenue", data_type: "numeric", udt_name: "numeric", is_nullable: "NO" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "order_status", data_type: "text", udt_name: "text", is_nullable: "YES" },
        { table_schema: "public", table_name: "orders", table_type: "BASE TABLE", column_name: "raw_meta", data_type: "jsonb", udt_name: "jsonb", is_nullable: "YES" },
        { table_schema: "public", table_name: "product_events", table_type: "VIEW", column_name: "user_id", data_type: "uuid", udt_name: "uuid", is_nullable: "NO" },
        { table_schema: "public", table_name: "product_events", table_type: "VIEW", column_name: "event_timestamp", data_type: "timestamp with time zone", udt_name: "timestamptz", is_nullable: "NO" },
        { table_schema: "public", table_name: "product_events", table_type: "VIEW", column_name: "feature_name", data_type: "text", udt_name: "text", is_nullable: "YES" }
      ];
    }
    if (sql.includes("FROM information_schema.table_constraints")) {
      return [
        { table_schema: "public", table_name: "orders", constraint_name: "orders_pkey", constraint_type: "PRIMARY KEY", column_name: "order_id", foreign_table_name: null, foreign_column_name: null }
      ];
    }
    if (sql.includes("SELECT COUNT(*) AS row_count FROM \"public\".\"orders\"")) {
      return [{ row_count: 100 }];
    }
    if (sql.includes("SELECT COUNT(*) AS row_count FROM \"public\".\"product_events\"")) {
      return [{ row_count: 500 }];
    }
    if (sql.includes("FROM \"public\".\"orders\"") && sql.includes("c0_non_null")) {
      return [{
        c0_non_null: 100, c0_distinct: 98,
        c1_non_null: 100, c1_distinct: 10, c1_min: "2026-11-12", c1_max: "2026-11-22",
        c2_non_null: 95, c2_distinct: 80, c2_min: 10, c2_max: 2500, c2_avg: 320.5, c2_neg: 0, c2_zero: 1, c2_int_only: false,
        c3_non_null: 100, c3_distinct: 3,
        c4_non_null: 40
      }];
    }
    if (sql.includes("FROM \"public\".\"product_events\"") && sql.includes("c0_non_null")) {
      return [{
        c0_non_null: 500, c0_distinct: 120,
        c1_non_null: 500, c1_distinct: 490, c1_min: "2026-11-01T00:00:00Z", c1_max: "2026-11-22T12:00:00Z",
        c2_non_null: 500, c2_distinct: 6
      }];
    }
    if (sql.includes("SELECT DISTINCT LOWER(TRIM(CAST(\"order_status\"")) {
      return [{ token: "completed" }, { token: "pending" }, { token: "cancelled" }];
    }
    if (sql.includes("SELECT DISTINCT LOWER(TRIM(CAST(\"feature_name\"")) {
      return [{ token: "daily_report" }, { token: "pdf_export" }];
    }
    if (sql.includes("AS dup_check")) {
      return sql.includes("\"orders\"")
        ? [{ duplicate_groups: 2, duplicate_rows: 2 }]
        : [{ duplicate_groups: 0, duplicate_rows: 0 }];
    }
    return [];
  };

  const dbProfile = await profileDatabaseWithExecutor(mockExecutor, {
    now: new Date("2026-11-22T18:00:00.000Z")
  });

  // Never loads raw rows via SELECT *
  assert.ok(executedQueries.every(sql => !/SELECT\s+\*/i.test(sql)));

  assert.equal(dbProfile.tables.length, 2);
  const ordersProfile = dbProfile.tables.find(t => t.name === "orders");
  const eventsProfile = dbProfile.tables.find(t => t.name === "product_events");

  assert.equal(ordersProfile?.tableType, "BASE TABLE");
  assert.equal(eventsProfile?.tableType, "VIEW");
  assert.equal(ordersProfile?.duplicates.hasDuplicates, true);
  assert.equal(ordersProfile?.duplicates.duplicateRowCount, 2);
  assert.equal(ordersProfile?.freshness.status, "fresh");
  assert.deepEqual(ordersProfile?.unsupportedColumns, ["raw_meta"]);

  // Multi-domain database understands each table in its best-fitting domain when no global override is selected
  assert.equal(dbProfile.tableUnderstandings.orders.domainId, "sales_ecommerce");
  assert.equal(dbProfile.tableUnderstandings.product_events.domainId, "product_usage_saas");
  assert.equal(dbProfile.isDomainAmbiguous, true); // Both Sales & Product Usage score strongly — never silently misclassifies!
});

test("domain suggestion clearly identifies single-domain database and flags ambiguous ones", () => {
  const inventoryTable = profileRowsSnapshot(
    {
      name: "warehouse_inventory",
      columns: [
        { name: "sku_id", dataType: "text", isPrimaryKey: true },
        { name: "snapshot_date", dataType: "date" },
        { name: "stock_on_hand", dataType: "integer" },
        { name: "reorder_point", dataType: "integer" },
        { name: "warehouse_name", dataType: "text" },
        { name: "supplier_name", dataType: "text" }
      ]
    },
    [
      { sku_id: "SKU-1", snapshot_date: "2026-11-22", stock_on_hand: 40, reorder_point: 15, warehouse_name: "Dhaka Hub", supplier_name: "Apex" }
    ]
  );

  const singleResult = suggestBusinessDomains([inventoryTable]);
  assert.equal(singleResult.suggestedDomain?.domainId, "inventory_supply_chain");
  assert.equal(singleResult.isDomainAmbiguous, false);

  const ambiguousGeneric = profileRowsSnapshot(
    {
      name: "entries",
      columns: [
        { name: "id", dataType: "integer", isPrimaryKey: true },
        { name: "created_at", dataType: "timestamp" },
        { name: "status", dataType: "text" }
      ]
    },
    [{ id: 1, created_at: "2026-11-22T00:00:00Z", status: "active" }]
  );

  const ambiguousResult = suggestBusinessDomains([ambiguousGeneric]);
  assert.equal(ambiguousResult.isDomainAmbiguous, true);
  assert.equal(ambiguousResult.suggestedDomain, null);
});

test("preserves full compatibility with existing Sales dataset mapping", () => {
  const salesTable = profileRowsSnapshot(
    {
      name: "daily_sales_orders",
      columns: [
        { name: "order_id", dataType: "text", isPrimaryKey: true },
        { name: "order_date", dataType: "date" },
        { name: "product_name", dataType: "text" },
        { name: "category", dataType: "text" },
        { name: "quantity", dataType: "integer" },
        { name: "total_revenue", dataType: "numeric" },
        { name: "unit_cost", dataType: "numeric" },
        { name: "discount_amount", dataType: "numeric" },
        { name: "status", dataType: "text" },
        { name: "region", dataType: "text" },
        { name: "customer_gender", dataType: "text" },
        { name: "customer_rating", dataType: "numeric" }
      ]
    },
    [
      {
        order_id: "ORD-1",
        order_date: "2026-11-21",
        product_name: "Laptop",
        category: "Electronics",
        quantity: 2,
        total_revenue: 2000,
        unit_cost: 700,
        discount_amount: 100,
        status: "Completed",
        region: "Dhaka",
        customer_gender: "Female",
        customer_rating: 4.8
      }
    ]
  );

  const understanding = understandTableForDomain(salesTable, "sales_ecommerce", { isSelectedDomain: true });
  const bridgedMapping = toLegacySalesMapping(understanding);
  const legacyDetected = detectDatasetColumns({ name: salesTable.name, columns: salesTable.columns.map(c => c.name) });
  const legacySuggested = suggestDatasetMapping({ name: salesTable.name, columns: salesTable.columns.map(c => c.name) });

  assert.equal(bridgedMapping.orderId, legacySuggested.orderId);
  assert.equal(bridgedMapping.orderDate, legacySuggested.orderDate);
  assert.equal(bridgedMapping.revenue, legacyDetected.revenue);
  assert.equal(bridgedMapping.cost, legacyDetected.cost);
  assert.equal(bridgedMapping.quantity, legacyDetected.quantity);
  assert.equal(bridgedMapping.product, legacyDetected.product);
  assert.equal(bridgedMapping.category, legacyDetected.category);
  assert.equal(bridgedMapping.discount, legacyDetected.discount);
  assert.equal(bridgedMapping.status, legacyDetected.status);
  assert.equal(bridgedMapping.region, legacyDetected.region);
  assert.equal(bridgedMapping.gender, legacyDetected.gender);
  assert.equal(bridgedMapping.rating, legacyDetected.rating);
  assert.deepEqual(availableMetricsForMapping(bridgedMapping), availableMetricsForMapping(legacySuggested));

  const dbProfile = analyzeDatabaseSemantics([salesTable], [], { selectedDomain: "sales_ecommerce" });
  assert.equal(dbProfile.selectedDomain, "sales_ecommerce");
  assert.equal(dbProfile.tableUnderstandings.daily_sales_orders.readyForAnalysis, true);
});
