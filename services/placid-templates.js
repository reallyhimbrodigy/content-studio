const {
  PLACID_POST_GRAPHIC_TEMPLATE_ID,
  PLACID_STORY_TEMPLATE_ID,
  PLACID_CAROUSEL_TEMPLATE_ID,
} = process.env;

function resolvePlacidTemplateId(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'story') return PLACID_STORY_TEMPLATE_ID || null;
  if (key === 'carousel') return PLACID_CAROUSEL_TEMPLATE_ID || null;
  return null;
}

module.exports = { resolvePlacidTemplateId };
