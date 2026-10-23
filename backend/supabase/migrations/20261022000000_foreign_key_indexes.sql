-- Indexes for foreign keys that had none starting with their first column. Without them,
-- deleting a parent row (a course, a source, a concept) scans the whole child table to find the
-- rows to cascade to or clear. Every other foreign key is already covered by an index or unique
-- constraint that starts with the same column (see tests/indexes.test.ts, which checks this).

-- Deleting a source removes its chunks.
create index chunks_source_id_idx on public.chunks (source_id);

-- Deleting a concept removes the edges pointing to it (edges from it use the primary key).
create index concept_edges_to_concept_idx on public.concept_edges (to_concept);

-- Deleting a chunk removes its concept links (links from a concept use the primary key).
create index concept_sources_chunk_id_idx on public.concept_sources (chunk_id);

-- Deleting a course clears it from its notebooks. Most notebooks have no course.
create index notebooks_course_id_idx on public.notebooks (course_id) where course_id is not null;
