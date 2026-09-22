#!/usr/bin/env node
/**
 * THE DOCUMENTED LIST AND THE MEASUREMENT MUST NOT DRIFT APART.
 *
 * The hand-written list named six languages nobody had typed and omitted seven
 * people had. That is not a typo class — it is what happens whenever a list of
 * what-exists is MAINTAINED BESIDE the thing rather than derived from it, which
 * is the same defect that made the component library read 79 when it was 77.
 * So the prompt's list is generated from a measured artefact, and this check is
 * what makes the pair break loudly instead of quietly.
 *
 * It also proves the READ-SIDE normalizer collapses the 5800071 vocabulary seam,
 * because the whole point of the list being right is a by-language cut that does
 * not split one language in two.
 */
'use strict';
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { languageTag, tagsFromRows } = require('../../lib/language-tag.js');

let fail = 0, n = 0;
const leg = (name, ok, detail) => { n++; if (!ok) fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ::  ' + detail : ''}`); };

const obs = JSON.parse(readFileSync(join(__dirname, 'fixtures/typed_in_observed.json'), 'utf8'));
const SRC = readFileSync(join(__dirname, '../../lib/request-taxonomy.js'), 'utf8');

// ── 1. the artefact is a measurement, not an empty container ────────────────
const expected = Object.keys(obs.tags).concat(obs.extra);
leg('the observed-tag artefact is non-empty and carries its denominator',
    expected.length > 0 && obs._rows > 0, `${expected.length} tag(s) from ${obs._rows} row(s)`);

// ── 2. the prompt's list IS the derived list, in order ──────────────────────
const m = SRC.match(/DERIVED rather than guessed: ([^.\n]+)\./);
leg('the prompt states a derived list at all', !!m);
const listed = m ? m[1].split(',').map(s => s.trim()) : [];
leg('the prompt list equals the measurement, same members and same order',
    JSON.stringify(listed) === JSON.stringify(expected),
    `prompt=[${listed.join(' ')}] artefact=[${expected.join(' ')}]`);

// ── 3. the list is declared OPEN, because typed_in is a string not an enum ──
leg('the prompt says the list is not closed',
    /NOT CLOSED/.test(SRC) && /WRITE ITS OWN TAG/.test(SRC));
leg('and typed_in is still a free string in the schema, not an enum',
    /typed_in:\s*\{\s*type:\s*'string'\s*\}/.test(SRC));

// ── 4. the read-side normalizer collapses the deploy seam ───────────────────
leg('English and en are ONE bucket', languageTag('English').tag === languageTag('en').tag,
    `${languageTag('English').tag} == ${languageTag('en').tag}`);
leg('both spellings of Latin-script Hindi are one bucket',
    languageTag('Hindi (Latin script transliteration)').tag === languageTag('hi-latn').tag,
    languageTag('hi-latn').tag);

// ── 5. THREE STATES. An unknown value is counted, never guessed into a tag. ─
leg('an unrecognised language is UNKNOWN, not folded into a neighbour',
    languageTag('Klingon').state === 'UNKNOWN' && languageTag('Klingon').tag === null);
leg('an empty language is ABSENT, not a tag', languageTag('').state === 'ABSENT');
leg('a null language is ABSENT, not a tag', languageTag(null).state === 'ABSENT');

// ── 6. the derivation reproduces the artefact from the rows it claims ───────
const rebuilt = tagsFromRows(
  [].concat(Array(79).fill('English'), Array(6).fill('en'), Array(5).fill('Spanish'),
    ['Arabic','Arabic','French','French','Hindi','Hindi','Persian','Persian','Bengali','Hebrew',
     'Hindi (Hindustani in Latin script)','Hindi (Latin script transliteration)',
     'Polish','Portuguese','Russian','Turkish','Urdu']));
leg('the derivation reproduces the recorded counts exactly',
    JSON.stringify(Object.fromEntries(rebuilt.tags)) === JSON.stringify(obs.tags),
    `${rebuilt.total} rows, ${rebuilt.unknown.length} unknown`);
leg('  ...with the recorded denominator and no silent absences',
    rebuilt.total === obs._rows && rebuilt.absent === obs._absent && rebuilt.unknown.length === obs._unknown);

console.log(fail ? `\n${fail} of ${n} FAILED` : `\nall ${n} legs green`);
process.exit(fail ? 1 : 0);
