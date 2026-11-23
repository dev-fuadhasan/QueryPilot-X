import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PdfStorageAdapter, StorageCapabilityStatus, StoredPdfDescriptor } from "./types";

function safePathSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+|\.+$/g, "").slice(0, 120);
  if (!cleaned || cleaned.includes("..")) {
    throw new Error("Invalid storage path segment.");
  }
  return cleaned;
}

export function assertValidPdfBuffer(bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 100) {
    throw new Error("Generated PDF is empty or truncated.");
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Generated output does not contain a valid %PDF- header.");
  }
}

export function buildPrivatePdfStorageKey(organizationId: string, reportId: string, filename: string): string {
  return `${safePathSegment(organizationId)}/${safePathSegment(reportId)}/${safePathSegment(filename)}`;
}

/**
 * Local filesystem private storage adapter — intended for local development and tests ONLY.
 * Never exposes public URLs and enforces strict base-directory containment against path traversal.
 */
export class LocalPrivatePdfStorage implements PdfStorageAdapter {
  readonly backendName = "local_private_fs" as const;
  readonly isProductionPersistent = false;
  private readonly baseDirectory: string;

  constructor(baseDirectory?: string) {
    this.baseDirectory = path.resolve(
      baseDirectory || process.env.QUERYPILOT_REPORT_DIRECTORY || path.join(process.cwd(), ".local-data", "private-pdfs")
    );
  }

  private resolveSafePath(storageKey: string): string {
    const normalizedKey = storageKey.replace(/\\/g, "/").replace(/^\/+/, "");
    const target = path.resolve(this.baseDirectory, normalizedKey);
    const relative = path.relative(this.baseDirectory, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Storage key escapes private storage root.");
    }
    return target;
  }

  async savePdf(input: { organizationId: string; reportId: string; filename: string; bytes: Buffer }): Promise<StoredPdfDescriptor> {
    assertValidPdfBuffer(input.bytes);
    const storageKey = buildPrivatePdfStorageKey(input.organizationId, input.reportId, input.filename);
    const fullPath = this.resolveSafePath(storageKey);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, input.bytes);
    return {
      storageKey,
      filename: safePathSegment(input.filename),
      sizeBytes: input.bytes.byteLength,
      backend: "local_private_fs"
    };
  }

  async readPdf(storageKey: string): Promise<Buffer | null> {
    const fullPath = this.resolveSafePath(storageKey);
    try {
      const bytes = await readFile(fullPath);
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

/**
 * Application-owned private Supabase Storage bucket adapter (strictly separate from the
 * organisation's connected read-only source database). Uses private upload/download only
 * and never creates or persists public URLs.
 */
export class SupabasePrivatePdfStorage implements PdfStorageAdapter {
  readonly backendName = "supabase_private_storage" as const;
  readonly isProductionPersistent = true;
  private readonly url: string;
  private readonly serviceRoleKey: string;
  private readonly bucket: string;

  constructor(config: { url: string; serviceRoleKey: string; bucket: string }) {
    if (!config.url || !config.serviceRoleKey || !config.bucket) {
      throw new Error("Supabase private PDF storage requires URL, service role key, and private bucket name.");
    }
    this.url = config.url;
    this.serviceRoleKey = config.serviceRoleKey;
    this.bucket = config.bucket;
  }

  private client() {
    return createClient(this.url, this.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }

  async savePdf(input: { organizationId: string; reportId: string; filename: string; bytes: Buffer }): Promise<StoredPdfDescriptor> {
    assertValidPdfBuffer(input.bytes);
    const storageKey = buildPrivatePdfStorageKey(input.organizationId, input.reportId, input.filename);
    const { error } = await this.client().storage.from(this.bucket).upload(storageKey, input.bytes, {
      contentType: "application/pdf",
      upsert: true
    });
    if (error) {
      throw new Error(`Private PDF upload failed: ${error.message}`);
    }
    return {
      storageKey,
      filename: safePathSegment(input.filename),
      sizeBytes: input.bytes.byteLength,
      backend: "supabase_private_storage"
    };
  }

  async readPdf(storageKey: string): Promise<Buffer | null> {
    const { data, error } = await this.client().storage.from(this.bucket).download(storageKey);
    if (error) {
      if (/not found/i.test(error.message)) return null;
      throw new Error(`Private PDF download failed: ${error.message}`);
    }
    if (!data) return null;
    return Buffer.from(await data.arrayBuffer());
  }
}

/**
 * Explicit fail-loud adapter used on serverless production deployments when private object
 * storage credentials are missing — prevents pretending ephemeral disk storage is permanent.
 */
export class UnconfiguredProductionPdfStorage implements PdfStorageAdapter {
  readonly backendName = "unconfigured" as const;
  readonly isProductionPersistent = false;

  async savePdf(_input: {
    organizationId: string;
    reportId: string;
    filename: string;
    bytes: Buffer;
  }): Promise<StoredPdfDescriptor> {
    throw new Error(
      "Permanent private PDF storage is not configured for production. Configure QUERYPILOT_STORAGE_SUPABASE_URL, QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY, and QUERYPILOT_STORAGE_BUCKET."
    );
  }

  async readPdf(): Promise<Buffer | null> {
    return null;
  }
}

export function isServerlessProduction(): boolean {
  return Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
}

export function createDefaultPdfStorage(): PdfStorageAdapter {
  const url = process.env.QUERYPILOT_STORAGE_SUPABASE_URL?.trim();
  const key = process.env.QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucket = process.env.QUERYPILOT_STORAGE_BUCKET?.trim();

  if (url && key && bucket) {
    return new SupabasePrivatePdfStorage({ url, serviceRoleKey: key, bucket });
  }
  if (isServerlessProduction() && !process.env.QUERYPILOT_ALLOW_LOCAL_PDF_STORAGE) {
    return new UnconfiguredProductionPdfStorage();
  }
  return new LocalPrivatePdfStorage();
}

export function getStorageCapabilityStatus(): StorageCapabilityStatus {
  const hasAppDb = Boolean(process.env.QUERYPILOT_APP_DATABASE_URL?.trim());
  const hasPdfBucket = Boolean(
    process.env.QUERYPILOT_STORAGE_SUPABASE_URL?.trim()
    && process.env.QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY?.trim()
    && process.env.QUERYPILOT_STORAGE_BUCKET?.trim()
  );
  const hasSchedulerSecret = Boolean(
    process.env.CRON_SECRET?.trim() || process.env.QUERYPILOT_SCHEDULER_SECRET?.trim()
  );

  const missing: string[] = [];
  if (!hasAppDb) missing.push("QUERYPILOT_APP_DATABASE_URL");
  if (!hasPdfBucket) {
    missing.push(
      "QUERYPILOT_STORAGE_SUPABASE_URL",
      "QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY",
      "QUERYPILOT_STORAGE_BUCKET"
    );
  }
  if (!hasSchedulerSecret) missing.push("CRON_SECRET");

  return {
    databaseBackend: hasAppDb ? "postgres" : "sqlite",
    databaseProductionReady: hasAppDb,
    pdfBackend: hasPdfBucket ? "supabase_private_storage" : isServerlessProduction() ? "unconfigured" : "local_private_fs",
    pdfProductionReady: hasPdfBucket,
    schedulerSecretConfigured: hasSchedulerSecret,
    schedulerProductionReady: hasAppDb && hasPdfBucket && hasSchedulerSecret,
    missingProductionConfig: missing
  };
}
