-- Clips (Screen Coach S3, docs/SCREEN_COACH_S3.md §3.5, decision 9): part of the screen the
-- student chose to save to their notebook, with the tutor's ink as vectors.
--
-- The only stored screenshots, and only because the student pressed Save in the desktop app's
-- preview. Clips are created by the API service with the secret key, after it checked the
-- desktop app's device token (the desktop app has no Clerk session). Their owner can read them,
-- note which notebook page was built from one, and delete them; nothing else. The image is in
-- the private "clips" bucket under "<user id>/"; the window title and link only exist here.
-- Deleting the account removes the rows with the profile.
--
-- Notebooks are local-first (IndexedDB), so notebook_page_id names a page in the student's
-- browser, not a row of public.pages: no foreign key.

create table public.clips (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles (id) on delete cascade,
  notebook_page_id uuid,
  -- "<user id>/<clip id>.jpg" in the clips bucket.
  storage_path text not null unique
    check (storage_path ~ '^[A-Za-z0-9_-]{1,128}/[0-9a-f-]{36}\.jpg$'
      and split_part(storage_path, '/', 1) = user_id),
  -- The image's size in pixels, and its pixels per CSS pixel of the screen it came from.
  width integer not null check (width between 1 and 2400),
  height integer not null check (height between 1 and 2400),
  pixel_ratio real not null check (pixel_ratio between 0.25 and 8),
  source_app text not null check (source_app ~ '^[a-z0-9 ._+()-]{1,60}\.exe$'),
  source_title text check (char_length(source_title) between 1 and 200),
  source_url text check (char_length(source_url) <= 2000 and source_url ~ '^https://'),
  source_timestamp_sec integer check (source_timestamp_sec between 0 and 86400),
  -- The tutor's strokes, in image pixels: [{tool, color, width, points: [[x, y, p, t], …]}, …].
  annotations jsonb not null default '[]'::jsonb
    check (jsonb_typeof(annotations) = 'array' and pg_column_size(annotations) <= 1048576),
  -- Text read on the device from the (redacted) image: context for the notebook tutor.
  ocr_text text not null default '' check (char_length(ocr_text) <= 8000),
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),

  unique (id, user_id)
);

create index clips_user_id_created_at_idx on public.clips (user_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Privileges: owners read, delete, and note the notebook page; the API service creates clips.
-- ---------------------------------------------------------------------------------------------
revoke all on public.clips from anon, authenticated;

grant select, delete on public.clips to authenticated;
grant update (notebook_page_id) on public.clips to authenticated;

alter table public.clips enable row level security;

create policy clips_select on public.clips for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy clips_update on public.clips for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy clips_delete on public.clips for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

-- ---------------------------------------------------------------------------------------------
-- Storage: a private bucket of JPEGs. Owners may read and delete their own folder; uploads come
-- only from the API service (no insert policy for users).
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clips', 'clips', false, 3145728, array['image/jpeg']);

create policy clips_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'clips'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));
create policy clips_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'clips'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));
