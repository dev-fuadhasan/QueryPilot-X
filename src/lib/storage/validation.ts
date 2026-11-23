import path from "node:path";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from "./config";
import type { StorageCategory } from "./types";

/**
 * Validates and sanitizes user ID string.
 * Must be non-empty and alphanumeric with dashes or underscores only.
 */
export function validateUserId(userId: string): string {
  if (!userId || typeof userId !== "string") {
    throw new Error("Invalid user ID: user ID must be provided.");
  }
  const trimmed = userId.trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(trimmed)) {
    throw new Error("Invalid user ID format: only alphanumeric, dash, and underscore characters are allowed.");
  }
  return trimmed;
}

/**
 * Validates and normalizes storage category.
 */
export function validateCategory(category?: string): StorageCategory {
  const validCategories: StorageCategory[] = ["datasets", "reports", "exports", "uploads", "general"];
  if (!category) return "general";
  const normalized = category.toLowerCase().trim() as StorageCategory;
  if (!validCategories.includes(normalized)) {
    return "general";
  }
  return normalized;
}

/**
 * Sanitizes a filename, preventing directory traversal, control characters, and reserved names.
 */
export function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== "string") {
    throw new Error("Filename must be a non-empty string.");
  }

  // Remove any path separators (strip directory components)
  const base = path.basename(filename.replace(/\\/g, "/")).trim();

  // Strip null bytes, control characters, and dangerous characters
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>:"/\\|?*#%]/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 160);

  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("Filename contains invalid characters or escapes directory boundaries.");
  }

  return cleaned;
}

/**
 * Validates file buffer and size.
 */
export function validateFileSize(buffer: Buffer, maxBytes: number = MAX_FILE_SIZE_BYTES): void {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("File content must be a valid Buffer.");
  }
  if (buffer.length === 0) {
    throw new Error("File cannot be empty (0 bytes).");
  }
  if (buffer.length > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
    throw new Error(`File size (${sizeMb} MB) exceeds maximum allowed size of ${maxMb} MB.`);
  }
}

/**
 * Infers or validates MIME type against whitelist.
 */
export function validateMimeType(mimeType?: string, filename?: string): string {
  const mime = (mimeType || "").toLowerCase().trim();
  
  if (mime && ALLOWED_MIME_TYPES.includes(mime)) {
    return mime;
  }

  // Fallback to extension-based MIME deduction
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    const map: Record<string, string> = {
      ".pdf": "application/pdf",
      ".csv": "text/csv",
      ".json": "application/json",
      ".txt": "text/plain",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xls": "application/vnd.ms-excel",
      ".tsv": "text/tab-separated-values"
    };

    if (map[ext]) {
      return map[ext];
    }
  }

  // Default to application/octet-stream if in whitelist, otherwise reject
  if (ALLOWED_MIME_TYPES.includes("application/octet-stream")) {
    return "application/octet-stream";
  }

  throw new Error(`Unsupported file type: ${mime || "unknown"}`);
}

/**
 * Builds an isolated storage key strictly namespaced under the user's ID.
 * Pattern: {userId}/{category}/{uniquePrefix}-{sanitizedFilename}
 */
export function buildStorageKey(userId: string, category: StorageCategory, filename: string): string {
  const safeUser = validateUserId(userId);
  const safeCat = validateCategory(category);
  const safeName = sanitizeFilename(filename);

  return `${safeUser}/${safeCat}/${safeName}`;
}

/**
 * Strict server-side verification that a storageKey belongs exclusively to userId.
 * Prevents User A from reading, modifying, or deleting User B's files.
 */
export function verifyKeyOwnership(userId: string, storageKey: string): boolean {
  if (!userId || !storageKey) return false;
  const safeUser = validateUserId(userId);
  
  // Normalize slashes
  const normalizedKey = storageKey.replace(/\\/g, "/").replace(/^\/+/, "");
  
  // Check for directory traversal attempts
  if (normalizedKey.includes("..") || normalizedKey.includes("//")) {
    return false;
  }

  const parts = normalizedKey.split("/");
  if (parts.length < 2) return false;

  // The first segment MUST strictly match the authenticated user's ID
  return parts[0] === safeUser;
}
