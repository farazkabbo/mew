-- Note lines (Screen Coach S3.5, Notes Check N1; docs/SCREEN_COACH_NOTES_CHECK.md §4.1 and its
-- Decisions 1, 2, 5 and 6): the recognised text of every line in a student's notebook, so the
-- tutor can find the notes that relate to what's on screen.
--
-- Notebooks stay local-first (strokes live in the browser). What's mirrored here is the text of
-- each line, where it is on its page, and the notebook and page it belongs to (ids, title,
-- course, page number), written by one call (sync_note_page) whenever a page's lines change.
-- Lines cascade with their page, notebook and account. The device keeps which strokes make up
-- each line; the server doesn't need them.
--
-- The "notes_index" setting (on unless the student turns it off) is checked here as well as by
-- the app: while it's off, no line can be added or changed.

-- ---------------------------------------------------------------------------------------------
-- The setting
-- ---------------------------------------------------------------------------------------------
alter table public.profiles
  add constraint profiles_settings_notes_index check (
    settings -> 'notes_index' is null or jsonb_typeof(settings -> 'notes_index') = 'boolean'
  );

-- ---------------------------------------------------------------------------------------------
-- note_lines
-- ---------------------------------------------------------------------------------------------
create table public.note_lines (
  -- Made on the device and kept while the line exists, so marks can find it again.
  id uuid primary key,
  user_id text not null default (auth.jwt() ->> 'sub'),
  page_id uuid not null,
  -- Reading order on the page (top to bottom): neighbours give a line its context.
  line_index integer not null check (line_index between 0 and 10000),
  -- [x, y, w, h] in page units.
  bbox real[] not null check (
    array_ndims(bbox) = 1 and cardinality(bbox) = 4 and array_position(bbox, null) is null
  ),
  -- "ink": the student's handwriting. "clip": text read from a clip saved from the screen,
  -- which is part of their notes but never their own mistake.
  source text not null check (source in ('ink', 'clip')),
  clip_id uuid,
  text text not null check (char_length(text) between 1 and 300),
  latex text check (char_length(latex) <= 300),
  recognition_confidence real not null check (recognition_confidence between 0 and 1),
  -- Of the line's strokes (ids and point counts), so a changed line is recognised again.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{8}$'),
  embedding extensions.vector(768),
  -- Which embedder made it (queries must use the same one).
  embedding_model text check (char_length(embedding_model) between 1 and 64),
  search tsvector generated always as (to_tsvector('simple'::regconfig, text)) stored,
  updated_at timestamptz not null default now(),

  unique (id, user_id),
  check ((source = 'clip') = (clip_id is not null)),
  check ((embedding is null) = (embedding_model is null)),
  foreign key (page_id, user_id) references public.pages (id, user_id) on delete cascade,
  foreign key (clip_id, user_id) references public.clips (id, user_id) on delete cascade
);

create index note_lines_page_id_line_index_idx on public.note_lines (page_id, line_index);
create index note_lines_user_id_idx on public.note_lines (user_id);
create index note_lines_clip_id_idx on public.note_lines (clip_id) where clip_id is not null;
create index note_lines_embedding_idx on public.note_lines
  using hnsw (embedding extensions.vector_cosine_ops);
create index note_lines_search_idx on public.note_lines using gin (search);
create trigger note_lines_touch_updated_at before update on public.note_lines
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Privileges: owners read, write (while the setting is on) and delete their own lines.
-- ---------------------------------------------------------------------------------------------
revoke all on public.note_lines from anon, authenticated;

grant select, insert, delete on public.note_lines to authenticated;
grant update (line_index, bbox, text, latex, recognition_confidence, content_hash, embedding,
  embedding_model) on public.note_lines to authenticated;

alter table public.note_lines enable row level security;

create policy note_lines_select on public.note_lines for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy note_lines_insert on public.note_lines for insert to authenticated
  with check (
    user_id = (select auth.jwt() ->> 'sub')
    and not exists (
      select 1 from public.profiles p
      where p.id = note_lines.user_id and p.settings -> 'notes_index' = 'false'::jsonb
    )
  );
create policy note_lines_update on public.note_lines for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (
    user_id = (select auth.jwt() ->> 'sub')
    and not exists (
      select 1 from public.profiles p
      where p.id = note_lines.user_id and p.settings -> 'notes_index' = 'false'::jsonb
    )
  );
create policy note_lines_delete on public.note_lines for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

-- ---------------------------------------------------------------------------------------------
-- sync_note_page: one page's changes in one transaction.
--
--   p_page      the page
--   p_notebook  {"id", "title", "course_id"}: mirrored into public.notebooks (a course the
--               caller can't see, e.g. one deleted since, is left out rather than failing)
--   p_index     the page's number in its notebook (0-based)
--   p_lines     lines to add or change: {id, line_index, bbox, source, clip_id, text, latex,
--               confidence, content_hash, embedding, embedding_model, keep_embedding}.
--               keep_embedding: the text didn't change, so the stored embedding stays.
--   p_removed   ids of lines that are gone (or changed and not yet recognised again)
--
-- SECURITY INVOKER: every statement runs as the caller, so RLS and the column grants apply. A
-- line id that belongs to another page is never moved or overwritten.
-- ---------------------------------------------------------------------------------------------
create function public.sync_note_page(
  p_page uuid,
  p_notebook jsonb,
  p_index integer,
  p_lines jsonb,
  p_removed uuid[]
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  notebook_id uuid := (p_notebook ->> 'id')::uuid;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 200
    or cardinality(p_removed) > 1000 then
    raise exception 'too many lines in one sync' using errcode = '22023';
  end if;

  -- The first sync of a new account may come before its settings were ever saved.
  insert into public.profiles default values on conflict (id) do nothing;

  insert into public.notebooks (id, title, course_id)
  values (
    notebook_id,
    p_notebook ->> 'title',
    (select c.id from public.courses c where c.id = (p_notebook ->> 'course_id')::uuid)
  )
  on conflict (id) do update set title = excluded.title, course_id = excluded.course_id
    where public.notebooks.title is distinct from excluded.title
      or public.notebooks.course_id is distinct from excluded.course_id;

  insert into public.pages (id, notebook_id, index)
  values (p_page, notebook_id, p_index)
  on conflict (id) do update set index = excluded.index
    where public.pages.notebook_id = excluded.notebook_id
      and public.pages.index <> excluded.index;

  delete from public.note_lines l where l.page_id = p_page and l.id = any (p_removed);

  -- Lines with a new (or no) embedding.
  insert into public.note_lines as n (id, page_id, line_index, bbox, source, clip_id, text,
    latex, recognition_confidence, content_hash, embedding, embedding_model)
  select l.id, p_page, l.line_index, l.bbox, l.source, l.clip_id, l.text, l.latex,
    l.confidence, l.content_hash, l.embedding::extensions.vector, l.embedding_model
  from jsonb_to_recordset(p_lines) as l(id uuid, line_index integer, bbox real[], source text,
    clip_id uuid, text text, latex text, confidence real, content_hash text, embedding text,
    embedding_model text, keep_embedding boolean)
  where not coalesce(l.keep_embedding, false)
  on conflict (id) do update set
    line_index = excluded.line_index, bbox = excluded.bbox, text = excluded.text,
    latex = excluded.latex, recognition_confidence = excluded.recognition_confidence,
    content_hash = excluded.content_hash, embedding = excluded.embedding,
    embedding_model = excluded.embedding_model
    where n.page_id = excluded.page_id;

  -- Lines whose text is unchanged (moved, renumbered): their embedding stays as it is.
  insert into public.note_lines as n (id, page_id, line_index, bbox, source, clip_id, text,
    latex, recognition_confidence, content_hash)
  select l.id, p_page, l.line_index, l.bbox, l.source, l.clip_id, l.text, l.latex,
    l.confidence, l.content_hash
  from jsonb_to_recordset(p_lines) as l(id uuid, line_index integer, bbox real[], source text,
    clip_id uuid, text text, latex text, confidence real, content_hash text,
    keep_embedding boolean)
  where coalesce(l.keep_embedding, false)
  on conflict (id) do update set
    line_index = excluded.line_index, bbox = excluded.bbox, text = excluded.text,
    latex = excluded.latex, recognition_confidence = excluded.recognition_confidence,
    content_hash = excluded.content_hash
    where n.page_id = excluded.page_id;
end;
$$;

revoke all on function public.sync_note_page(uuid, jsonb, integer, jsonb, uuid[])
  from public, anon;
grant execute on function public.sync_note_page(uuid, jsonb, integer, jsonb, uuid[])
  to authenticated;
