-- Searching note lines (Notes Check N2, docs/SCREEN_COACH_NOTES_CHECK.md §5): the lines of a
-- student's notes nearest to what's on screen, by meaning (embeddings) and by word.
--
-- One student's notes are thousands of lines at most, so the search is exact, over their rows
-- only. A shared approximate (HNSW) index searches everyone's rows first and filters by owner
-- afterwards, which can miss a student's best lines; it also slows every write. It goes.

drop index public.note_lines_embedding_idx;

-- "The notebook the student is working in" is the one whose lines changed last.
drop index public.note_lines_user_id_idx;
create index note_lines_user_id_updated_at_idx on public.note_lines (user_id, updated_at desc);

-- ---------------------------------------------------------------------------------------------
-- match_note_lines: candidate lines for a screen.
--
--   p_user       whose notes (always filtered on, even when RLS also applies)
--   p_query      the screen's embedding, or null for words only
--   p_model      the embedder that made p_query (only lines embedded by it are compared)
--   p_terms      words and phrases to match (each is parsed as plain text, never as syntax)
--   p_notebooks  the notebooks in scope, or null for all of them
--   p_exclude_clip  a clip whose own text lines are left out (checking that clip against the
--                   rest of the notes), or null
--   p_count      how many to take by meaning and by word, each (1 to 100)
--
-- Returns every line found either way, with its similarity and/or word rank. SECURITY INVOKER:
-- with a student's token RLS applies as well; the API service calls it for the desktop app
-- (secret key) only after checking the device token, with that device's owner as p_user.
-- ---------------------------------------------------------------------------------------------
create function public.match_note_lines(
  p_user text,
  p_query extensions.vector(768),
  p_model text,
  p_terms text[],
  p_notebooks uuid[],
  p_exclude_clip uuid default null,
  p_count integer default 40
) returns table (
  id uuid,
  page_id uuid,
  line_index integer,
  similarity double precision,
  word_rank real
)
language sql
stable
security invoker
set search_path = ''
as $$
  with scoped as (
    select l.id, l.page_id, l.line_index, l.embedding, l.embedding_model, l.search
    from public.note_lines l
    join public.pages p on p.id = l.page_id and p.user_id = l.user_id
    where l.user_id = p_user
      and (p_notebooks is null or p.notebook_id = any (p_notebooks))
      and (p_exclude_clip is null or l.clip_id is distinct from p_exclude_clip)
  ),
  words as (
    select nullif(string_agg('(' || t.q::text || ')', ' | '), '')::tsquery as q
    from (
      select plainto_tsquery('simple', term) as q
      from unnest(coalesce(p_terms, '{}'::text[])) as term
      limit 40
    ) t
    where t.q::text <> ''
  ),
  by_meaning as (
    select s.id, 1 - (s.embedding operator(extensions.<=>) p_query) as similarity
    from scoped s
    where p_query is not null and s.embedding_model = p_model
    order by s.embedding operator(extensions.<=>) p_query
    limit least(greatest(p_count, 1), 100)
  ),
  by_word as (
    select s.id, ts_rank_cd(s.search, w.q) as word_rank
    from scoped s, words w
    where w.q is not null and s.search @@ w.q
    order by word_rank desc
    limit least(greatest(p_count, 1), 100)
  )
  select s.id, s.page_id, s.line_index, m.similarity, w.word_rank
  from scoped s
  left join by_meaning m on m.id = s.id
  left join by_word w on w.id = s.id
  where m.id is not null or w.id is not null;
$$;

revoke all on function public.match_note_lines(text, extensions.vector, text, text[], uuid[], uuid, integer)
  from public, anon;
grant execute on function public.match_note_lines(text, extensions.vector, text, text[], uuid[], uuid, integer)
  to authenticated, service_role;
