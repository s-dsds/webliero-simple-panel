# webliero-simple-panel — Plugin Architecture (+ arena & newjohn as plugins)

Status: draft (2026-07-19). Implements: "add the arena script (updated with new,
more-scalable stats) and newjohn (manipulation room) to the admin panel; those
should be *plugins* of webliero-simple-panel; get inspired by ffa-room / the
command registry; arena has a lot of safeguards to limit the queue breaking — be
careful."

## Goal & non-goals

**Goal.** A formal, additive plugin system so a room bundle can opt into extra
behavior (arena ladder, newjohn manipulation, future ffa, etc.) without forking
the whole room, and so each plugin can surface a config/UI tab in the ext-proxy
admin panel.

**Non-goals.** (1) Rewriting the existing fork feature files — they keep working
as-is; plugins are guests added *around* them. (2) A package manager / versioned
manifest / bundler — plugins stay plain JS files dropped into the room dir,
matching how `webliero-command-registry-plugin` and `webliero-kill-message-plugin`
already work. (3) Auto-deploying the arena *queue* port to a live room unattended
— the queue's safeguards make it review-gated (see §6).

## What already exists (don't reinvent)

- **Load model.** A room is a directory of plain browser JS, loaded
  **alphabetically** into one global scope; engine = `window.WLROOM`. `_`-prefix
  loads first (`_conf.js`→`CONFIG`, `_init.js`→`WLROOM`), `zz_`-prefix last
  (boot). Everything shares bare `window` globals.
- **The de-facto plugin shape** (both example plugins are identical): a single
  `var XXX_PLUGIN = (function(){ … })()` IIFE with `init(room, conf)` +
  `loadSettings(conf)`, a `window.__SENTINEL` idempotency guard, private state in
  the closure, and hooks attached via **`chainFunction(obj, attr, fn)`** (wraps an
  existing handler so many files share one engine callback; a handler returning
  `false` **vetoes/consumes** the event).
- **The command registry** (`command_registry.js`) is itself a plugin and the
  natural extension point: `COMMAND_REGISTRY.add(name|aliases, help[], fn, level)`
  with 3 tiers `COMMAND.{SUPER_ADMIN_ONLY:2, ADMIN_ONLY:1, FOR_ALL:0}`; dispatch
  chains onto `onPlayerChat`. `isSuperAdmin` currently lives in `firebase.js`.
- **Panel bridge.** The room publishes capabilities to RTDB
  `simple/<room_id>/meta` (`panel.js:writePanelMeta` — `contractVersion`,
  `weapons`, `stats`, `roomlink`). The ext-proxy panel reads `meta` to decide
  which tabs to show. **This is the hook for surfacing plugins in the panel.**

## Design

### 0. Load-order facts (the loader model the framework MUST obey)

Files load alphabetically as separate `<script>`s sharing one global lexical
scope. ASCII order that matters: `_c` < `_h` < `_i` < `_p` (so `_conf` < a
would-be `_host` < `_init` < `_pluginhost`); all `_`-prefixed load before any
lowercase file (`a`rena…, `command_*`, `n`ewjohn…); `z_` < `zz_1` < `zz_z`. Two
consequences that a spec-review caught and this design now bakes in:

- **The host must load AFTER `_init.js`**, because `_init.js` is where
  `const chainFunction` (line 23, loose `false==r||false==or` veto — the exact
  semantics we want), `let auth` (line 1), and `window.WLROOM = room` (line 56,
  inside an async IIFE — set *later still*) live. A file named `_host.js` sorts
  *before* `_init.js` and would capture none of these. ⇒ name it
  **`_pluginhost.js`** (`_p` > `_i`).
- **Do NOT declare a second `chainFunction`.** `_init.js`'s is already global and
  already used by `panel.js`/`moderation.js`/`z_stats.js`/`z_trace.js`/
  `zz_1v1.js`/`d_anti-afk.js`. A new top-level `const chainFunction` in
  `_pluginhost.js` is a redeclaration → load failure. Reuse the existing one.
- **`WLROOM`, `auth`, `COMMAND`, `JSZip` are eager-capture traps.** `WLROOM` is
  assigned later (async), `auth` must be *the* `_init.js` Map (not a fresh empty
  one, or safeguard #1 dies), `COMMAND` lives in `command_registry.js` which
  loads *after* any `_` file, and `JSZip` may not be present yet. All must be
  **lazy getters**, resolved at plugin-init time, never captured in the literal.

### 1. The host-services object (`_pluginhost.js`)

Today a feature file reaches into cross-file globals (`announce`, `isSuperAdmin`
from `firebase.js`, `auth`/`chainFunction` from `_init.js`, `getActivePlayers`
from `states.js`, `fdb` from `firebase.js`). A plugin must not depend on load
order or on those names existing at its own file-load time. `_pluginhost.js`
(loads after `_init.js`, before every lowercase plugin/feature file) defines one
host object — **all late bindings are getters or call-time arrow closures**, so
nothing is read until a plugin actually uses it at runtime:

    window.WL_HOST = {
      baseRoomName:      "simple",
      get room()         { return window.WLROOM; },          // assigned async in _init.js
      get config()       { return CONFIG; },
      get roomId()       { return CONFIG.room_id; },
      get registry()     { return COMMAND_REGISTRY; },        // command_registry.js (loads after)
      get fdb()          { return (typeof fdb!=='undefined') ? fdb : null; },
      get auth()         { return auth; },                    // THE _init.js Map (getter, not copy)
      get chainFunction(){ return chainFunction; },           // reuse _init.js's, do not redeclare
      get COMMAND()      { return (typeof COMMAND!=='undefined') ? COMMAND : null; },
      get JSZip()        { return (typeof JSZip!=='undefined') ? JSZip : null; },
      announce:          (...a) => announce(...a),            // resolved at call time
      notifyAdmins:      (...a) => notifyAdmins(...a),
      getActivePlayers:  () => getActivePlayers(),
      isSuperAdmin:      (p) => isSuperAdmin(p),
    };

Existing files are untouched; the host merely *wraps* what they already export.

### 2. `chainFunction` — reuse the one `_init.js` already exports

`_init.js:23` already defines a global `const chainFunction` with the semantics
we want: it runs the existing handler first, then the new one, and propagates a
veto with **loose** equality — `if (false==r || false==or) return false` — so a
handler returning `false`/`0`/`""` consumes the event. Plugins reach it via
`host.chainFunction` (the getter in §1). **Do not ship a second copy** — a new
top-level `const chainFunction` collides with `_init.js`'s (redeclaration =
load failure). Keep the loose `false==` test to match every deployed caller
(`_init.js:29`, `command_registry.js:27`, `kill-message-plugin/index.js:11`);
switching to strict `=== false` would silently change veto behavior for `0`/`""`.
(The registry and the standalone example plugins keep their own internal copies;
consolidating those is out of scope.)

### 3. The plugin contract

A plugin is a global IIFE exposing at minimum:

    var ARENA_PLUGIN = (function () {
      let host = null, settings = { /* defaults */ };
      const manifest = {
        id: "arena",
        name: "Arena (1v1 ladder)",
        // panel surface — see §5. Fields the panel renders + persists to RTDB.
        settings: [
          { key:"max_games_in_a_row", label:"Max win streak", type:"number", min:0, default:3 },
          { key:"enabled", label:"Ladder enabled", type:"bool", default:true },
          ...
        ],   // default 3 matches arena _conf.js:11 / _init.js:2
        // optional read-only status the panel can show (published to meta)
      };
      function init(h, conf) {
        if (window.__ARENA_PLUGIN) return;   // idempotency sentinel
        window.__ARENA_PLUGIN = true;
        host = h; Object.assign(settings, conf||{});
        // hook engine events via host.chainFunction(host.room, 'onGameEnd2', …)
        // register commands via host.registry.add(..., host.COMMAND.ADMIN_ONLY)
        // publish manifest to the panel (see §5)
      }
      function loadSettings(conf){ Object.assign(settings, conf||{}); /* re-apply */ }
      return { manifest, init, loadSettings };
    })();
    if (window.WL_PLUGINS) window.WL_PLUGINS.register(ARENA_PLUGIN);

Rules: idempotency sentinel; defaults + `loadSettings` merge; private state in
closure; **hooks via `host.chainFunction` (never raw assignment)**; commands via
`host.registry.add` **inside `init`** (not at file top-level) so load order stops
mattering; all cross-file needs come from `host`, not bare globals.

### 4. The loader + boot

The registration array must exist **before** the plugin files load, and plugin
files (`arena_plugin.js` = `a`, `newjohn_plugin.js` = `n`) are lowercase, so they
sort *after* every `_`-prefixed file. Therefore define `window.WL_PLUGINS` in the
same early `_pluginhost.js` (not a separate `plugin_loader.js`, which as a
lowercase `p` would load *after* the plugin files and their `register()` calls
would silently no-op):

    // in _pluginhost.js, right after WL_HOST:
    window.WL_PLUGINS = {
      _all: [],
      register(p){ this._all.push(p); },
      initAll(){
        const conf = (CONFIG.plugins)||{};
        for (const p of this._all) {
          const id = p.manifest.id;
          if (conf[id] && conf[id].enabled === false) continue;  // opt-out per room
          try {
            p.init(window.WL_HOST, conf[id]||{});
            publishPluginManifest(p.manifest, (conf[id]||{}));    // defined below, §5
          } catch(e){ console.log("plugin "+id+" init failed:", e && e.message || e); }
        }
      }
    };
    // publishPluginManifest writes simple/<room_id>/plugins/<id> and subscribes
    // simple/<room_id>/pluginconf/<id> → plugin.loadSettings. Lives here so the
    // panel contract has exactly one writer/reader (§5).

`CONFIG.plugins = { arena:{enabled:true, max_games_in_a_row:3}, newjohn:{enabled:false} }`
selects + configures plugins per room. A plugin file present but disabled in
CONFIG registers but is skipped at init — zero effect.

**Boot file `zz_zplugins.js`** (sorts last: `zz_z` > `zz_1`, after `zz_1v1.js`'s
`initFirebase()`). There is no fdb-ready callback — `initFirebase` assigns `fdb`
inside an async IIFE, and `panel.js`/`mappool.js` already cope by polling. Mirror
that:

    (function boot(){
      if (typeof fdb === 'undefined' || !fdb || !window.WLROOM) { setTimeout(boot, 200); return; }
      window.WL_PLUGINS.initAll();
    })();

Boot order end-to-end: `_conf → _init (chainFunction, auth, async WLROOM) →
_pluginhost (WL_HOST + WL_PLUGINS defined, all lazy) → command_* (COMMAND) →
arena_plugin/newjohn_plugin (register) → …existing fork files… → zz_1v1
(initFirebase) → zz_zplugins (poll until fdb+WLROOM, then initAll)`.

### 5. Surfacing plugins in the admin panel

Each active plugin publishes its manifest to RTDB
`simple/<room_id>/plugins/<id>`:

    plugins/<id> = { name, settings:[<field descriptors>], status?:{…}, updatedAt }

and reads its live config from `simple/<room_id>/pluginconf/<id>` (panel writes,
plugin `.on('value')` → `loadSettings`). This mirrors the existing
`mod`/`weapons` panel↔room contract exactly. The **single writer/reader of this
contract is `publishPluginManifest(manifest, conf)` in `_pluginhost.js`** (§4): it
`set`s `plugins/<id>` and attaches the `pluginconf/<id>` `.on('value')` →
`plugin.loadSettings` listener. No other file touches these nodes.

Panel side (ext-proxy `embed/roomadmin.html`): a **new, generic** Plugins section
reads `plugins/*`, and for each plugin renders a tab from its `settings[]` field
descriptors (number/bool/enum/string/text) — a small schema-driven form — plus
any read-only `status`. Saving writes `pluginconf/<id>`. No per-plugin panel
code: the manifest *is* the UI. This ext-proxy change (read a new RTDB node +
generic form renderer + PUT `pluginconf`) is **not yet built** — it's additive
new work on the panel, called out here as the concrete meaning of "add
arena/newjohn to the admin panel". It reads/writes RTDB nodes exactly like the
existing settings/pool/mod endpoints, so it slots into `handlePadminAPI` with a
`pluginconf`/`plugins` case and rides the same auth.

This is what "add arena/newjohn to the admin panel" concretely means: they become
plugins whose manifests drive auto-generated panel tabs, and whose runtime config
flows back over `pluginconf`.

### 6. Arena as a plugin — port plan

Source: `/home/qmdev/liero/arena` (see the arena design brief). The ladder is
**fragile and auth-keyed**; port with care.

**6a. What moves into `arena_plugin.js` (self-contained):**
- Queue core: `PlayerQueue`, `OutQueue`, the seat-fill logic (`game_queue.js` +
  `game_outqueue.js`).
- The hooks — **chained, not assigned** (arena today *assigns*
  `onGameEnd/onGameEnd2/onGameStart/onPlayerKilled/onPlayerTeamChange`,
  `command_log.js` assigns `onPlayerJoin`; as a guest the plugin must chain so the
  base fork's handlers still run): `host.chainFunction(room,'onGameStart'|…)`.
- Commands `!q !j !p` via `host.registry.add(...)`.

**Rotation ownership — the double-`next()` trap (must resolve before coding).**
The base fork already advances the map on round end (`onGameEnd2 → next()`, active
under `CONFIG.pool_from_database`), and arena's own `onGameEnd2` *also* calls
`next()` (`arena/commands.js:119`). Naively chaining arena's handler ⇒ **two
`next()` calls ⇒ the pool skips a map every round.** Resolution: **arena does the
queue swap in the `onGameEnd` chain (which fires before `onGameEnd2`) and does NOT
call `next()` itself** — it lets the fork's existing `onGameEnd2 → next()` do the
single map advance, by which point teams are already set. So arena_plugin owns
*seat assignment*, the fork owns *map rotation*; neither calls `next()` twice.
(arena_plugin therefore does **not** port arena's `mappool.js` — the fork's pool
system stays in charge.) This must be stated in code and asserted in the test
room: exactly one map advance per round with the plugin active.

**6b. Safeguards that MUST be preserved verbatim** (regressions here break the
ladder — the owner's explicit warning):
1. **auth-keyed queue** — every op resolves `host.auth.get(id)` first; never key
   on `player.id`.
2. **duplicate-auth kick** on join (two sessions on one auth corrupts the queue).
3. `cleanQueue()` prunes disconnected players before every dequeue/peek/place.
4. **2-player gate** in `computeScores`/`flushScoreLogs` — a non-duel yields no
   ejection and persists no game.
5. **streak cap** (`#hasPlayedTooMuch`, `max_games_in_a_row`) forces a hot streak
   to rotate.
6. score-log gating `startScoreLogs` only when `isFull()`.
7. **teamsLocked auto-management** (`setLock(isFull())` on team-change/leave/
   settings-reload) — stops a spectator self-joining a full duel.
8. re-queue-loser-before-shift ordering (rematch vs back-of-line semantics).
9. self-heal backfill in `onGameEnd2` when a seat vanished mid-swap.

**6c. Latent bugs to FIX during the port (do not carry forward):**
- `detectBadRunaway` (method header `game_stats.js:46`) calls **bare**
  `wasLosing(player)` at `game_stats.js:47` instead of `this.wasLosing(player)` —
  the method exists (`game_stats.js:42`) but the bare name is undefined at global
  scope → `ReferenceError`. It's reachable: called from `arena/commands.js:71` on
  player-leave once a game is >30s in. Drop or repair (add `this.`).
- `kill.killer = resolvePlayerInfo(killed)` (`game_stats.js:18`) — should resolve
  `killer`. Fix so persisted kill attribution is correct.

**6d. Stats: replace the in-memory replay with the scalable model.**
Arena today persists **raw per-game snapshots** at `<room_id>/gamestats/{ms}` and
**replays the entire node in RAM on boot** (`_stats.js:189` reads all of
`gamestats`; `listenForStatsEvents` streams full history) — unbounded RAM +
bulk-read-timeout: exactly the "arena RTDB has a lot of data, might time out"
hazard. **Do not port this.**

**Ownership: `z_stats.js` owns stats, not the arena plugin.** `z_stats.js`
already self-chains `onGameStart`/`onGameEnd`/`onPlayerKilled` and computes
elo/daily/form/live on its own (`z_stats.js:80-81,342,374`). The arena plugin
must **not** also drive stats, or every game double-counts. So the "make arena
stats scalable + add new stats" work = **extend `z_stats.js`** (which any room
already runs) with the new bounded 1v1 stats below; the arena plugin only
provides the ladder and leaves `z_stats` to observe the same engine events it
already hooks. Reuse the fork's `z_stats.js` model:
- `ServerValue.increment` bounded aggregates under `simple/<room_id>/stats/*`
  (`players/<auth>`, `weapons/<fp>`, `daily/<ymd>`, `levels/<key>`, `live`).
- N-player ELO + `form` already in `z_stats.js:statsComputeElo` (generalizes
  arena's 2-player elo.js).
- **New stats to add** (the "include new stats" ask), all increment-safe and
  1v1-meaningful: current & best win-streak, head-to-head (`stats/h2h/<a>__<b>`),
  fastest-win time, per-map win-rate, comeback count (won after trailing),
  average duel duration. Keep them bounded (per-auth / per-pair / per-map counts,
  never per-game rows).
- **Weapon/damage caveat:** `stats/weapons/<fp>` only populates on the *hacked*
  headless build (guarded on `getWeapons()`/`onPlayerHit`, `z_stats.js:20`). Any
  per-weapon 1v1 stat inherits that limitation — on a vanilla build it stays
  empty. Call this out in the manifest/status so the panel doesn't imply data
  that won't come.
- **Never bulk-read** `gamestats`/`logins`. If legacy history matters, migrate
  once offline into the aggregates; the live plugin only ever does the
  `z_stats.js` pattern (read `stats/players` once for `!stats`, increment on
  events).

So the "arena stats plugin" = the fork's `z_stats.js` aggregation engine + the
1v1-specific new stats, driven by the arena plugin's game events. Arena-specific
cruft dropped: `mergedAuth` alt-merge, chat-printed leaderboards, the strict
duel-duration validators (kept only as optional guards).

### 7. newjohn as a plugin — port plan

Source: `/home/qmdev/liero/newjohn`. Lower risk than arena (no queue).
`newjohn_plugin.js` carries: the 16 map-geometry `effects` transforms
(`effects.js`), the `!fx`/`!autofx`/`!autoexp` commands, in-browser mod-ZIP build
(`mod.js` via `host.JSZip`) + `base_sprites` (bundle `mod_sprite.js`'s base64
blob as a plugin asset), and the RTDB-driven live mod push. Port work:
- namespace all bare globals under the closure (`next`, `mods`, `currMod`,
  `effectList`, `autoFx`, …);
- **chain** `onGameEnd2` (auto-advance) instead of assigning — must not fight the
  base fork's rotation; expose `enabled` so a normal room keeps the fork's
  mappool rotation and newjohn only advances when its own mode is on;
- commands via `host.registry.add`;
- config (`base_sprites`, map base URL, JSZip) injected, not ambient.

newjohn's effects are a clean first plugin to validate the framework (pure map
transforms + one command, no queue, no stats coupling).

## Phasing / rollout

1. **Framework** (`_host.js`, `plugin_loader.js`, shared `chainFunction`, the
   `plugins`/`pluginconf` RTDB contract + generic panel renderer) + **newjohn
   effects** as the proof plugin. Additive; a room without `CONFIG.plugins` is
   unchanged. Safe to build and land on a branch.
2. **Arena stats plugin** (the scalable aggregation + new 1v1 stats) — additive,
   read-safe, no queue coupling. Can run on any room to gather stats.
3. **Arena queue plugin** — the fragile part. Implement on a branch, exercise
   against a *test* room with a bot before any live use. **Review-gated; not
   unattended prod.** Ship only after the owner validates the ladder end-to-end.

Branch: `feat/plugins`. Nothing here changes a currently-running room until the
owner opts a room in via `CONFIG.plugins` and redeploys it.
