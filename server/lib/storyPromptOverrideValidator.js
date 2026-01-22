const STORY_PROMPT_KEYWORD_OVERRIDE_VALIDATE_FAILED = 'STORY_PROMPT_KEYWORD_OVERRIDE_VALIDATE_FAILED';

function normalizeOverrideInput(raw) {
  if (raw === null || raw === undefined) return null;
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : [String(raw)];
  return entries
    .map((token) => String(token || '').trim())
    .filter(Boolean)
    .map((token) => token.toUpperCase());
}

function isOverrideTokenSafe(token) {
  return /^[A-Z]{3,12}$/.test(token);
}

function logInvalidOverride(raw, context = {}) {
  const info = {
    requestId: context.requestId || 'unknown',
    userId: context.userId || null,
    override: raw,
  };
  console.warn('[Calendar] Story prompt keyword override ignored', info);
}

function validateStoryPromptKeywordOverride(raw, context = {}) {
  const tokens = normalizeOverrideInput(raw);
  if (!tokens || !tokens.length) return null;
  const safeTokens = tokens.filter(isOverrideTokenSafe);
  if (safeTokens.length !== tokens.length) {
    logInvalidOverride(raw, context);
    return null;
  }
  return safeTokens;
}

// Guard: invalid overrides should always collapse to null so the generator never throws.
const _storyPromptOverrideGuard = validateStoryPromptKeywordOverride('123', { requestId: 'guard', userId: 'guard' });
void _storyPromptOverrideGuard;

module.exports = {
  STORY_PROMPT_KEYWORD_OVERRIDE_VALIDATE_FAILED,
  validateStoryPromptKeywordOverride,
};
