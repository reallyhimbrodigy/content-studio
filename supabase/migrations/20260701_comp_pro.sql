-- comp_pro: a bulletproof, RevenueCat-immune complimentary-Pro flag.
--
-- isUserPro() (lib/entitlement.js) checks comp_pro FIRST and returns Pro on its
-- own, regardless of tier / pro_until / RevenueCat fields. So a comped user
-- can never be knocked off Pro by any RC webhook (INITIAL_PURCHASE,
-- CANCELLATION, EXPIRATION, BILLING_ISSUE, …). The write-guard trigger ensures
-- only the service role (the server) — never a client — can set it.
--
-- Applied to production via the Supabase SQL editor on 2026-07-01. Idempotent.

-- 1) The column.
alter table public.profiles
  add column if not exists comp_pro boolean not null default false;

-- 2) Write-guard: authenticated/anon clients may update their own profile, but
--    any attempt to CHANGE comp_pro is rejected. Only the service role (or a
--    direct DB/SQL-editor session, which has no request.jwt.claims) may set it.
--    A trigger (not a blanket column revoke) so normal profile updates that
--    don't touch comp_pro keep working.
create or replace function public.guard_comp_pro()
returns trigger language plpgsql security definer set search_path = public as $$
declare claim_role text := current_setting('request.jwt.claims', true)::jsonb ->> 'role';
begin
  if tg_op = 'UPDATE' and new.comp_pro is distinct from old.comp_pro then
    if claim_role in ('authenticated', 'anon') then
      raise exception 'comp_pro may only be changed by the service role';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_comp_pro on public.profiles;
create trigger trg_guard_comp_pro
  before update on public.profiles
  for each row execute function public.guard_comp_pro();

-- 3) Comp grants are one-off data changes (service role), e.g.:
--    update public.profiles set comp_pro = true where id = '<user-uuid>';
