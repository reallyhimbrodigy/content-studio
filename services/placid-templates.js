const {
  PLACID_POST_GRAPHIC_TEMPLATE_ID,
  PLACID_STORY_TEMPLATE_ID,
  PLACID_CAROUSEL_TEMPLATE_ID,
} = process.env;

function resolvePlacidTemplateId(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'story') return PLACID_STORY_TEMPLATE_ID || PLACID_POST_GRAPHIC_TEMPLATE_ID;
  if (key === 'carousel') return PLACID_CAROUSEL_TEMPLATE_ID || PLACID_POST_GRAPHIC_TEMPLATE_ID;
  return PLACID_POST_GRAPHIC_TEMPLATE_ID;
}

function validatePlacidTemplateConfig() {
  const missing = [];
  if (!PLACID_POST_GRAPHIC_TEMPLATE_ID) missing.push('PLACID_POST_GRAPHIC_TEMPLATE_ID');
  if (!PLACID_STORY_TEMPLATE_ID) missing.push('PLACID_STORY_TEMPLATE_ID');
  if (!PLACID_CAROUSEL_TEMPLATE_ID) missing.push('PLACID_CAROUSEL_TEMPLATE_ID');

  if (missing.length) {
    console.warn('[Placid] Missing template env vars:', missing.join(', '));
  } else {
    console.log('[Placid] Template IDs loaded:', {
      post_graphic: PLACID_POST_GRAPHIC_TEMPLATE_ID,
      story: PLACID_STORY_TEMPLATE_ID,
      carousel: PLACID_CAROUSEL_TEMPLATE_ID,
    });
  }
}

module.exports = { resolvePlacidTemplateId, validatePlacidTemplateConfig };
