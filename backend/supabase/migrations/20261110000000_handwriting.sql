-- The handwriting profile (K10, docs/NOTEBOOKS_K.md §8.3): each student's own samples, so
-- recognition can show the model how this student writes ("this is my 7") and note their
-- look-alikes. A sample is one line or one character: its picture (a small PNG made from the
-- strokes, as recognition makes it), what it really says, and what neb had read. They come from
-- calibration, from fixing what neb read, and from confirming a "?" or "not wrong".
--
-- Visible and deletable: Settings → Handwriting shows how many there are and Reset deletes them
-- all (as does turning "Learn my handwriting" off). They're never used to train a model; that is
-- K11's separate opt-in.

create table public.handwriting_samples (
  id uuid primary key,
  user_id text not null default (auth.jwt() ->> 'sub')
    references public.profiles (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 300),
  latex text check (char_length(latex) <= 300),
  read_as text check (char_length(read_as) <= 300),
  source text not null check (source in ('calibration', 'fix', 'confirm', 'not_wrong')),
  -- A base64 PNG (its signature checked here too); at most ~90 KB.
  image text not null check (char_length(image) <= 120000 and image like 'iVBORw0KGgo%'),
  created_at timestamptz not null default now()
);

create index handwriting_samples_user_id_created_at_idx
  on public.handwriting_samples (user_id, created_at desc);

revoke all on public.handwriting_samples from anon, authenticated;
grant select, delete on public.handwriting_samples to authenticated;
grant insert (id, text, latex, read_as, source, image) on public.handwriting_samples
  to authenticated;

alter table public.handwriting_samples enable row level security;

create policy handwriting_samples_owner on public.handwriting_samples for all to authenticated
  using (user_id = (select auth.jwt() ->> 'sub'))
  with check (user_id = (select auth.jwt() ->> 'sub'));

-- "Learn my handwriting" (Settings → Handwriting): on unless turned off.
alter table public.profiles
  add constraint profiles_settings_learn_handwriting check (
    settings -> 'learn_handwriting' is null
    or jsonb_typeof(settings -> 'learn_handwriting') = 'boolean'
  );
