-- K8 follow-up: a Windows notification when saved moments' checks are due (§4.7: desktop
-- notifications are opt-in), a setting like the others.

alter table public.profiles
  add constraint profiles_settings_notify_checks check (
    settings -> 'notify_moment_checks' is null
    or jsonb_typeof(settings -> 'notify_moment_checks') = 'boolean'
  );
