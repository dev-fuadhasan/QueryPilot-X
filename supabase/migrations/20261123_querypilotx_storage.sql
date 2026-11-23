-- ==============================================================================
-- QueryPilot-X — Production Multi-User Supabase Storage Integration Migration
-- Bucket: querypilotx-storage (strictly private)
-- ==============================================================================
-- ARCHITECTURAL SECURITY NOTICE:
-- QueryPilot-X uses custom session authentication (smart_data_session) rather
-- than Supabase GoTrue Auth. All file uploads, listings, downloads, and deletions
-- are mediated and authorized by the QueryPilot-X Next.js backend API (/api/storage/*).
--
-- The backend uses the Supabase Service Role Key (QUERYPILOT_STORAGE_SUPABASE_SERVICE_ROLE_KEY)
-- on the server to operate on the private bucket. The Service Role Key inherently
-- bypasses Row Level Security (RLS) in Supabase.
--
-- Therefore, the critical security boundary is enforced at the application layer:
-- 1. All storage paths are strictly namespaced under {userId}/.
-- 2. User ownership (verifyKeyOwnership) is validated before every privileged operation.
-- 3. Anonymous and direct public access to storage.objects is blocked.
-- ==============================================================================

-- 1. Create the private storage bucket if it does not already exist
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'querypilotx-storage',
  'querypilotx-storage',
  false, -- STRICTLY PRIVATE: no unauthorized or anonymous public reads
  52428800, -- 50 MB file size limit
  ARRAY[
    'application/pdf',
    'text/csv',
    'application/json',
    'text/plain',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/tab-separated-values',
    'application/octet-stream'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 2. Ensure Row Level Security is enabled on storage.objects
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 3. Block all direct public / anonymous access to the private bucket
DROP POLICY IF EXISTS "querypilotx_storage_block_anon" ON storage.objects;
CREATE POLICY "querypilotx_storage_block_anon"
ON storage.objects FOR ALL
TO anon
USING (false)
WITH CHECK (false);

-- 4. If GoTrue Auth is enabled in the future, allow authenticated users access ONLY to their own folder:
DROP POLICY IF EXISTS "querypilotx_storage_authenticated_own" ON storage.objects;
CREATE POLICY "querypilotx_storage_authenticated_own"
ON storage.objects FOR ALL
TO authenticated
USING (
  bucket_id = 'querypilotx-storage'
  AND (storage.foldername(name))[1] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'querypilotx-storage'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
