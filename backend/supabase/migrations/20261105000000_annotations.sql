-- Live annotations (K9, docs/NOTEBOOKS_K.md §7): the marks the tutor makes on each finished line
-- while the student writes (a tick, an error circle with a 1-4 word hint, "units?", a margin note,
-- or a dashed "?"). The strokes themselves stay on the device with the page (decision 14); the
-- server keeps what each mark was, how it ended (resolved, or dismissed as "not wrong" / hidden)
-- and the evidence it gave, so "Not wrong" corrections feed the checker's and recognition's eval
-- sets (§8). The recognised text is sent only when the student lets neb keep their notes' text.

create table public.annotations (
  id uuid primary key,
  user_id text not null default (auth.jwt() ->> 'sub')
    references public.profiles (id) on delete cascade,
  -- Pages and lines live on the device: no foreign keys, only the ids the device made.
  page_id uuid not null,
  line_id uuid not null,
  mark_kind text not null check (mark_kind in ('tick', 'error', 'missing', 'margin', 'unsure')),
  verdict text not null check (verdict in ('correct', 'incorrect', 'unknown')),
  checker_method text not null
    check (checker_method in ('math', 'chemistry', 'code', 'rubric', 'coach', 'reading')),
  recognized_text text check (char_length(recognized_text) <= 500),
  confidence real check (confidence between 0 and 1),
  stroke_group_id uuid not null,
  note text check (char_length(note) <= 32),
  created_at timestamptz not null,
  resolved_at timestamptz,
  dismissed_as text check (dismissed_as in ('not_wrong', 'hidden')),
  evidence text check (evidence in ('independent', 'with_hint', 'after_explanation')),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create index annotations_user_id_page_id_idx on public.annotations (user_id, page_id);
-- The eval sets read the corrections: "not wrong" marks.
create index annotations_not_wrong_idx on public.annotations (user_id)
  where dismissed_as = 'not_wrong';

revoke all on public.annotations from anon, authenticated;
-- The student's device writes its own marks (an upsert by id) and may read or delete them.
grant select, delete on public.annotations to authenticated;
grant insert (id, page_id, line_id, mark_kind, verdict, checker_method, recognized_text,
  confidence, stroke_group_id, note, created_at, resolved_at, dismissed_as, evidence, updated_at)
  on public.annotations to authenticated;
-- An upsert sends every column, so update covers them all; the trigger below keeps what a mark is
-- about (its page, line, stroke group and when it was made) from changing.
grant update (id, page_id, line_id, mark_kind, verdict, checker_method, recognized_text,
  confidence, stroke_group_id, note, created_at, resolved_at, dismissed_as, evidence, updated_at)
  on public.annotations to authenticated;

create function public.annotations_keep_identity() returns trigger
  language plpgsql set search_path = '' as $$
begin
  if new.page_id <> old.page_id or new.line_id <> old.line_id
     or new.stroke_group_id <> old.stroke_group_id or new.created_at <> old.created_at then
    raise exception 'an annotation stays on its page and line' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger annotations_keep_identity before update on public.annotations
  for each row execute function public.annotations_keep_identity();

alter table public.annotations enable row level security;

create policy annotations_owner on public.annotations for all to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));

-- A line that's right after a mark (or first time) is an attempt of its own kind.
alter table public.attempts
  drop constraint attempts_source_check,
  add constraint attempts_source_check
    check (source in ('practice', 'quiz', 'notes_check', 'your_turn', 'moment_check',
      'live_annotation'));
