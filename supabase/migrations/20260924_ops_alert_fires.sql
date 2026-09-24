-- Durable record of every page the origin guard fires.
--
-- WHY A TABLE AND NOT JUST THE LOG. device_tokens is 0 for the owner today, so
-- every fire right now is UNDELIVERED / no_recipients — a machine-readable
-- miss, not a success into the void. Those fires are the ones most worth
-- keeping: they are the evidence that the guard was working before anyone
-- could receive from it.
--
-- The server does not depend on this. Fires are written to a [ops-fire] log
-- line and an in-memory ring on /healthz?ops_fires=1 regardless; this makes
-- them survive a restart. An absent table produces ONE loud line, never
-- silence and never a failed page.

create table if not exists public.ops_alert_fires (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  why         text        not null,          -- 'latency' | 'errors'
  p95_ms      integer,                       -- null when the arm is not latency
  samples     integer,
  delivery    text        not null,          -- DELIVERED | UNDELIVERED | UNKNOWN | NOT_ATTEMPTED
  reason      text,                          -- no_recipients, no_tokens, http_401, ...
  delivered   integer     not null default 0,
  recipients  integer     not null default 0,
  title       text
);

create index if not exists idx_ops_alert_fires_at on public.ops_alert_fires (at desc);

alter table public.ops_alert_fires enable row level security;
-- Server only. No policy is created, so with RLS on, anon and authenticated
-- see nothing; the service role bypasses RLS.
revoke all on public.ops_alert_fires from public, anon, authenticated;
grant select, insert on public.ops_alert_fires to service_role;
grant usage, select on sequence public.ops_alert_fires_id_seq to service_role;

comment on column public.ops_alert_fires.delivery is
  'UNKNOWN is never folded into its neighbours: read as delivered it hides an outage, read as failed it retries an alert that already landed.';
