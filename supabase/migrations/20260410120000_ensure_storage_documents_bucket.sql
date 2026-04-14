-- Fix "Bucket not found" when the documents vault was never provisioned on the remote project.
-- Safe to run multiple times.

INSERT INTO storage.buckets (id, name, public)
SELECT 'documents', 'documents', false
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'documents');

DROP POLICY IF EXISTS "Users can view own files" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload own files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own files" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own files" ON storage.objects;

CREATE POLICY "Users can view own files"
ON storage.objects FOR SELECT
USING (bucket_id = 'documents' AND split_part(name, '/', 1) = auth.uid()::text);

CREATE POLICY "Users can upload own files"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'documents' AND split_part(name, '/', 1) = auth.uid()::text);

CREATE POLICY "Users can delete own files"
ON storage.objects FOR DELETE
USING (bucket_id = 'documents' AND split_part(name, '/', 1) = auth.uid()::text);

CREATE POLICY "Users can update own files"
ON storage.objects FOR UPDATE
USING (bucket_id = 'documents' AND split_part(name, '/', 1) = auth.uid()::text)
WITH CHECK (bucket_id = 'documents' AND split_part(name, '/', 1) = auth.uid()::text);
