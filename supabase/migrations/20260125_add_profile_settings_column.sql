-- Add profile_settings column + updated_at trigger (idempotent)

alter table public.profiles
  add column if not exists profile_settings jsonb not null default '{}'::jsonb;

alter table public.profiles
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();
