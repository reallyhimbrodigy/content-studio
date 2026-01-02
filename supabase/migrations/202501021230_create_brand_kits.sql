create table if not exists public.brand_kits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  brand_name text,
  primary_color text,
  secondary_color text,
  font text,
  logo_url text,
  updated_at timestamptz default now()
);

alter table public.brand_kits enable row level security;

create policy "brand_kits_select_own"
on public.brand_kits
for select
using (auth.uid() = user_id);

create policy "brand_kits_insert_own"
on public.brand_kits
for insert
with check (auth.uid() = user_id);

create policy "brand_kits_update_own"
on public.brand_kits
for update
using (auth.uid() = user_id);
