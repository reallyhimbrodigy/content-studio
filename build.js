#!/usr/bin/env node
/**
 * Simple CSS minifier build script.
 * Reads styles.css and writes styles.min.css removing comments and extra whitespace.
 * For production use a robust tool (e.g. postcss + cssnano) — this is a minimal, zero-dependency pass.
 */
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname,'styles.css');
const out = path.join(__dirname,'styles.min.css');

if (!fs.existsSync(src)) {
  console.error('styles.css not found');
  process.exit(1);
}
let css = fs.readFileSync(src,'utf8');
// remove /* comments */
css = css.replace(/\/\*[\s\S]*?\*\//g,'');
// collapse whitespace
css = css.replace(/\s+/g,' ');
// remove space before/after certain tokens
css = css.replace(/ ?([;:{},>]) ?/g,'$1');
// preserve newlines for source mapping readability optional
fs.writeFileSync(out, css.trim());
console.log('Generated styles.min.css ('+ Buffer.byteLength(css)+' bytes)');
