function resolvePlacidTemplateId(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'story') return process.env.PLACID_STORY_TEMPLATE_ID || process.env.PLACID_POST_GRAPHIC_TEMPLATE_ID;
  if (key === 'carousel') return process.env.PLACID_CAROUSEL_TEMPLATE_ID || process.env.PLACID_POST_GRAPHIC_TEMPLATE_ID;
  return process.env.PLACID_POST_GRAPHIC_TEMPLATE_ID;
}

module.exports = { resolvePlacidTemplateId };
