-- Adds moderation flag for box score comments.
-- Used by Full Admin hide/unhide controls.

alter table public.box_score_comments
  add column if not exists is_hidden boolean not null default false;

create index if not exists idx_box_score_comments_is_hidden
  on public.box_score_comments (is_hidden);
