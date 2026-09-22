'use strict';

// RE-EDIT VERSIONS — the ordinal a user sees on a re-edited video, and the
// one-at-a-time guard that keeps two of them from claiming the same number.
//
// WHY THE ORDINAL IS NOT DEPTH IN THE CHAIN. Measured against prod 2026-09-21:
// 114 re-edit rows, 97 distinct parents, 29 whose parent is ITSELF a re-edit,
// and a maximum of 4 children hanging off a single parent. parent_job_id
// describes a TREE, not a line. "version = how many links back to the root"
// therefore hands two siblings the same number, and there are already parents
// with four of them. The ordinal has to be anchored at the ROOT.
//
// WHY THE ORDINAL IS NOT PERSISTED. The obvious move is an integer column
// written at insert. It cannot be both stable and gapless:
//   - number every row, and a failed re-edit burns a number: the list reads
//     v1, v2, v4 and the user asks what happened to v3;
//   - number only the ones that succeed, and a failure RENUMBERS everything
//     after it — a version the user opened as v3 yesterday is v2 today.
// Computing it on read over COMPLETED rows only gives both at once, and it is
// safe precisely because terminal states are terminal here (first-terminal-wins
// on the way in, dispatch-to-modal.js): a completed job never un-completes, so
// a number, once shown, never moves.
//
// A FAILED RE-EDIT IS NOT A VERSION. It produced nothing the user can open.
// It belongs in the chat as a failed attempt, never in the version switcher —
// which is also why `version_count` counts completed rows and nothing else.

// NAMED FOR THE PROPERTY, NOT THE SCHEDULE. The first version of this called
// itself IN_FLIGHT_STATUSES and meant "non-terminal". That was correct until it
// wasn't: `needs_input` is non-terminal with NOTHING RUNNING, and the moment the
// client learned to answer a parked question (1e7aa37) the two stopped being the
// same fact. A guard whose membership is right when written and is invalidated by
// a change somewhere else is exactly what a schedule-shaped name hides — nothing
// in "in flight" announced which property a caller was relying on.
//
// So the two reasons a row holds its root are now separate and each says why.

// A worker is running, or is about to be. Matches the set the rest of the
// codebase already uses for this (job-reaper.js, orphan-redispatch.js).
const RENDERING_STATUSES = Object.freeze(['queued', 'processing']);

// Waiting on the USER, with no worker running and no slot held. Two different
// mechanisms land here and only one of them is live (see lib/clarification.js):
// the dormant Phase D ask-back, and the plan-diff clarification that has parked
// 19 rows across 8 users for up to 63 days.
const PARKED_STATUSES = Object.freeze(['needs_input']);

// What forbids a SECOND re-edit on the same root — Zac's "one re-edit at a time
// per video". A parked question is included deliberately: if it were not, a user
// sitting on an unanswered question could start a second render of the same
// video, which is the case the rule exists to prevent.
//
// The escape is not expiry. Answering the question CANCELS the parked row in the
// same operation that creates the retry (cancelAndCreate below), so a user who
// answers never meets this lock at all; the 24h expiry only catches the user who
// walked away. That ordering is load-bearing — see the note on provisionalVersion.
const ROOT_LOCK_STATUSES = Object.freeze([...RENDERING_STATUSES, ...PARKED_STATUSES]);

function isRendering(status) {
  return RENDERING_STATUSES.includes(String(status || ''));
}

function isParked(status) {
  return PARKED_STATUSES.includes(String(status || ''));
}

function holdsRootLock(status) {
  return ROOT_LOCK_STATUSES.includes(String(status || ''));
}

// Retained as an alias so an existing caller cannot silently change meaning on
// this rename. New code should say which property it means.
const IN_FLIGHT_STATUSES = ROOT_LOCK_STATUSES;
const isInFlight = holdsRootLock;

// Deterministic order. created_at ascending, id as the tie-break — without the
// tie-break, two rows written in the same millisecond (which the branched rows
// in prod already demonstrate is reachable) could order differently between two
// reads and silently renumber the list.
function byCreatedThenId(a, b) {
  const ta = Date.parse(a && a.created_at) || 0;
  const tb = Date.parse(b && b.created_at) || 0;
  if (ta !== tb) return ta - tb;
  return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
}

/**
 * The rows that ARE versions: completed, in display order.
 * @param {Array<object>} rows every row sharing one root_job_id
 */
function completedVersions(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.status === 'completed')
    .sort(byCreatedThenId);
}

/**
 * job_id -> 1-based dense version number. Completed rows only; a row that is
 * not a version is absent from the map rather than mapped to null, so a caller
 * that forgets to check gets `undefined` and not a plausible-looking 0.
 */
function versionMap(rows) {
  const map = new Map();
  completedVersions(rows).forEach((r, i) => map.set(String(r.id), i + 1));
  return map;
}

function versionOf(rows, jobId) {
  const v = versionMap(rows).get(String(jobId));
  return v === undefined ? null : v;
}

function versionCount(rows) {
  return completedVersions(rows).length;
}

/**
 * The in-flight row for this root, or null. There is at most one once the
 * partial unique index is live; before then this is still the read the 409
 * answers from, and it takes the OLDEST so the answer is stable across polls
 * rather than flapping between two rows.
 */
function findInFlight(rows) {
  const live = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && holdsRootLock(r.status))
    .sort(byCreatedThenId);
  return live.length ? live[0] : null;
}

/**
 * The parked rows on this root that a reply should clear, oldest first.
 *
 * Only PARKED rows — a rendering job is never cancelled by someone answering a
 * question, because something is actually running and cancelling it would throw
 * away work the user is waiting for.
 */
function findParked(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && isParked(r.status))
    .sort(byCreatedThenId);
}

/**
 * The version a job that is still rendering WILL occupy if it completes.
 *
 * Exact rather than a guess, and only because of the 409: one re-edit at a time
 * per root means nothing else can complete and take the number first. If the
 * one-at-a-time rule is ever relaxed, this becomes a race and the caller must
 * stop flagging it `version_provisional` and start returning null.
 */
function provisionalVersion(rows) {
  return versionCount(rows) + 1;
}

/**
 * The versions[] payload, minus the signed urls the caller mints on read.
 * Completed rows only — see the header note on why a failure is not a version.
 */
function buildVersionList(rows) {
  return completedVersions(rows).map((r, i) => ({
    job_id: r.id,
    version: i + 1,
    status: r.status,
    created_at: r.created_at,
    change_request: r.change_request || null,
  }));
}

/**
 * Root for a row. An original IS its own root; a re-edit inherits its parent's.
 *
 * Returns null when the row is a re-edit whose root_job_id has not been
 * backfilled — the caller must walk parent_job_id rather than invent a root.
 * Guessing `id` there would make a v3 its own root and strand v1 and v2.
 */
function resolveRootId(row) {
  if (!row) return null;
  if (row.root_job_id) return String(row.root_job_id);
  if (!row.parent_job_id) return String(row.id);
  return null;
}

module.exports = {
  RENDERING_STATUSES,
  PARKED_STATUSES,
  ROOT_LOCK_STATUSES,
  isRendering,
  isParked,
  holdsRootLock,
  findParked,
  IN_FLIGHT_STATUSES,
  isInFlight,
  byCreatedThenId,
  completedVersions,
  versionMap,
  versionOf,
  versionCount,
  findInFlight,
  provisionalVersion,
  buildVersionList,
  resolveRootId,
};
