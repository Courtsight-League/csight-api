-- Claim workflow foundation (tokens, events, and player/team status fields)
create extension if not exists pgcrypto;

alter table if exists teams
  add column if not exists payment_status text default 'Unpaid';

alter table if exists players
  add column if not exists claim_status text,
  add column if not exists claimed_at timestamptz;

-- Backfill claim_status for existing rows.
update players
set claim_status = case
  when user_id is null then 'Unclaimed'
  else 'Claimed'
end
where claim_status is null;

create table if not exists player_claim_tokens (
  id uuid primary key default gen_random_uuid(),
  player_id text null,
  email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz null,
  revoked_at timestamptz null,
  claimed_player_id text null,
  claimed_user_id text null,
  created_by text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_player_claim_tokens_email on player_claim_tokens (email);
create index if not exists idx_player_claim_tokens_expires_at on player_claim_tokens (expires_at);
create index if not exists idx_player_claim_tokens_active
  on player_claim_tokens (email, created_at desc)
  where used_at is null and revoked_at is null;

create table if not exists player_claim_events (
  id bigserial primary key,
  token_id uuid null,
  email text null,
  player_id text null,
  ip_address text null,
  action text not null,
  outcome text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_player_claim_events_ip_created
  on player_claim_events (ip_address, created_at desc);
create index if not exists idx_player_claim_events_email_created
  on player_claim_events (email, created_at desc);
