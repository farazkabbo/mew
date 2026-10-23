-- Device tokens (Screen Coach S2, docs/SCREEN_COACH.md decision 8): how the desktop app signs in
-- to the Screen Coach endpoints without a browser session.
--
-- The desktop app holds an opaque random token (256 bits) in Windows Credential Manager; this
-- table holds only its SHA-256 hash. Tokens are created and checked by the API service with the
-- secret key (the desktop app has no Clerk session). Users can list their devices and revoke
-- them, nothing else: they can't create tokens, read hashes, or bring a revoked token back.
--
-- Revoking sets revoked_at (immediate: every Screen Coach request is checked against this table).
-- Deleting the account removes the tokens with the profile.

create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles (id) on delete cascade,
  -- Lowercase hex SHA-256 of the token.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  device_name text not null check (char_length(device_name) between 1 and 80),
  -- What the token may be used for. Only Screen Coach exists.
  scopes text[] not null default array['screen']
    check (cardinality(scopes) between 1 and 4 and scopes <@ array['screen']),
  created_at timestamptz not null default now(),
  -- Updated at most once an hour by the API (avoids a write per request).
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index device_tokens_user_id_idx on public.device_tokens (user_id);

-- ---------------------------------------------------------------------------------------------
-- Privileges: users may read their devices (never the hash) and revoke them; the API service
-- (secret key) creates and checks tokens.
-- ---------------------------------------------------------------------------------------------
revoke all on public.device_tokens from anon, authenticated;

grant select (id, device_name, scopes, created_at, last_used_at, revoked_at)
  on public.device_tokens to authenticated;
grant update (revoked_at) on public.device_tokens to authenticated;

alter table public.device_tokens enable row level security;

create policy device_tokens_select on public.device_tokens for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));
-- Revoking only: once set, revoked_at can't be cleared again.
create policy device_tokens_revoke on public.device_tokens for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub') and revoked_at is null)
  with check (user_id = (select auth.jwt() ->> 'sub') and revoked_at is not null);
