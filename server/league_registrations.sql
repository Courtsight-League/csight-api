-- Run this in Supabase SQL editor to persist the short League Registration step.

create extension if not exists pgcrypto;

create table if not exists public.league_registrations (
  id uuid primary key default gen_random_uuid(),
  registration_type text not null check (registration_type in ('team', 'free-agent')),
  season_id uuid not null,
  division_id uuid not null,
  season_label text not null,
  division_label text not null,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text not null,
  team_name text,
  payment_choice text,
  status text not null default 'submitted',
  source text not null default 'website',
  linked_user_id uuid,
  linked_team_id uuid,
  linked_player_id uuid,
  metadata jsonb,
  submitted_at timestamptz default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_league_registrations_email
  on public.league_registrations (email);

create index if not exists idx_league_registrations_status
  on public.league_registrations (status);

alter table public.league_registrations enable row level security;

-- Public can submit short form.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'league_registrations'
      and policyname = 'league_registrations_public_insert'
  ) then
    create policy league_registrations_public_insert
      on public.league_registrations
      for insert
      to anon, authenticated
      with check (true);
  end if;
end $$;

-- Public updates are only by id (used for payment choice + completion handoff).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'league_registrations'
      and policyname = 'league_registrations_public_update'
  ) then
    create policy league_registrations_public_update
      on public.league_registrations
      for update
      to anon, authenticated
      using (true)
      with check (true);
  end if;
end $$;

