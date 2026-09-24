-- SERVER-SIDE ROLLOUT FLAGS. One table, one row per flag.
--
-- WHY A TABLE AND NOT AN ENV VAR. An env change on Render is not live until a
-- REDEPLOY — already written down in this repo as "a secret flip is not live
-- until a redeploy". So "changeable without a deploy" cannot be env, and a
-- rollout you cannot stop without a deploy is a rollout you cannot stop during
-- the ten minutes when stopping it matters.
--
-- lib/upload-flags.js reads this table FIRST and falls back to env, so the
-- feature works before this is applied and becomes no-deploy the moment it is,
-- with no code change either way. Until then every resolution reports
-- from='env', which is the field that says which source answered.
--
-- RLS ON, ZERO POLICIES: service role only, same as the generation tables.
-- These rows decide who gets which code path; nothing client-side reads them.

CREATE TABLE IF NOT EXISTS server_flags (
  flag        text PRIMARY KEY,
  -- Named accounts always win, whatever the percentage says. This is the
  -- canary list: three internal accounts before anyone else sees it.
  allowlist   uuid[] NOT NULL DEFAULT '{}',
  -- 0..100. Resolved as a STABLE HASH of (flag, user_id), never a coin flip:
  -- a user must get the same answer on every request, or a canary produces
  -- someone whose first upload accelerates and whose retry does not, and the
  -- comparison is then between two populations that both contain everybody.
  percent     integer NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  -- The global on switch, checked before both of the above.
  enabled_all boolean NOT NULL DEFAULT false,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE server_flags ENABLE ROW LEVEL SECURITY;

-- The two flags in flight, seeded to match what the env fallback already does,
-- so applying this changes NOTHING on the day it lands. A migration that also
-- changes behaviour makes a rollback ambiguous: you cannot tell whether you
-- are undoing the table or the rollout.
INSERT INTO server_flags (flag, allowlist, percent, enabled_all, note) VALUES
  ('s3_accelerate',
   ARRAY['ec702499-ca10-49e6-8850-df8f99840904',
         '08956fe8-ab49-4351-a938-474feff0002d',
         '2efb75dd-cf8b-496a-a3a3-75c5f7f349f3']::uuid[],
   0, false,
   'Canary for S3 Transfer Acceleration. Bucket is Enabled; S3_USE_ACCELERATE '
   'was "false" in the Render env with no recorded reason. Raise percent after '
   'the canary uploads land, then enabled_all.'),
  ('upload_shrink',
   ARRAY['ec702499-ca10-49e6-8850-df8f99840904',
         '08956fe8-ab49-4351-a938-474feff0002d',
         '2efb75dd-cf8b-496a-a3a3-75c5f7f349f3']::uuid[],
   0, false,
   'Frontend knob. Values are "on" or ABSENT — never "off": the client treats '
   'absence as off and a third value would be a third code path.')
ON CONFLICT (flag) DO NOTHING;
