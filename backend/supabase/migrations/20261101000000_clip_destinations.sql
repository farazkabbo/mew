-- Save where I say (K3, docs/NOTEBOOKS_K.md §4): a clip or Circle & Ask entry remembers where the
-- student said it goes in their notebook, as data their device lays it out with: a node of their
-- tree, which of its pages, and (after "Create it and save") a chapter to make first.
--
-- The tree is local-first, so the node id isn't a foreign key (the device may know the node before
-- the server does); it's only compared with the student's own tree on their device. Written with
-- the secret key after the device token is checked (like the rest of a clip), never by the
-- browser: `authenticated` keeps its update grant on notebook_page_id only.

alter table public.clips
  add column destination jsonb,
  add constraint clips_destination_shape check (
    destination is null
    or (
      jsonb_typeof(destination) = 'object'
      and octet_length(destination::text) <= 1200
      and coalesce(destination ->> 'nodeId', '')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and coalesce(destination -> 'page' ->> 'kind', '') in ('from_screen', 'new', 'number')
    )
  );
