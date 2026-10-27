-- Quiz me on this (Screen Coach S6, docs/SCREEN_COACH.md §2.5): "quiz me on this" turns what's on
-- the screen into 1–3 practice questions, asked there and then, and each becomes a recall card in
-- the review queue — the same cards as K8's saved moments (`moment_checks`), so they're reviewed,
-- scheduled, capped and answered the same way.
--
-- A quiz card has no saved moment behind it (nothing was saved: the screenshot is never kept), so
-- `clip_id` is optional for it; it keeps where its questions came from instead (the window's
-- title and the app, kept only because the student asked to be quizzed on it).

alter table public.moment_checks
  add column origin text not null default 'moment' check (origin in ('moment', 'screen_quiz')),
  add column source_title text check (char_length(source_title) between 1 and 200),
  add column source_app text check (source_app ~ '^[a-z0-9 ._+()-]{1,60}\.exe$'),
  alter column clip_id drop not null,
  -- A saved moment's card has its moment; a quiz card has none.
  add constraint moment_checks_origin_clip check ((origin = 'moment') = (clip_id is not null));
