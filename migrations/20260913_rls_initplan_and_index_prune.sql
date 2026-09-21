-- 2026-09-13 · APPLIED TO PRODUCTION (not pending). Three changes, measured.
--
-- WHY. Every RLS policy called auth.uid() unwrapped. Postgres treats that as a
-- per-row expression, so on any plan where the policy lands as a Filter rather
-- than an Index Cond it runs once per row. Wrapped as (select auth.uid()) it
-- becomes an InitPlan: evaluated once per query.
--
-- WHERE IT ACTUALLY BIT, and where it did not. Tables with a leading user_id
-- index (chats, usage_events, device_tokens) already had auth.uid() inlined
-- into an Index Cond by the planner — those were optimal before and after.
-- video_jobs has NO plain user_id index, so a user's own query seq-scans 12,002
-- rows with the policy as a Filter. Measured there, as authenticated:
--
--   select count(*) from video_jobs
--   before  36.459 ms   Filter: (auth.uid() = user_id) OR (auth.role() = 'service_role')
--   after    6.400 ms   Filter: (InitPlan 1).col1 = user_id
--   buffers  2518 -> 2518   (UNCHANGED — this is a CPU win, not an I/O one;
--                            the same rows are still scanned)
--
-- The standing follow-up this exposes: video_jobs wants an index on (user_id),
-- which would turn the seq scan into an index scan. Not done here — one change
-- at a time, and it is a different decision with a write-cost trade.

BEGIN;

-- ── 1. auth.uid() / auth.role() -> InitPlan, all 16 unwrapped policies ──────
-- ALTER POLICY rather than DROP+CREATE: the table is never momentarily
-- unprotected, and the policy's name, roles and command are preserved.
ALTER POLICY "chats_delete_own"            ON public.chats            USING ((select auth.uid()) = user_id);
ALTER POLICY "chats_insert_own"            ON public.chats            WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "chats_select_own"            ON public.chats            USING ((select auth.uid()) = user_id);
ALTER POLICY "chats_update_own"            ON public.chats            USING ((select auth.uid()) = user_id);
ALTER POLICY "device_tokens_delete_own"    ON public.device_tokens    USING ((select auth.uid()) = user_id);
ALTER POLICY "device_tokens_insert_own"    ON public.device_tokens    WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "device_tokens_select_own"    ON public.device_tokens    USING ((select auth.uid()) = user_id);
ALTER POLICY "device_tokens_update_own"    ON public.device_tokens    USING ((select auth.uid()) = user_id);
ALTER POLICY "referral_rewards_select_own" ON public.referral_rewards USING ((select auth.uid()) = user_id);
ALTER POLICY "referrals_referrer_progress" ON public.referrals        USING ((select auth.uid()) = referrer_id);
ALTER POLICY "referrals_select_own"        ON public.referrals        USING (((select auth.uid()) = referrer_id) OR ((select auth.uid()) = referred_id));
ALTER POLICY "usage_events_select_own"     ON public.usage_events     USING ((select auth.uid()) = user_id);
ALTER POLICY "Users can create own jobs"   ON public.video_jobs       WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "Users can view own jobs"     ON public.video_jobs       USING ((select auth.uid()) = user_id);
ALTER POLICY "Users can update own jobs"   ON public.video_jobs       USING ((select auth.uid()) = user_id);
ALTER POLICY "Service role has full access" ON public.video_jobs      USING ((select auth.role()) = 'service_role'::text);

-- ── 2. one duplicate + 19 never-used indexes ───────────────────────────────
-- The stats window is 306 days (pg_stat_database.stats_reset 2025-11-11), so
-- idx_scan=0 here means "never used in the life of the project", not "quiet
-- sample". Every table below holds 0-526 rows, where the planner seq-scans
-- regardless — these indexes could not be chosen even if their queries ran.
--
-- THE THREE THAT LOOKED LIKE RARE-PATH INSURANCE, and were not:
--   account_deletions_unfinished_idx  (requested_at) WHERE stage NOT IN (done,failed)
--     lib/account-deletion.js addresses every row by user_id (the PK). Nothing
--     scans for unfinished deletions by requested_at. The resume reads ONE row
--     by PK and restarts from row.stage. Index backs no query on any branch.
--   idx_free_credit_periods_unlanded  (granted_at) WHERE provider_ok = false
--     provider_ok is only ever WRITTEN (insert false / update true by PK). The
--     comment at server.js promises the unlanded row "remains queryable" — that
--     is an aspiration, not a caller. No query filters on it.
--   referral_rewards_failed_idx       (provider_ok, granted_at) WHERE NOT ok
--     same shape: written at the ledger-first insert, updated by id, never read
--     by provider_ok.
-- If any of those sweeps is written later, recreate the index WITH the sweep.
DROP INDEX IF EXISTS public.referral_rewards_user_idx;  -- exact duplicate of referral_rewards_user_time_idx
DROP INDEX IF EXISTS public.anon_signup_log_device_idx;
DROP INDEX IF EXISTS public.idx_reverse_trial_user;
DROP INDEX IF EXISTS public.idx_free_credit_periods_unlanded;
DROP INDEX IF EXISTS public.idx_trend_videos_analyzed;
DROP INDEX IF EXISTS public.idx_trend_analyses_video_id;
DROP INDEX IF EXISTS public.reference_beats_purpose_idx;
DROP INDEX IF EXISTS public.idx_edit_jobs_user_id;
DROP INDEX IF EXISTS public.account_deletions_unfinished_idx;
DROP INDEX IF EXISTS public.idx_edit_jobs_created_at;
DROP INDEX IF EXISTS public.build_distribution_snapshot_label_idx;
DROP INDEX IF EXISTS public.referrals_device_id_idx;
DROP INDEX IF EXISTS public.idx_cbc_multiple;
DROP INDEX IF EXISTS public.reference_beats_bare_idx;
DROP INDEX IF EXISTS public.idx_cbp_method;
DROP INDEX IF EXISTS public.idx_cbp_clip;
DROP INDEX IF EXISTS public.referral_rewards_failed_idx;
DROP INDEX IF EXISTS public.idx_cbs_author;
DROP INDEX IF EXISTS public.referrals_qualified_idx;
DROP INDEX IF EXISTS public.idx_cbc_author;
-- DELIBERATELY KEPT: video_jobs_user_client_message_id_key. idx_scan=0, but it
-- is a UNIQUE index enforcing render idempotency on (user_id, client_message_id).
-- A constraint is not a performance index and zero scans is not evidence against
-- one — it is doing its job every time an insert does NOT duplicate.

-- ── 3. the inert video_jobs service-role policy ────────────────────────────
-- service_role has rolbypassrls = true, so it never reaches policy evaluation
-- at all. This policy could therefore never grant the role it names anything —
-- while still being OR'd into the Filter and evaluated per row for every OTHER
-- role. It also trusted a JWT CLAIM (auth.role() reads request.jwt.claims->>role)
-- rather than the database role, which is a second, weaker authority over the
-- same table. Dropping it removes both. Verified after: service_role still reads
-- all 12,002 rows and still updates.
DROP POLICY IF EXISTS "Service role has full access" ON public.video_jobs;

COMMIT;

-- ── AUDIT. Must return zero rows. Run after any policy change. ─────────────
-- SELECT tablename, policyname FROM pg_policies WHERE schemaname='public'
--   AND ( (qual       ~ 'auth\.(uid|role)\(\)' AND qual       !~ 'SELECT auth\.')
--      OR (with_check ~ 'auth\.(uid|role)\(\)' AND with_check !~ 'SELECT auth\.') );

-- ── ROLLBACK: scratchpad db/ROLLBACK.sql, and reproduced below. ────────────
-- Restores all 16 policies to the unwrapped form, recreates the 20 indexes and
-- recreates the service-role policy exactly as it was.
-- -- ROLLBACK for the 2026-09-13 RLS/index migrations. Restores the EXACT prior state.
-- -- Captured from pg_policies + pg_indexes before any change.
-- 
-- -- ── 1. RLS policies back to the unwrapped auth.uid() ────────────────────────
-- ALTER POLICY "chats_delete_own"            ON public.chats            USING (auth.uid() = user_id);
-- ALTER POLICY "chats_insert_own"            ON public.chats            WITH CHECK (auth.uid() = user_id);
-- ALTER POLICY "chats_select_own"            ON public.chats            USING (auth.uid() = user_id);
-- ALTER POLICY "chats_update_own"            ON public.chats            USING (auth.uid() = user_id);
-- ALTER POLICY "device_tokens_delete_own"    ON public.device_tokens    USING (auth.uid() = user_id);
-- ALTER POLICY "device_tokens_insert_own"    ON public.device_tokens    WITH CHECK (auth.uid() = user_id);
-- ALTER POLICY "device_tokens_select_own"    ON public.device_tokens    USING (auth.uid() = user_id);
-- ALTER POLICY "device_tokens_update_own"    ON public.device_tokens    USING (auth.uid() = user_id);
-- ALTER POLICY "referral_rewards_select_own" ON public.referral_rewards USING (auth.uid() = user_id);
-- ALTER POLICY "referrals_referrer_progress" ON public.referrals        USING (auth.uid() = referrer_id);
-- ALTER POLICY "referrals_select_own"        ON public.referrals        USING ((auth.uid() = referrer_id) OR (auth.uid() = referred_id));
-- ALTER POLICY "usage_events_select_own"     ON public.usage_events     USING (auth.uid() = user_id);
-- ALTER POLICY "Users can create own jobs"   ON public.video_jobs       WITH CHECK (auth.uid() = user_id);
-- ALTER POLICY "Users can view own jobs"     ON public.video_jobs       USING (auth.uid() = user_id);
-- ALTER POLICY "Users can update own jobs"   ON public.video_jobs       USING (auth.uid() = user_id);
-- 
-- -- ── 3. the dropped video_jobs service-role policy, exactly as it was ────────
-- CREATE POLICY "Service role has full access" ON public.video_jobs
--   AS PERMISSIVE FOR ALL TO public USING (auth.role() = 'service_role'::text);
-- 
-- -- ── 2. the 20 dropped indexes (19 unused + 1 duplicate) ────────────────────
-- CREATE INDEX anon_signup_log_device_idx ON public.anon_signup_log USING btree (device_id);
-- CREATE INDEX idx_reverse_trial_user ON public.reverse_trial_grants USING btree (user_id);
-- CREATE INDEX idx_free_credit_periods_unlanded ON public.free_credit_periods USING btree (granted_at) WHERE (provider_ok = false);
-- CREATE INDEX idx_trend_videos_analyzed ON public.trend_videos USING btree (analyzed);
-- CREATE INDEX idx_trend_analyses_video_id ON public.trend_analyses USING btree (trend_video_id);
-- CREATE INDEX reference_beats_purpose_idx ON public.reference_beats USING btree (purpose);
-- CREATE INDEX idx_edit_jobs_user_id ON public.edit_jobs USING btree (user_id);
-- CREATE INDEX account_deletions_unfinished_idx ON public.account_deletions USING btree (requested_at) WHERE (stage <> ALL (ARRAY['done'::text, 'failed'::text]));
-- CREATE INDEX idx_edit_jobs_created_at ON public.edit_jobs USING btree (created_at DESC);
-- CREATE INDEX build_distribution_snapshot_label_idx ON public.build_distribution_snapshot USING btree (label, app_version);
-- CREATE INDEX referrals_device_id_idx ON public.referrals USING btree (device_id);
-- CREATE INDEX idx_cbc_multiple ON public.clip_brain_clips USING btree (performance_multiple DESC NULLS LAST);
-- CREATE INDEX reference_beats_bare_idx ON public.reference_beats USING btree (is_bare) WHERE is_bare;
-- CREATE INDEX idx_cbp_method ON public.clip_brain_pairs USING btree (match_method);
-- CREATE INDEX idx_cbp_clip ON public.clip_brain_pairs USING btree (clip_id);
-- CREATE INDEX referral_rewards_failed_idx ON public.referral_rewards USING btree (provider_ok, granted_at DESC) WHERE (provider_ok = false);
-- CREATE INDEX idx_cbs_author ON public.clip_brain_sources USING btree (author_handle);
-- CREATE INDEX referrals_qualified_idx ON public.referrals USING btree (referrer_id, qualified_at) WHERE ((qualified_at IS NOT NULL) AND (counted_at IS NULL));
-- CREATE INDEX idx_cbc_author ON public.clip_brain_clips USING btree (author_handle);
-- CREATE INDEX referral_rewards_user_idx ON public.referral_rewards USING btree (user_id, granted_at DESC);
