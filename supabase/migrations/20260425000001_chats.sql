-- Persistent chat history for ChatGPT-style sidebar / new-chat UX.
--
-- One row per chat thread. `messages` is a JSONB array of serialized
-- ChatMessage records (see SerializedMessage in iOS Models.swift) so we
-- don't have to fan out to a per-message table — chats are small (a few
-- KB at most), reads are always the whole-chat shape, and this avoids
-- a JOIN on every load.
--
-- Apply via Supabase dashboard SQL editor or `supabase db push`.

CREATE TABLE IF NOT EXISTS chats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'New Chat',
  messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chats_user_updated_idx
  ON chats (user_id, updated_at DESC);

ALTER TABLE chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chats_select_own"   ON chats;
DROP POLICY IF EXISTS "chats_insert_own"   ON chats;
DROP POLICY IF EXISTS "chats_update_own"   ON chats;
DROP POLICY IF EXISTS "chats_delete_own"   ON chats;

CREATE POLICY "chats_select_own" ON chats
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "chats_insert_own" ON chats
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "chats_update_own" ON chats
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "chats_delete_own" ON chats
  FOR DELETE USING (auth.uid() = user_id);

-- Touch updated_at automatically on every UPDATE so the sidebar can
-- order by recent activity without the client having to set it.
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chats_touch_updated_at ON chats;
CREATE TRIGGER chats_touch_updated_at
  BEFORE UPDATE ON chats
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
