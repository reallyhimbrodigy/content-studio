# Wall doors — every entry into app functionality, and how the wall holds it

Wall Correctness Package item 3. "Every door leads to the wall" — this is the
enumeration + the gate/trace per door. A door not on this list, or without a
gate, is a hole in the wall. The **server** doors are authoritative (they enforce
even against a jailbroken or old client); the **client** doors present the wall
UI in front of them (with the demo front door first).

Enforcement decision core (pure, tested): [lib/wall-enforcement.js](../lib/wall-enforcement.js) +
[lib/tier-capabilities.js](../lib/tier-capabilities.js). Rollout: enforce when the
`WALL_ENFORCEMENT` knob is ON **and** (account created ≥ `WALL_FLIP_DATE` **or**
the client sent `X-Promptly-Wall-Capable: 1`). **Knob OFF = today's behavior for
everyone**, so wiring these doors changes nothing until the flip.

## Server doors (API enforcement — the wall that holds without the client)

| Door | Endpoint (server.js) | Today's gate | Wall decision (`enforce` on) | Proven by |
|---|---|---|---|---|
| **Render** | `POST /api/video-jobs` :3257 | `assertProEntitled` :3308 + `claimDailyUsage('render', 3)` :3380 | `gateDecision({tier,'render',today})`: none→403 `wall`, trial→3/day then 402 `paywall`, paid→∞ | `wall-enforcement.test.js` render cells |
| **Re-edit** | `POST /api/video-jobs` (re-edit branch) :3491/:3543 | `assertProEntitled` (Pro-only) | `tier==paid`; none→403 `wall`, trial→402 `paywall` | truth-table `re-edit: paid only` |
| **Chat** | `POST /api/chat` :2290 | `assertProEntitled` :2329/:2470 + `FREE_DAILY_CHATS=50` | `gateDecision({tier,'chat',today})`: none→403 `wall`, trial→50/day, paid→∞ | `wall-enforcement.test.js` chat cells |
| **Upload** | `POST /api/upload` :1345 · `/api/upload-url` :1881 · `/api/upload-multipart-init` :1907 | rate-limit only — **NOT tier-gated today** | `uploadDecision({tier,count})`: none→403 `wall`, trial→1, paid→10 — **new gate** | `wall-enforcement.test.js` upload cells |
| **Prewarm (GPU)** | `POST /api/prewarm` :3091 | rate-limit only | require `appUsable`: none→403 `wall` (it spends GPU) | truth-table `appUsable` |
| **Usage (read)** | `GET /api/usage` :2624 | — | returns `tier` so the client routes wall vs paywall (no grant) | `entitlement.test.js` tier + `/api/usage` |

Wiring status: decision core + tests **done**; live-endpoint wiring is the next unit (each handler computes `tier = entitlementTier(profile)` + `enforce = shouldEnforceWall(...)`, then calls the matching decision and returns `{ error, route: 'wall'|'paywall' }` on deny). Because the knob defaults OFF, the wired gates are byte-for-byte today's behavior until the flip.

## Client doors (post-auth entry points — the wall UI + demo front door)

Every path that reaches app functionality must, for `.none`, land on the wall
(demo front door first), not on a usable screen or the daily-limit paywall.

| Entry point | Where | Routes `.none` → wall via | Status |
|---|---|---|---|
| Cold launch, restored session | `PromptlyApp` → `AppShell` | tier gate at the shell root → wall overlay | to build (item 3 client) |
| Editor (compose / send) | `EditorView` | send blocked for `.none` → wall | to build |
| Library (re-edit / watch) | `LibraryView` | already Pro-gated; `.none` → wall | to build |
| Model picker (Lumen) | `ModelPicker` | already gated; `.none` → wall | to build |
| Push-notification tap | `NotificationDelegate` | deep-links into the shell → shell gate catches `.none` | to trace |
| Deep link / Universal Link | (none currently registered) | n/a — confirm no URL scheme bypasses the shell | to confirm |
| Share sheet / extension | (none currently) | n/a — no app extension target exists | confirmed absent |

The **demo front door** sits in front of the wall on every path: install → sample
before/after (zero render cost) → first action → wall. The wall is never a cold
user's first screen.

## The invariant
For `.none` with `enforce` on: **no server door returns a 2xx grant, and no client
door reaches a usable screen** — both resolve to the wall. Every server cell is
green in `wall-enforcement.test.js`; each client door gets a trace as the wall UI
lands.
