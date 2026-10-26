-- Moments (K8, docs/NOTEBOOKS_K.md §4.6–4.7): saved screen moments are filed by what the
-- student studies, revisited at the exact spot, and quizzed on later.
--
-- - notebooks.subject: what a notebook is about ("physics"), suggested from its name, editable;
--   filing compares it with the subject of an answer.
-- - filing_memory: where each source's moments went last (a YouTube video, a PDF, a site and
--   path), so the next moment from it goes there too; `corrected` when the student moved one.
-- - filing_corrections: "Change teaches": a moment moved from one place to another, with its
--   concept hints, so similar moments aren't filed back where the student took them from.
-- - moment_checks: one check question per saved moment, an FSRS card each (merged by concept
--   within a week, at most 15 new a day, the rest queued).
-- - The private "moment-audio" bucket: the explanation's own voice, for Replay.
--
-- Filing and new checks are written by the API service with the secret key after it checked the
-- desktop app's device token (filtered to the token's owner, decision 40); the student's own
-- session reads them, answers checks and moves moments. RLS: owners only, everywhere.

-- ---------------------------------------------------------------------------------------------
-- notebooks.subject
-- ---------------------------------------------------------------------------------------------
alter table public.notebooks
  add column subject text check (subject in
    ('math', 'physics', 'chemistry', 'biology', 'history', 'language', 'programming', 'other'));

grant update (subject) on public.notebooks to authenticated;

-- sync_notebook_tree with the subject (otherwise as in 20261030000000_notebook_tree.sql).
create or replace function public.sync_notebook_tree(p_nodes jsonb, p_removed uuid[] default '{}')
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

  insert into public.profiles default values on conflict (id) do nothing;

  delete from public.notebooks n where n.id = any (coalesce(p_removed, '{}'));

  for item in select value from jsonb_array_elements(p_nodes) with ordinality order by ordinality
  loop
    select * into node from jsonb_to_record(item) as x(
      id uuid, parent_id uuid, title text, position text, child_label text, icon text,
      color text, subject text, course_id uuid, deleted_at timestamptz, edited_at timestamptz
    );
    outcome := 'saved';
    wanted := node.title;
    attempt := 1;
    loop
      begin
        insert into public.notebooks as n (id, parent_id, title, position, child_label, icon,
          color, subject, course_id, deleted_at, edited_at)
        values (
          node.id, node.parent_id, wanted, node.position, node.child_label, node.icon,
          node.color, node.subject,
          (select c.id from public.courses c where c.id = node.course_id),
          node.deleted_at, node.edited_at
        )
        on conflict (id) do update set
          parent_id = excluded.parent_id, title = excluded.title, position = excluded.position,
          child_label = excluded.child_label, icon = excluded.icon, color = excluded.color,
          subject = excluded.subject, course_id = excluded.course_id,
          deleted_at = excluded.deleted_at, edited_at = excluded.edited_at
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
          'child_label', n.child_label, 'icon', n.icon, 'color', n.color, 'subject', n.subject,
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
-- filing_memory and filing_corrections
-- ---------------------------------------------------------------------------------------------
create table public.filing_memory (
  user_id text not null default (auth.jwt() ->> 'sub')
    references public.profiles (id) on delete cascade,
  -- "youtube:<video id>", "pdf:<file name>", "web:<host>/<path>", "app:<exe>" (destinations.ts).
  source_key text not null check (char_length(source_key) between 1 and 300),
  node_id uuid not null,
  corrected boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, source_key),
  foreign key (node_id, user_id) references public.notebooks (id, user_id) on delete cascade
);

create index filing_memory_node_id_user_id_idx on public.filing_memory (node_id, user_id);

create table public.filing_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub')
    references public.profiles (id) on delete cascade,
  from_node_id uuid,
  to_node_id uuid not null,
  hints text[] not null default '{}'
    check (cardinality(hints) <= 5 and array_to_string(hints, '') !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now(),
  foreign key (to_node_id, user_id) references public.notebooks (id, user_id) on delete cascade,
  foreign key (from_node_id, user_id) references public.notebooks (id, user_id)
    on delete set null (from_node_id)
);

create index filing_corrections_user_id_created_at_idx
  on public.filing_corrections (user_id, created_at);
create index filing_corrections_to_node_id_user_id_idx
  on public.filing_corrections (to_node_id, user_id);
create index filing_corrections_from_node_id_user_id_idx
  on public.filing_corrections (from_node_id, user_id);

-- ---------------------------------------------------------------------------------------------
-- moment_checks
-- ---------------------------------------------------------------------------------------------
create table public.moment_checks (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub')
    references public.profiles (id) on delete cascade,
  -- The moment it was made from, and the others about the same concept that week.
  clip_id uuid not null,
  merged_clip_ids uuid[] not null default '{}' check (cardinality(merged_clip_ids) <= 20),
  node_id uuid,
  prompt text not null check (char_length(prompt) between 1 and 300),
  kind text not null check (kind in ('short', 'mcq', 'work')),
  choices jsonb not null default '[]'::jsonb
    check (jsonb_typeof(choices) = 'array' and jsonb_array_length(choices) <= 4),
  answer_key text not null check (char_length(answer_key) between 1 and 300),
  answer_latex text check (char_length(answer_latex) <= 300),
  concept_hints text[] not null default '{}' check (cardinality(concept_hints) <= 5),
  -- Queued past the day's 15 new checks; active once there's room.
  status text not null default 'active' check (status in ('queued', 'active')),
  fsrs_state jsonb check (fsrs_state is null or jsonb_typeof(fsrs_state) = 'object'),
  due_at timestamptz,
  reps integer not null default 0 check (reps >= 0),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (clip_id, user_id) references public.clips (id, user_id) on delete cascade,
  foreign key (node_id, user_id) references public.notebooks (id, user_id)
    on delete set null (node_id),
  check ((status = 'active') = (due_at is not null))
);

create index moment_checks_user_id_due_at_idx on public.moment_checks (user_id, due_at);
create index moment_checks_clip_id_user_id_idx on public.moment_checks (clip_id, user_id);
create index moment_checks_node_id_user_id_idx on public.moment_checks (node_id, user_id);

-- ---------------------------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------------------------
revoke all on public.filing_memory, public.filing_corrections, public.moment_checks
  from anon, authenticated;

-- A move by the student ("Change") is theirs to record.
grant select, delete on public.filing_memory to authenticated;
grant insert (source_key, node_id, corrected) on public.filing_memory to authenticated;
grant update (node_id, corrected, updated_at) on public.filing_memory to authenticated;
grant select, delete on public.filing_corrections to authenticated;
grant insert (from_node_id, to_node_id, hints) on public.filing_corrections to authenticated;
-- Checks are made by the API service; the student answers them (the schedule) or clears them.
grant select, delete on public.moment_checks to authenticated;
grant update (fsrs_state, due_at, reps, status, activated_at) on public.moment_checks
  to authenticated;

alter table public.filing_memory enable row level security;
alter table public.filing_corrections enable row level security;
alter table public.moment_checks enable row level security;

create policy filing_memory_owner on public.filing_memory for all to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy filing_corrections_owner on public.filing_corrections for all to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy moment_checks_owner on public.moment_checks for all to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));

-- ---------------------------------------------------------------------------------------------
-- Answering a check is an attempt of its own; the setting that turns new checks off
-- ---------------------------------------------------------------------------------------------
alter table public.attempts
  drop constraint attempts_source_check,
  add constraint attempts_source_check
    check (source in ('practice', 'quiz', 'notes_check', 'your_turn', 'moment_check'));

alter table public.profiles
  add constraint profiles_settings_quiz_saved check (
    settings -> 'quiz_saved_moments' is null
    or jsonb_typeof(settings -> 'quiz_saved_moments') = 'boolean'
  );

-- ---------------------------------------------------------------------------------------------
-- Storage: the explanation's voice, per step (16-bit PCM, 24 kHz), under "<user id>/<clip id>/".
-- The student's own page uploads what it played; owners read and delete their own folder.
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('moment-audio', 'moment-audio', false, 1048576, array['audio/L16']);

create policy moment_audio_select on storage.objects for select to authenticated
  using (bucket_id = 'moment-audio'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));
create policy moment_audio_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'moment-audio'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));
create policy moment_audio_delete on storage.objects for delete to authenticated
  using (bucket_id = 'moment-audio'
    and (storage.foldername(name))[1] = (select auth.jwt() ->> 'sub'));
