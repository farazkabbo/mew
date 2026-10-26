-- Two-key shortcuts (K2, docs/NOTEBOOKS_K.md §11.4): the student's own notebook shortcuts and the
-- one-time "Shortcuts got simpler" card are settings like the others, stored in
-- profiles.settings. The same rule as the app's: an object of at most 32 bindings, each named in
-- lowercase and each two keys at most (Ctrl or Alt with a key, or a key alone).

alter table public.profiles
  add constraint profiles_settings_shortcuts check (
    settings -> 'shortcuts' is null
    or (
      jsonb_typeof(settings -> 'shortcuts') = 'object'
      and jsonb_array_length(jsonb_path_query_array(settings -> 'shortcuts', '$.keyvalue()')) <= 32
      and not jsonb_path_exists(
        settings -> 'shortcuts',
        '$.keyvalue() ? (!(@.key like_regex "^[a-z_]{1,32}$"))'
      )
      and not jsonb_path_exists(
        settings -> 'shortcuts',
        '$.* ? (@.type() != "string" || !(@ like_regex "^((Ctrl|Alt)[+])?([A-Z0-9]|F([1-9]|1[0-2])|Arrow(Up|Down|Left|Right)|Enter|Space|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|Minus|Equal|BracketLeft|BracketRight|Backslash|Backquote)$"))'
      )
    )
  ),
  add constraint profiles_settings_shortcuts_notice check (
    settings -> 'shortcuts_notice_seen' is null
    or jsonb_typeof(settings -> 'shortcuts_notice_seen') = 'boolean'
  );
