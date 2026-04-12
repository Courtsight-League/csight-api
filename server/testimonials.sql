-- Run this in Supabase SQL editor.
-- Creates a dedicated testimonials table used by Home page marquee + Admin Testimonials manager.

create extension if not exists pgcrypto;

create table if not exists public.testimonials (
  id uuid primary key default gen_random_uuid(),
  quote text not null,
  name text not null,
  role text not null default 'Player',
  team text not null default 'Courtsight',
  division text not null default 'Division',
  season text not null default 'Season',
  avatar_url text,
  accent_color text not null default '#e1ff2b',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.testimonials
  add column if not exists avatar_url text;

create index if not exists idx_testimonials_sort_order
  on public.testimonials (sort_order);

create index if not exists idx_testimonials_is_active
  on public.testimonials (is_active);

create or replace function public.set_testimonials_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_testimonials_updated_at on public.testimonials;
create trigger trg_testimonials_updated_at
before update on public.testimonials
for each row execute function public.set_testimonials_updated_at();

alter table public.testimonials enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'testimonials'
      and policyname = 'testimonials_public_select_active'
  ) then
    create policy testimonials_public_select_active
      on public.testimonials
      for select
      to anon, authenticated
      using (is_active = true);
  end if;
end $$;

-- Seed temporary testimonials.
insert into public.testimonials (
  id, quote, name, role, team, division, season, avatar_url, accent_color, sort_order, is_active
)
values
  (
    '4f44f89e-efdd-4c4f-9ef3-f39ea2a6b0f1',
    'CSL feels like a pro run every week. The stream quality, player tracking, and game photos made our whole team look legit.',
    'Ryan Torres',
    'Team Captain',
    'Hoop Titans',
    'D2 Saturdays',
    'Winter 2026',
    null,
    '#e1ff2b',
    0,
    true
  ),
  (
    'f8574935-2aeb-4cbf-b625-2f8d8a8cf36f',
    'What I like most is the balance. It is competitive but organized, and every game has clean stats right after. Super smooth experience.',
    'Jamal Rivera',
    'Player',
    'Night Shift',
    'D3 Flex',
    'Winter 2026',
    null,
    '#38bdf8',
    1,
    true
  ),
  (
    '9ad6f5f7-306f-4d90-b56f-84a7ba3813d8',
    'We joined as new players and the division setup was perfect. Good competition, clear schedules, and the league actually communicates fast.',
    'Aiden Collins',
    'Free Agent',
    'Dime Buckets',
    'D1 Brampton',
    'Winter 2026',
    null,
    '#fb923c',
    2,
    true
  ),
  (
    'e1d2c4e8-8f39-4bc1-b045-8de3b3d0ee42',
    'The media coverage is a game changer. Highlights, rankings, and box scores make every matchup feel bigger than just a rec game.',
    'Miguel Santos',
    'Team Manager',
    'Spray & Pray',
    'D2 Sunday',
    'Winter 2026',
    null,
    '#e879f9',
    3,
    true
  ),
  (
    'a6d0f52d-9ef9-4cca-8a2e-1f55d49d2d08',
    'CSL gave us structure. We know where we play, when we play, and all our players can follow stats from one clean portal.',
    'Luca Bennett',
    'Coach',
    'Young Bucks',
    'D3 Mississauga',
    'Winter 2026',
    null,
    '#34d399',
    4,
    true
  )
on conflict (id)
do update set
  quote = excluded.quote,
  name = excluded.name,
  role = excluded.role,
  team = excluded.team,
  division = excluded.division,
  season = excluded.season,
  avatar_url = excluded.avatar_url,
  accent_color = excluded.accent_color,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active,
  updated_at = now();

