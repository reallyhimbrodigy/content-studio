const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BRANDS_DIR = path.join(DATA_DIR, 'brands');

function slugify(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function loadBrandFile(userId) {
  if (!userId) return null;
  try {
    const file = path.join(BRANDS_DIR, `${slugify(userId)}.json`);
    if (!fs.existsSync(file)) return null;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json;
  } catch (err) {
    console.error('[BrandBrain] loadBrandFile error', { userId, message: err?.message });
    return null;
  }
}

function normalizeBrandBrain(brand) {
  if (!brand) return null;
  const kit = brand.kit || {};
  return {
    logo_url: kit.logoUrl || kit.logoDataUrl || '',
    heading_font: kit.headingFont || '',
    body_font: kit.bodyFont || '',
    primary_color: kit.primaryColor || '',
    secondary_color: kit.secondaryColor || '',
    accent_color: kit.accentColor || '',
  };
}

async function getBrandBrainForUser(userId) {
  const raw = loadBrandFile(userId);
  return normalizeBrandBrain(raw);
}

module.exports = {
  getBrandBrainForUser,
};
