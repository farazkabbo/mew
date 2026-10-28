-- "Stayed" (docs/NEB_APP_UI.md §6.4, decision U10): the only progress the app shows. A moment
-- check stayed when it was answered right, alone (no peek, no hint), at least a day after it
-- was saved. The grading path sets `stayed_at` the first time that happens; it never changes
-- after that (a retried answer can't count twice), and it can't be earlier than a day after the
-- check was made. `notebook_stayed` counts them per notebook for the desk's ribbons.

alter table public.moment_checks
  add column stayed_at timestamptz,
  add constraint moment_checks_stayed_after_a_day
    check (stayed_at is null or stayed_at >= created_at + interval '1 day');

-- Set once: an update can set it, never move or clear it.
create function public.moment_checks_keep_stayed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.stayed_at is not null then
    new.stayed_at := old.stayed_at;
  end if;
  return new;
end;
$$;

create trigger moment_checks_keep_stayed
  before update of stayed_at on public.moment_checks
  for each row execute function public.moment_checks_keep_stayed();

grant update (stayed_at) on public.moment_checks to authenticated;

-- Per root notebook (a check filed in a page or chapter counts for its notebook), with the last
-- 7 days for "stayed this week". security_invoker: RLS on moment_checks and notebooks applies, so
-- a student only ever counts their own.
create view public.notebook_stayed
with (security_invoker = true)
as
  with recursive roots as (
    select id, user_id, id as notebook_id
    from public.notebooks
    where parent_id is null
    union all
    select child.id, child.user_id, roots.notebook_id
    from public.notebooks child
    join roots on child.parent_id = roots.id and child.user_id = roots.user_id
  )
  select
    roots.notebook_id,
    count(*)::integer as stayed_count,
    count(*) filter (where checks.stayed_at > now() - interval '7 days')::integer as stayed_week
  from public.moment_checks checks
  join roots on roots.id = checks.node_id and roots.user_id = checks.user_id
  where checks.stayed_at is not null
  group by roots.notebook_id;

revoke all on public.notebook_stayed from anon, authenticated;
grant select on public.notebook_stayed to authenticated;
