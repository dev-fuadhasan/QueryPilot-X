import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDefaultPdfStorage,
  getDefaultDailySettings,
  getDefaultLocalReportsDirectory,
  LocalPrivatePdfStorage,
  SupabasePrivatePdfStorage
} from "../storage";
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
