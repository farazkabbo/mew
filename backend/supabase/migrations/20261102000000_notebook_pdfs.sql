-- PDFs into notebooks and chapters (K4, docs/NOTEBOOKS_K.md §5): a PDF the student imported, kept
-- privately so its pages can be drawn under their ink, and (optionally) used as course material.
--
-- The file is in the private "pdfs" bucket under "<user id>/"; this table holds only what the
-- app needs to show it: its file name, page count and outline (the chapters it proposed). The
-- student's own Clerk session writes and reads both (RLS and the bucket's folder policies), so
-- nothing here bypasses them. Pages and ink stay on the student's device (local-first); a page
-- refers to a PDF by id and page index, no foreign key.

create table public.notebook_pdfs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub')
    references public.profiles (id) on delete cascade,
  -- "<user id>/<pdf id>.pdf" in the pdfs bucket.
  storage_path text not null unique
    check (storage_path ~ '^[A-Za-z0-9_-]{1,128}/[0-9a-f-]{36}\.pdf$'
      and split_part(storage_path, '/', 1) = user_id),
  file_name text not null check (char_length(file_name) between 1 and 200),
  byte_size integer not null check (byte_size between 1 and 104857600),
  page_count integer not null check (page_count between 1 and 1000),
  -- [{title, pageIndex}, …]: the outline's top level, at most 200 entries.
  outline jsonb not null default '[]'::jsonb
    check (jsonb_typeof(outline) = 'array' and jsonb_array_length(outline) <= 200
      and pg_column_size(outline) <= 65536),
  -- The course it became material for ("Use as course material"), once there is one.
  course_id uuid,
  created_at timestamptz not null default now(),

  unique (id, user_id),
  foreign key (course_id, user_id) references public.courses (id, user_id) on delete set null (course_id)
);

create index notebook_pdfs_user_id_idx on public.notebook_pdfs (user_id, created_at);
create index notebook_pdfs_course_idx on public.notebook_pdfs (course_id, user_id);

revoke all on public.notebook_pdfs from anon, authenticated;
grant select, delete on public.notebook_pdfs to authenticated;
grant insert (id, storage_path, file_name, byte_size, page_count, outline)
  on public.notebook_pdfs to authenticated;
grant update (course_id) on public.notebook_pdfs to authenticated;

alter table public.notebook_pdfs enable row level security;

create policy notebook_pdfs_select on public.notebook_pdfs for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy notebook_pdfs_insert on public.notebook_pdfs for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy notebook_pdfs_update on public.notebook_pdfs for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy notebook_pdfs_delete on public.notebook_pdfs for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

-- The files: private, PDFs only, 100 MB each, each user in their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdfs', 'pdfs', false, 104857600, array['application/pdf'])
on conflict (id) do nothing;

create policy pdfs_select on storage.objects for select to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));
create policy pdfs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'pdfs'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));
create policy pdfs_delete on storage.objects for delete to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));

-- Chapter-scoped retrieval (§2.3, §5.1): a course passage from a notebook PDF knows which chapter
-- (or section) its page went to. Null for courses built the M7 way.
alter table public.chunks add column notebook_node_id uuid;
create index chunks_notebook_node_idx on public.chunks (course_id, notebook_node_id);
