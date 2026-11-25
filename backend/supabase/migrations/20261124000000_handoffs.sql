-- Handoff (docs/HANDOFF_FEATURE.md, being built): a person's work handed to a teammate from the
-- exact moment they stopped.
--
-- The package is encrypted on the sender's computer (AES-256-GCM); only ciphertext is stored, in
-- the private "handoffs" bucket. Its content key is kept here wrapped by a server key, and handed
-- out by the server only to signed-in members. Everything is read and written by the API service
-- (secret key) after it checked who is asking: users get no direct access to any of these tables
-- (RLS on, no policies, no grants). Events carry no content. Expired or revoked handoffs are
-- hard-deleted with their package, key, members, events and replies by `purge_handoffs`.

create table public.handoffs (
  id uuid primary key,
  sender_id text not null references public.profiles (id) on delete cascade,
  sender_name text not null check (char_length(sender_name) between 1 and 80),
  title text not null check (char_length(title) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'sent', 'revoked')),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  -- "<sender id>/<handoff id>.bin" in the handoffs bucket.
  storage_path text not null unique
    check (storage_path ~ '^[A-Za-z0-9_-]{1,128}/[0-9a-f-]{36}\.bin$'
      and split_part(storage_path, '/', 1) = sender_id),
  wrapped_key text check (char_length(wrapped_key) <= 200),
  size_bytes integer not null check (size_bytes between 1 and 26214400)
);

create index handoffs_sender_idx on public.handoffs (sender_id, created_at);
create index handoffs_expires_idx on public.handoffs (expires_at);

create table public.handoff_members (
  handoff_id uuid not null references public.handoffs (id) on delete cascade,
  -- Set when the member is known by id (or on their first sign-in with the invited email).
  user_id text,
  email text not null check (email ~ '^[^@\s]{1,64}@[^@\s]{1,190}$' and email = lower(email)),
  role text not null check (role in ('sender', 'recipient')),
  opened_at timestamptz,
  picked_up_at timestamptz,
  primary key (handoff_id, email)
);

create index handoff_members_user_idx on public.handoff_members (user_id);
create index handoff_members_email_idx on public.handoff_members (email);

create table public.handoff_events (
  id bigint generated always as identity primary key,
  handoff_id uuid not null references public.handoffs (id) on delete cascade,
  actor_id text,
  type text not null check (type in (
    'created', 'opened', 'walkthrough_played', 'asked', 'replied', 'picked_up', 'revoked', 'expired'
  )),
  at timestamptz not null default now()
);

create index handoff_events_handoff_idx on public.handoff_events (handoff_id, at);

create table public.handoff_replies (
  id uuid primary key default gen_random_uuid(),
  handoff_id uuid not null references public.handoffs (id) on delete cascade,
  author_id text not null,
  author_name text not null check (char_length(author_name) between 1 and 80),
  body text not null check (char_length(body) between 1 and 2000),
  voice_path text,
  created_at timestamptz not null default now()
);

create index handoff_replies_handoff_idx on public.handoff_replies (handoff_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Privileges: none for users. The API service (secret key) is the only reader and writer.
-- ---------------------------------------------------------------------------------------------
revoke all on public.handoffs, public.handoff_members, public.handoff_events,
  public.handoff_replies from anon, authenticated;

alter table public.handoffs enable row level security;
alter table public.handoff_members enable row level security;
alter table public.handoff_events enable row level security;
alter table public.handoff_replies enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Storage: a private bucket of ciphertext, with no policies (service only).
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('handoffs', 'handoffs', false, 26214400, array['application/octet-stream']);

-- ---------------------------------------------------------------------------------------------
-- The daily purge: the handoffs that expired or were revoked, and everything hanging off them.
-- Returns their storage paths, which the API service then deletes from the bucket.
-- ---------------------------------------------------------------------------------------------
create function public.purge_handoffs(p_now timestamptz)
returns setof text
language sql
security invoker
set search_path = ''
as $$
  delete from public.handoffs
  where expires_at <= p_now or status = 'revoked'
  returning storage_path;
$$;

revoke all on function public.purge_handoffs(timestamptz) from public, anon, authenticated;
