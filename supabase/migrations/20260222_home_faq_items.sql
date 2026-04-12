-- Editable Home FAQ items.
-- Run via Supabase migrations/SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.faq_items (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  category text not null default 'General',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_faq_items_sort_order
  on public.faq_items (sort_order);

create index if not exists idx_faq_items_is_active
  on public.faq_items (is_active);

create or replace function public.set_faq_items_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_faq_items_updated_at on public.faq_items;
create trigger trg_faq_items_updated_at
before update on public.faq_items
for each row execute function public.set_faq_items_updated_at();

alter table public.faq_items enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'faq_items'
      and policyname = 'faq_items_public_select_active'
  ) then
    create policy faq_items_public_select_active
      on public.faq_items
      for select
      to anon, authenticated
      using (is_active = true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'faq_items'
      and policyname = 'faq_items_full_admin_insert'
  ) then
    create policy faq_items_full_admin_insert
      on public.faq_items
      for insert
      to authenticated
      with check (
        exists (
          select 1
          from public.admin_users au
          where au.id = auth.uid()
            and au.role = 'ADMIN_FULL'
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'faq_items'
      and policyname = 'faq_items_full_admin_update'
  ) then
    create policy faq_items_full_admin_update
      on public.faq_items
      for update
      to authenticated
      using (
        exists (
          select 1
          from public.admin_users au
          where au.id = auth.uid()
            and au.role = 'ADMIN_FULL'
        )
      )
      with check (
        exists (
          select 1
          from public.admin_users au
          where au.id = auth.uid()
            and au.role = 'ADMIN_FULL'
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'faq_items'
      and policyname = 'faq_items_full_admin_delete'
  ) then
    create policy faq_items_full_admin_delete
      on public.faq_items
      for delete
      to authenticated
      using (
        exists (
          select 1
          from public.admin_users au
          where au.id = auth.uid()
            and au.role = 'ADMIN_FULL'
        )
      );
  end if;
end $$;

insert into public.faq_items (
  id,
  question,
  answer,
  category,
  sort_order,
  is_active
)
values
  (
    '76618895-8d29-48fd-a70c-ed0d4378df0e',
    'How do I register a team?',
    'You can register a team by creating a captain account and paying the deposit fee on the Registration page.',
    'Registration',
    0,
    true
  ),
  (
    '6d6f6d4d-2fd2-40e2-9d89-cf8fcb551675',
    'How long are the games?',
    'Games consist of two 20-minute halves with a running clock, stopping in the last 2 minutes of the second half.',
    'Game Rules',
    1,
    true
  ),
  (
    'fcf5d6f8-b6d9-4d01-8c47-4b06417e84ac',
    'Where are games played?',
    'All games are played at the Central City Gymnasium on Courts 1 & 2.',
    'General',
    2,
    true
  ),
  (
    'f6a1aad6-eb4e-4eb7-beca-13856dcf2dcc',
    'Can I join as a free agent?',
    'Yes! Select "Join Myself" during registration and we will place you on a team looking for players.',
    'Registration',
    3,
    true
  )
on conflict (id)
do update set
  question = excluded.question,
  answer = excluded.answer,
  category = excluded.category,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active,
  updated_at = now();
