import { createClient } from "@supabase/supabase-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  PdfStorageAdapter,
  SchedulerOrgDbMapStatus,
  StorageCapabilityStatus,
  StoredPdfDescriptor
} from "./types";

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

export const DEFAULT_SHARED_STORAGE_BUCKET = "querypilotx-storage";

export function buildPrivatePdfStorageKey(
  organizationId: string,
  reportId: string,
  filename: string,
  storageUserId?: string
): string {
  const safeName = safePathSegment(filename);
  if (storageUserId && /^[a-zA-Z0-9_-]{1,128}$/.test(storageUserId.trim())) {
    const prefix = safePathSegment(reportId).slice(0, 8) || "report";
    return `${storageUserId.trim()}/reports/${prefix}-${safeName}`;
  }
  return `${safePathSegment(organizationId)}/${safePathSegment(reportId)}/${safeName}`;
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

  async savePdf(input: {
    organizationId: string;
    storageUserId?: string;
    reportId: string;
    filename: string;
    bytes: Buffer;
  }): Promise<StoredPdfDescriptor> {
    assertValidPdfBuffer(input.bytes);
    const storageKey = buildPrivatePdfStorageKey(
      input.organizationId,
      input.reportId,
      input.filename,
      input.storageUserId
    );
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

  async savePdf(input: {
    organizationId: string;
    storageUserId?: string;
    reportId: string;
    filename: string;
    bytes: Buffer;
  }): Promise<StoredPdfDescriptor> {
    assertValidPdfBuffer(input.bytes);
    const storageKey = buildPrivatePdfStorageKey(
      input.organizationId,
      input.reportId,
      input.filename,
      input.storageUserId
    );
    const supabase = this.client();
    let { error } = await supabase.storage.from(this.bucket).upload(storageKey, input.bytes, {
      contentType: "application/pdf",
      upsert: true
    });
    if (error && /bucket.*not found/i.test(error.message)) {
      // Ensure shared private bucket exists (aligned with src/lib/storage/client.ts)
      await supabase.storage.createBucket(this.bucket, {
        public: false,
        fileSizeLimit: 52428800
      }).catch(() => undefined);
      const retry = await supabase.storage.from(this.bucket).upload(storageKey, input.bytes, {
        contentType: "application/pdf",
        upsert: true
      });
      error = retry.error;
    }
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

export function resolveSharedPdfStorageEnv(): {
  url: string;
  serviceRoleKey: string;
  bucket: string;
  configured: boolean;
} {
  const url = (
    process.env.QUERYPILOT_STORAGE_SUPABASE_URL
    || process.env.QUERYPILOT_CORE_SUPABASE_URL
    || ""
  ).trim();
  const serviceRoleKey = (
    process.env.QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.QUERYPILOT_CORE_SUPABASE_ANON_KEY
    || ""
  ).trim();
  const explicitBucket = (process.env.QUERYPILOT_STORAGE_BUCKET || "").trim();
  const bucket = explicitBucket || (url && serviceRoleKey ? DEFAULT_SHARED_STORAGE_BUCKET : "");
  return {
    url,
    serviceRoleKey,
    bucket,
    configured: Boolean(url && serviceRoleKey && bucket)
  };
}

export function resolveAppDatabaseUrl(): string {
  return (
    process.env.QUERYPILOT_APP_DATABASE_URL
    || process.env.DATABASE_URL
    || ""
  ).trim();
}

export function createDefaultPdfStorage(): PdfStorageAdapter {
  const storageEnv = resolveSharedPdfStorageEnv();

  if (storageEnv.configured) {
    return new SupabasePrivatePdfStorage({
      url: storageEnv.url,
      serviceRoleKey: storageEnv.serviceRoleKey,
      bucket: storageEnv.bucket
    });
  }
  if (isServerlessProduction() && !process.env.QUERYPILOT_ALLOW_LOCAL_PDF_STORAGE) {
    return new UnconfiguredProductionPdfStorage();
  }
  return new LocalPrivatePdfStorage();
}

export type SchedulerOrgDbMapInspection = {
  configured: boolean;
  status: SchedulerOrgDbMapStatus;
  validOrgCount: number;
  invalidOrgCount: number;
  organizationMapped: boolean | null;
  error: string | null;
};

export function isValidPostgresConnectionUri(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!/^postgres(?:ql)?:\/\/.+/i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Validates `QUERYPILOT_SCHEDULER_ORG_DB_MAP` presence, JSON object structure, PostgreSQL URI
 * syntax, and optional organisation membership without ever exposing URIs or credentials.
 */
export function inspectSchedulerOrgDbMap(
  rawValue: string | undefined | null = process.env.QUERYPILOT_SCHEDULER_ORG_DB_MAP,
  organizationId?: string
): SchedulerOrgDbMapInspection {
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!raw) {
    return {
      configured: false,
      status: "missing",
      validOrgCount: 0,
      invalidOrgCount: 0,
      organizationMapped: organizationId ? false : null,
      error: "QUERYPILOT_SCHEDULER_ORG_DB_MAP is not configured for unattended background scheduling."
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      configured: false,
      status: "invalid_json",
      validOrgCount: 0,
      invalidOrgCount: 0,
      organizationMapped: organizationId ? false : null,
      error: "QUERYPILOT_SCHEDULER_ORG_DB_MAP must be a valid JSON object mapping organisation IDs to read-only PostgreSQL URIs."
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      configured: false,
      status: "invalid_json",
      validOrgCount: 0,
      invalidOrgCount: 0,
      organizationMapped: organizationId ? false : null,
      error: "QUERYPILOT_SCHEDULER_ORG_DB_MAP must be a JSON object (not an array or primitive)."
    };
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    return {
      configured: false,
      status: "missing",
      validOrgCount: 0,
      invalidOrgCount: 0,
      organizationMapped: organizationId ? false : null,
      error: "QUERYPILOT_SCHEDULER_ORG_DB_MAP contains no organisation database mappings."
    };
  }

  let validOrgCount = 0;
  let invalidOrgCount = 0;
  let orgMapped = false;
  let orgUriInvalid = false;

  for (const [orgKey, uriVal] of entries) {
    const cleanKey = orgKey.trim();
    const uriOk = Boolean(cleanKey) && isValidPostgresConnectionUri(uriVal);
    if (uriOk) {
      validOrgCount += 1;
      if (organizationId && cleanKey === organizationId) {
        orgMapped = true;
      }
    } else {
      invalidOrgCount += 1;
      if (organizationId && cleanKey === organizationId) {
        orgUriInvalid = true;
      }
    }
  }

  if (orgUriInvalid || (invalidOrgCount > 0 && validOrgCount === 0)) {
    return {
      configured: false,
      status: "invalid_uri",
      validOrgCount,
      invalidOrgCount,
      organizationMapped: organizationId ? false : null,
      error: orgUriInvalid
        ? "Configured background database URI for this organisation is not a valid PostgreSQL connection string."
        : "QUERYPILOT_SCHEDULER_ORG_DB_MAP contains invalid PostgreSQL connection URI(s)."
    };
  }

  if (organizationId && !orgMapped) {
    return {
      configured: validOrgCount > 0,
      status: "org_not_mapped",
      validOrgCount,
      invalidOrgCount,
      organizationMapped: false,
      error: "Current organisation is not present in QUERYPILOT_SCHEDULER_ORG_DB_MAP; unattended background runs will skip it."
    };
  }

  if (invalidOrgCount > 0) {
    return {
      configured: false,
      status: "invalid_uri",
      validOrgCount,
      invalidOrgCount,
      organizationMapped: organizationId ? orgMapped : null,
      error: `QUERYPILOT_SCHEDULER_ORG_DB_MAP has ${invalidOrgCount} invalid PostgreSQL URI entry(s).`
    };
  }

  return {
    configured: true,
    status: "valid",
    validOrgCount,
    invalidOrgCount: 0,
    organizationMapped: organizationId ? orgMapped : null,
    error: null
  };
}

export function getStorageCapabilityStatus(organizationId?: string): StorageCapabilityStatus {
  const hasAppDb = Boolean(resolveAppDatabaseUrl());
  const storageEnv = resolveSharedPdfStorageEnv();
  const hasPdfBucket = storageEnv.configured;
  const hasSchedulerSecret = Boolean(
    process.env.CRON_SECRET?.trim() || process.env.QUERYPILOT_SCHEDULER_SECRET?.trim()
  );
  const orgMap = inspectSchedulerOrgDbMap(process.env.QUERYPILOT_SCHEDULER_ORG_DB_MAP, organizationId);
  const orgMapReady = orgMap.status === "valid" && (organizationId ? orgMap.organizationMapped === true : orgMap.validOrgCount > 0);

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
  if (!orgMapReady) missing.push("QUERYPILOT_SCHEDULER_ORG_DB_MAP");

  return {
    databaseBackend: hasAppDb ? "postgres" : "sqlite",
    databaseProductionReady: hasAppDb,
    pdfBackend: hasPdfBucket ? "supabase_private_storage" : isServerlessProduction() ? "unconfigured" : "local_private_fs",
    pdfProductionReady: hasPdfBucket,
    schedulerSecretConfigured: hasSchedulerSecret,
    schedulerOrgDbMapConfigured: orgMap.configured,
    schedulerOrgDbMapStatus: orgMap.status,
    schedulerOrgMappedForCurrentOrg: orgMap.organizationMapped,
    schedulerOrgDbMapError: orgMap.error,
    schedulerProductionReady: hasAppDb && hasPdfBucket && hasSchedulerSecret && orgMapReady,
    missingProductionConfig: missing
  };
}
