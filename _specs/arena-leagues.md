# Arena Leagues — named config variants (settings / mod / map pool) per room

Status: design (2026-07-29). Implements: "work on a fork or improvement of arena
with leagues: each league has its own settings, mod, map pool.. some leagues
would be just a small variation of other (eg promode league with or without
force random weapons)."

Companions: `_specs/plugin-architecture.md` (the fork's plugin/host model and
the arena ladder), `ext-proxy/_specs/room-admin-panel.md` (governed RTDB nodes,
validators, panel tabs), `ext-proxy/_specs/panel-collaboration.md`
(`recordAndWrite`, history/undo, `_meta/versions`, presets),
`headless-launcher-go/_specs/game-history.md` (`@@GAME@@` emission, SQLite
store).

## Goal & non-goals

**Goal.** A room can hold a small named catalog of *leagues* — each a bundle of
settings overrides plus optionally a mod and a map pool, optionally **extending**
another league — and switch between them in one action (panel button or in-room
command) without re-editing settings/mod/pool by hand.

**Non-goals (v1).**
1. Per-league ELO ladders / separate leaderboards. One ladder per room; every
   game *records* its league so a split can be backfilled later (§7).
2. Seasons (time-boxed ladders, resets, promotion/relegation).
3. Scheduling / automatic rotation ("promode on Fridays").
4. Multi-room shared leagues. A league is per-room; cross-room reuse rides the
   existing preset machinery in phase 6.
5. Replacing the arena plugin. Leagues are orthogonal — they configure the room;
   the arena plugin runs the queue. A room can use either alone.
6. Per-league weapon-effectiveness buckets. Weapon stats are already bucketed by
   **mod** (`z_stats.js:474-505`), and a league pins a mod, so two leagues on the
   same mod correctly share a bucket.

## What already exists (don't reinvent)

- **Governed RTDB nodes.** `settings`, `pool`, `poolbounds`, `admins`,
  `weapons`, `mod`, `pluginconf` are written whole by the panel through
  `recordAndWrite` (`ext-proxy/history.go:60`), which writes the node, pushes a
  `_history` entry, and stamps `_meta/versions/<node>` for the 5s live-sync poll.
  `governedNodes` is the list (`history.go:27`).
- **Per-node validation** lives in Go: `validateSettings` (`roomadmin.go:682`,
  backed by `settingsCatalog` at `roomadmin.go:623`), `validatePool`
  (`roomadmin.go:733`), the poolbounds/weapons/mod cases in
  `validateNodeValue` (`validate_nodes.go:15`). `validateNodeValue` is the
  authoritative gate for every non-PUT write path (undo, preset apply).
- **Live apply in the room.** `settings` → `updateSettings` merges the node onto
  `WLROOM.getSettings()` and calls the global `loadSettings(sett)`
  (`firebase.js:181-199`). `mod` → `handlePanelModChange` → `applyPanelMod`
  (`panel.js:119-163`), with **postpone-apply** (`applyAt:"nextGame"` stashes in
  `panelPendingMod`, applied on a chained `onGameStart` — `panel.js:26-34,124`).
  `pool` → child listeners feeding `mypool` (`firebase.js:140-165`,
  `mappool.js:67`). `poolbounds` → `mappool.js:357`.
- **Runtime-state mirrors.** `poolstate` (room → panel: current shuffled order +
  position, `mappool.js:372`) and `poolctl` (panel → room one-shots, cleared
  after apply, `mappool.js:359`). `meta.alive` heartbeat (`panel.js:51`).
- **The room already writes some governed nodes from chat commands**: `!addmap`
  (registered `mappool.js:478`) writes `pool` via `firebase.js:168-170`, `!admin`
  (`mappool.js:470`) writes `admins` via `firebase.js:121-124`. A room-originated write to a governed node is precedented;
  it just doesn't produce a `_history` entry.
- **Stats.** `z_stats.js` is the single stats writer; it captures the active mod
  once per game at `onGameStart` from `window.panelCurrentMod`
  (`z_stats.js:236-248`) and emits one `@@GAME@@` console line per game
  (`z_stats.js:614`) which wlhl stores in SQLite.
- **Panel plugin tab** renders a schema-driven form from each plugin's published
  manifest (`embed/roomadmin.html:1968`), saving to `pluginconf`.

## Design

### 1. Two nodes: a catalog and a pointer

    simple/<roomId>/leagues        the catalog   — ONE writer: the panel
    simple/<roomId>/league         the pointer   — TWO writers: panel + room
    simple/<roomId>/leaguestate    runtime mirror — room-written, read-only

Splitting catalog from pointer is what makes §6 (validation) hold: the in-room
command can only ever move the *pointer*, which carries no configuration, so an
in-room switch physically cannot introduce an unvalidated league. Both nodes join
`governedNodes` (history, undo, versions, live-sync for free).

**`leagues`** — an object keyed by league id (`^[a-z0-9_-]{1,32}$` — same
charset as `pluginIDRe`, lowercase so `!league PROMODE` can be folded), max 32
entries. Facet caps are TIGHTER than the standalone nodes they shadow (a league
is a variation, not a second full config; this also keeps the whole catalog
within the PUT body cap — `MaxBytesReader` 256KB on `PUT leagues`): `settings`
≤ 40 keys, `pool` ≤ 100 maps, `poolbounds` ≤ 100 entries, `desc` ≤ 200,
`name` ≤ 60:

    leagues = {
      "promode": {
        name: "Pro mode", desc: "classic 1v1 ruleset",
        settings: { scoreLimit: 30, bonusDrops: "none", weaponChangeDelay: 20 },
        mod: { name: "Jerac/DooM.zip" },            // or { url: "https://…" }
        pool: ["arena1.png", "arena2.png"],         // phase 4
        poolbounds: { "arena1.png": {min:2,max:2} },// phase 4
        weapons: { banById: [3, 17] },              // phase 4
        updatedAt: <ms>, updatedBy: "panel:<grantId>"
      },
      "promode-random": {
        name: "Pro mode (random weapons)",
        extends: "promode",
        settings: { forceRandomizeWeapons: true }
      }
    }

Every facet is **optional and absent-means-inherit**. A facet's shape is
byte-identical to the governed node it shadows, so each is validated by the
existing validator for that node (§6).

**`league`** — the active pointer, shaped exactly like the `mod` node so the
postpone machinery is the same:

    league = { id: "promode-random" | "",     // "" = no league, base config
               applyAt: "now" | "nextGame",   // absent = "now"
               setAt: <ms>, setBy: "panel:<grantId>" | "room:<auth>" }

**`leaguestate`** — the room's mirror, so panel/stats readers can show what is
actually live (the pointer says what was *asked for*; this says what *landed*):

    leaguestate = { id, name, appliedAt, facets: ["settings","mod"],
                    pending: {id, name} | null, warnings: [ "…" ], updatedAt }

### 2. Inheritance: single-level `extends`, shallow

`resolve(id)`:
- `settings` — **key-level merge**, child wins: `{...parent.settings, ...own.settings}`.
- `mod` / `pool` / `poolbounds` / `weapons` — **whole-facet replace**: the child's
  facet if present, else the parent's. Merging two map lists or two ban lists has
  no sane semantics.
- A parent that itself declares `extends` is rejected at validation time; if one
  slips into the node by hand, the room ignores the grandparent and records a
  `leaguestate.warnings` entry rather than recursing.

**Why one level is enough, and not a limitation we'll regret.** The ask is
literally "promode ± one flag". One level keeps the Go validator to a *one-level
merge* instead of a resolver: since each league's facets are individually valid
and a settings merge is a key-wise union of already-valid values, the resolved
product is valid by construction — the only thing the merge has to re-check is
that the union still fits `validateSettings`'s 100-key cap. (As-built note:
with the per-facet ≤40-key cap, a one-level union tops out at 80 keys — the
merge re-check is defensive infrastructure, unreachable via key-count alone;
the per-facet cap is the operative gate.) A recursive chain
would need cycle detection, a depth cap, and a full Go resolver kept in lockstep
with the JS one. A third variant extends the same base instead of chaining.
Cost: a change to a common base has to be made once per base — acceptable for a
catalog capped at 32.

### 3. Applying a league: an overlay, never a rewrite

The room applies the resolved league **on top of** the governed nodes; it does
**not** materialize a league into `settings`/`pool`/`mod`.

    effective_settings = bootSettings ⊕ settingsNode ⊕ league.settings
    effective_mod      = league.mod  ?? modNode
    effective_pool     = league.pool ?? poolNode          (phase 4)

The rejected alternative — having ext-proxy resolve the league and write the
concrete node values — is in *Alternatives considered*. The short version: it
destroys the room's base config on every switch, makes "edit the pool" ambiguous
(room pool or league pool?), and makes deactivation lossy.

**The apply hook is a wrap of the global `loadSettings` PLUS a cache-only
settings listener.** `updateSettings` (`firebase.js:181`) merges the settings
node onto the live engine settings and calls the global `loadSettings(sett)` —
which has exactly two callers (`firebase.js:187` and the `!reset` command at
`firebase.js:202`) and is a top-level function declaration, i.e. a writable
global binding. `leagues.js` (loads after `firebase.js`: `f` < `l`) captures and
replaces it:

    if (!window.__LEAGUE_WRAPPED) {                   // double-wrap sentinel
      window.__LEAGUE_WRAPPED = true;
      var leagueBaseLoadSettings = loadSettings;      // capture at load, deterministic
      loadSettings = function (sett) {
        leagueBaseLoadSettings(leagueOverlay(sett));  // returns a NEW object
      };
    }

**Why the extra listener (spec-review finding).** `WLROOM.getSettings()`
serializes the engine's CURRENT state, not its defaults — so after the first
league apply, the `sett` reaching the wrapper is `defaults ⊕ activeLeague ⊕
settingsNode`, and the settings node is NOT reconstructable from it. The
overlay therefore cannot be computed from `sett` alone. `leagues.js` keeps its
own **cache-only** `.on('value')` on the settings ref (`leagueNodeCache`) —
cache-only means it never applies anything, so the "second applier /
listener-ordering" objection doesn't arise; ordering only affects how fresh the
cache is, and the fallback below covers the boot race.

`leagueOverlay(sett)` builds the effective object from clean sources:

    effective = { ...bootSettings,                    // engine defaults (16 keys)
                  ...(leagueNodeCache ?? sett),       // the settings node (carries
                                                      //  node-only keys: afkLimit…)
                  ...resolvedLeague.settings }        // the league's overrides
    + carry-forward of RUNTIME-OWNED keys (below) unless explicitly named
      by the node or the league.

`?? sett`: on the very first call the cache may not have fired yet — at that
moment `sett` IS `defaults ⊕ node`, unpolluted, so it's a safe fallback.

**Deactivation rebuilds too** (found live in phase-1 testing): the settings
node can be SPARSE (only panel-touched keys), so after a league was active,
`sett`/`settingsSnap` stays polluted with the league's values for every key the
node doesn't name — passing it through on `!leagueoff` leaked `bonusDrops`/
`weaponChangeDelay`. The overlay therefore returns `sett` untouched ONLY until
a league has ever been active this room lifetime (`window.__LEAGUE_TOUCHED`
sentinel, set on first apply); after that it always rebuilds `boot ⊕ node ⊕
(league.settings || {})` — deactivation is just the empty-league rebuild.
Non-league rooms keep exact legacy behavior.

Traps this must respect:

1. **`updateSettings` MERGES, it never resets** (`firebase.js:184-186`). This is
   exactly why the overlay rebuilds from `bootSettings ⊕ node ⊕ league` rather
   than patching `sett`: a key set by league A and named by neither league B nor
   the settings node must fall back to the engine default. `bootSettings` is a
   one-time snapshot of `WLROOM.getSettings()` taken on the **first** invocation
   of the wrapper (the engine still holds defaults then — that call *is* the
   first application of the settings node), guarded by
   `window.__LEAGUE_BOOT_SETTINGS` against hot-reload recapture. Node-only keys
   (e.g. `afkLimit`, consumed at `firebase.js:194-198`) are NOT in
   `bootSettings` — they ride in via `leagueNodeCache`, which is why the overlay
   unions the node cache rather than building from the snapshot alone.
2. **Never mutate `sett`.** `updateSettings` assigns `window.settingsSnap = sett`
   *after* calling `loadSettings` (`firebase.js:187-188`); mutating the argument
   would poison the base snapshot that `!reset` and the next overlay read from.
   `leagueOverlay` returns a new object.
3. **Runtime-owned keys.** Some settings are driven continuously by plugins and
   must be carried forward from the LIVE engine value unless the node or league
   explicitly names them: `teamsLocked` (arena plugin, `arena_plugin.js:50`) and
   `expandLevel` (newjohn, `newjohn_plugin.js:153-154`). The list lives in
   `leagues.js` as `LEAGUE_RUNTIME_KEYS` — any future runtime-owned setting must
   be added there.
4. **Hot-reload hazards.** Re-running `firebase.js` re-declares `loadSettings`
   and silently UN-wraps the overlay; re-running `leagues.js` without the
   sentinel would double-wrap. Both are why fork deploys are room-restart-only
   (`firebase.js` and `leagues.js` named explicitly in the phases caveat).

**Mod (phase 1b).** Two paths, one applier:
- *Node changed while a league is active*: `handlePanelModChange` (`panel.js:119`)
  passes the node value through `leagueEffectiveMod(baseModNodeValue)` before
  applying — the league's mod wins while active, and `panel.js` remembers the
  last raw node value in a new `lastModNode` so deactivation can restore it.
- *League activation/deactivation itself*: the `mod` node does NOT change, so the
  node listener never fires — `leagues.js` calls the global `applyPanelMod`
  DIRECTLY with the league's mod (activation) or `lastModNode` (deactivation).
  `leagues.js` loads before `panel.js` (`l` < `p`) but only calls it at runtime,
  after boot — safe.
- *Deactivation with NO base mod node*: the engine has no `unloadMod`; the room
  keeps the league's mod loaded and records a `leaguestate.warnings` entry
  ("no base mod to restore — restart to clear"). The phase-1b checklist reflects
  this.
All loading goes through `applyPanelMod`, which owns the `lastAppliedModKey`
dedup — a league naming the already-loaded mod is a free no-op, and there is
still exactly one mod applier.

**Pending-queue precedence.** A queued league (this spec) and a queued panel mod
(`panelPendingMod`) can both be waiting on the same `onGameStart`. Rule: **the
league wins.** When the league's pending apply includes a mod, it sets
`window.__LEAGUE_PENDING_MOD_APPLIED = true`; `panel.js`'s pending handler
checks the flag, skips its own `loadMod`, clears the flag, and logs the skip.
(`chainFunction` ordering alone must not decide this — it's load-order trivia.)

**Pointer dedup.** Re-writing the pointer with the same `id` as the currently
applied league is a no-op (no re-apply, no queue) — mirrors the mod path's
`lastAppliedModKey` guard so a redundant panel write can't queue a redundant
`loadMod`.

**Re-apply points.** `leagues.js` calls `leagueReapply()` (recompute the overlay
via `loadSettings(window.settingsSnap ?? leagueNodeCache)` + resolve the
effective mod) when: the `league` pointer changes, the `leagues` catalog changes
and the active league's resolution changed, and once at boot after both nodes
have arrived (guarded: `settingsSnap` is undefined until the settings listener
first fires — the boot re-apply waits for it). A persisted pointer therefore
survives a room restart.

**Catalog edits and vanishing leagues are gated like switches.** A catalog
change that alters the ACTIVE league's resolution (panel edit, History-tab undo)
re-applies through the same in-progress gate as `!league`: immediate when idle,
queued to the next `onGameStart` when a game runs (`leaguestate.pending` shows
it) — a catalog edit must not `loadMod` mid-round. If the active league
DISAPPEARS from the catalog (delete, undo, `emptyIdentity` `{}`), the room
treats it as a pointer to `""`: revert to base config through the same gate,
plus a `leaguestate.warnings` entry ("league <id> removed from catalog —
reverted to base"). The pointer node is left as-is (an undo restoring the
catalog brings the league back at the next gate).

### 4. Activation surface

**Panel** — Leagues tab: `Activate now` / `Activate next game` per row
(§8). Writes the `league` node via `PUT /padmin/<room>/api/league`.

**In-room commands** (registered in `leagues.js` via `COMMAND_REGISTRY.add`).
All are registered once at `COMMAND.FOR_ALL` with an internal `player.admin`
check for the write paths — registering the same name in two tiers works but is
subtle (the registry consults super → admin → any tiers and stops at the first
handler that returns false, `command_registry.js:69-81`), and a command-name collision has already caused one
round of review fixes in this fork (commit `eeee7ae`).

| command | who | effect |
|---|---|---|
| `!leagues` | anyone | list ids + names, marking the active one |
| `!league` | anyone | show the active league, its facets, and any pending switch |
| `!league <id> [now]` | admin | write the pointer. `applyAt` defaults to `nextGame` **when a game is in progress**, `now` otherwise; the literal `now` argument forces immediate |
| `!leagueoff` | admin | write `{id:""}` — back to base config |

The in-game default of `nextGame` mid-game exists because applying a league can
`loadMod`, and a mid-round `loadMod` disrupts the running game — the same reason
`panel.js` has the postpone path at all.

`leagues.js` tracks game-in-progress with its own `onGameStart`/`onGameEnd`
chained flag; it must not read `z_stats`'s `statsGameInProgress` (stats owns
that, and a stats hot-reload resets it).

Pending switches use the same shape as `panelPendingMod`: stash, apply on the
next chained `onGameStart`, publish it in `leaguestate.pending` so the panel and
`!league` can say "promode-random applies next game". A pointer written with
`applyAt:"nextGame"` while NO game is running applies immediately (a pending
switch must never wait indefinitely on an idle room).

### 5. Who writes what (and the one deliberate exception)

| node | panel writes | room writes |
|---|---|---|
| `leagues` | yes, via `recordAndWrite` | **never** |
| `league` | yes, via `recordAndWrite` | yes, from `!league` / `!leagueoff` |
| `leaguestate` | never | yes (mirror) |
| `settings` / `mod` / `pool` | unchanged | unchanged (leagues never write these) |

A room-originated pointer write bypasses `recordAndWrite`, so it produces no
`_history` entry and no `_meta/versions` bump — the panel's live-sync would not
notice an in-room switch for as long as the tab stayed open. Fix: after writing
the pointer, `leagues.js` also writes `_meta/versions/league = Date.now()`. This
is a **documented exception** — `_meta` is otherwise ext-proxy-owned
(`history.go:10-13`) — and it is one small write on an admin action, not a hot
path. History still shows only panel switches; in-room switches are visible in
`leaguestate` + the room's announce + the chat log.

### 6. Validation: one implementation, in Go

`validateNodeValue` (`validate_nodes.go:15`) gains two cases; the logic lives in
a new `ext-proxy/leagues.go`:

- **`leagues`**: object, ≤32 entries. Per entry: id matches the league-id regex;
  `name` non-empty ≤60; `desc` ≤200; `extends` (if present) names an existing
  league in the *same* payload that has no `extends` of its own. Facets are
  validated by delegating to the existing validators — `validateSettings` for
  `settings`, `validatePool` for `pool`, and the `poolbounds` / `weapons` / `mod`
  cases of `validateNodeValue` itself. Then a **one-level merge** per league that
  declares `extends`, re-running `validateSettings` on the union (catches the
  100-key cap only reachable after merging).
  - **Empty facets must be dropped, not validated.** `validateSettings` rejects
    an empty object outright (`roomadmin.go:683-685`) and the `mod` case requires
    a name or url (`validate_nodes.go:108`). A league that only overrides the mod
    legitimately has no settings facet. So: strip any facet that is `null`, `{}`
    or `[]` *before* validating, and reject a league that ends up with zero
    facets ("a league must override something").
- **`league`**: object; `id` is `""` or a valid league id; `applyAt` ∈
  {`""`,`now`,`nextGame`}; `setAt`/`setBy` server-stamped by the handler (like
  `handlePutMod`, `roomadmin.go:1167`). The pointer is **not** checked against the
  catalog at write time (an admin may stage a switch to a league they are about
  to create, and the catalog could change under an undo); an unknown id is a room-
  side no-op with a `leaguestate.warnings` entry.

`emptyIdentity` (`history.go:234`) returns `{}` for both, which the room reads as
"no league" — so undoing the first-ever pointer write is safe.

`summarizeChange` (`validate_nodes.go:159`) gains: `leagues` → `"leagues: +promode-random, ~promode"`;
`league` → `"league → Pro mode (random weapons)"` / `"league cleared"`.

**The room never validates.** It resolves and applies, defensively bounded: an
unknown id, a missing parent, a non-object facet or an oversized catalog is
logged, surfaced in `leaguestate.warnings`, and skipped — a corrupt catalog must
never wedge the room (the RTDB is world-open until the phase-6 rules lock-down of
`room-admin-panel.md`, so a hand-edited catalog is a real possibility).

### 7. Stats: record the league now, split the ladder never (yet)

1. **Per-game capture.** `z_stats.js` gains `statsCaptureLeague()` next to
   `statsCaptureMod()` (`z_stats.js:236`), reading `window.leagueCurrent =
   {id,name}` set by `leagues.js` — the same indirection `panelCurrentMod` uses.
   Captured once at `onGameStart`, because a queued league applies at the next
   game start anyway.
2. **`@@GAME@@` gains `"league": "<id>" | null`** (`z_stats.js:614`). Storage is
   free — wlhl already keeps the verbatim payload in `games.raw`
   (`gamestore.go:73`). **But the API will not surface it**: `Query` unmarshals
   `raw` into the `Game` struct (`gamestore.go:174,211`) and `Game`
   (`gamestore.go:42-51`) has no `League` field, so an unknown key is silently
   dropped on read. Surfacing/filtering needs a wlhl change: `League *string` on
   `Game`, a `league TEXT` column + index in a schema v2 migration, and a
   `QueryOpts.League` filter. Deferred to phase 5 — the emission lands first so
   history accumulates the field from day one.
3. **RTDB index** `stats/leagues/<id> = {name, games, lastUsed}`, incremented
   UNCONDITIONALLY at game end (NOT like `stats/mods/<modKey>`, which sits
   inside `if (statsWpnSeen.size)` at `z_stats.js:501-506` and so skips
   hit-less games — the phase-5 "increments once per game" assertion needs the
   unconditional write). Bounded by catalog size; gives readers a selector.
4. **One ladder per room.** ELO, streaks, h2h and per-map win rates stay
   room-wide. Splitting them means per-league player nodes
   (`stats/leaguePlayers/<id>/<auth>`), multiplying write volume and fragmenting a
   small player base across variants that mostly differ by one flag. This is not a
   corner: because every game row carries its league id, a per-league ladder can
   be **recomputed offline from the SQLite history** whenever it's wanted. That
   recomputability is the whole reason step 2 is worth doing now.
5. **Public stats page** shows the active league. Fold `leaguestate` into the
   existing `overview` endpoint payload (`statspage.go:131`, already cached 10s)
   rather than adding an endpoint; render a chip next to the room name and a line
   on the Arena tab (`embed/stats.html:76`).

### 8. Panel UI (Leagues tab)

New tab between **Mod** and **Weapons** (`embed/roomadmin.html:145-158`), shown
only when the room advertises the capability: `leagues.js` writes
`meta.leagues = 1` at boot (same pattern as `meta.weapons` / `meta.stats` —
`contractVersion` is the wrong gate: it means "fork v1", which is true of fork
rooms that don't ship `leagues.js`, and the tab would render but do nothing).

- **List.** One row per league: `id · name · extends · facet chips
  (settings/mod/pool/bounds/weapons) · ACTIVE badge`, actions `Activate now`,
  `Activate next game`, `Edit`, `Duplicate`, `Delete`. A footer row shows the
  pointer's `pending` state from `leaguestate`.
- **Editor** (inline panel, not a modal — matches the existing tabs): id
  (create-only, regex-checked client-side), name, desc, `extends` select listing
  only leagues that don't themselves extend, and one collapsible section per
  facet with an enable checkbox.
  - *settings facet*: reuse the settings-catalog editor component, with
    "untouched = inherit" rendered dashed exactly like the Settings tab's
    unset-key treatment (panel v2, `room-admin-panel.md` §2026-07-15).
  - *mod facet*: reuse the Mod tab's catalog browser + custom-URL field.
  - *pool / poolbounds / weapons facets*: phase 4.
- **Resolved preview** (the feature that makes `extends` legible): a read-only
  list of the effective facets after the merge, and for settings a diff against
  the room's base `settings` node. Keys the league sets that the base node does
  **not** define are flagged — they resolve to the engine default when the league
  is deactivated (§3 trap 1), which is usually what the admin wants but should be
  visible.
- **Save** = whole-node `PUT leagues` (last-writer-wins + history, same as
  Settings; the presence chips and live-sync banner already warn about concurrent
  editors). **Activate** = `PUT league {id, applyAt}`.
- **Cross-tab banners.** When a league is active and overrides a facet, the
  Settings / Mod / Map-pool tabs show a one-line banner: "League *Pro mode
  (random weapons)* overrides these settings: scoreLimit, forceRandomizeWeapons —
  edits here change the room's base config." Without this, an admin edits
  `scoreLimit` on the Settings tab, sees no effect in game, and files a bug.

## Files to create / modify

| File | Change | ~LOC |
|---|---|---|
| `webliero-simple-panel/leagues.js` | NEW: catalog + pointer listeners, resolver, `loadSettings` wrap, `leagueEffectiveMod`, pending/apply, `leaguestate` writer, `!league`/`!leagues`/`!leagueoff` | 280 |
| `webliero-simple-panel/panel.js` | MODIFY: remember `lastModNode`; route `handlePanelModChange` through `leagueEffectiveMod` | +20 |
| `webliero-simple-panel/z_stats.js` | MODIFY: `statsCaptureLeague`, `league` in the `@@GAME@@` payload, `stats/leagues/<id>` index | +18 |
| `webliero-simple-panel/mappool.js` | MODIFY (phase 4): `basePool` vs active pool split so a league pool overlays without fighting the `pool` child listeners; `poolstate.league` | +45 |
| `webliero-simple-panel/firebase.js` | **NO CHANGE** — the overlay wraps the global `loadSettings` from `leagues.js` | 0 |
| `ext-proxy/leagues.go` | NEW: `validateLeagues` (facet delegation + one-level merge check), `validateLeaguePointer`, `handlePutLeagues`, `handlePutLeague` | 220 |
| `ext-proxy/validate_nodes.go` | MODIFY: `leagues` + `league` cases in `validateNodeValue`; `summarizeChange` cases | +25 |
| `ext-proxy/history.go` | MODIFY: `governedNodes` += `leagues`, `league` | +2 |
| `ext-proxy/roomadmin.go` | MODIFY: PUT dispatch cases; add `leagues`, `league`, `leaguestate` to the readable-node case (`roomadmin.go:449`) | +12 |
| `ext-proxy/embed/roomadmin.html` | MODIFY: Leagues tab (list/editor/resolved preview/activate) + facet banners on Settings/Mod/Maps | +420 |
| `ext-proxy/statspage.go` / `statsread.go` | MODIFY (phase 5): fold `leaguestate` into the `overview` payload | +20 |
| `ext-proxy/embed/stats.html` | MODIFY (phase 5): active-league chip + Arena-tab line | +30 |
| `ext-proxy/presets.go` | MODIFY (phase 6): `presetNodes` += `leagues` for cross-room copy | +5 |
| `headless-launcher-go/internal/gamestore/gamestore.go` | MODIFY (phase 5): `Game.League`, `league` column + index, `QueryOpts.League`. NOTE: there is NO migration mechanism today (bare `CREATE TABLE IF NOT EXISTS`, no `user_version`) — phase 5 includes building one (PRAGMA user_version + ALTER TABLE path) and touching `Append`'s explicit column list; this is real infrastructure, not a +30 diff | +90 |

## Phases

Each phase is independently shippable and independently testable. Fork changes
deploy with a **room restart, not a per-file hot reload** — hot-reloading a fork
file loses in-memory state (`room-admin-panel.md` prod-rollout caveat), and
`leagues.js` specifically re-wraps `loadSettings` on every load.

### Phase 1 — room-side leagues, SETTINGS ONLY, hand-seeded catalog

Smallest end-to-end surface: one test room, no panel UI, no ext-proxy change.
The catalog is written by hand into `simple/<room>/leagues` (the RTDB is
world-open, `room-admin-panel.md` risk 1). Ships `leagues.js` (overlay + cache
listener + commands + `leaguestate` + `meta.leagues`) — settings facet only;
mod/pool/poolbounds/weapons facets are ignored if present (that keeps ALL the
two-applier mod complexity out of the first landing).

### Phase 1b — mod facet

The `panel.js` `lastModNode` hook, `leagueEffectiveMod`, direct `applyPanelMod`
on activation, pending-queue precedence, no-base-mod deactivation warning.

Verify:
- [ ] With no `leagues` node at all, the room behaves exactly as today (settings
      apply, mod applies, `!leagues` says "no leagues configured").
- [ ] Seed `promode` (settings only) + `promode-random` (`extends: promode`,
      `forceRandomizeWeapons: true`). `!league promode-random` while idle applies
      immediately; `WLROOM.getSettings()` shows promode's keys **and** the random
      flag.
- [ ] `!league promode` → `forceRandomizeWeapons` returns to the base node's
      value, or to the engine default when the base node doesn't define it (the
      §3 trap-1 case — this is the assertion that proves `bootSettings` works).
- [ ] `!leagueoff` → every league-only key returns to base/default.
- [ ] A league with a `mod` facet loads that mod; `!leagueoff` reloads the base
      `mod` node's mod; re-activating the same league does **not** re-`loadMod`
      (`lastAppliedModKey` dedup).
- [ ] `!league <id>` **during** a running game queues it (`!league` reports the
      pending switch; `leaguestate.pending` is set) and it applies at the next
      `onGameStart`.
- [ ] With the arena plugin active: switching a league mid-duel does not unlock
      teams (`teamsLocked` carried forward, §3 trap 3) and does not eject anyone.
- [ ] Panel Settings tab still saves and applies (the `loadSettings` wrap is
      transparent); `!reset` re-applies base + overlay.
- [ ] Garbage catalog (unknown `extends`, a facet set to a string, 200 entries)
      → warnings in `leaguestate`, room keeps playing.
- [ ] Restart the room: the persisted pointer re-applies its league on boot.

### Phase 2 — ext-proxy API + validation + history (no UI)

`leagues.go`, the `validateNodeValue` cases, `governedNodes`, the PUT/GET
dispatch. Exercised with curl against a dev instance.

Verify:
- [ ] `PUT /padmin/<room>/api/leagues` with a valid catalog writes the node,
      pushes a `_history` entry with a readable summary, and bumps
      `_meta/versions/leagues`.
- [ ] Rejected (422/400) with a specific message: unknown settings key value out
      of catalog range, a 2-level `extends`, a self-`extends`, a league with zero
      facets, 33 leagues, a settings union >100 keys after merge.
- [ ] An empty `settings: {}` facet is dropped rather than rejected, and a league
      whose only facet is `mod` saves.
- [ ] `PUT .../league {id:"promode",applyAt:"nextGame"}` → the running room from
      phase 1 queues the switch. `{id:""}` clears it.
- [ ] Undo of a `leagues` write from the History tab restores the prior catalog
      and re-validates it; undo of the first-ever `league` write writes `{}` and
      the room reads that as "no league".
- [ ] `GET .../leagues`, `.../league`, `.../leaguestate` return the nodes.

### Phase 3 — panel Leagues tab

List / create / edit / duplicate / delete / activate, extends picker, resolved
preview, cross-tab banners.

Verify:
- [ ] Create `promode` from the UI, then `promode-random` extending it, without
      touching RTDB by hand; the resolved preview shows the union.
- [ ] Keys set by a league but absent from the base settings node are flagged in
      the preview.
- [ ] Activate now / next game both work from the UI and are reflected in
      `leaguestate` within one poll.
- [ ] With a league active, the Settings/Mod tabs show the override banner and
      editing them still writes the base node (verified in the History tab).
- [ ] Two panels open: one activates a league, the other sees the change via the
      existing 5s activity poll without a reload.
- [ ] The tab is hidden for a room with no `meta.contractVersion`.

### Phase 4 — pool / poolbounds / weapons facets

`mappool.js` gains `basePool` (fed by the `pool` child listeners) and an active
pool that is the league's list when one is defined; `rebuildPoolIdx(true)` on
switch; `poolstate.league` so the Maps tab can say which pool is playing.

Verify:
- [ ] Activating a league with a `pool` swaps the rotation to that list within one
      map change and `poolstate.order` reflects it; `!leagueoff` restores the room
      pool **including its manual play order** if one was set.
- [ ] A panel edit to the `pool` node while a league pool is active updates the
      base pool without disturbing the live rotation, and takes effect on
      deactivation.
- [ ] `poolbounds` from the league are honored by `mapFitsPlayers`.
- [ ] Weapons facet: bans re-apply **after** the league's mod finishes loading
      (the `Ck`-clear-on-`loadMod` trap, `room-admin-panel.md` risk 5), and a
      league whose `weapons` indices were authored against a different mod is
      flagged in `leaguestate.warnings` rather than banning the wrong weapons
      (see open question 1).

### Phase 5 — stats

`@@GAME@@` league field, `stats/leagues` index, `overview` payload, stats-page
chip; wlhl `Game.League` + column + filter.

Verify:
- [ ] A game played under a league emits `"league":"promode-random"`; a game with
      no league emits `null`.
- [ ] `stats/leagues/<id>.games` increments once per game.
- [ ] After the wlhl change, `GET /api/rooms/<id>/games` returns `league` per row
      and `?league=` filters; rows stored **before** the wlhl change still return
      their league (it was always in `raw`) but are not filterable until
      backfilled from `raw`.
- [ ] The public stats page shows the active league; the Arena tab notes it.

### Phase 6 (optional) — leagues as presets

`presetNodes` += `leagues`, so a catalog can be saved once and applied to another
room through the existing preset save/apply path (`presets.go:288-307`, which
already re-validates on apply). This is the whole of "multi-room leagues" for v1
purposes: copy, don't share. CAVEAT (spec review): `presetNodes` deliberately
excludes `mod` and `weapons` as room-identity-ish (`presets.go:24-27`) — a
league catalog carries both as facets, which would smuggle them cross-room.
Phase 6 must STRIP mod/weapons facets on preset apply (with a visible note in
the apply result), or explicitly reopen the presetNodes rationale first.

## Risks

1. **Settings-node merge semantics leak keys between leagues.** `updateSettings`
   copies node keys onto the live engine settings and never resets
   (`firebase.js:184-186`), so without the `bootSettings` base a key set by the
   outgoing league survives the switch. Mitigated by §3 trap 1; the residual risk
   is capturing `bootSettings` from an already-polluted engine after a hot reload,
   which the `window.__LEAGUE_BOOT_SETTINGS` sentinel prevents *within* a room
   lifetime but not across a mid-session `wlhl run leagues.js`. Deploy fork
   changes with a restart.

2. **`teamsLocked` clobber.** The arena plugin owns `teamsLocked` at runtime
   (`arena_plugin.js:50`); a full settings re-apply would unlock a live duel and
   let a spectator self-join. Mitigated by carrying the live value forward unless
   explicitly named. Any future runtime-owned setting must be added to that
   carry-forward list.

3. **In-room switches produce no history entry.** The room writes the pointer
   directly, bypassing `recordAndWrite`. Mitigated by the room stamping
   `_meta/versions/league` (§5) so live-sync still notices; accepted that the
   History tab shows only panel-originated switches. Chat log + `leaguestate` +
   `setBy:"room:<auth>"` provide the audit trail.

4. **Mid-game mod swap.** Applying a league can `loadMod`; mid-round that
   disrupts the game. Mitigated by defaulting in-room switches to `nextGame`
   while a game runs, and by the panel offering both. An admin who forces `now`
   mid-duel gets what they asked for.

5. **Phase 1 trusts an unvalidated catalog.** The Go validator lands in phase 2,
   and the RTDB is world-open until the `room-admin-panel.md` phase-6 rules
   lock-down. Mitigated by the room's defensive bounds (§6 last paragraph);
   phase 1 runs on a single test room.

6. **Two mod-application paths.** The `mod` node listener and the league both
   want to load a mod. Mitigated structurally: the node listener routes through
   `leagueEffectiveMod` so the league wins while it's active, and every load goes
   through `applyPanelMod`'s `lastAppliedModKey` dedup. If a future feature adds a
   third mod writer, it must route through the same function.

7. **`league` in `@@GAME@@` is invisible to the API until wlhl changes.**
   `Query` unmarshals `raw` into a struct without the field (`gamestore.go:211`),
   so the value is durably stored but not returned. Phase 5 fixes it; until then
   the field is write-only history.

8. **One ladder across leagues mixes ratings from different rulesets.** A player
   grinding a low-skill league inflates the same ELO as the pro league.
   Deliberate for v1 (§7.4) and recoverable — every game row carries its league,
   so a per-league ladder is a backfill, not a migration.

9. **Whole-node catalog PUTs race.** Two admins editing different leagues in the
   same catalog: last writer wins and the other's edit is one undo away — same
   trade-off `pluginconf` accepted (`roomadmin.go:1481-1483`). The presence chips
   and live-sync banner make the collision visible within 5s.

10. **Pool overlay vs the `pool` child listeners** (phase 4). `loadnewMap` /
    `removeMap` write `mypool` directly (`firebase.js:150,161`); the overlay
    inserts a `basePool` indirection between them and the rotation. Getting this
    wrong shows up as the rotation silently reverting to the room pool, or a
    manual play order being lost. This is why pool is phase 4, not phase 1.

## Open questions

1. **Weapon bans in a league are mod-coupled.** `weapons` is index-based
   (`banById`, resolved against the `weaponlist` snapshot the room writes after a
   mod load) and indices are meaningful only for one mod — the known limitation in
   `room-admin-panel.md` risk 4. A league that carries both a `mod` and a
   `weapons` facet is self-consistent; one that carries `weapons` while
   inheriting the base mod is a footgun. Proposal for phase 4: allow the
   `weapons` facet **only** on a league that also defines a `mod` (its own or its
   parent's), and record the mod key the ban list was authored against so the
   room can warn when they disagree. Needs the owner's call before building.

2. **Should activating a league force an immediate map rotation?** A league with
   a pool applies its list, but the current map keeps playing until the round
   ends. Forcing a rotation is one `poolctl`-style call away but interrupts play.
   Default proposed: no; revisit after phase 4 use.

3. **Should `!league <id>` be admin or super-admin?** Specced as admin (a room
   moderator changes the ruleset). If leagues become ranked/competitive, super
   may be the right tier.

4. **Naming.** "League" is the user's word and reads well for an arena ladder,
   but the mechanism is generic (any room can use it for "night mode" vs "chaos
   mode"). Keeping "league" — renaming later means renaming two RTDB nodes and a
   command, so flag now if "profile"/"ruleset" is preferred.

## Alternatives considered

- **ext-proxy resolves the league and writes concrete `settings`/`mod`/`pool`
  node values (materialization).** Tempting because it needs zero new room-side
  apply logic and gets history for free. Rejected: it overwrites the room's base
  config on every switch (so "what were the settings before promode?" is only
  answerable from `_history`), it makes the Map-pool tab ambiguous (editing it
  edits a value the next league switch will overwrite), deactivation is lossy,
  and it strands the in-room `!league` command — ext-proxy holds no RTDB
  listeners and no polling loop, so a room-written request node would never be
  picked up. Routing the command back through an ext-proxy HTTP call would add a
  second trust path from the room, which `room-admin-panel.md` explicitly deferred
  for grant minting.
- **Leagues as arena-plugin `pluginconf`.** The catalog would ride the existing
  plugin manifest/settings plumbing with no new node. Rejected: `pluginconf` is a
  flat scalar-keyed blob validated generically (`validatePluginConf`,
  `roomadmin.go:1400`) — it cannot express a nested catalog, cannot reuse
  `validateSettings`/`validatePool` per facet, and gives one coarse history entry
  ("plugin config: arena") for any change. It would also chain leagues to the
  arena plugin, when leagues are useful in a plain room.
- **Leagues as Firestore presets only.** Presets already store
  `{settings,pool,poolbounds}` bundles and apply them cross-room
  (`presets.go:27`). Rejected as the primary home: presets are *applied once*
  (they materialize into nodes — same objection as above), they have no active-
  pointer concept, no `extends`, and they live in the control-plane DB where the
  room script cannot see them. Presets remain the right vehicle for *copying* a
  catalog between rooms (phase 6).
- **Multi-level `extends`.** Rejected for the validator cost and the legibility
  cost; see §2.
