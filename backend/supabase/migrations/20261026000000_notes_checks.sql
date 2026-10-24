-- Notes Check results (N3, docs/SCREEN_COACH_NOTES_CHECK.md §4.2): each check, its findings,
-- and the links from matched note lines to where they came from.
--
-- No screenshot and no screen text is kept: only the short quotes attached to findings (at most
-- 200 characters each). A check from the desktop app is written by the API service with the
-- secret key after its device token was verified; one from the notebook with the student's own
-- token. Students read their own, update a finding's status (N5) and delete; nobody else.
-- Findings go with the page their lines are on; everything goes with the account.

create table public.notes_checks (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub')
    references public.profiles (id) on delete cascade,
  -- {"kind": "notebook"|"course"|"all", "notebook_ids": [...], "course_id": …}
  scope jsonb not null check (jsonb_typeof(scope) = 'object' and pg_column_size(scope) <= 4096),
  -- The app in front ("msedge.exe"); never its window title.
  source_app text check (source_app ~ '^[a-z0-9 ._+()-]{1,60}\.exe$'),
  model_version text not null check (char_length(model_version) between 1 and 120),
  latency_ms integer not null check (latency_ms between 0 and 600000),
  created_at timestamptz not null default now(),

  unique (id, user_id)
);

create index notes_checks_user_id_created_at_idx on public.notes_checks (user_id, created_at);

create table public.notes_findings (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null,
  user_id text not null default (auth.jwt() ->> 'sub'),
  -- The page of the finding's lines (or, for a gap, of the line it would follow).
  page_id uuid,
  type text not null check (type in ('match', 'difference', 'gap', 'unclear')),
  note_line_ids uuid[] not null default '{}' check (cardinality(note_line_ids) <= 12),
  note_quote text check (char_length(note_quote) <= 200),
  screen_snippet text not null check (char_length(screen_snippet) between 1 and 200),
  question text check (char_length(question) <= 240),
  -- For the tutor's follow-ups (N5); never shown as it is.
  explanation text not null default '' check (char_length(explanation) <= 300),
  concept_hint text check (char_length(concept_hint) <= 80),
  concept_id uuid,
  confidence real not null check (confidence between 0 and 1),
  source_conflict boolean not null default false,
  status text not null default 'open' check (status in
    ('open', 'resolved_fixed', 'resolved_student_right', 'dismissed', 'explained')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,

  unique (id, user_id),
  check ((status = 'open') = (resolved_at is null)),
  foreign key (check_id, user_id) references public.notes_checks (id, user_id) on delete cascade,
  foreign key (page_id, user_id) references public.pages (id, user_id) on delete cascade,
  foreign key (concept_id, user_id) references public.concepts (id, user_id)
    on delete set null (concept_id)
);

create index notes_findings_check_id_idx on public.notes_findings (check_id);
create index notes_findings_user_id_status_idx on public.notes_findings (user_id, status);
create index notes_findings_page_id_idx on public.notes_findings (page_id) where page_id is not null;
create index notes_findings_concept_id_idx on public.notes_findings (concept_id)
  where concept_id is not null;

create table public.note_source_links (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub'),
  note_line_id uuid not null,
  clip_id uuid,
  -- A link kept only because the student checked their notes against it: https, trimmed like a
  -- clip's (scheme, host and path, plus YouTube's v and t).
  url text check (char_length(url) <= 2000 and url ~ '^https://'),
  title text check (char_length(title) between 1 and 200),
  timestamp_sec integer check (timestamp_sec between 0 and 86400),
  created_from_finding_id uuid,
  created_at timestamptz not null default now(),

  unique (id, user_id),
  check (clip_id is not null or url is not null),
  foreign key (note_line_id, user_id) references public.note_lines (id, user_id) on delete cascade,
  foreign key (clip_id, user_id) references public.clips (id, user_id) on delete cascade,
  foreign key (created_from_finding_id, user_id) references public.notes_findings (id, user_id)
    on delete set null (created_from_finding_id)
);

create index note_source_links_note_line_id_idx on public.note_source_links (note_line_id);
create index note_source_links_user_id_idx on public.note_source_links (user_id);
create index note_source_links_clip_id_idx on public.note_source_links (clip_id)
  where clip_id is not null;
create index note_source_links_finding_idx on public.note_source_links (created_from_finding_id)
  where created_from_finding_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
revoke all on public.notes_checks, public.notes_findings, public.note_source_links
  from anon, authenticated;

grant select, insert, delete on public.notes_checks to authenticated;
grant select, insert, delete on public.notes_findings to authenticated;
grant update (status, resolved_at, concept_id) on public.notes_findings to authenticated;
grant select, insert, delete on public.note_source_links to authenticated;

alter table public.notes_checks enable row level security;
alter table public.notes_findings enable row level security;
alter table public.note_source_links enable row level security;

create policy notes_checks_select on public.notes_checks for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy notes_checks_insert on public.notes_checks for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy notes_checks_delete on public.notes_checks for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy notes_findings_select on public.notes_findings for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy notes_findings_insert on public.notes_findings for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy notes_findings_update on public.notes_findings for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy notes_findings_delete on public.notes_findings for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

create policy note_source_links_select on public.note_source_links for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy note_source_links_insert on public.note_source_links for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub'));
create policy note_source_links_delete on public.note_source_links for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
