/**
 * Supabase Storage configuration loader for QueryPilot-X.
 * Safely resolves existing configuration from environment variables without exposing secrets.
 */

export const STORAGE_BUCKET_NAME = process.env.QUERYPILOT_STORAGE_BUCKET || "querypilotx-storage";

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "text/csv",
  "application/json",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/tab-separated-values",
  "application/octet-stream"
];

export interface StorageConfig {
  supabaseUrl: string;
  supabaseKey: string;
  isServiceRole: boolean;
  bucket: string;
  maxSizeBytes: number;
  isProduction: boolean;
}

export function isServerlessProduction(): boolean {
  return Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
}

export function getStorageConfig(): StorageConfig {
  const supabaseUrl = (
    process.env.QUERYPILOT_STORAGE_SUPABASE_URL ||
    process.env.QUERYPILOT_CORE_SUPABASE_URL ||
    ""
  ).trim();

  // Specifically check for server-side Service Role Key as requested
  const serviceRoleKey = (
    process.env.QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  ).trim();

  const anonKey = (
    process.env.QUERYPILOT_CORE_SUPABASE_ANON_KEY ||
    ""
  ).trim();

  // Prefer Service Role Key on the server for private bucket management
  const supabaseKey = serviceRoleKey || anonKey;

  return {
    supabaseUrl,
    supabaseKey,
    isServiceRole: Boolean(serviceRoleKey),
    bucket: STORAGE_BUCKET_NAME,
    maxSizeBytes: MAX_FILE_SIZE_BYTES,
    isProduction: isServerlessProduction()
  };
}
