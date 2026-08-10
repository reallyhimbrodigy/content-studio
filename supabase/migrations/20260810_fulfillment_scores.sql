-- LANE 1 / JUDGE — per-job fulfillment judgments (new table, additive only).
-- Written by scripts/fulfillment-judge.js. Never touches existing tables.
create table if not exists public.fulfillment_scores (
  job_id uuid primary key,
  judged_at timestamptz not null default now(),
  judge_model text not null,
  judge_version int not null default 1,
  is_preset boolean not null,
  route text,                       -- standard_editorial | minimal | minimal_speech_uncut | moodreel | hype
  n_asks int not null,
  n_honored int not null,
  n_dropped_with_note int not null,
  n_dropped_silently int not null,
  n_unsupported int not null,
  honor_rate numeric,               -- honored / n_asks
  asks jsonb not null,              -- [{text, class, verdict, noted, evidence}]
  flags jsonb,
  vibe_input text,
  created_at timestamptz,          -- the JOB's created_at (scoreboard filters by day on this)
  change_request text
);
create index if not exists fulfillment_scores_judged_at_idx on public.fulfillment_scores (judged_at);
create index if not exists fulfillment_scores_route_idx on public.fulfillment_scores (route);
