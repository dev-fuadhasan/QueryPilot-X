import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getStorageConfig, STORAGE_BUCKET_NAME } from "./config";

let cachedClient: SupabaseClient | null = null;

/**
 * Returns a Supabase client configured for storage operations using the existing configuration.
 * Uses the Service Role Key if available (server-side only) to manage private bucket objects.
 */
export function getStorageSupabaseClient(): SupabaseClient | null {
  const config = getStorageConfig();
  if (!config.supabaseUrl || !config.supabaseKey) {
    return null;
  }

  if (!cachedClient) {
    cachedClient = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }

  return cachedClient;
}

/**
 * Checks if the configured Supabase Storage instance is reachable and bucket exists.
 * Employs a 4-second timeout to avoid stalling requests if cloud host is paused or unreachable.
 */
export async function verifySupabaseStorageConnection(): Promise<{
  reachable: boolean;
  bucketExists: boolean;
  error?: string;
}> {
  const client = getStorageSupabaseClient();
  if (!client) {
    return {
      reachable: false,
      bucketExists: false,
      error: "Supabase storage URL or key is not configured."
    };
  }

  try {
    const timeoutPromise = new Promise<{ data: null; error: Error }>((_, reject) =>
      setTimeout(() => reject(new Error("Supabase storage request timed out (host unreachable or paused).")), 4000)
    );

    const listPromise = client.storage.listBuckets();
    const result = await Promise.race([listPromise, timeoutPromise]);

    if ("error" in result && result.error) {
      return { reachable: false, bucketExists: false, error: result.error.message };
    }

    const buckets = (result as { data: Array<{ name: string }> | null }).data;
    const bucketExists = Array.isArray(buckets) && buckets.some(b => b.name === STORAGE_BUCKET_NAME);
    return { reachable: true, bucketExists };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Network or configuration error.";
    return { reachable: false, bucketExists: false, error: message };
  }
}

/**
 * Ensures the bucket exists if connectivity permits.
 * Keeps bucket strictly private.
 */
export async function ensureStorageBucket(): Promise<boolean> {
  const client = getStorageSupabaseClient();
  if (!client) return false;

  try {
    const { reachable, bucketExists } = await verifySupabaseStorageConnection();
    if (!reachable) return false;
    if (bucketExists) return true;

    const { error } = await client.storage.createBucket(STORAGE_BUCKET_NAME, {
      public: false, // Strictly private as required
      fileSizeLimit: 52428800 // 50MB
    });

    if (error && !error.message.includes("already exists")) {
      console.warn("Storage bucket auto-creation notice:", error.message);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
