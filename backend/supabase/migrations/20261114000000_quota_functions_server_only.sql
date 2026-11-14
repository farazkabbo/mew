-- The allowance functions are the API service's alone (secret key: service_role). The two
-- migrations before this revoked them only from `public`, but Supabase also grants every new
-- function in `public` to anon and authenticated by name, so with the publishable key anyone
-- could call these security-definer functions directly (for example reserve_question with
-- p_unlimited = true). Revoked here; applied to production on 2026-11-14 before any traffic.

revoke execute on function public.reserve_question(text, text, integer, boolean, boolean)
  from anon, authenticated;
revoke execute on function public.refund_question(uuid) from anon, authenticated;
revoke execute on function public.finish_question(uuid, text, integer, integer)
  from anon, authenticated;
revoke execute on function public.ask_to_notify(text, integer) from anon, authenticated;
