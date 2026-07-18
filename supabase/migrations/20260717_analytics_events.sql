-- Analytics events sink
-- One row per client-emitted product/commerce event. Purpose: make the
-- paywall → purchase funnel measurable (it is currently uninstrumented, which
-- is why "$0 revenue with hundreds of installs" has no diagnosis). The six
-- events emitted by the iOS client are:
--   paywall_view          — the paywall sheet was shown (props.reason)
--   offerings_loaded      — RevenueCat offerings fetched (props.count)
--   offerings_load_failed — fetch threw OR returned zero packages (props.code/domain/reason)
--   purchase_attempt      — user tapped buy on a package (props.product/package)
--   purchase_error        — purchase() threw, incl. user-cancel (props.code/domain/cancelled)
--   trial_start           — a free-trial purchase completed (props.product)
--
-- Anon-first: the join key is `anon_user_id` (the RevenueCat appUserID, which
-- maps to profiles.rc_app_user_id once the user is identified), NOT an auth
-- session — so an event is recorded even before/without a Supabase token. Every
-- event also carries territory (App Store storefront country) + app version, so
-- the funnel can be geo-split (the India-storefront hypothesis) without joining
-- anything. Event-specific fields ride in `props` (jsonb).
--
-- Service role is the sole gateway: RLS is enabled with NO client policies,
-- mirroring app_feedback / creator_submissions. The /api/events endpoint writes
-- with the service key (bypasses RLS); anon/auth clients can neither read nor
-- forge rows directly.

CREATE TABLE IF NOT EXISTS analytics_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  event         TEXT        NOT NULL,
  anon_user_id  TEXT,            -- RevenueCat appUserID; joins profiles.rc_app_user_id
  user_id       UUID,            -- optional; reserved for a future authed attach
  territory     TEXT,            -- App Store storefront country (ISO alpha-3, e.g. 'USA','IND')
  storefront    TEXT,            -- storefront id when available
  app_version   TEXT,
  platform      TEXT        DEFAULT 'ios',
  props         JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS analytics_events_event_created_idx
  ON analytics_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_territory_idx
  ON analytics_events (territory);
CREATE INDEX IF NOT EXISTS analytics_events_created_at_idx
  ON analytics_events (created_at DESC);

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
-- No policies: service-role server endpoint (/api/events) is the sole gateway.
-- Enabling RLS with no policies means anon/auth clients can neither read nor
-- write directly.
