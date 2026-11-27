import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStorageSupabaseClient, ensureStorageBucket } from "@/lib/storage/client";
import { getStorageConfig, STORAGE_BUCKET_NAME } from "@/lib/storage/config";
import { downloadFile, listUserFiles, uploadFile } from "@/lib/storage/service";
import type { StoredFileDescriptor } from "@/lib/storage/types";
import { validateUserId } from "@/lib/storage/validation";
import type { BusinessDomainId } from "../profiler/types";
import { assertValidPdfBuffer, getDefaultLocalReportsDirectory } from "./pdf-storage";
import type {
  PersistentDailySettings,
  PersistentReportSummary,
  ReportFrequency,
  ReportFrequencyOrManual,
  ReportGenerationType
} from "./types";

type StoredSettingsEnvelope = {
  settings: PersistentDailySettings;
  cursors?: Partial<Record<ReportFrequency, string>>;
  updatedAt: string;
};

type LocalPdfSidecarMetadata = {
  fileId: string;
  userId: string;
  filename: string;
  storageKey: string;
  sizeBytes: number;
  createdAt: string;
  metadata?: {
    domainId?: string;
    domainName?: string;
    datasetTable?: string;
    frequency?: string;
    periodStart?: string;
    periodEnd?: string;
    generationType?: string;
    summaryText?: string;
  };
};

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename || "report.pdf");
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+|\.+$/g, "").slice(0, 140);
  if (!cleaned) return "report.pdf";
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

function getLocalStorageRoot(): string {
  return getDefaultLocalReportsDirectory();
}

function settingsStorageKey(userId: string): string {
  return `${validateUserId(userId)}/general/daily-analysis-settings.json`;
}

function resolveLocalPath(key: string): string {
  const root = getLocalStorageRoot();
  const normalized = key.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(root, normalized);
  const rel = path.relative(root, target);
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
  const client = isSharedStorageConfigured() ? getStorageSupabaseClient() : null;

  // Priority 1: Cloud storage whenever configured
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
      // Fall through to temporary local storage fallback
    }
  }

  // Priority 2: Temporary local gitignored module storage (`daily_data_analysis_and_notification/generated-reports/`)
  try {
    const text = await readFile(resolveLocalPath(key), "utf8");
    const parsed = JSON.parse(text) as StoredSettingsEnvelope;
    if (parsed && typeof parsed === "object" && parsed.settings) {
      return parsed;
    }
  } catch {
    return null;
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
  const client = isSharedStorageConfigured() ? getStorageSupabaseClient() : null;
  let savedToCloud = false;
  let cloudError: string | null = null;

  // Priority 1: Cloud storage whenever configured
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

  // Priority 2: Temporary local module storage fallback
  if (!savedToCloud) {
    try {
      const localTarget = resolveLocalPath(key);
      await mkdir(path.dirname(localTarget), { recursive: true });
      await writeFile(localTarget, payload);
    } catch (localErr) {
      const localMsg = localErr instanceof Error ? localErr.message : String(localErr);
      throw new Error(cloudError || `Unable to save Daily Analysis settings locally: ${localMsg}`);
    }
  }

  return envelope;
}

async function savePdfToTemporaryLocalFolder(input: {
  userId: string;
  filename: string;
  bytes: Buffer;
  metadata?: Record<string, unknown>;
}): Promise<StoredFileDescriptor> {
  const safeUserId = validateUserId(input.userId);
  assertValidPdfBuffer(input.bytes);

  const safeFilename = sanitizeFilename(input.filename);
  const fileId = randomUUID().replace(/-/g, "").slice(0, 12);
  const storageKey = `${safeUserId}/reports/${fileId}-${safeFilename}`;
  const fullPath = resolveLocalPath(storageKey);

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, input.bytes);

  // Verify the saved PDF can be read back with a valid %PDF- header
  const verifyBytes = await readFile(fullPath);
  assertValidPdfBuffer(verifyBytes);

  const createdAt = new Date().toISOString();
  const sidecar: LocalPdfSidecarMetadata = {
    fileId,
    userId: safeUserId,
    filename: safeFilename,
    storageKey,
    sizeBytes: input.bytes.byteLength,
    createdAt,
    metadata: input.metadata
      ? {
          domainId: typeof input.metadata.domainId === "string" ? input.metadata.domainId : undefined,
          domainName: typeof input.metadata.domainName === "string" ? input.metadata.domainName : undefined,
          datasetTable: typeof input.metadata.datasetTable === "string" ? input.metadata.datasetTable : undefined,
          frequency: typeof input.metadata.frequency === "string" ? input.metadata.frequency : undefined,
          periodStart: typeof input.metadata.periodStart === "string" ? input.metadata.periodStart : undefined,
          periodEnd: typeof input.metadata.periodEnd === "string" ? input.metadata.periodEnd : undefined,
          generationType: typeof input.metadata.generationType === "string" ? input.metadata.generationType : undefined,
          summaryText: typeof input.metadata.summaryText === "string" ? input.metadata.summaryText : undefined
        }
      : undefined
  };

  await writeFile(`${fullPath}.meta.json`, JSON.stringify(sidecar, null, 2), "utf8");

  return {
    fileId,
    userId: safeUserId,
    category: "reports",
    filename: safeFilename,
    storageKey,
    mimeType: "application/pdf",
    sizeBytes: input.bytes.byteLength,
    backend: "local_secure_storage",
    createdAt
  };
}

export async function uploadDailyPdfToSharedStorage(input: {
  userId: string;
  filename: string;
  bytes: Buffer;
  metadata?: Record<string, unknown>;
}): Promise<StoredFileDescriptor> {
  assertValidPdfBuffer(input.bytes);

  // Priority 1: Cloud Supabase Storage automatically whenever configured
  if (isSharedStorageConfigured()) {
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

  // Priority 2: Temporary gitignored local storage (`daily_data_analysis_and_notification/generated-reports/`)
  return savePdfToTemporaryLocalFolder(input);
}

export async function downloadDailyPdfFromSharedStorage(userId: string, storageKey: string): Promise<Buffer | null> {
  const safeUserId = validateUserId(userId);
  const normalizedKey = storageKey.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedKey.startsWith(`${safeUserId}/`)) {
    return null;
  }

  // Priority 1: Cloud download when configured
  if (isSharedStorageConfigured()) {
    try {
      const result = await downloadFile(safeUserId, normalizedKey);
      if (result.buffer) return result.buffer;
    } catch {
      // Fall through to check temporary local folder
    }
  }

  // Priority 2: Temporary local module folder
  try {
    const localPath = resolveLocalPath(normalizedKey);
    const bytes = await readFile(localPath);
    assertValidPdfBuffer(bytes);
    return bytes;
  } catch {
    return null;
  }
}

export async function findLocalDailyPdfByReportId(
  userId: string,
  reportId: string
): Promise<{ bytes: Buffer; filename: string; storageKey: string } | null> {
  const safeUserId = validateUserId(userId);
  const cleanedId = reportId.replace(/^(?:local_|cloud_)/, "").trim();
  if (!cleanedId || !/^[a-zA-Z0-9_-]{1,128}$/.test(cleanedId)) {
    return null;
  }

  const reportsDirKey = `${safeUserId}/reports`;
  const reportsDir = resolveLocalPath(reportsDirKey);
  let entries: string[];
  try {
    entries = await readdir(reportsDir);
  } catch {
    return null;
  }

  const shortPrefix = cleanedId.slice(0, 8);
  const pdfEntries = entries.filter(name => /\.pdf$/i.test(name));
  for (const entry of pdfEntries) {
    const matchesExact = entry.startsWith(`${cleanedId}-`) || entry === `${cleanedId}.pdf`;
    const matchesShort = shortPrefix.length >= 6 && entry.startsWith(`${shortPrefix}-`);
    if (!matchesExact && !matchesShort) continue;

    const storageKey = `${reportsDirKey}/${entry}`;
    try {
      const fullPath = resolveLocalPath(storageKey);
      const bytes = await readFile(fullPath);
      assertValidPdfBuffer(bytes);
      let filename = entry.replace(/^[a-f0-9-]{6,36}-/i, "") || entry;
      try {
        const metaRaw = await readFile(`${fullPath}.meta.json`, "utf8");
        const meta = JSON.parse(metaRaw) as LocalPdfSidecarMetadata;
        if (meta?.filename) filename = meta.filename;
      } catch {
        // Sidecar optional
      }
      return { bytes, filename, storageKey };
    } catch {
      continue;
    }
  }

  return null;
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
  organizationId: string,
  sidecarMeta?: LocalPdfSidecarMetadata["metadata"]
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

  if (sidecarMeta?.domainId && sidecarMeta.domainId in DOMAIN_LABELS) {
    domainId = sidecarMeta.domainId as BusinessDomainId;
  }
  if (sidecarMeta?.frequency && ["daily", "weekly", "monthly", "manual"].includes(sidecarMeta.frequency)) {
    frequency = sidecarMeta.frequency as ReportFrequencyOrManual;
  }
  if (sidecarMeta?.periodStart) periodStart = sidecarMeta.periodStart;
  if (sidecarMeta?.periodEnd) periodEnd = sidecarMeta.periodEnd;

  const generationType: ReportGenerationType = sidecarMeta?.generationType === "automatic"
    ? "automatic"
    : sidecarMeta?.generationType === "manual"
      ? "manual"
      : frequency === "manual"
        ? "manual"
        : "automatic";

  const isLocal = file.backend === "local_secure_storage";
  const idPrefix = isLocal ? "local_" : "cloud_";

  return {
    id: `${idPrefix}${file.fileId}`,
    organizationId,
    ownerRef: file.userId,
    domainId,
    domainName: sidecarMeta?.domainName || DOMAIN_LABELS[domainId] || "Daily Analysis",
    datasetTable: sidecarMeta?.datasetTable || (isLocal ? "local-archive" : "cloud-archive"),
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
    summaryText: sidecarMeta?.summaryText || `Stored PDF report (${filename})`,
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

async function listLocalTemporaryDailyPdfs(
  userId: string,
  organizationId: string
): Promise<PersistentReportSummary[]> {
  const safeUserId = validateUserId(userId);
  const reportsDirKey = `${safeUserId}/reports`;
  const reportsDir = resolveLocalPath(reportsDirKey);
  let entries: string[];
  try {
    entries = await readdir(reportsDir);
  } catch {
    return [];
  }

  const summaries: PersistentReportSummary[] = [];
  for (const entry of entries) {
    if (!/\.pdf$/i.test(entry)) continue;
    const storageKey = `${reportsDirKey}/${entry}`;
    try {
      const fullPath = resolveLocalPath(storageKey);
      const info = await stat(fullPath);
      if (!info.isFile() || info.size < 100) continue;

      let sidecar: LocalPdfSidecarMetadata | null = null;
      try {
        const raw = await readFile(`${fullPath}.meta.json`, "utf8");
        sidecar = JSON.parse(raw) as LocalPdfSidecarMetadata;
      } catch {
        sidecar = null;
      }

      const prefixMatch = /^([a-zA-Z0-9_-]{6,36})-(.+\.pdf)$/i.exec(entry);
      const fileId = sidecar?.fileId || (prefixMatch ? prefixMatch[1] : entry.replace(/\.pdf$/i, ""));
      const filename = sidecar?.filename || (prefixMatch ? prefixMatch[2] : entry);
      const createdAt = sidecar?.createdAt || info.mtime.toISOString();

      summaries.push(
        parsePdfDescriptorToSummary(
          {
            fileId,
            userId: safeUserId,
            category: "reports",
            filename,
            storageKey,
            mimeType: "application/pdf",
            sizeBytes: info.size,
            backend: "local_secure_storage",
            createdAt
          },
          organizationId,
          sidecar?.metadata
        )
      );
    } catch {
      continue;
    }
  }

  return summaries.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export async function listDailyPdfsFromSharedStorage(
  userId: string,
  organizationId: string
): Promise<PersistentReportSummary[]> {
  const localPromise = listLocalTemporaryDailyPdfs(userId, organizationId).catch(() => [] as PersistentReportSummary[]);

  let cloudSummaries: PersistentReportSummary[] = [];
  if (isSharedStorageConfigured()) {
    try {
      const files = await listUserFiles({
        userId,
        category: "reports",
        limit: 100
      });
      cloudSummaries = files
        .filter(file => /\.pdf$/i.test(file.filename) || file.mimeType === "application/pdf")
        .map(file => parsePdfDescriptorToSummary(file, organizationId));
    } catch {
      cloudSummaries = [];
    }
  }

  const localSummaries = await localPromise;

  // Deduplicate by storageKey (cloud priority when configured, plus any local temporary reports)
  const seenKeys = new Set<string>();
  const combined: PersistentReportSummary[] = [];
  for (const item of cloudSummaries) {
    if (item.pdfStorageKey) seenKeys.add(item.pdfStorageKey);
    combined.push(item);
  }
  for (const item of localSummaries) {
    if (item.pdfStorageKey && seenKeys.has(item.pdfStorageKey)) continue;
    combined.push(item);
  }

  return combined.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}
