-- Skills (Screen Coach S5, docs/SCREEN_COACH.md §2.6 and §6): what a walkthrough taught, kept in
-- the learner model with spaced re-checks ("Three days ago you made a pivot table with one hint.
-- Want to try it solo?").
--
-- - skills: one per task the student learned (its title and app), with its FSRS card and, when
--   one of their course concepts is that task, a link to it.
-- - skill_evidence: one row per finished walkthrough of it. The brief's rule is enforced here:
--   a guided walkthrough is never `independent`; only a re-check done without coaching is.
-- - walkthroughs: a kind (guided, or a re-check) and the skill it built or checked.
--
-- Written by the API service with the secret key, after the web server finished the walkthrough
-- it ran for the desktop app's device token (decision 10: the device can't claim evidence).
-- Owners read their skills and evidence and may delete a skill; nothing else.

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 60),
  app_exe_name text check (app_exe_name ~ '^[a-z0-9 ._+()-]{1,60}\.exe$'),
  -- The same task in the same app is one skill: lower(title) and the app.
  key text not null check (char_length(key) between 1 and 130),
  -- The course concept that is this task, when there is one.
  course_id uuid,
  concept_id uuid,
  fsrs_state jsonb not null check (jsonb_typeof(fsrs_state) = 'object'),
  due_at timestamptz not null,
  last_walkthrough_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, key),
  check ((course_id is null) = (concept_id is null)),
  foreign key (concept_id, course_id, user_id)
    references public.concepts (id, course_id, user_id) on delete set null (concept_id, course_id),
  foreign key (last_walkthrough_id, user_id)
    references public.walkthroughs (id, user_id) on delete set null (last_walkthrough_id)
);

create index skills_user_id_due_at_idx on public.skills (user_id, due_at);
create index skills_concept_id_course_id_user_id_idx
  on public.skills (concept_id, course_id, user_id);
create index skills_last_walkthrough_id_user_id_idx
  on public.skills (last_walkthrough_id, user_id);

create table public.skill_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles (id) on delete cascade,
  skill_id uuid not null,
  walkthrough_id uuid,
  kind text not null check (kind in ('guided', 'recheck')),
  -- `not_yet`: a re-check that wasn't done (the card comes back sooner).
  evidence text not null
    check (evidence in ('independent', 'with_hint', 'after_explanation', 'not_yet')),
  hints integer not null default 0 check (hints between 0 and 45),
  created_at timestamptz not null default now(),
  -- The brief's rule (§6): coaching is never independent.
  check (kind = 'recheck' or evidence <> 'independent'),
  foreign key (skill_id, user_id) references public.skills (id, user_id) on delete cascade,
  foreign key (walkthrough_id, user_id)
    references public.walkthroughs (id, user_id) on delete set null (walkthrough_id)
);

create index skill_evidence_user_id_created_at_idx
  on public.skill_evidence (user_id, created_at);
create index skill_evidence_skill_id_user_id_idx on public.skill_evidence (skill_id, user_id);
create index skill_evidence_walkthrough_id_user_id_idx
  on public.skill_evidence (walkthrough_id, user_id);

alter table public.walkthroughs
  add column kind text not null default 'guided' check (kind in ('guided', 'recheck')),
  add column skill_id uuid,
  add constraint walkthroughs_skill_fk foreign key (skill_id, user_id)
    references public.skills (id, user_id) on delete set null (skill_id);

create index walkthroughs_skill_id_user_id_idx on public.walkthroughs (skill_id, user_id);

-- ---------------------------------------------------------------------------------------------
-- Privileges: owners read (and may delete a skill); the API service writes.
-- ---------------------------------------------------------------------------------------------
revoke all on public.skills, public.skill_evidence from anon, authenticated;

grant select, delete on public.skills to authenticated;
grant select on public.skill_evidence to authenticated;

alter table public.skills enable row level security;
alter table public.skill_evidence enable row level security;

create policy skills_select on public.skills for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy skills_delete on public.skills for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
create policy skill_evidence_select on public.skill_evidence for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
