-- K1 §2.2 (decision 53): a chapter card shows its course progress. A concept belongs to the
-- notebook chapters its passages were imported into (K4: chunks.notebook_node_id, linked to the
-- concept by concept_sources). SECURITY INVOKER, so RLS still applies: a caller only ever sees
-- their own concepts and passages, whatever course id they pass.

create function public.concept_nodes(course uuid)
returns table (concept_id uuid, notebook_node_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct s.concept_id, c.notebook_node_id
  from public.concept_sources s
  join public.chunks c on c.id = s.chunk_id and c.user_id = s.user_id
  where c.course_id = course and c.notebook_node_id is not null;
$$;

revoke all on function public.concept_nodes(uuid) from public, anon;
grant execute on function public.concept_nodes(uuid) to authenticated;
