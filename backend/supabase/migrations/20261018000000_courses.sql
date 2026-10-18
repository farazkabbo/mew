-- Courses (M7): courses built from a student's PDF, its chunks (with embeddings for retrieval),
-- the concept graph, and storage for the uploaded files.
--
-- Same security model as the core schema: RLS on every table matching the caller's Clerk `sub`,
-- explicit per-column grants, size limits, and composite foreign keys (id, user_id) so a user
-- can never attach a row to someone else's course.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------------------------------
create table public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub')
    references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  subject text check (char_length(subject) <= 40),
  exam_date date,
  -- processing → review (scope review screen) → ready; or failed
  status text not null default 'processing'
    check (status in ('processing', 'review', 'ready', 'failed')),
  status_detail text check (char_length(status_detail) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, user_id)
);

create index courses_user_id_idx on public.courses (user_id);
create trigger courses_touch_updated_at before update on public.courses
  for each row execute function private.touch_updated_at();

-- A notebook can belong to a course. Deleting the course keeps the notebook (only the link goes).
alter table public.notebooks
  add constraint notebooks_course_fk foreign key (course_id, user_id)
    references public.courses (id, user_id) on delete set null (course_id);

-- ---------------------------------------------------------------------------------------------
-- sources (an uploaded PDF, pasted notes, or a topic)
-- ---------------------------------------------------------------------------------------------
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null,
  user_id text not null default (auth.jwt() ->> 'sub'),
  kind text not null check (kind in ('pdf', 'text', 'topic')),
  title text not null check (char_length(title) between 1 and 200),
  -- "<user id>/<source id>.pdf" in the course-sources bucket, for PDFs
  storage_path text check (char_length(storage_path) <= 300),
  page_count integer check (page_count between 0 and 2000),
  -- Which embedding produced the chunks (queries must use the same one).
  embedding_model text not null check (char_length(embedding_model) <= 80),
  created_at timestamptz not null default now(),

  unique (id, user_id),
  foreign key (course_id, user_id) references public.courses (id, user_id) on delete cascade
);

create index sources_course_id_idx on public.sources (course_id);

-- ---------------------------------------------------------------------------------------------
-- chunks (retrieval units; never span pages, so citations stay exact)
-- ---------------------------------------------------------------------------------------------
create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null,
  course_id uuid not null,
  user_id text not null default (auth.jwt() ->> 'sub'),
  page integer not null check (page between 1 and 2000),
  heading text check (char_length(heading) <= 200),
  text text not null check (char_length(text) between 1 and 4000),
  embedding extensions.vector(768) not null,

  unique (id, user_id),
  foreign key (source_id, user_id) references public.sources (id, user_id) on delete cascade,
  foreign key (course_id, user_id) references public.courses (id, user_id) on delete cascade
);

create index chunks_course_id_idx on public.chunks (course_id);
create index chunks_embedding_idx on public.chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------------------------
-- concepts and their prerequisite graph
-- ---------------------------------------------------------------------------------------------
create table public.concepts (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null,
  user_id text not null default (auth.jwt() ->> 'sub'),
  title text not null check (char_length(title) between 1 and 120),
  summary text not null default '' check (char_length(summary) <= 600),
  order_index integer not null check (order_index >= 0),
  -- Pages of the source that teach this concept (for citations).
  source_pages integer[] not null default '{}' check (cardinality(source_pages) <= 50),
  -- Generated on demand and cached: { explanation, example, practice[] }
  lesson jsonb check (lesson is null or (jsonb_typeof(lesson) = 'object'
    and pg_column_size(lesson) <= 32768)),
  created_at timestamptz not null default now(),

  unique (id, user_id),
  foreign key (course_id, user_id) references public.courses (id, user_id) on delete cascade
);

create index concepts_course_id_idx on public.concepts (course_id, order_index);

create table public.concept_edges (
  from_concept uuid not null,
  to_concept uuid not null,
  user_id text not null default (auth.jwt() ->> 'sub'),
  primary key (from_concept, to_concept),
  check (from_concept <> to_concept),
  foreign key (from_concept, user_id) references public.concepts (id, user_id) on delete cascade,
  foreign key (to_concept, user_id) references public.concepts (id, user_id) on delete cascade
);

create table public.concept_sources (
  concept_id uuid not null,
  chunk_id uuid not null,
  user_id text not null default (auth.jwt() ->> 'sub'),
  primary key (concept_id, chunk_id),
  foreign key (concept_id, user_id) references public.concepts (id, user_id) on delete cascade,
  foreign key (chunk_id, user_id) references public.chunks (id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------------------------
-- Retrieval: nearest chunks of one course. SECURITY INVOKER, so RLS still applies: a caller can
-- only ever match their own chunks, whatever course id they pass.
-- ---------------------------------------------------------------------------------------------
create function public.match_chunks(
  course uuid,
  query extensions.vector(768),
  match_count integer default 5
) returns table (id uuid, page integer, heading text, text text, similarity double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.id, c.page, c.heading, c.text,
         1 - (c.embedding operator(extensions.<=>) query) as similarity
  from public.chunks c
  where c.course_id = course
  order by c.embedding operator(extensions.<=>) query
  limit least(greatest(match_count, 1), 20);
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: nothing by default; then exactly what the app needs.
-- ---------------------------------------------------------------------------------------------
revoke all on public.courses, public.sources, public.chunks, public.concepts,
  public.concept_edges, public.concept_sources from anon, authenticated;
revoke all on function public.match_chunks(uuid, extensions.vector, integer) from public, anon;

grant select, insert, delete on public.courses to authenticated;
grant update (title, subject, exam_date, status, status_detail) on public.courses to authenticated;

grant select, insert, delete on public.sources to authenticated;
grant update (title, page_count) on public.sources to authenticated;

grant select, insert, delete on public.chunks to authenticated;

grant select, insert, delete on public.concepts to authenticated;
grant update (title, summary, order_index, source_pages, lesson) on public.concepts to authenticated;

grant select, insert, delete on public.concept_edges to authenticated;
grant select, insert, delete on public.concept_sources to authenticated;

grant execute on function public.match_chunks(uuid, extensions.vector, integer) to authenticated;

alter table public.courses enable row level security;
alter table public.sources enable row level security;
alter table public.chunks enable row level security;
alter table public.concepts enable row level security;
alter table public.concept_edges enable row level security;
alter table public.concept_sources enable row level security;

create policy courses_select on public.courses for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy courses_insert on public.courses for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy courses_update on public.courses for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy courses_delete on public.courses for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy sources_select on public.sources for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy sources_insert on public.sources for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy sources_update on public.sources for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy sources_delete on public.sources for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy chunks_select on public.chunks for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy chunks_insert on public.chunks for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy chunks_delete on public.chunks for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy concepts_select on public.concepts for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy concepts_insert on public.concepts for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy concepts_update on public.concepts for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy concepts_delete on public.concepts for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy concept_edges_select on public.concept_edges for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy concept_edges_insert on public.concept_edges for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy concept_edges_delete on public.concept_edges for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy concept_sources_select on public.concept_sources for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy concept_sources_insert on public.concept_sources for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy concept_sources_delete on public.concept_sources for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

-- ---------------------------------------------------------------------------------------------
-- Storage: a private bucket for uploaded sources. Objects live under "<user id>/…", and each
-- user can only read, add or delete objects in their own folder. PDFs only, 15 MB each.
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course-sources', 'course-sources', false, 15728640, array['application/pdf'])
on conflict (id) do nothing;

create policy course_sources_select on storage.objects for select to authenticated
  using (bucket_id = 'course-sources'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));
create policy course_sources_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'course-sources'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));
create policy course_sources_delete on storage.objects for delete to authenticated
  using (bucket_id = 'course-sources'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));
