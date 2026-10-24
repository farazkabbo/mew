-- Notes Check's resolution loop (N5, docs/SCREEN_COACH_NOTES_CHECK.md §2.4, §9): a misunderstanding
-- the student fixed after a question, or had explained, is learner evidence on its concept, like
-- a practice or quiz answer. Findings themselves change nothing; only these outcomes do.

alter table public.attempts drop constraint attempts_source_check;
alter table public.attempts
  add constraint attempts_source_check check (source in ('practice', 'quiz', 'notes_check'));
