-- "We'll email you when more open up" (docs/LAUNCH_LIMITS.md): a learner who reached 0 free
-- questions is flagged, and the owner exports those accounts' emails for a broadcast
-- (scripts/export-notify-emails.mjs). Nothing is sent from here.
--
-- Written only by the API service (secret key), like the rest of the allowance. The learner may
-- read their own row (the existing select policy), not change it.

alter table public.question_quota
  add column notify_when_more boolean not null default false;

-- Flags `p_user` (making the row if they ran out on a computer before their own row existed).
create function public.ask_to_notify(p_user text, p_limit integer)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.question_quota (user_id, limit_total, notify_when_more)
  values (p_user, p_limit, true)
  on conflict (user_id) do update set notify_when_more = true, updated_at = now();
$$;

revoke all on function public.ask_to_notify(text, integer) from public;
grant execute on function public.ask_to_notify(text, integer) to service_role;
