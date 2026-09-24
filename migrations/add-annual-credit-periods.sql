-- MONTHLY CREDIT ROLL FOR ANNUAL SUBSCRIBERS.
--
-- ── THE PROBLEM, MEASURED FROM THE DEBIT LEDGER ────────────────────────────
-- RevenueCat's recurring virtual-currency grant fires ON RENEWAL. An annual
-- product renews once a year, so an annual subscriber receives ONE allowance
-- for twelve months. Proven without needing RC's API, which exposes no ledger:
--
--   ea7609f2  subscribed 2026-08-19, pro_until 2027-08-19
--             103 jobs, 80 credits debited, balance 120
--             80 + 120 = 200 = one Pro allowance, and NO grant appeared at the
--             2026-09-19 month boundary.
--
-- That is 20 renders for a year. The paywall pre-selects annual, so every
-- future annual buyer lands in the same place.
--
-- ── WHICH DESIGN THIS IS ───────────────────────────────────────────────────
-- This is the INTERIM design: RC keeps granting on its own cadence and this
-- roll fills the months RC does not cover. It is deliberately additive so it
-- can ship without a dashboard change.
--
-- THE CLEANER DESIGN IS A SINGLE WRITER: annual product grants set to 0 in
-- RevenueCat, and this roll owning EVERY annual grant from INITIAL_PURCHASE
-- onward. That removes the skip logic below entirely, because there is then
-- nothing to avoid double-granting against. It needs a dashboard change, so it
-- waits for the session where the 500/2000 grants are set. When that happens,
-- the skip rule is deleted and `decided_by` stops having anything to record.
--
-- ── SKIPPING THE MONTH RC ITSELF GRANTED: OBSERVED FIRST, DERIVED SECOND ────
-- Our webhook already records every RevenueCat event it receives, so the month
-- RC granted can be OBSERVED rather than computed:
--
--   analytics_events.event = 'rc_webhook_received'
--     props->>'rc_type'      IN ('INITIAL_PURCHASE','RENEWAL','PRODUCT_CHANGE')
--     props->>'app_user_id'  = the Supabase user id
--
-- TWO LIMITS OF THAT RECORD, BOTH REAL, BOTH WHY THE FALLBACK EXISTS:
--
--   1. IT DOES NOT CARRY product_id. rcReasons() records cancel_reason,
--      expiration_reason, period_type, store, grace_until and the identity
--      chain — no product. So the record says "RC granted this user something
--      in this month", not "RC granted the ANNUAL product". That is sound only
--      because the roll runs exclusively for users whose CURRENT product is
--      annual, and it is why events BEFORE the annual term started are
--      excluded: a user who upgraded from monthly would otherwise have their
--      old monthly RENEWALs mark annual months as already-granted, and the
--      error would be an UNDER-grant — money owed to a payer, the direction
--      that must not be guessed wrong.
--
--   2. ~32% OF PURCHASE WEBHOOKS ARRIVE ANONYMOUS. The first-launch paywall
--      sells before sign-in, so app_user_id can be a `$RCAnonymousID:…` that
--      does not join to profiles.id. An event can therefore be MISSING from
--      the record for a user who really did get one.
--
-- So: observe where the record exists, derive from the renewal date where it
-- does not, and WRITE DOWN WHICH RULE DECIDED. `decided_by` is not decoration
-- — 'derived' rows are the ones to audit if a double-grant ever appears, and
-- without the column the two cases are indistinguishable afterwards.

CREATE TABLE IF NOT EXISTS annual_credit_periods (
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- THE PERIOD IS ANCHORED TO THE SUBSCRIPTION DAY, NOT THE CALENDAR MONTH.
  -- A user who bought on the 19th gets their months on the 19th. Calendar
  -- anchoring would hand a buyer on the 31st a second allowance within hours.
  period_start  date NOT NULL,
  amount        integer NOT NULL DEFAULT 0 CHECK (amount >= 0),
  balance_before integer,
  -- provider_ok=false means THE ROW EXISTS BEFORE THE MONEY DOES: a credit
  -- that failed after the claim is a VISIBLE ROW rather than nothing. Same
  -- shape as free_credit_periods, and for the same reason.
  provider_ok   boolean NOT NULL DEFAULT false,
  -- 'granted'          we granted this period
  -- 'skip_rc_observed' a recorded INITIAL_PURCHASE/RENEWAL/PRODUCT_CHANGE
  --                    falls inside it — RC granted, we must not
  -- 'skip_rc_derived'  no event on record; the renewal-date arithmetic says
  --                    RC granted. AUDIT THESE FIRST if anything double-grants.
  -- 'skip_lapsed'      the entitlement was not active for this period
  decided_by    text NOT NULL
                CHECK (decided_by IN ('granted','skip_rc_observed',
                                      'skip_rc_derived','skip_lapsed')),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  -- THE ONE-SHOT GATE. A double run finds the row and does nothing; two
  -- concurrent runs race on the primary key and exactly one inserts. The
  -- idempotency is the CONSTRAINT, never a check-then-insert — the same TOCTOU
  -- shape as a balance check, and here it would double-grant real money.
  PRIMARY KEY (user_id, period_start)
);

-- The sweep reads "which periods has this user already been decided for",
-- which is the primary key prefix — so no second index is needed for the hot
-- path. This one serves the audit question instead: show me every derived
-- skip, newest first.
CREATE INDEX IF NOT EXISTS annual_credit_periods_audit_idx
  ON annual_credit_periods (decided_by, granted_at DESC);

ALTER TABLE annual_credit_periods ENABLE ROW LEVEL SECURITY;
