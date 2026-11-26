import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSessionPerformanceCaches,
  mapWithConcurrency,
  profileRowsSnapshot,
  setCachedTableProfile,
  type ReadOnlyQueryExecutor
} from "../profiler";
import { runUnifiedDailyAnalysisWithExecutor } from "../intelligence";

test("Session cache makes Reference Period switches & PDF re-runs execute 0 extra SQL queries and enforces session isolation", async () => {
  clearSessionPerformanceCaches();

  const rows = [
    { order_id: "1", order_date: "2024-05-01", category: "Electronics", revenue: 1000, cost: 500, quantity: 5, status: "completed" },
    { order_id: "2", order_date: "2024-05-02", category: "Electronics", revenue: 1200, cost: 550, quantity: 6, status: "completed" },
    { order_id: "3", order_date: "2024-05-08", category: "Electronics", revenue: 1400, cost: 600, quantity: 7, status: "completed" },
    { order_id: "4", order_date: "2024-05-09", category: "Electronics", revenue: 1600, cost: 650, quantity: 8, status: "completed" }
  ];

  const profile = profileRowsSnapshot({
    name: "fast_orders",
    columns: [
      { name: "order_id", dataType: "text", isPrimaryKey: true },
      { name: "order_date", dataType: "date" },
      { name: "category", dataType: "text" },
      { name: "revenue", dataType: "numeric" },
      { name: "cost", dataType: "numeric" },
      { name: "quantity", dataType: "integer" },
      { name: "status", dataType: "text" }
    ]
  }, rows);

  // Seed table profile as GET /api/daily-analysis/profile does
  setCachedTableProfile("session-user-A", profile);

  let sqlCount = 0;
  const countingExecutor: ReadOnlyQueryExecutor = async () => {
    sqlCount += 1;
    return rows;
  };

  // 1st run (Previous Day): profile hits cache (0 queries), fetches rows in 1 single pass (1 query total!)
  const first = await runUnifiedDailyAnalysisWithExecutor(countingExecutor, "fast_orders", {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-09",
    periodEnd: "2024-05-09",
    comparisonPreset: "previous_day",
    sessionCacheKey: "session-user-A"
  });
  assert.equal(first.analysis.availableMetrics.find(m => m.metricId === "totalRevenue")?.value, 1600);
  assert.equal(sqlCount, 1, "First run with cached profile should perform only 1 SQL row fetch");

  // 2nd run (Switch Reference Period -> Previous 7 Days): 0 SQL queries! Instant in-memory hit!
  const second = await runUnifiedDailyAnalysisWithExecutor(countingExecutor, "fast_orders", {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-03",
    periodEnd: "2024-05-09",
    comparisonPreset: "previous_7_days",
    sessionCacheKey: "session-user-A"
  });
  assert.equal(second.analysis.availableMetrics.find(m => m.metricId === "totalRevenue")?.value, 3000);
  assert.equal(sqlCount, 1, "Switching Reference Period must execute 0 additional SQL queries");

  // 3rd run (PDF / different range on same table): still 0 SQL queries!
  const third = await runUnifiedDailyAnalysisWithExecutor(countingExecutor, "fast_orders", {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-01",
    periodEnd: "2024-05-09",
    comparisonPreset: "none",
    sessionCacheKey: "session-user-A"
  });
  assert.equal(third.analysis.availableMetrics.find(m => m.metricId === "totalRevenue")?.value, 5200);
  assert.equal(sqlCount, 1, "Generating PDF / full-history analysis must reuse cached rows with 0 extra SQL queries");

  // 4th run with forceRefresh: true -> bypasses cache and re-fetches fresh rows
  setCachedTableProfile("session-user-A", profile);
  await runUnifiedDailyAnalysisWithExecutor(countingExecutor, "fast_orders", {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-09",
    periodEnd: "2024-05-09",
    comparisonPreset: "previous_day",
    sessionCacheKey: "session-user-A",
    forceRefresh: true
  }, profile);
  assert.equal(sqlCount, 2, "Explicit forceRefresh must bypass cache and re-query the database");

  // 5th run under DIFFERENT session -> strictly isolated, must NOT read session-user-A cache
  setCachedTableProfile("session-user-B", profile);
  await runUnifiedDailyAnalysisWithExecutor(countingExecutor, "fast_orders", {
    domainId: "sales_ecommerce",
    timezone: "UTC",
    periodStart: "2024-05-09",
    periodEnd: "2024-05-09",
    comparisonPreset: "previous_day",
    sessionCacheKey: "session-user-B"
  });
  assert.equal(sqlCount, 3, "Different session must never read another session's cached rows");
});

test("mapWithConcurrency preserves result ordering and bounds active parallel workers", async () => {
  let active = 0;
  let maxActive = 0;
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const output = await mapWithConcurrency(input, 3, async n => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    return n * 10;
  });
  assert.deepEqual(output, [10, 20, 30, 40, 50, 60, 70, 80]);
  assert.ok(maxActive <= 3, `Expected concurrency <= 3, observed ${maxActive}`);
  assert.ok(maxActive >= 2, "Expected tasks to execute concurrently");
});
