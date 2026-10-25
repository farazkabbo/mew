-- The notebook tree (K1, docs/NOTEBOOKS_K.md §2 and Decisions 14–19): a notebook can hold
-- chapters, and a chapter sections, three levels at most (depth 0–2). One table, as before: a
-- chapter is a notebook row with a parent. Pages hang off any node.
--
-- The student's device is the source of truth for edits (decision 0.1 #6); it sends its changes
-- with `sync_notebook_tree`. The database still enforces, on every write:
-- - a parent belongs to the same user (the composite foreign key below);
-- - depth ≤ 2 and no cycles (the `notebooks_place` trigger), including for everything under a
--   node that moves;
-- - sibling names unique, ignoring case and trashed nodes (a partial unique index);
-- - latest edit wins (`edited_at`, set by the device when the student changed the node).
-- Existing notebooks become roots; nothing is lost.

-- ---------------------------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------------------------
alter table public.notebooks
  add column parent_id uuid,
  -- Kept by the trigger (whatever a client sends): the top notebook, and 0 / 1 / 2.
  add column root_id uuid,
  add column depth smallint not null default 0 check (depth between 0 and 2),
  -- Sibling order: a fractional index (`fractional-indexing`, base 62).
  add column position text not null default 'a0' check (position ~ '^[0-9A-Za-z]{1,64}$'),
  -- What this notebook calls its second level ("New unit").
  add column child_label text not null default 'Chapters'
    check (child_label in ('Chapters', 'Units', 'Weeks', 'Topics', 'Modules')),
  add column icon text check (icon in ('book', 'atom', 'flask', 'sigma', 'dna', 'globe', 'code',
    'landmark', 'languages', 'music', 'palette', 'leaf', 'brain', 'calculator')),
  add column color text check (color in ('slate', 'teal', 'blue', 'violet', 'rose', 'amber',
    'green')),
  -- In the trash since (purged by the device after 30 days).
  add column deleted_at timestamptz,
  -- When the student last changed the title, place or settings (on their device).
  add column edited_at timestamptz not null default now(),
  add constraint notebooks_not_own_parent check (parent_id is distinct from id),
  -- A child's owner is its parent's owner; deleting a node deletes what's under it.
  add constraint notebooks_parent_fk foreign key (parent_id, user_id)
    references public.notebooks (id, user_id) on delete cascade;

update public.notebooks set root_id = id where root_id is null;

create index notebooks_parent_id_user_id_idx on public.notebooks (parent_id, user_id);
create index notebooks_root_id_idx on public.notebooks (root_id);

-- Sibling names are unique (voice routing needs it). Older notebooks could share a name, so
-- those get a number first ("Notebook 1 2"), as a clash found during sync would.
with clashes as (
  select id, row_number() over (
      partition by user_id, lower(title) order by created_at, id
    ) as n
  from public.notebooks
)
update public.notebooks n
set title = left(n.title, 190) || ' ' || c.n
from clashes c
where c.id = n.id and c.n > 1;

create unique index notebooks_sibling_name on public.notebooks
  (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(title))
  where deleted_at is null;

grant update (parent_id, position, child_label, icon, color, deleted_at, edited_at)
  on public.notebooks to authenticated;

-- ---------------------------------------------------------------------------------------------
-- notebooks_place: depth, root and the no-cycle rule, on every insert and update
-- ---------------------------------------------------------------------------------------------
create function private.notebooks_place() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_depth smallint;
  parent_root uuid;
begin
  if new.parent_id is null then
    new.depth := 0;
    new.root_id := new.id;
    return new;
  end if;

  select n.depth, n.root_id into parent_depth, parent_root
  from public.notebooks n
  where n.id = new.parent_id and n.user_id = new.user_id;
  if not found then
    raise exception 'notebook parent not found' using errcode = 'foreign_key_violation';
  end if;

  -- Moving a node under one of its own descendants would make a loop.
  if tg_op = 'UPDATE' and exists (
    with recursive above (id, parent_id, steps) as (
      select n.id, n.parent_id, 1 from public.notebooks n where n.id = new.parent_id
      union all
      select n.id, n.parent_id, above.steps + 1
      from public.notebooks n join above on n.id = above.parent_id
      where above.steps < 4
    )
    select 1 from above where above.id = new.id
  ) then
    raise exception 'notebook tree cycle' using errcode = 'check_violation';
  end if;

  new.depth := parent_depth + 1;
  new.root_id := parent_root;
  if new.depth > 2 then
    raise exception 'notebook tree too deep' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger notebooks_place before insert or update on public.notebooks
  for each row execute function private.notebooks_place();

-- A node that moved takes everything under it along: each child is placed again (and so on
-- down), which also refuses the move if a descendant would end up deeper than 2.
create function private.notebooks_place_children() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.notebooks c set parent_id = c.parent_id
  where c.parent_id = new.id and c.user_id = new.user_id;
  return null;
end;
$$;

create trigger notebooks_place_children after update on public.notebooks
  for each row
  when (old.depth is distinct from new.depth or old.root_id is distinct from new.root_id)
  execute function private.notebooks_place_children();

-- ---------------------------------------------------------------------------------------------
-- sync_notebook_tree: the device's changes to its tree, in one call.
--
--   p_nodes    nodes added or changed, parents before children (at most 200):
--              {id, parent_id, title, position, child_label, icon, color, course_id,
--               deleted_at, edited_at}
--   p_removed  nodes purged from the trash (at most 500); what's under them goes too
--
-- Returns one result per node: {"id", "status", "node"}, where status is
-- - "saved":    stored as sent;
-- - "renamed":  stored, but its title clashed with a sibling's, so it got a number ("Physics 2");
-- - "stale":    the server has a later edit, which is kept;
-- - "rejected": refused (too deep, a loop, a parent that isn't the caller's);
-- and "node" is the server's copy after the call (null when there is none), so the device can
-- show a rename and undo a refused move.
--
-- SECURITY INVOKER: RLS, the column grants and the triggers all apply to the caller.
-- ---------------------------------------------------------------------------------------------
create function public.sync_notebook_tree(p_nodes jsonb, p_removed uuid[] default '{}')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item jsonb;
  node record;
  wanted text;
  attempt integer;
  outcome text;
  stored integer;
  clash text;
  results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_nodes) <> 'array' or jsonb_array_length(p_nodes) > 200
    or cardinality(coalesce(p_removed, '{}')) > 500 then
    raise exception 'too many notebook changes in one sync' using errcode = '22023';
  end if;

  -- The first sync of a new account may come before its settings were ever saved.
  insert into public.profiles default values on conflict (id) do nothing;

  delete from public.notebooks n where n.id = any (coalesce(p_removed, '{}'));

  for item in select value from jsonb_array_elements(p_nodes) with ordinality order by ordinality
  loop
    select * into node from jsonb_to_record(item) as x(
      id uuid, parent_id uuid, title text, position text, child_label text, icon text,
      color text, course_id uuid, deleted_at timestamptz, edited_at timestamptz
    );
    outcome := 'saved';
    wanted := node.title;
    attempt := 1;
    loop
      begin
        insert into public.notebooks as n (id, parent_id, title, position, child_label, icon,
          color, course_id, deleted_at, edited_at)
        values (
          node.id, node.parent_id, wanted, node.position, node.child_label, node.icon,
          node.color,
          -- A course the caller can't see (deleted since) is left out rather than failing.
          (select c.id from public.courses c where c.id = node.course_id),
          node.deleted_at, node.edited_at
        )
        on conflict (id) do update set
          parent_id = excluded.parent_id, title = excluded.title, position = excluded.position,
          child_label = excluded.child_label, icon = excluded.icon, color = excluded.color,
          course_id = excluded.course_id, deleted_at = excluded.deleted_at,
          edited_at = excluded.edited_at
          where n.edited_at <= excluded.edited_at;
        get diagnostics stored = row_count;
        if stored = 0 then
          outcome := 'stale';
        end if;
        exit;
      exception
        when unique_violation then
          get stacked diagnostics clash = constraint_name;
          if clash is distinct from 'notebooks_sibling_name' or attempt >= 50 then
            outcome := 'rejected';
            exit;
          end if;
          attempt := attempt + 1;
          wanted := left(node.title, 76) || ' ' || attempt;
          outcome := 'renamed';
        when check_violation or foreign_key_violation or insufficient_privilege
          or not_null_violation or invalid_text_representation then
          outcome := 'rejected';
          exit;
      end;
    end loop;

    results := results || jsonb_build_array(jsonb_build_object(
      'id', node.id,
      'status', outcome,
      'node', (
        select jsonb_build_object(
          'id', n.id, 'parent_id', n.parent_id, 'title', n.title, 'position', n.position,
          'child_label', n.child_label, 'icon', n.icon, 'color', n.color,
          'course_id', n.course_id, 'deleted_at', n.deleted_at, 'edited_at', n.edited_at
        )
        from public.notebooks n where n.id = node.id
      )
    ));
  end loop;
  return results;
end;
$$;

revoke all on function public.sync_notebook_tree(jsonb, uuid[]) from public, anon;
grant execute on function public.sync_notebook_tree(jsonb, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- sync_note_page: the tree sync owns a notebook's title, place and course now (decision 17).
-- A page's lines only make a notebook row when there's none yet (older clients), never
-- changing one. Otherwise as in 20261024000000_note_lines.sql.
-- ---------------------------------------------------------------------------------------------
create or replace function public.sync_note_page(
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
  free_title text := p_notebook ->> 'title';
  attempt integer := 1;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 200
    or cardinality(p_removed) > 1000 then
    raise exception 'too many lines in one sync' using errcode = '22023';
  end if;

  insert into public.profiles default values on conflict (id) do nothing;

  if not exists (select 1 from public.notebooks n where n.id = notebook_id) then
    -- A top-level notebook, numbered past any root it would clash with.
    while exists (
      select 1 from public.notebooks n
      where n.user_id = (select auth.jwt() ->> 'sub') and n.parent_id is null
        and n.deleted_at is null and lower(n.title) = lower(free_title)
    ) loop
      attempt := attempt + 1;
      free_title := left(p_notebook ->> 'title', 76) || ' ' || attempt;
    end loop;
    insert into public.notebooks (id, title, course_id)
    values (
      notebook_id,
      free_title,
      (select c.id from public.courses c where c.id = (p_notebook ->> 'course_id')::uuid)
    )
    on conflict (id) do nothing;
  end if;

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
