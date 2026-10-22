-- Settings (M9): the keys the settings screen stores in profiles.settings get the same kind of
-- type checks mew_threshold and mew_logging_opt_in already have (core schema), so a client can't
-- store values the app would choke on. Unknown keys stay allowed (older or newer clients).

alter table public.profiles
  add constraint profiles_settings_answer_style check (
    settings -> 'answer_style' is null
    or settings ->> 'answer_style' in ('hints_first', 'direct')
  ),
  add constraint profiles_settings_flags check (
    (settings -> 'captions' is null or jsonb_typeof(settings -> 'captions') = 'boolean')
    and (settings -> 'auto_check' is null or jsonb_typeof(settings -> 'auto_check') = 'boolean')
    and (settings -> 'listen_on_open' is null
      or jsonb_typeof(settings -> 'listen_on_open') = 'boolean')
    and (settings -> 'onboarded' is null or jsonb_typeof(settings -> 'onboarded') = 'boolean')
  ),
  -- Part of an upstream URL path when speaking, so only the voice-ID alphabet.
  add constraint profiles_settings_voice_id check (
    settings -> 'voice_id' is null
    or jsonb_typeof(settings -> 'voice_id') = 'null'
    or (settings ->> 'voice_id') ~ '^[A-Za-z0-9]{8,64}$'
  );
