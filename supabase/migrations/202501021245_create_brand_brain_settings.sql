create table if not exists public.brand_brain_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.brand_brain_settings
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid,
  add column if not exists enabled boolean default false,
  add column if not exists settings jsonb default '{}'::jsonb,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists created_at timestamptz default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'brand_brain_settings_user_id_key'
  ) then
    alter table public.brand_brain_settings
      add constraint brand_brain_settings_user_id_key unique (user_id);
  end if;
end $$;

create index if not exists brand_brain_settings_user_id_idx on public.brand_brain_settings (user_id);

alter table public.brand_brain_settings enable row level security;

create policy if not exists "brand_brain_settings_select_own"
on public.brand_brain_settings
for select
using (auth.uid() = user_id);

create policy if not exists "brand_brain_settings_insert_own"
on public.brand_brain_settings
for insert
with check (auth.uid() = user_id);

create policy if not exists "brand_brain_settings_update_own"
on public.brand_brain_settings
for update
using (auth.uid() = user_id);
