-- Private, durable image storage. The backend creates a signed URL ONLY when publishing.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('post-images','post-images',false,8388608,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
-- Browser writes are intentionally not granted; uploads use the authenticated backend.
create policy "Read own post images" on storage.objects for select to authenticated
using(bucket_id='post-images' and (storage.foldername(name))[1]=(select auth.uid())::text);
