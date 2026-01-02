create table if not exists public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brand_name text,
  primary_color text,
  secondary_color text,
  font text,
  logo_url text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.brand_kits
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid,
  add column if not exists brand_name text,
  add column if not exists primary_color text,
  add column if not exists secondary_color text,
  add column if not exists font text,
  add column if not exists logo_url text,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists created_at timestamptz default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'brand_kits_user_id_key'
  ) then
    alter table public.brand_kits
      add constraint brand_kits_user_id_key unique (user_id);
  end if;
end $$;

create index if not exists brand_kits_user_id_idx on public.brand_kits (user_id);

alter table public.brand_kits enable row level security;

create policy if not exists "brand_kits_select_own"
on public.brand_kits
for select
using (auth.uid() = user_id);

create policy if not exists "brand_kits_insert_own"
on public.brand_kits
for insert
with check (auth.uid() = user_id);

create policy if not exists "brand_kits_update_own"
on public.brand_kits
for update
using (auth.uid() = user_id);
