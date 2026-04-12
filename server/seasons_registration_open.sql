-- Adds a per-season registration toggle.
-- Run this in Supabase SQL editor (or your Postgres migration flow).

alter table if exists public.seasons
  add column if not exists registration_open boolean not null default false;

-- If you previously used a "single open season" index, remove it to allow multiple open seasons.
drop index if exists public.seasons_single_registration_open;

-- Optional: on first install, open registration for the current season only if nothing is open yet.
update public.seasons
set registration_open = true
where is_current = true
  and not exists (
    select 1 from public.seasons s where s.registration_open = true
  );
