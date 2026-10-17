-- Strokes record which tool drew them (pens taper with pressure; highlighters are flat and
-- translucent). The tool is fixed at creation, so it gets no update grant.
alter table public.strokes
  add column tool text not null default 'pen' check (tool in ('pen', 'highlighter'));
