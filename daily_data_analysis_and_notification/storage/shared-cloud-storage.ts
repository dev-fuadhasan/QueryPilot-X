import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStorageSupabaseClient, ensureStorageBucket } from "@/lib/storage/client";
import { getStorageConfig, isServerlessProduction, STORAGE_BUCKET_NAME } from "@/lib/storage/config";
import { downloadFile, listUserFiles, uploadFile } from "@/lib/storage/service";
import type { StoredFileDescriptor } from "@/lib/storage/types";
import { validateUserId } from "@/lib/storage/validation";
import type { BusinessDomainId } from "../profiler/types";
import type {
  PersistentDailySettings,
  PersistentReportSummary,
  ReportFrequency,
  ReportFrequencyOrManual,
  ReportGenerationType
} from "./types";

const LOCAL_SHARED_DIR = path.join(process.cwd(), ".local-data", "querypilotx-storage");

type StoredSettingsEnvelope = {
  settings: PersistentDailySettings;
  cursors?: Partial<Record<ReportFrequency, string>>;
  updatedAt: string;
};

function settingsStorageKey(userId: string): string {
  return `${validateUserId(userId)}/general/daily-analysis-settings.json`;
}

function resolveLocalPath(key: string): string {
  const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(LOCAL_SHARED_DIR, normalized);
  const rel = path.relative(LOCAL_SHARED_DIR, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Invalid local storage path.");
  }
  return target;
}

export function isSharedStorageConfigured(): boolean {
  const cfg = getStorageConfig();
  return Boolean(cfg.supabaseUrl && cfg.supabaseKey && cfg.bucket);
}

export async function loadSharedSettingsEnvelope(userId: string): Promise<StoredSettingsEnvelope | null> {
  const key = settingsStorageKey(userId);
  const client = getStorageSupabaseClient();

  if (client) {
    try {
      const { data, error } = await client.storage.from(STORAGE_BUCKET_NAME).download(key);
      if (!error && data) {
        const text = await data.text();
        const parsed = JSON.parse(text) as StoredSettingsEnvelope;
        if (parsed && typeof parsed === "object" && parsed.settings) {
          return parsed;
        }
      }
    } catch {
      // Fall through to local dev check if not production
    }
  }

  if (!isServerlessProduction()) {
    try {
      const text = await readFile(resolveLocalPath(key), "utf8");
      const parsed = JSON.parse(text) as StoredSettingsEnvelope;
      if (parsed && typeof parsed === "object" && parsed.settings) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
}

export async function saveSharedSettingsEnvelope(
  userId: string,
  settings: PersistentDailySettings,
  cursors?: Partial<Record<ReportFrequency, string>>
): Promise<StoredSettingsEnvelope> {
  const existing = await loadSharedSettingsEnvelope(userId);
  const envelope: StoredSettingsEnvelope = {
    settings,
    cursors: { ...(existing?.cursors || {}), ...(cursors || {}) },
    updatedAt: new Date().toISOString()
  };

  const key = settingsStorageKey(userId);
  const payload = Buffer.from(JSON.stringify(envelope, null, 2), "utf8");
  const client = getStorageSupabaseClient();
  let savedToCloud = false;
  let cloudError: string | null = null;

  if (client) {
    try {
      await ensureStorageBucket();
      const { error } = await client.storage.from(STORAGE_BUCKET_NAME).upload(key, payload, {
        contentType: "application/json",
        upsert: true
      });
      if (!error) {
        savedToCloud = true;
      } else {
        cloudError = error.message;
      }
    } catch (err) {
      cloudError = err instanceof Error ? err.message : String(err);
    }
  }

  if (!savedToCloud) {
    if (isServerlessProduction()) {
      throw new Error(cloudError || "Unable to save Daily Analysis settings to shared cloud storage.");
    }
    const localTarget = resolveLocalPath(key);
    await mkdir(path.dirname(localTarget), { recursive: true });
    await writeFile(localTarget, payload);
  }

  return envelope;
}

export async function uploadDailyPdfToSharedStorage(input: {
  userId: string;
  filename: string;
  bytes: Buffer;
  metadata?: Record<string, unknown>;
}): Promise<StoredFileDescriptor> {
  await ensureStorageBucket().catch(() => undefined);
  return uploadFile({
    userId: input.userId,
    category: "reports",
    filename: input.filename,
    buffer: input.bytes,
    mimeType: "application/pdf",
    metadata: input.metadata
  });
}

export async function downloadDailyPdfFromSharedStorage(userId: string, storageKey: string): Promise<Buffer | null> {
  try {
    const result = await downloadFile(userId, storageKey);
    return result.buffer ?? null;
  } catch {
    return null;
  }
}

const DOMAIN_LABELS: Record<string, string> = {
  sales_ecommerce: "Sales & E-commerce",
  inventory_supply_chain: "Inventory & Supply Chain",
  marketing_campaigns: "Marketing & Campaigns",
  finance_accounting: "Finance & Accounting",
  operations_logistics: "Operations & Logistics",
  customer_crm: "Customer & CRM",
  saas_product: "SaaS & Product"
};

function parsePdfDescriptorToSummary(
  file: StoredFileDescriptor,
  organizationId: string
): PersistentReportSummary {
  const filename = file.filename || path.basename(file.storageKey);
  const createdIso = file.createdAt || new Date().toISOString();
  const createdDate = createdIso.slice(0, 10);

  // Expected pattern from buildReportPdfFilename:
  // querypilot-x-<domain>-<freq>-<YYYY-MM-DD>-to-<YYYY-MM-DD>.pdf
  // or querypilot-x-<domain>-<freq>-<YYYY-MM-DD>.pdf
  const rangeMatch = /^querypilot-x-([a-z0-9_-]+?)-(daily|weekly|monthly|manual)-(\d{4}-\d{2}-\d{2})(?:-to-(\d{4}-\d{2}-\d{2}))?\.pdf$/i.exec(filename);

  let domainId: BusinessDomainId = "sales_ecommerce";
  let frequency: ReportFrequencyOrManual = "manual";
  let periodStart = createdDate;
  let periodEnd = createdDate;

  if (rangeMatch) {
    const parsedDomain = rangeMatch[1].replace(/-/g, "_");
    if (parsedDomain in DOMAIN_LABELS) {
      domainId = parsedDomain as BusinessDomainId;
    }
    frequency = rangeMatch[2].toLowerCase() as ReportFrequencyOrManual;
    periodStart = rangeMatch[3];
    periodEnd = rangeMatch[4] || rangeMatch[3];
  }

  const generationType: ReportGenerationType = frequency === "manual" ? "manual" : "automatic";

  return {
    id: `cloud_${file.fileId}`,
    organizationId,
    ownerRef: file.userId,
    domainId,
    domainName: DOMAIN_LABELS[domainId] || "Daily Analysis",
    datasetTable: "cloud-archive",
    reportingDate: periodEnd,
    periodStart,
    periodEnd,
    comparisonStart: null,
    comparisonEnd: null,
    comparisonPreset: null,
    frequency,
    generationType,
    executionKey: null,
    status: "generated",
    summaryText: `Stored PDF report (${filename})`,
    pdfStatus: "generated",
    pdfStorageKey: file.storageKey,
    pdfFilename: filename,
    pdfGeneratedAt: createdIso,
    pdfSizeBytes: file.sizeBytes || null,
    pdfError: null,
    errorMessage: null,
    generatedAt: createdIso,
    createdAt: createdIso
  };
}

export async function listDailyPdfsFromSharedStorage(
  userId: string,
  organizationId: string
): Promise<PersistentReportSummary[]> {
  const files = await listUserFiles({
    userId,
    category: "reports",
    limit: 100
  });
  return files
    .filter(file => /\.pdf$/i.test(file.filename) || file.mimeType === "application/pdf")
    .map(file => parsePdfDescriptorToSummary(file, organizationId))
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}
