-- Show-then-You (K6, docs/NOTEBOOKS_K.md §6): a Your Turn solved after a full solution is an
-- attempt of its own kind (it's what counts toward mastery when done alone), and the student can
-- turn the Your Turn off ("After a full solution: give me a Your Turn", on by default).

alter table public.attempts
  drop constraint attempts_source_check,
  add constraint attempts_source_check
    check (source in ('practice', 'quiz', 'notes_check', 'your_turn'));

alter table public.profiles
  add constraint profiles_settings_your_turn check (
    settings -> 'your_turn_after_solution' is null
    or jsonb_typeof(settings -> 'your_turn_after_solution') = 'boolean'
  );
