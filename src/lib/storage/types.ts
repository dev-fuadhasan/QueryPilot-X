export type StorageCategory = "datasets" | "reports" | "exports" | "uploads" | "general";

export interface StoredFileDescriptor {
  fileId: string;
  userId: string;
  category: StorageCategory;
  filename: string;
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
  updatedAt?: string;
  backend: "supabase_storage" | "local_secure_storage";
  metadata?: Record<string, unknown>;
}

export interface UploadFileInput {
  userId: string;
  category?: StorageCategory;
  filename: string;
  buffer: Buffer;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface ListFilesOptions {
  userId: string;
  category?: StorageCategory;
  limit?: number;
  offset?: number;
  search?: string;
}

export interface DownloadFileResult {
  buffer?: Buffer;
  signedUrl?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface StorageCapabilityStatus {
  configured: boolean;
  bucketName: string;
  backend: "supabase_storage" | "local_secure_storage";
  supabaseReachable: boolean;
  maxFileSizeBytes: number;
  allowedMimeTypes: string[];
}
