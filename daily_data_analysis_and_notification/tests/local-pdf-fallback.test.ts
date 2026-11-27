import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  createDefaultPdfStorage,
  getDefaultDailySettings,
  getDefaultLocalReportsDirectory,
  getServerlessTempReportsDirectory,
  LocalPrivatePdfStorage,
  runScheduledReports,
  SqliteReportRepository,
  SupabasePrivatePdfStorage
} from "../storage";
import type { ReadOnlyQueryExecutor } from "../profiler";
import {
  downloadDailyPdfFromSharedStorage,
  findLocalDailyPdfByReportId,
  isSharedStorageConfigured,
  listDailyPdfsFromSharedStorage,
  loadSharedSettingsEnvelope,
  saveSharedSettingsEnvelope,
  uploadDailyPdfToSharedStorage
} from "../storage/shared-cloud-storage";
import { resolveAutoReportDisplayState } from "../components/dashboard-helpers";
import type { StorageCapabilityStatus } from "../storage/types";

const SAMPLE_PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% QueryPilot-X temporary local fallback test payload with sufficient length to pass PDF buffer validation.\n%%EOF\n",
  "utf8"
);

const CLOUD_ENV_KEYS = [
  "QUERYPILOT_STORAGE_SUPABASE_URL",
  "QUERYPILOT_CORE_SUPABASE_URL",
  "QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "QUERYPILOT_CORE_SUPABASE_ANON_KEY",
  "QUERYPILOT_STORAGE_BUCKET",
  "QUERYPILOT_REPORT_DIRECTORY",
  "NODE_ENV",
  "VERCEL"
] as const;

function withCleanEnv(
  overrides: Partial<Record<(typeof CLOUD_ENV_KEYS)[number], string | undefined>>,
  fn: () => Promise<void> | void
): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const backup: Record<string, string | undefined> = {};
  for (const key of CLOUD_ENV_KEYS) {
    backup[key] = env[key];
    delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of CLOUD_ENV_KEYS) {
        if (backup[key] === undefined) delete env[key];
        else env[key] = backup[key];
      }
    });
}

test("Default local PDF storage targets gitignored daily_data_analysis_and_notification/generated-reports/", async () => {
  await withCleanEnv({}, () => {
    const dir = getDefaultLocalReportsDirectory();
    const normalized = dir.replace(/\\/g, "/");
    assert.ok(
      normalized.endsWith("/daily_data_analysis_and_notification/generated-reports"),
      `Expected default dir to end with daily_data_analysis_and_notification/generated-reports, got: ${normalized}`
    );

    const storage = createDefaultPdfStorage();
    assert.ok(storage instanceof LocalPrivatePdfStorage);
    assert.equal(storage.backendName, "local_private_fs");
  });
});

test("Temporary local PDF fallback works even under NODE_ENV=production when cloud is unconfigured, and auto-switches to Cloud when configured", async () => {
  await withCleanEnv({ NODE_ENV: "production" }, () => {
    assert.equal(isSharedStorageConfigured(), false);
    const localAdapter = createDefaultPdfStorage();
    assert.ok(localAdapter instanceof LocalPrivatePdfStorage);
    assert.equal(localAdapter.backendName, "local_private_fs");
  });

  await withCleanEnv(
    {
      NODE_ENV: "production",
      QUERYPILOT_STORAGE_SUPABASE_URL: "https://cloud-test.supabase.co",
      QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY: "service-role-key-test",
      QUERYPILOT_STORAGE_BUCKET: "querypilotx-storage"
    },
    () => {
      assert.equal(isSharedStorageConfigured(), true);
      const cloudAdapter = createDefaultPdfStorage();
      assert.ok(cloudAdapter instanceof SupabasePrivatePdfStorage);
      assert.equal(cloudAdapter.backendName, "supabase_private_storage");
    }
  );
});

test("Manual and scheduled PDFs + schedule settings save, list, download, and isolate users in temporary local storage", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "qp-local-fallback-"));
  try {
    await withCleanEnv(
      {
        NODE_ENV: "production",
        QUERYPILOT_REPORT_DIRECTORY: tempRoot
      },
      async () => {
        // 1. Save & reload scheduled settings + cursor locally
        const settings = {
          ...getDefaultDailySettings("org_local_1"),
          selectedDataset: "daily_sales_orders",
          selectedDomain: "sales_ecommerce" as const,
          autoReportEnabled: true,
          frequency: "daily" as const,
          scheduledTime: "08:30",
          timezone: "Asia/Dhaka"
        };
        const savedEnvelope = await saveSharedSettingsEnvelope("usr_alpha123", settings, { daily: "2026-11-26" });
        assert.equal(savedEnvelope.settings.selectedDataset, "daily_sales_orders");
        assert.equal(savedEnvelope.cursors?.daily, "2026-11-26");

        const loadedEnvelope = await loadSharedSettingsEnvelope("usr_alpha123");
        assert.ok(loadedEnvelope);
        assert.equal(loadedEnvelope.settings.scheduledTime, "08:30");
        assert.equal(loadedEnvelope.cursors?.daily, "2026-11-26");
        assert.equal(await loadSharedSettingsEnvelope("usr_other999"), null);

        // 2. Upload manual & automatic PDFs locally
        const manualDesc = await uploadDailyPdfToSharedStorage({
          userId: "usr_alpha123",
          filename: "querypilot-x-sales_ecommerce-manual-2026-11-01-to-2026-11-26.pdf",
          bytes: SAMPLE_PDF_BYTES,
          metadata: {
            domainId: "sales_ecommerce",
            domainName: "Sales & E-commerce",
            datasetTable: "daily_sales_orders",
            frequency: "manual",
            periodStart: "2026-11-01",
            periodEnd: "2026-11-26",
            generationType: "manual",
            summaryText: "Manual test summary"
          }
        });
        assert.equal(manualDesc.backend, "local_secure_storage");
        assert.ok(existsSync(path.join(tempRoot, manualDesc.storageKey)));

        const autoDesc = await uploadDailyPdfToSharedStorage({
          userId: "usr_alpha123",
          filename: "querypilot-x-sales_ecommerce-daily-2026-11-26-to-2026-11-26.pdf",
          bytes: SAMPLE_PDF_BYTES,
          metadata: {
            domainId: "sales_ecommerce",
            domainName: "Sales & E-commerce",
            datasetTable: "daily_sales_orders",
            frequency: "daily",
            periodStart: "2026-11-26",
            periodEnd: "2026-11-26",
            generationType: "automatic",
            summaryText: "Automatic scheduled test summary"
          }
        });
        assert.equal(autoDesc.backend, "local_secure_storage");

        // 3. List stored local PDFs and verify preserved metadata
        const listed = await listDailyPdfsFromSharedStorage("usr_alpha123", "org_local_1");
        assert.equal(listed.length, 2);
        const manualItem = listed.find(r => r.generationType === "manual");
        const autoItem = listed.find(r => r.generationType === "automatic");
        assert.ok(manualItem);
        assert.ok(autoItem);
        assert.ok(manualItem.id.startsWith("local_"));
        assert.equal(manualItem.datasetTable, "daily_sales_orders");
        assert.equal(manualItem.periodStart, "2026-11-01");
        assert.equal(autoItem.frequency, "daily");
        assert.equal(autoItem.summaryText, "Automatic scheduled test summary");

        // 4. Download via storageKey and via local reportId
        const downloaded = await downloadDailyPdfFromSharedStorage("usr_alpha123", manualDesc.storageKey);
        assert.ok(downloaded);
        assert.equal(downloaded.subarray(0, 5).toString("ascii"), "%PDF-");

        const foundById = await findLocalDailyPdfByReportId("usr_alpha123", manualItem.id);
        assert.ok(foundById);
        assert.equal(foundById.filename, manualDesc.filename);
        assert.equal(foundById.bytes.subarray(0, 5).toString("ascii"), "%PDF-");

        // 5. Cross-user isolation: another user cannot list or download usr_alpha123's files
        const otherListed = await listDailyPdfsFromSharedStorage("usr_other999", "org_other");
        assert.equal(otherListed.length, 0);
        assert.equal(await downloadDailyPdfFromSharedStorage("usr_other999", manualDesc.storageKey), null);
        assert.equal(await findLocalDailyPdfByReportId("usr_other999", manualItem.id), null);
      }
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Vercel serverless environment automatically uses writable OS tmpdir instead of read-only /var/task", async () => {
  await withCleanEnv({ VERCEL: "1", NODE_ENV: "production" }, () => {
    const dir = getDefaultLocalReportsDirectory();
    assert.equal(dir, getServerlessTempReportsDirectory());
    assert.ok(!dir.replace(/\\/g, "/").includes("/var/task"), `Must never target read-only /var/task, got: ${dir}`);
  });
});

test("Automatic scheduled PDF with anchorToDatasetDates matches Smart Comparison dataset dates instead of empty present date", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qp-anchor-sched-"));
  const db = new Database(path.join(dir, "sched.sqlite"));
  try {
    const migrationDir = path.join(process.cwd(), "daily_data_analysis_and_notification", "database", "migrations");
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const name of readdirSync(migrationDir).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
      db.exec(readFileSync(path.join(migrationDir, name), "utf8"));
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(Number(name.split("_", 1)[0]), name);
    }
    const repository = new SqliteReportRepository(db);
    const pdfStorage = new LocalPrivatePdfStorage(path.join(dir, "pdfs"));
    await repository.saveSettings({
      ...getDefaultDailySettings("org_hist_2024"),
      selectedDomain: "sales_ecommerce",
      selectedDataset: "orders_2024",
      autoReportEnabled: true,
      frequency: "daily",
      scheduledTime: "00:15",
      timezone: "Asia/Dhaka"
    });

    const historicalRows = [
      { order_id: "o1", order_date: "2024-11-14", total_revenue: 1200, region: "Dhaka", product_name: "Laptop", order_status: "Completed" },
      { order_id: "o2", order_date: "2024-11-15", total_revenue: 1850, region: "Dhaka", product_name: "Laptop", order_status: "Completed" }
    ];

    const executor: ReadOnlyQueryExecutor = async (sql: string) => {
      if (sql.includes("FROM information_schema.columns")) {
        return [
          { table_schema: "public", table_name: "orders_2024", table_type: "BASE TABLE", column_name: "order_id", data_type: "text", udt_name: "text", is_nullable: "NO" },
          { table_schema: "public", table_name: "orders_2024", table_type: "BASE TABLE", column_name: "order_date", data_type: "date", udt_name: "date", is_nullable: "NO" },
          { table_schema: "public", table_name: "orders_2024", table_type: "BASE TABLE", column_name: "total_revenue", data_type: "numeric", udt_name: "numeric", is_nullable: "NO" },
          { table_schema: "public", table_name: "orders_2024", table_type: "BASE TABLE", column_name: "region", data_type: "text", udt_name: "text", is_nullable: "YES" },
          { table_schema: "public", table_name: "orders_2024", table_type: "BASE TABLE", column_name: "product_name", data_type: "text", udt_name: "text", is_nullable: "YES" },
          { table_schema: "public", table_name: "orders_2024", table_type: "BASE TABLE", column_name: "order_status", data_type: "text", udt_name: "text", is_nullable: "YES" }
        ];
      }
      if (sql.includes("FROM information_schema.table_constraints")) {
        return [{ table_schema: "public", table_name: "orders_2024", constraint_name: "orders_2024_pkey", constraint_type: "PRIMARY KEY", column_name: "order_id" }];
      }
      if (sql.includes("SELECT COUNT(*) AS row_count")) {
        return [{ row_count: historicalRows.length }];
      }
      if (sql.includes("c0_non_null")) {
        return [{
          c0_non_null: 2, c0_distinct: 2,
          c1_non_null: 2, c1_distinct: 2, c1_min: "2024-11-14", c1_max: "2024-11-15",
          c2_non_null: 2, c2_distinct: 2, c2_min: 1200, c2_max: 1850, c2_avg: 1525, c2_neg: 0, c2_zero: 0, c2_int_only: true,
          c3_non_null: 2, c3_distinct: 1,
          c4_non_null: 2, c4_distinct: 1,
          c5_non_null: 2, c5_distinct: 1
        }];
      }
      if (sql.includes("SELECT DISTINCT LOWER(TRIM(")) {
        return [{ token: "completed" }];
      }
      if (sql.includes("AS dup_check")) {
        return [{ duplicate_groups: 0, duplicate_rows: 0 }];
      }
      return historicalRows;
    };

    const result = await runScheduledReports({
      repository,
      pdfStorage,
      resolveSourceExecutor: async orgId => (orgId === "org_hist_2024" ? executor : null),
      organizationIdFilter: "org_hist_2024",
      anchorToDatasetDates: true,
      now: new Date("2026-11-27T06:00:00.000Z")
    });

    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0].status, "generated");
    const reportId = result.outcomes[0].reportId;
    assert.ok(reportId);

    const saved = await repository.getReportById("org_hist_2024", reportId);
    assert.ok(saved);
    assert.equal(saved.pdfStatus, "generated");
    // Anchored to the dataset's actual latest active date (2024-11-15) & previous active date (2024-11-14)
    assert.equal(saved.periodStart, "2024-11-15");
    assert.equal(saved.periodEnd, "2024-11-15");
    assert.equal(saved.comparisonStart, "2024-11-14");
    assert.equal(saved.comparisonEnd, "2024-11-14");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UI helper shows Scheduled (Local) instead of Storage not configured when local_private_fs is active", () => {
  const localDevStatus: StorageCapabilityStatus = {
    databaseBackend: "sqlite",
    databaseProductionReady: false,
    pdfBackend: "local_private_fs",
    pdfProductionReady: false,
    schedulerSecretConfigured: false,
    schedulerOrgDbMapConfigured: false,
    schedulerOrgDbMapStatus: "missing",
    schedulerOrgMappedForCurrentOrg: false,
    schedulerOrgDbMapError: "Missing",
    schedulerProductionReady: false,
    missingProductionConfig: ["QUERYPILOT_APP_DATABASE_URL", "QUERYPILOT_STORAGE_BUCKET"]
  };

  const state = resolveAutoReportDisplayState({
    autoReportEnabled: true,
    saving: false,
    storageStatus: localDevStatus,
    scheduleSummary: null,
    latestReport: null
  });
  assert.equal(state.code, "scheduled");
  assert.equal(state.label, "Scheduled (Local)");
});
