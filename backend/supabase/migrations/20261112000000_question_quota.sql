-- The free allowance (docs/LAUNCH_LIMITS.md): every learner gets a few questions (8 by default),
-- and so does every computer, so a new account on the same computer starts with what that
-- computer has left. The count lives here, not in Redis (Redis may evict or be flushed).
--
-- Only the API service writes, through the functions below (the secret key: service_role).
-- A learner may read their own allowance row, nothing else; nobody can write it directly.
--
-- A question is reserved before the model is called, then finished (with its token counts) or
-- refunded when it failed before the learner got an answer: our errors never cost a question.
-- Reserving is one statement per table, each guarded by "used < limit", so parallel requests can
-- never get more than the allowance through.

create table public.question_quota (
  -- The Clerk user id ("user_2ab…"): text, and no foreign key (the row can come before the
  -- profile, from Clerk's user.created webhook).
  user_id text primary key check (char_length(user_id) between 1 and 200),
  used integer not null default 0 check (used >= 0),
  limit_total integer not null default 8 check (limit_total between 0 and 100000),
  -- Founders and testers (an allowlist the API service applies).
  unlimited boolean not null default false,
  -- The day the count started (QUOTA_WINDOW=daily resets it each day; lifetime never does).
  window_start date not null default current_date,
  updated_at timestamptz not null default now()
);

create table public.device_quota (
  -- SHA-256 of the computer's own id (kept in its keychain), never the id itself.
  device_hash text primary key check (device_hash ~ '^[0-9a-f]{64}$'),
  used integer not null default 0 check (used >= 0),
  window_start date not null default current_date,
  updated_at timestamptz not null default now()
);

create table public.question_log (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (char_length(user_id) between 1 and 200),
  device_hash text check (device_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'reserved' check (status in ('reserved', 'done', 'refunded')),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  model text check (char_length(model) <= 100),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0)
);

create index question_log_user_idx on public.question_log (user_id, created_at desc);

alter table public.question_quota enable row level security;
alter table public.device_quota enable row level security;
alter table public.question_log enable row level security;

revoke all on public.question_quota, public.device_quota, public.question_log
  from anon, authenticated;
grant select on public.question_quota to authenticated;

create policy question_quota_own on public.question_quota for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'));

-- Reserves one question for `p_user` on `p_device` (null: the web, no computer). Raises
-- QUOTA_EXCEEDED (errcode P0001) when the learner's or the computer's allowance is used up;
-- the whole call is one transaction, so nothing is counted then. Returns the question's id.
create function public.reserve_question(
  p_user text,
  p_device text,
  p_limit integer,
  p_daily boolean default false,
  p_unlimited boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unlimited boolean;
  v_id uuid;
begin
  insert into public.question_quota (user_id, limit_total, unlimited)
  values (p_user, p_limit, p_unlimited)
  on conflict (user_id) do update set unlimited = excluded.unlimited
    where public.question_quota.unlimited is distinct from excluded.unlimited;

  update public.question_quota q
  set used = case when p_daily and q.window_start < current_date then 1 else q.used + 1 end,
      window_start = current_date,
      updated_at = now()
  where q.user_id = p_user
    and (q.unlimited or (p_daily and q.window_start < current_date) or q.used < q.limit_total)
  returning q.unlimited into v_unlimited;
  if not found then
    raise exception 'QUOTA_EXCEEDED' using errcode = 'P0001';
  end if;

  if p_device is not null and not v_unlimited then
    insert into public.device_quota (device_hash) values (p_device)
    on conflict (device_hash) do nothing;
    update public.device_quota d
    set used = case when p_daily and d.window_start < current_date then 1 else d.used + 1 end,
        window_start = current_date,
        updated_at = now()
    where d.device_hash = p_device
      and ((p_daily and d.window_start < current_date) or d.used < p_limit);
    if not found then
      raise exception 'QUOTA_EXCEEDED' using errcode = 'P0001';
    end if;
  end if;

  insert into public.question_log (user_id, device_hash) values (p_user, p_device)
  returning id into v_id;
  return v_id;
end;
$$;

-- Gives a reserved question back (the model failed before the learner got an answer). Only a
-- reserved question can be refunded, once.
create function public.refund_question(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user text;
  v_device text;
begin
  update public.question_log
  set status = 'refunded', finished_at = now()
  where id = p_id and status = 'reserved'
  returning user_id, device_hash into v_user, v_device;
  if not found then
    return false;
  end if;
  update public.question_quota set used = greatest(used - 1, 0), updated_at = now()
  where user_id = v_user;
  if v_device is not null then
    update public.device_quota set used = greatest(used - 1, 0), updated_at = now()
    where device_hash = v_device;
  end if;
  return true;
end;
$$;

-- Marks a reserved question answered, with what it cost.
create function public.finish_question(
  p_id uuid,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.question_log
  set status = 'done', finished_at = now(), model = left(p_model, 100),
      input_tokens = greatest(p_input_tokens, 0), output_tokens = greatest(p_output_tokens, 0)
  where id = p_id and status = 'reserved';
  return found;
end;
$$;

revoke all on function public.reserve_question(text, text, integer, boolean, boolean) from public;
revoke all on function public.refund_question(uuid) from public;
revoke all on function public.finish_question(uuid, text, integer, integer) from public;
grant execute on function public.reserve_question(text, text, integer, boolean, boolean)
  to service_role;
grant execute on function public.refund_question(uuid) to service_role;
grant execute on function public.finish_question(uuid, text, integer, integer) to service_role;
