-- Circle & Ask entries (Screen Coach S3.2, docs/SCREEN_COACH_S3_2.md §5 and decision 11): a clip
-- can be an "entry", the explanation the tutor gave about what the student marked on screen.
--
-- An entry keeps, besides the clip's picture and the tutor's strokes (annotations):
-- - session_id: its Circle & Ask session (follow-ups in it are added to the same entry);
-- - student_strokes: the student's own marks, in the picture's pixels;
-- - entry: {turns: [{question, steps, summary, followUpQuestion?}], strokeSteps: [[turn, step]]
--   (one per annotation, for Replay), conceptHints: [...]}.
-- Text only, besides the picture the student's explanation was about. As with clips, the API
-- service writes them (after checking the device token) and the owner can only read them, note
-- the notebook page, and delete them. `revision` makes a follow-up's write compare-and-set.

alter table public.clips
  add column kind text not null default 'clip' check (kind in ('clip', 'entry')),
  add column session_id uuid,
  add column student_strokes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(student_strokes) = 'array' and pg_column_size(student_strokes) <= 262144),
  add column entry jsonb
    check (entry is null or (jsonb_typeof(entry) = 'object' and pg_column_size(entry) <= 131072)),
  add column revision integer not null default 0 check (revision >= 0),
  -- An entry has its session and its explanation; an ordinary clip has neither.
  add constraint clips_entry_shape check (
    (kind = 'entry') = (session_id is not null and entry is not null)
  );

-- One entry per session (and per owner): follow-ups find it by the session.
create unique index clips_user_id_session_id_key on public.clips (user_id, session_id)
  where session_id is not null;
