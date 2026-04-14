-- Allow users to update their own objects (needed for storage upload upsert / overwrites)
CREATE POLICY "Users can update own files"
ON storage.objects FOR UPDATE
USING (bucket_id = 'documents' AND split_part(name, '/', 1) = auth.uid()::text)
WITH CHECK (bucket_id = 'documents' AND split_part(name, '/', 1) = auth.uid()::text);
