import { mkdir, readFile, writeFile, unlink, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getStorageConfig,
  STORAGE_BUCKET_NAME,
  MAX_FILE_SIZE_BYTES,
  ALLOWED_MIME_TYPES,
  isServerlessProduction
} from "./config";
import { getStorageSupabaseClient, verifySupabaseStorageConnection } from "./client";
import {
  buildStorageKey,
  sanitizeFilename,
  validateCategory,
  validateFileSize,
  validateMimeType,
  validateUserId,
  verifyKeyOwnership
} from "./validation";
import type {
  DownloadFileResult,
  ListFilesOptions,
  StorageCapabilityStatus,
  StoredFileDescriptor,
  UploadFileInput
} from "./types";

const LOCAL_STORAGE_DIR = path.join(process.cwd(), ".local-data", "querypilotx-storage");

/**
 * Resolves local file path while preventing any path traversal.
 */
function resolveLocalPath(storageKey: string): string {
  const normalizedKey = storageKey.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.resolve(LOCAL_STORAGE_DIR, normalizedKey);
  const relative = path.relative(LOCAL_STORAGE_DIR, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Security violation: path traversal detected.");
  }
  return target;
}

/**
 * Uploads a file securely, enforcing user-isolation, size, type, and path validation.
 *
 * PRODUCTION SAFETY:
 * In production, if Supabase cloud storage is unreachable, it FAILS LOUDLY instead of
 * silently saving to ephemeral local storage. Local fallback is enabled ONLY in local development.
 */
export async function uploadFile(input: UploadFileInput): Promise<StoredFileDescriptor> {
  const userId = validateUserId(input.userId);
  const category = validateCategory(input.category);
  const filename = sanitizeFilename(input.filename);
  
  validateFileSize(input.buffer);
  const mimeType = validateMimeType(input.mimeType, filename);

  const fileId = randomUUID();
  const prefixedFilename = `${fileId.slice(0, 8)}-${filename}`;
  const storageKey = buildStorageKey(userId, category, prefixedFilename);

  const isProd = isServerlessProduction();
  const supabaseClient = getStorageSupabaseClient();
  let uploadedToSupabase = false;
  let supabaseErrorMessage: string | null = null;

  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.storage.from(STORAGE_BUCKET_NAME).upload(storageKey, input.buffer, {
        contentType: mimeType,
        upsert: false // Prevent accidental overwrite
      });

      if (!error) {
        uploadedToSupabase = true;
      } else {
        supabaseErrorMessage = error.message;
      }
    } catch (err: unknown) {
      supabaseErrorMessage = err instanceof Error ? err.message : String(err);
    }
  } else {
    supabaseErrorMessage = "Supabase storage client is not configured.";
  }

  // Handle production failure explicitly
  if (isProd && !uploadedToSupabase) {
    throw new Error(
      `Production storage failure: unable to persist to Supabase cloud storage (${supabaseErrorMessage || "cloud host unreachable"}). Local filesystem fallback is disabled in production to prevent data loss.`
    );
  }

  // In local development ONLY, allow local secure fallback
  if (!uploadedToSupabase) {
    console.warn(`[Local Dev] Supabase unavailable (${supabaseErrorMessage}). Storing in local development directory.`);
    const fullPath = resolveLocalPath(storageKey);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, input.buffer);
  }

  return {
    fileId,
    userId,
    category,
    filename,
    storageKey,
    sizeBytes: input.buffer.length,
    mimeType,
    createdAt: new Date().toISOString(),
    backend: uploadedToSupabase ? "supabase_storage" : "local_secure_storage",
    metadata: input.metadata
  };
}

/**
 * Lists stored files exclusively belonging to the specified user.
 * Strictly prevents User A from listing User B's files.
 */
export async function listUserFiles(options: ListFilesOptions): Promise<StoredFileDescriptor[]> {
  const userId = validateUserId(options.userId);
  const category = options.category ? validateCategory(options.category) : undefined;
  const isProd = isServerlessProduction();
  const results: StoredFileDescriptor[] = [];

  const supabaseClient = getStorageSupabaseClient();

  // Query Supabase Storage
  if (supabaseClient) {
    try {
      const categoriesToScan = category
        ? [category]
        : (["datasets", "reports", "exports", "uploads", "general"] as const);

      for (const cat of categoriesToScan) {
        const folderPrefix = `${userId}/${cat}`;
        const { data, error } = await supabaseClient.storage.from(STORAGE_BUCKET_NAME).list(folderPrefix, {
          limit: options.limit || 100,
          offset: options.offset || 0,
          sortBy: { column: "created_at", order: "desc" }
        });

        if (!error && Array.isArray(data)) {
          for (const item of data) {
            // In Supabase Storage, folder placeholders have item.id === null
            if (!item.name || item.id === null) continue;
            const storageKey = `${folderPrefix}/${item.name}`;
            if (!verifyKeyOwnership(userId, storageKey)) continue;

            results.push({
              fileId: item.id || item.name.slice(0, 8),
              userId,
              category: cat,
              filename: item.name.includes("-") ? item.name.split("-").slice(1).join("-") : item.name,
              storageKey,
              sizeBytes: item.metadata?.size || 0,
              mimeType: item.metadata?.mimetype || "application/octet-stream",
              createdAt: item.created_at || new Date().toISOString(),
              backend: "supabase_storage"
            });
          }
        }
      }
    } catch {
      // In production, do not mix local storage
      if (isProd) {
        throw new Error("Unable to list files from Supabase cloud storage in production.");
      }
    }
  }

  // In local development ONLY, check local fallback files
  if (!isProd) {
    try {
      const userDir = category ? path.join(LOCAL_STORAGE_DIR, userId, category) : path.join(LOCAL_STORAGE_DIR, userId);
      
      async function scanLocal(dir: string, currentCategory: string) {
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await scanLocal(entryPath, entry.name);
            } else if (entry.isFile()) {
              const relKey = path.relative(LOCAL_STORAGE_DIR, entryPath).replace(/\\/g, "/");
              if (verifyKeyOwnership(userId, relKey)) {
                const fileStat = await stat(entryPath);
                results.push({
                  fileId: entry.name.slice(0, 8),
                  userId,
                  category: validateCategory(currentCategory),
                  filename: entry.name.includes("-") ? entry.name.split("-").slice(1).join("-") : entry.name,
                  storageKey: relKey,
                  sizeBytes: fileStat.size,
                  mimeType: validateMimeType(undefined, entry.name),
                  createdAt: fileStat.birthtime.toISOString(),
                  backend: "local_secure_storage"
                });
              }
            }
          }
        } catch {
          // Directory does not exist yet
        }
      }

      await scanLocal(userDir, category || "general");
    } catch {
      // Non-fatal for local dev
    }
  }

  if (options.search) {
    const q = options.search.toLowerCase();
    return results.filter(f => f.filename.toLowerCase().includes(q) || f.storageKey.toLowerCase().includes(q));
  }

  return results;
}

/**
 * Downloads a file, verifying user ownership first.
 * Strictly throws if User A tries to download User B's file.
 */
export async function downloadFile(userId: string, storageKey: string): Promise<DownloadFileResult> {
  const safeUser = validateUserId(userId);
  const isProd = isServerlessProduction();

  if (!verifyKeyOwnership(safeUser, storageKey)) {
    throw new Error("Access denied: You are not authorized to access this file.");
  }

  const supabaseClient = getStorageSupabaseClient();
  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient.storage.from(STORAGE_BUCKET_NAME).download(storageKey);
      if (!error && data) {
        const arrayBuf = await data.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        return {
          buffer,
          filename: path.basename(storageKey),
          mimeType: validateMimeType(data.type, storageKey),
          sizeBytes: buffer.length
        };
      }
    } catch (err: unknown) {
      if (isProd) {
        throw new Error(`Production download failed: ${err instanceof Error ? err.message : "cloud storage error"}`);
      }
    }
  }

  // In production, do not fall back to local disk
  if (isProd) {
    throw new Error("File not found in Supabase cloud storage.");
  }

  // Local development read
  const localPath = resolveLocalPath(storageKey);
  try {
    const buffer = await readFile(localPath);
    return {
      buffer,
      filename: path.basename(storageKey),
      mimeType: validateMimeType(undefined, storageKey),
      sizeBytes: buffer.length
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("File not found in storage.");
    }
    throw err;
  }
}

/**
 * Generates a short-lived signed download URL after validating user ownership.
 */
export async function createSignedDownloadUrl(userId: string, storageKey: string, expiresInSeconds = 60): Promise<string> {
  const safeUser = validateUserId(userId);

  if (!verifyKeyOwnership(safeUser, storageKey)) {
    throw new Error("Access denied: You are not authorized to generate a download URL for this file.");
  }

  const supabaseClient = getStorageSupabaseClient();
  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient.storage
        .from(STORAGE_BUCKET_NAME)
        .createSignedUrl(storageKey, expiresInSeconds);

      if (!error && data?.signedUrl) {
        return data.signedUrl;
      }
    } catch {
      // Fallback to internal API route signed link
    }
  }

  // Return internal authenticated download link
  return `/api/storage/download?key=${encodeURIComponent(storageKey)}`;
}

/**
 * Deletes a file, strictly verifying user ownership.
 * Prevents User A from deleting User B's files.
 */
export async function deleteFile(userId: string, storageKey: string): Promise<boolean> {
  const safeUser = validateUserId(userId);
  const isProd = isServerlessProduction();

  if (!verifyKeyOwnership(safeUser, storageKey)) {
    throw new Error("Access denied: You are not authorized to delete this file.");
  }

  let deleted = false;
  const supabaseClient = getStorageSupabaseClient();

  if (supabaseClient) {
    try {
      const { error } = await supabaseClient.storage.from(STORAGE_BUCKET_NAME).remove([storageKey]);
      if (!error) {
        deleted = true;
      }
    } catch {
      if (isProd) {
        throw new Error("Production deletion failed: could not remove object from Supabase storage.");
      }
    }
  }

  // In local development, also delete from local filesystem
  if (!isProd) {
    try {
      const localPath = resolveLocalPath(storageKey);
      await unlink(localPath);
      deleted = true;
    } catch {
      // Ignore if not present locally
    }
  }

  return deleted;
}

/**
 * Returns overall storage health and capability status.
 */
export async function getStorageStatus(): Promise<StorageCapabilityStatus> {
  const config = getStorageConfig();
  const conn = await verifySupabaseStorageConnection();

  return {
    configured: Boolean(config.supabaseUrl && config.supabaseKey),
    bucketName: STORAGE_BUCKET_NAME,
    backend: conn.reachable ? "supabase_storage" : isServerlessProduction() ? "supabase_storage" : "local_secure_storage",
    supabaseReachable: conn.reachable,
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    allowedMimeTypes: ALLOWED_MIME_TYPES
  };
}
