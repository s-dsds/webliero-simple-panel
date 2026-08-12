/** room-stats contract v1 (Phase 1: stock stats). Single writer.
 *  Filename `z_` so it loads AFTER command_log.js (which assigns onPlayerChat
 *  raw, not via chainFunction) — see room-stats.md. Keyed on auth.get(id),
 *  snapshotted at game start so a mid-game leaver is still credited. */

var STATS_ELO_K = (typeof CONFIG !== 'undefined' && CONFIG.stats_elo_k) || 32;
var STATS_COLD_ELO = 1500;
var STATS_FORM_CAP = 20;

// Leaver & AFK stats policy (_specs/leaver-afk-stats-policy.md). Independent
// of !afk <n> (d_anti-afkinit.js) on purpose (§2) — only stats_afk_min_ms is
// CONFIG-tunable, per spec.
var STATS_AFK_MIN_MS = (typeof CONFIG !== 'undefined' && CONFIG.stats_afk_min_ms) || 20000;
var STATS_EXIT_MATERIAL_MS = 45000;
var STATS_EXIT_MATERIAL_SCORE = 2;
var STATS_REENTRY_QUIET_MS = 5000;
var STATS_KNOWN_MODES = { dm: 1, tdm: 1, htf: 1, dtf: 1, ctf: 1, ctf2: 1, haz: 1, pred: 1, lms: 1 };

var statsRootRef;
var statsSV;            // firebase.database.ServerValue
var statsHasIncrement;  // confirmed at init (Risk 3 smoke)
var statsGameInProgress = false;
var statsParticipants = new Map();   // id -> {auth,name,scoreStart,killsStart,deathsStart,elo,form,midSession}
var statsPending = new Map();         // auth -> {joins,chat,name} accrued between flushes
var statsTeamSince = new Map();        // id -> epoch ms (playtime timer)
var statsSeenToday = new Set();        // auths credited to daily uniques today
var statsTodayKey = null;

// Leaver/AFK policy state (§2, §4). statsAct/statsSeen are per-round (reset in
// statsOnGameStart); statsExits is module-level so a mid-round reset (§4)
// can't destroy a pending exit record.
var statsAct = new Map();          // id -> {firstMs, lastMs, n}  (input | damage dealt | kill scored)
var statsSeen = new Map();         // id -> lastMs                (the above, plus chat)
var statsAfkSignalOk = true;       // capability probe result — fails OPEN (false = AFK logic off)
// Capability probe input ONLY — statsAct is also fed by statsOnHit/statsOnKilled
// (damage dealt / kills scored also count as activity, §2), so a single kill
// would mask a truly-dead onPlayerActivity wiring. This counts real
// onPlayerActivity events only. Reset per round.
var statsRealActivityEvents = 0;
var statsExits = new Map();        // auth -> {kind, atMs, standing, material, afk, full, roundSeq, awayAt, eliminated}
var statsRoundSeq = 0;
var statsDiscardedRounds = 0;      // rounds discarded by a reset since the last flush
var statsUnknownModeLogged = false; // one "unknown gameMode" log per round

// Phase 2 (weapons/damage) — only active when the hacked headless build
// exposes getWeapons()/onPlayerHit. Per-game in-memory accumulators, flushed
// with everything else at game end.
var statsWeaponsEnabled = false;
var statsDmgDealt = new Map();     // auth -> damage dealt this game
var statsDmgTaken = new Map();     // auth -> damage taken this game
var statsWpnByAuth = new Map();    // auth -> Map(fp -> {kills, damage})
var statsWpnGlobal = new Map();    // fp -> {kills, damage, name}
var statsWpnSeen = new Set();      // fps used this game (for weapons/<fp>/games)
var statsLastHit = new Map();      // victim auth -> {fp, attacker auth} (kill attribution)

// Kill feed + suicides (work on any build — onPlayerKilled is stock).
var statsKillFeed = [];            // rolling recent kill events for the live board
var STATS_FEED_CAP = 25;
var statsSuicides = new Map();     // auth -> suicides this game
// Timing metrics (need onPlayerSpawn — exact spawn times from the hacked build).
var statsSpawnTime = new Map();    // player id -> ts of their current life's spawn
var statsLastKill = new Map();     // killer id -> ts of their last kill this life
var statsLifeSum = new Map();      // auth -> summed lifespan ms (spawn->death)
var statsLifeCount = new Map();    // auth -> deaths counted for time-to-death
var statsKillGapSum = new Map();   // auth -> summed kill->kill ms
var statsKillGapCount = new Map(); // auth -> kill->kill intervals counted
var statsSpawnKillSum = new Map(); // auth -> summed spawn->first-kill ms
var statsSpawnKillCount = new Map();
function statsMapAdd(m, k, v) { if (k) m.set(k, (m.get(k) || 0) + v); }

function statsDayKey(ts) { return new Date(ts).toISOString().slice(0, 10).replace(/-/g, ''); }
function statsInc(n) { return statsHasIncrement ? statsSV.increment(n) : n; } // fallback handled at flush
function statsPend(auth, name) {
    if (!auth) return null;
    var p = statsPending.get(auth);
    if (!p) { p = { joins: 0, chat: 0, rejoins: 0, name: name || "" }; statsPending.set(auth, p); }
    if (name) p.name = name;
    return p;
}

// Declared (and assigned) ABOVE initStats: on a hot-reload of z_stats.js alone,
// fdb is already set from the prior load, so initStats runs fully synchronously
// on this pass — if STATS_LIVE_MS were still declared further down the file it
// would be `undefined` at the setInterval call (→ 0ms busy interval). statsLiveTimer
// lets us clear a previous interval so hot reloads don't stack duplicates.
var STATS_LIVE_MS = 4000;
var statsLiveTimer = (typeof statsLiveTimer !== 'undefined') ? statsLiveTimer : null;

function initStats() {
    if (typeof fdb == 'undefined' || !fdb) { setTimeout(initStats, 200); return; }
    statsRootRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/stats`);

    statsSV = firebase.database.ServerValue;
    statsHasIncrement = !!(statsSV && typeof statsSV.increment === 'function');
    console.log("stats: ServerValue.increment available =", statsHasIncrement);

    statsRootRef.child('meta/playtimeSince').once('value').then(function (s) {
        if (!s.exists()) statsRootRef.child('meta/playtimeSince').set(Date.now());
    });

    // Chain ONCE per room lifetime: a hot-reload of z_stats.js alone re-runs
    // initStats, and re-chaining would stack a second copy of every handler —
    // every game after that double-counts kills/games/wins/ELO/duel stats.
    // (Tradeoff: after a hot reload the chained entry points keep their old
    // function bodies — free variables resolve to the reloaded globals, so
    // state stays consistent, but changed handler LOGIC needs a room restart.)
    if (!window.__Z_STATS_CHAINED) {
        window.__Z_STATS_CHAINED = true;
        chainFunction(window.WLROOM, 'onPlayerJoin', statsOnJoin);
        chainFunction(window.WLROOM, 'onPlayerChat', statsOnChat);
        chainFunction(window.WLROOM, 'onPlayerLeave', statsOnLeave);
        // onPlayerKicked is stock but only fires when the kick carried a reason
        // string (risk 9) — retracts a 'leave' exit to 'kick' (§4).
        chainFunction(window.WLROOM, 'onPlayerKicked', statsOnKicked);
        chainFunction(window.WLROOM, 'onPlayerTeamChange', statsOnTeamChange);
        chainFunction(window.WLROOM, 'onGameStart', statsOnGameStart);
        chainFunction(window.WLROOM, 'onGameEnd', statsOnGameEnd);
        // onPlayerKilled is stock — kill feed, suicides and kill-timing work on
        // any build. onPlayerSpawn is our injected callback (exact spawn times);
        // on a build without it the timing maps just stay empty.
        chainFunction(window.WLROOM, 'onPlayerKilled', statsOnKilled);
        chainFunction(window.WLROOM, 'onPlayerSpawn', statsOnSpawn);
        // onPlayerActivity is stock (§2) — the activity signal AFK/taint reads.
        chainFunction(window.WLROOM, 'onPlayerActivity', statsOnActivity);

        // Phase 2: weapon effectiveness + damage, only on the weapon-enabled
        // (hacked) build. onPlayerHit is our injected callback.
        statsWeaponsEnabled = typeof window.WLROOM.getWeapons === 'function';
        if (statsWeaponsEnabled) {
            chainFunction(window.WLROOM, 'onPlayerHit', statsOnHit);
            console.log('stats: weapon/damage tracking enabled');
        }
    } else {
        // reload path: refresh the capability flag without re-chaining. The
        // spec already mandates a room RESTART (not a hot reload) for this
        // file (z_stats.js:76-81-ish — chained handlers keep their OLD
        // bodies); silently continuing on a hot reload used to hide that the
        // leaver/AFK handlers (onPlayerActivity, onPlayerKicked, the exit
        // tracking chained onto onPlayerLeave/onPlayerTeamChange) are frozen
        // at whatever logic was loaded FIRST — so AFK/exit data from here on
        // is measured against stale code, not this file's current behavior.
        console.log('stats: *** HOT RELOAD DETECTED — onPlayerActivity/onPlayerKicked/exit-tracking handlers are NOT re-chained; leaver/AFK data for the rest of this room lifetime may be measured against STALE logic. Restart the room to pick up leaver-afk-stats-policy changes. ***');
        statsWeaponsEnabled = typeof window.WLROOM.getWeapons === 'function';
    }

    // Live scoreboard: aggregates only flush at game end, so during a game the
    // panel would look frozen. Write a small `live` node (current players +
    // their in-game scores) every few seconds so viewers see the game as it
    // happens. One whole-node overwrite per tick, only while a game runs.
    if (statsLiveTimer) clearInterval(statsLiveTimer); // hot reload: don't stack intervals
    statsLiveTimer = setInterval(statsWriteLive, STATS_LIVE_MS);

    console.log('stats ok');
}
initStats();

var statsLiveWasRunning = false;
function statsWriteLive() {
    try {
        if (!statsRootRef) return;
        // "in progress" = there are non-spectator players right now. Derived
        // from the live player list (not statsGameInProgress) so it survives a
        // mid-game script reload and reflects reality directly.
        var players = [];
        for (var p of window.WLROOM.getPlayerList()) {
            if (!p.team || p.team == 0) continue; // spectators excluded
            var sc = window.WLROOM.getPlayerScore(p.id) || {};
            players.push({
                name: p.name, auth: auth.get(p.id) || null, team: p.team,
                score: sc.score || 0, kills: sc.kills || 0, deaths: sc.deaths || 0
            });
        }
        if (!players.length) {
            if (statsLiveWasRunning) {
                statsLiveWasRunning = false;
                statsRootRef.child('live').set({ inProgress: false, ts: Date.now() });
            }
            return;
        }
        statsLiveWasRunning = true;
        players.sort(function (a, b) { return b.score - a.score; });
        statsRootRef.child('live').set({
            inProgress: true, ts: Date.now(),
            level: statsCurrentLevelName() || null,
            players: players,
            feed: statsKillFeed.slice(-STATS_FEED_CAP) // recent kills for the feed
        });
    } catch (e) {}
}

function statsOnJoin(player) {
    var a = player.auth || auth.get(player.id);
    if (a) statsPend(a, player.name).joins++;
    // re-entry retraction (§4): joining straight onto a team after an earlier
    // exit this round means they came back — no abandonment. Covers the
    // genuine-reconnect case (new player id); statsOnTeamChange covers the
    // same-id spectate/unspectate case.
    if (a && player.team && player.team != 0) statsRetractExit(a, Date.now());
    // mid-session joiner: a game is already running → still accrue their stats
    if (statsGameInProgress && player.team && player.team != 0) {
        statsAddParticipant(player, true);
    }
    if (player.team && player.team != 0) statsTeamSince.set(player.id, Date.now());
}

function statsOnChat(player) {
    var a = player.auth || auth.get(player.id);
    if (a) statsPend(a, player.name).chat++;
    // Chat is NOT input activity (§2 — deliberately excluded from the AFK/taint
    // predicate) but it DOES count for the exit-time "afk" flag's idleAnyMs.
    if (player && player.id != null) statsSeen.set(player.id, Date.now());
}

function statsOnTeamChange(player) {
    // team>0 = playing; team 0 = spectator. Accumulate playtime across transitions.
    var since = statsTeamSince.get(player.id);
    var a = player.auth || auth.get(player.id);
    if (player.team && player.team != 0) {
        if (since == null) statsTeamSince.set(player.id, Date.now());
        // §4/§9: this handler runs BEFORE zz_1v1's auth cleanup and the arena
        // plugin's own onPlayerTeamChange (chain order = registration order) —
        // a throw here must not abort the rest of the chain.
        try {
            if (a) statsRetractExit(a, Date.now()); // §4 re-entry retraction
            var pc = statsParticipants.get(player.id);
            if (statsGameInProgress && pc && pc.away) {
                // Same id, but the engine gave them a brand-new score entry (§9).
                statsRebaseOnReentry(pc);
            } else if (statsGameInProgress && !pc) {
                // spectator -> team while a game runs = mid-session participant
                statsAddParticipant(player, true);
            }
        } catch (e) { console.log('stats: onPlayerTeamChange (re-entry) failed: ' + ((e && e.message) || e)); }
    } else {
        if (since != null) { statsFlushPlaytime(player.id, since); statsTeamSince.delete(player.id); }
        if (statsGameInProgress) {
            var pc2 = statsParticipants.get(player.id);
            if (pc2) {
                pc2.away = true;
                // §4 step 1: snapshot NOW — the gamemode prunes this player's
                // score entry once their team reads 0 on the next tick.
                try {
                    var sc = window.WLROOM.getPlayerScore(player.id);
                    if (sc) pc2.scoreExit = { score: sc.score, kills: sc.kills, deaths: sc.deaths };
                    statsRecordExit(pc2, 'spec');
                } catch (e) { console.log('stats: onPlayerTeamChange (spec exit) failed: ' + ((e && e.message) || e)); }
            }
        }
    }
}

function statsOnLeave(player) {
    var since = statsTeamSince.get(player.id);
    if (since != null) { statsFlushPlaytime(player.id, since); statsTeamSince.delete(player.id); }
    // keep the participant entry (with its snapshotted auth) so game-end still
    // credits a mid-game leaver — and snapshot their score NOW: at game end
    // they're gone from getPlayerList, and falling back to the game-START
    // snapshot zeroed everything they earned this game (wrong ranks/ELO/h2h).
    var pc = statsParticipants.get(player.id);
    if (pc) {
        pc.left = true;
        // z_stats chains BEFORE zz_1v1 (auth cleanup) and the arena plugin
        // (queue backfill / restartGame) — a throw here must not abort them.
        try {
            var sc = window.WLROOM.getPlayerScore(player.id);
            if (sc) pc.scoreLeave = { score: sc.score, kills: sc.kills, deaths: sc.deaths };
            if (statsGameInProgress) statsRecordExit(pc, 'leave');
        } catch (e) { console.log('stats: onPlayerLeave (exit) failed: ' + ((e && e.message) || e)); }
    }
}

function statsOnKicked(player) {
    // Kick retraction (§4): onPlayerLeave already fired (recording a 'leave'
    // exit); when a reason string was supplied, onPlayerKicked follows right
    // after, so reclassify. auth.get(player.id) is already cleared by the
    // fork's own onPlayerLeave chain by the time this runs — resolve auth via
    // the participant entry (captured at add time) instead.
    try {
        if (!player) return;
        var pc = statsParticipants.get(player.id);
        if (!pc) return;
        // Stale-record guard (QA fix #6): a kick that lands after this round's
        // exit record was drained/overwritten must not reclassify a record
        // that belongs to an earlier round (or a different, later exit).
        var rec = statsExits.get(pc.auth);
        if (rec && rec.roundSeq === statsRoundSeq) rec.kind = 'kick';
    } catch (e) { console.log('stats: onPlayerKicked failed: ' + ((e && e.message) || e)); }
}

function statsFlushPlaytime(id, since) {
    var a = auth.get(id);
    if (!a) return;
    var secs = Math.round((Date.now() - since) / 1000);
    // Pre-existing flaw (not fixed here, out of scope): this bare .set() call
    // bypasses statsUpdateNoIncrement's fallback like the old rejoins write
    // did — on a build without ServerValue.increment it OVERWRITES the
    // lifetime playtime total instead of adding to it.
    if (secs > 0) statsRootRef.child(`players/${a}/playtime`).set(statsInc(secs));
}

function statsAddParticipant(player, midSession) {
    var a = auth.get(player.id) || player.auth;
    if (!a) return;
    var sc = window.WLROOM.getPlayerScore(player.id) || { score: 0, kills: 0, deaths: 0 };
    statsParticipants.set(player.id, {
        id: player.id, auth: a, name: player.name,
        // snapshot the score at the moment we start tracking them; deltas from here
        scoreStart: sc.score, killsStart: sc.kills, deathsStart: sc.deaths,
        elo: STATS_COLD_ELO, form: [], midSession: !!midSession,
        streak: 0, bestStreak: 0, fastestWinMs: 0,
        team: (player.team != null ? player.team : null), // captured NOW — a leaver is gone from getPlayerList at game end
        startedAt: Date.now(),  // AFK baseline (§2): never the round start alone
        seeded: false,          // §5 trap: no absolute writes (form/elo/streak/…) until the seed read lands
        left: false, away: false, scoreLeave: null, scoreExit: null,
        scoreCarry: 0, killsCarry: 0, deathsCarry: 0 // §9: pre-exit segments folded back in on re-entry
    });
    statsSeedParticipant(a, player.id);
}

// bounded read of the player's stored elo/form (only path the fork reads)
function statsSeedParticipant(a, id) {
    statsRootRef.child(`players/${a}`).once('value').then(function (snap) {
        var pc = statsParticipants.get(id);
        if (!pc) return;
        var v = snap.val();
        if (v) {
            pc.elo = (typeof v.elo == 'number') ? v.elo : STATS_COLD_ELO;
            pc.form = Array.isArray(v.form) ? v.form : [];
            pc.exists = true;
            // 1v1 extras (same read, no extra RTDB traffic): current streak,
            // best streak, fastest decisive win — absolutes rewritten at flush.
            pc.streak = (typeof v.streak == 'number') ? v.streak : 0;
            pc.bestStreak = (typeof v.bestStreak == 'number') ? v.bestStreak : 0;
            pc.fastestWinMs = (typeof v.fastestWinMs == 'number') ? v.fastestWinMs : 0;
        }
        pc.seeded = true; // landed (even if this player has no row yet) — absolutes are now safe to write
    });
}

var statsGameStartTs = 0; // for duel duration / fastest-win (1v1 extras)

// Per-mod weapon buckets: "BAZOOKA" in one mod is not the same weapon as in
// another, so weapon stats/medals are additionally bucketed by the mod the
// game STARTED with (captured once per game). panel.js sets
// window.panelCurrentMod SYNCHRONOUSLY at the top of applyPanelMod — its
// onGameStart handler runs earlier in this same chain, so a deferred
// (applyAt:nextGame) switch is already advertised when we capture here.
// Before any panel mod, the room runs its default.
var statsGameModKey = "default";
var statsGameModName = "default";
function statsCaptureMod() {
    var m = window.panelCurrentMod;
    var name = (m && m.name) ? String(m.name) : "default";
    statsGameModName = name.slice(0, 80);
    // key charset matches ext-proxy's rtdbKeyRe (readers pass it as ?mod=):
    // strictly [A-Za-z0-9_-], everything else folded to "_"
    statsGameModKey = name.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "_").slice(0, 80) || "default";
}

// League capture mirrors mod capture: once per game at start — a queued league
// switch applies at the next game start anyway (arena-leagues.md §7).
var statsGameLeague = null; // {id, name} | null
function statsCaptureLeague() {
    var l = window.leagueCurrent;
    statsGameLeague = (l && l.id) ? { id: String(l.id).slice(0, 40), name: String(l.name || l.id).slice(0, 80) } : null;
}

function statsOnGameStart() {
    // Round bookkeeping (§4): a reset (restartGame / level load) fires
    // onGameStart with no onGameEnd — the interrupted round's stats are
    // discarded (phase 2b supersedes this; phase 1 only measures it).
    // statsExits is module-level and survives this either way.
    var wasInProgress = statsGameInProgress;
    var prevParticipants = statsParticipants.size;
    statsRoundSeq++;
    if (wasInProgress) {
        console.log('stats: reset detected — round ' + statsRoundSeq + ' discarded (' + prevParticipants + ' participants)');
        statsDiscardedRounds++;
    }
    statsGameInProgress = true;
    statsGameStartTs = Date.now();
    statsCaptureMod();
    statsCaptureLeague();
    statsParticipants.clear();
    // reset per-game weapon/damage accumulators
    statsDmgDealt.clear(); statsDmgTaken.clear();
    statsWpnByAuth.clear(); statsWpnGlobal.clear();
    statsWpnSeen.clear(); statsLastHit.clear();
    // reset kill feed + suicide + timing accumulators
    statsKillFeed.length = 0;
    statsSuicides.clear();
    statsSpawnTime.clear(); statsLastKill.clear();
    statsLifeSum.clear(); statsLifeCount.clear();
    statsKillGapSum.clear(); statsKillGapCount.clear();
    statsSpawnKillSum.clear(); statsSpawnKillCount.clear();
    // reset the per-round activity signal (§2) — NOT statsExits (module-level,
    // must survive a reset).
    statsAct.clear(); statsSeen.clear();
    statsRealActivityEvents = 0;
    statsUnknownModeLogged = false;
    var now = Date.now();
    for (var p of window.WLROOM.getPlayerList()) {
        if (p.team && p.team != 0) {
            statsAddParticipant(p, false);
            if (!statsTeamSince.has(p.id)) statsTeamSince.set(p.id, now);
            // baseline spawn time: onPlayerSpawn fires on RESPAWN, so seed the
            // first life here (game start) or timing would miss it.
            statsSpawnTime.set(p.id, now);
        }
    }
}

// --- Phase 2: weapon + damage accumulation ---

// Stable per-weapon key from its name (mods reorder indices; the name is
// stable). Falls back to name#id when a name is empty/duplicated.
function statsWeaponFp(weaponID) {
    var name = "";
    try {
        var w = window.WLROOM.getWeapon ? window.WLROOM.getWeapon(weaponID) : (window.WLROOM.getWeapons() || [])[weaponID];
        if (w && w.name) name = String(w.name);
    } catch (e) {}
    var fp = name.trim().toUpperCase();
    if (!fp) fp = "WEAPON#" + weaponID;
    return { fp: statsSafeKey(fp), name: name || fp };
}

function statsAddWpn(map, key, kills, damage, name) {
    var e = map.get(key);
    if (!e) { e = { kills: 0, damage: 0, name: name }; map.set(key, e); }
    e.kills += kills; e.damage += damage; if (name) e.name = name;
    return e;
}

// injected onPlayerHit(attacker, victim, damage, weaponID) — player objects
// carry .id (wrapper), so resolve auth via the auth map.
function statsOnHit(attacker, victim, damage, weaponID) {
    if (!statsGameInProgress || !(damage > 0)) return;
    var aAuth = attacker && auth.get(attacker.id);
    var vAuth = victim && auth.get(victim.id);
    // §2: damage dealt counts as activity for the attacker (closes the
    // held-fire-key false positive). Weapon-enabled build only — matches the
    // "hacked build only" scoping in the spec.
    if (attacker) statsMarkActive(attacker.id);
    var wf = statsWeaponFp(weaponID);
    statsWpnSeen.add(wf.fp);
    if (vAuth) statsDmgTaken.set(vAuth, (statsDmgTaken.get(vAuth) || 0) + damage);
    if (aAuth) {
        statsDmgDealt.set(aAuth, (statsDmgDealt.get(aAuth) || 0) + damage);
        var byAuth = statsWpnByAuth.get(aAuth);
        if (!byAuth) { byAuth = new Map(); statsWpnByAuth.set(aAuth, byAuth); }
        statsAddWpn(byAuth, wf.fp, 0, damage, wf.name);
        statsAddWpn(statsWpnGlobal, wf.fp, 0, damage, wf.name);
    }
    // remember the victim's most-recent hit for kill attribution
    if (vAuth) statsLastHit.set(vAuth, { fp: wf.fp, name: wf.name, attacker: aAuth });
}

// onPlayerSpawn(player) — injected callback. Marks the start of a life: record
// the spawn time (time-to-death baseline) and reset the killer's per-life kill
// clock so spawn->first-kill is measured from here.
function statsOnSpawn(player) {
    if (!player) return;
    statsSpawnTime.set(player.id, Date.now());
    statsLastKill.delete(player.id);
}

// onPlayerKilled(killed, killer). No weapon on the event — weapon comes from the
// victim's last hit. Does four things: (1) weapon-kill attribution, (2) kill
// feed, (3) suicide count, (4) timing (victim lifespan; killer spawn->kill and
// kill->kill gaps).
function statsOnKilled(killed, killer) {
    if (!statsGameInProgress || !killed) return;
    var now = Date.now();
    var vAuth = auth.get(killed.id);
    var kAuth = killer && auth.get(killer.id);
    var suicide = !killer || (killed.id === killer.id);
    var last = statsLastHit.get(vAuth);
    var wname = last ? last.name : null;

    // §2: a kill scored counts as activity for the killer (not the victim).
    if (!suicide && killer) statsMarkActive(killer.id);

    // (1) weapon attribution — credit the killer (or last hitter) that weapon
    if (last) {
        var creditAuth = suicide ? vAuth : (kAuth || last.attacker);
        if (creditAuth) {
            var byAuth = statsWpnByAuth.get(creditAuth);
            if (!byAuth) { byAuth = new Map(); statsWpnByAuth.set(creditAuth, byAuth); }
            statsAddWpn(byAuth, last.fp, 1, 0, last.name);
            statsAddWpn(statsWpnGlobal, last.fp, 1, 0, last.name);
        }
        statsLastHit.delete(vAuth);
    }

    // (2) kill feed (rolling, for the live board)
    statsKillFeed.push({
        ts: now, weapon: wname || (suicide ? "suicide" : null), suicide: suicide,
        killer: suicide ? null : (killer ? killer.name : null),
        victim: killed.name
    });
    if (statsKillFeed.length > STATS_FEED_CAP) statsKillFeed.shift();

    // (3) suicides
    if (suicide) statsMapAdd(statsSuicides, vAuth, 1);

    // (4) timing — victim lifespan (spawn -> death)
    var vs = statsSpawnTime.get(killed.id);
    if (vAuth && vs) {
        statsMapAdd(statsLifeSum, vAuth, now - vs);
        statsMapAdd(statsLifeCount, vAuth, 1);
    }
    statsSpawnTime.delete(killed.id); // dead until next spawn event

    // killer timing — spawn->first-kill this life, then kill->kill
    if (!suicide && kAuth && killer) {
        var lastKill = statsLastKill.get(killer.id);
        if (lastKill) {
            statsMapAdd(statsKillGapSum, kAuth, now - lastKill);
            statsMapAdd(statsKillGapCount, kAuth, 1);
        } else {
            var ks = statsSpawnTime.get(killer.id);
            if (ks) {
                statsMapAdd(statsSpawnKillSum, kAuth, now - ks);
                statsMapAdd(statsSpawnKillCount, kAuth, 1);
            }
        }
        statsLastKill.set(killer.id, now);
    }
}

// ── §2: activity signal ─────────────────────────────────────────────────────

// onPlayerActivity(player) — stock, edge-triggered (fires on input CHANGE,
// not while a key is simply held). Capability probe (below, in statsOnGameEnd)
// is the live check that this is still wired on the current build.
function statsOnActivity(player) {
    if (!player) return;
    statsRealActivityEvents++;
    statsMarkActive(player.id);
}

function statsMarkActive(id, now) {
    if (id == null) return;
    now = now || Date.now();
    var e = statsAct.get(id);
    if (!e) { e = { firstMs: now, lastMs: now, n: 0 }; statsAct.set(id, e); }
    e.lastMs = now; e.n++;
    statsSeen.set(id, now);
}

function statsBaseline(pc) { return Math.max(statsGameStartTs, pc.startedAt || 0); }

// Missing entries mean idle, not unknown (§2) — both go through baseline(pc).
function statsIdleInputMs(pc, now) {
    var e = statsAct.get(pc.id);
    return now - (e ? e.lastMs : statsBaseline(pc));
}
function statsIdleAnyMs(pc, now) {
    var v = statsSeen.get(pc.id);
    return now - (v != null ? v : statsBaseline(pc));
}

// No round clock, or the capability probe already flipped the signal off ⇒
// no AFK classification for the rest of this round (§2).
function statsAfkGuardOk() { return statsAfkSignalOk && statsGameStartTs !== 0; }

// Whole-round predicate (§1/§2/§7): zero input|damage|kill activity ever,
// from this participant's own baseline, with STATS_AFK_MIN_MS elapsed. Works
// on both a raw (single-id) participant and a folded one (pc.ids, §5) — a
// folded participant is AFK only if EVERY id they played under this round was.
function statsIsAfk(pc, now) {
    if (!statsAfkGuardOk()) return false;
    if ((now - statsBaseline(pc)) < STATS_AFK_MIN_MS) return false;
    var ids = pc.ids || [pc.id];
    for (var i = 0; i < ids.length; i++) { if (statsAct.has(ids[i])) return false; }
    return true;
}

function statsGetMode() {
    try { var s = window.WLROOM.getSettings(); return (s && s.gameMode) || null; } catch (e) { return null; }
}
// The engine seeds LMS lives as max(scoreLimit, 1) (§3: gb.ec) — mirror that
// floor here so a scoreLimit:0 or absent room isn't permanently "never
// material" (Math.min(...) < 0 is never true, and < null was never true).
function statsGetScoreLimit() {
    try {
        var s = window.WLROOM.getSettings();
        var raw = (s && typeof s.scoreLimit === 'number') ? s.scoreLimit : 0;
        return Math.max(raw, 1);
    } catch (e) { return 1; }
}

// §3: rankScore + per-participant deltas, carry-inclusive (§9). live modes:
// rankScore === dScore (unchanged from today); lms: rankScore is the absolute
// lives stock, dScore stays 0 (Math.max(0, …) already yields that).
function statsDeltasOf(pc, mode) {
    var live = statsScoreById(pc);
    var dScore = (pc.scoreCarry || 0) + Math.max(0, live.score - pc.scoreStart);
    var dKills = (pc.killsCarry || 0) + Math.max(0, live.kills - pc.killsStart);
    var dDeaths = (pc.deathsCarry || 0) + Math.max(0, live.deaths - pc.deathsStart);
    return { dScore: dScore, dKills: dKills, dDeaths: dDeaths, rankScore: (mode === 'lms') ? live.score : dScore };
}

// ── §4: exit records ────────────────────────────────────────────────────────

function statsIsAbandon(rec) {
    return !!rec.full && rec.kind !== 'kick' && (rec.standing === 'losing' || rec.standing === 'tied') &&
        rec.material && !rec.afk && !rec.eliminated;
}

// Records the moment a participant stops playing while a game is in progress.
// Writes nothing — the record is drained at the next game end (statsOnGameEnd),
// which is what makes both retractions (kick, re-entry) possible.
function statsRecordExit(pc, kind) {
    if (!statsGameInProgress || !pc || !pc.auth) return;
    var now = Date.now();
    var mode = statsGetMode();
    var d = statsDeltasOf(pc, mode);
    var exitRankScore = d.rankScore;

    // O(P²) — P ≤ CONFIG.max_players, on a rare event.
    var bestOther = -Infinity, bestOtherDeaths = Infinity, anyOther = false;
    for (var other of statsParticipants.values()) {
        if (other === pc) continue;
        anyOther = true;
        var od = statsDeltasOf(other, mode);
        if (od.rankScore > bestOther) bestOther = od.rankScore;
        if (od.dDeaths < bestOtherDeaths) bestOtherDeaths = od.dDeaths;
    }

    var standing;
    if (!anyOther) {
        standing = 'solo';
    } else if (!STATS_KNOWN_MODES[mode]) {
        if (!statsUnknownModeLogged) {
            console.log('stats: unknown gameMode ' + mode + ' — standing falls back to deaths');
            statsUnknownModeLogged = true;
        }
        standing = d.dDeaths < bestOtherDeaths ? 'winning' : (d.dDeaths === bestOtherDeaths ? 'tied' : 'losing');
    } else if (exitRankScore > bestOther) {
        standing = 'winning';
    } else if (exitRankScore === bestOther) {
        standing = 'tied';
    } else {
        standing = 'losing';
    }

    var elapsedMs = statsGameStartTs > 0 ? (now - statsGameStartTs) : 0;
    var material;
    if (elapsedMs >= STATS_EXIT_MATERIAL_MS) {
        material = true;
    } else if (mode === 'lms') {
        // "at least one participant has lost a life" — check the exiter's own
        // rankScore too, not just the best other: in a duel the exiter is
        // often the only one who has taken damage yet.
        var limit = statsGetScoreLimit(); // always a number ≥ 1 (max(scoreLimit,1))
        material = anyOther && Math.min(exitRankScore, bestOther) < limit;
    } else {
        material = anyOther && bestOther >= STATS_EXIT_MATERIAL_SCORE;
    }

    var afk = statsAfkGuardOk() && statsIdleAnyMs(pc, now) >= STATS_AFK_MIN_MS;
    // LMS carve-out: reaching zero lives is losing, not abandoning — nothing
    // left to forfeit.
    var eliminated = mode === 'lms' && exitRankScore === 0;

    statsExits.set(pc.auth, {
        kind: kind, atMs: now, standing: standing, material: material, afk: afk,
        full: !pc.midSession, roundSeq: statsRoundSeq, awayAt: now, eliminated: eliminated
    });

    console.log('stats: exit auth=' + pc.auth + ' name=' + pc.name + ' kind=' + kind +
        ' standing=' + standing + ' material=' + material + ' afk=' + afk +
        ' full=' + (!pc.midSession) + ' round=' + statsRoundSeq);
}

// Deletes a pending exit record on return to the game — "they came back,
// there was no abandonment" (§4). A rejoins counter fires only past the quiet
// window, so !jq (same-tick spec+unspec) records nothing at all. Routed
// through statsPending (like joins/chat) rather than a direct .set() — a
// direct .set(statsInc(1)) bypasses statsUpdateNoIncrement's read-add-write
// fallback and would OVERWRITE the lifetime total with 1 on a build without
// ServerValue.increment (same pre-existing flaw as statsFlushPlaytime, fixed
// here since this is new code).
function statsRetractExit(a, now) {
    try {
        var rec = statsExits.get(a);
        if (!rec) return;
        statsExits.delete(a);
        if (now - rec.awayAt >= STATS_REENTRY_QUIET_MS) {
            statsPend(a).rejoins++;
        }
    } catch (e) { console.log('stats: statsRetractExit failed: ' + ((e && e.message) || e)); }
}

// §9: same participant, same id, but the engine handed them a brand-new score
// entry on re-entry — fold what they earned in the segment that just ended
// into the carry, then rebase scoreStart to the fresh entry.
function statsRebaseOnReentry(pc) {
    var snap = pc.scoreExit || pc.scoreLeave;
    if (snap) {
        pc.scoreCarry = (pc.scoreCarry || 0) + Math.max(0, snap.score - pc.scoreStart);
        pc.killsCarry = (pc.killsCarry || 0) + Math.max(0, snap.kills - pc.killsStart);
        pc.deathsCarry = (pc.deathsCarry || 0) + Math.max(0, snap.deaths - pc.deathsStart);
    }
    var sc = null;
    try { sc = window.WLROOM.getPlayerScore(pc.id); } catch (e) { }
    if (sc) { pc.scoreStart = sc.score; pc.killsStart = sc.kills; pc.deathsStart = sc.deaths; }
    pc.away = false;
    pc.scoreExit = null;
}

function statsOnGameEnd() {
    statsGameInProgress = false;
    var updates = {};
    var now = Date.now();
    var day = statsDayKey(now);
    if (statsTodayKey !== day) { statsTodayKey = day; statsSeenToday.clear(); }

    // Flush accrued playtime for players still on a team. Without this, a player
    // who never leaves/spectates (e.g. a bot) never gets playtime credited,
    // since statsFlushPlaytime otherwise only fires on leave/team-change.
    for (var te of statsTeamSince.entries()) {
        statsFlushPlaytime(te[0], te[1]);
        statsTeamSince.set(te[0], now); // reset the timer for the next game
    }

    var mode = statsGetMode();

    // per-segment deltas (id-keyed — a leave-then-rejoin under a NEW auth id
    // yields more than one entry per auth here; folded below).
    for (var pcRaw of statsParticipants.values()) {
        var d = statsDeltasOf(pcRaw, mode);
        pcRaw.dScore = d.dScore; pcRaw.dKills = d.dKills; pcRaw.dDeaths = d.dDeaths;
        pcRaw.rankScoreSeg = d.rankScore;
    }

    // §5: fold by auth before `updates` is built — sum dScore/dKills/dDeaths,
    // take the earliest startedAt, midSession only if every segment was. AFK
    // is computed after folding (needs the full id set + the capability probe
    // below). rankScore: in LMS the lives stock is an ABSOLUTE, so it takes
    // the LAST segment's value (summing it would be nonsense); in every other
    // mode rankScore === dScore (§3), so it must be the SUMMED value like
    // dScore — taking the last segment's would rank a folded participant on
    // only their final segment's kills and drop everything they earned before
    // the rejoin.
    var byAuth = new Map();
    for (var pcRaw2 of statsParticipants.values()) {
        var fp = byAuth.get(pcRaw2.auth);
        if (!fp) {
            fp = {
                auth: pcRaw2.auth, name: pcRaw2.name, elo: pcRaw2.elo, form: pcRaw2.form,
                exists: pcRaw2.exists, seeded: pcRaw2.seeded,
                streak: pcRaw2.streak, bestStreak: pcRaw2.bestStreak, fastestWinMs: pcRaw2.fastestWinMs,
                dScore: 0, dKills: 0, dDeaths: 0, midSession: pcRaw2.midSession,
                rankScoreLastSeg: pcRaw2.rankScoreSeg, team: pcRaw2.team,
                startedAt: pcRaw2.startedAt, ids: []
            };
            byAuth.set(pcRaw2.auth, fp);
        } else {
            fp.name = pcRaw2.name;
            fp.rankScoreLastSeg = pcRaw2.rankScoreSeg;
            fp.team = pcRaw2.team;
            fp.midSession = fp.midSession && pcRaw2.midSession;
            if (pcRaw2.startedAt < fp.startedAt) fp.startedAt = pcRaw2.startedAt;
        }
        fp.dScore += pcRaw2.dScore;
        fp.dKills += pcRaw2.dKills;
        fp.dDeaths += pcRaw2.dDeaths;
        fp.ids.push(pcRaw2.id);
    }
    var parts = Array.from(byAuth.values());
    for (var fpr of parts) { fpr.rankScore = (mode === 'lms') ? fpr.rankScoreLastSeg : fpr.dScore; }

    var full = parts.filter(function (p) { return !p.midSession; });
    var N = full.length;
    var gameKills = 0;

    // Capability probe (§2, hard requirement) — must run before AFK is
    // trusted for THIS round's classification. Fed ONLY by real
    // onPlayerActivity events (statsRealActivityEvents), not statsAct.size —
    // damage/kills also populate statsAct (§2), so one kill in a long game
    // would mask a dead onPlayerActivity wiring and never trip the probe.
    if (statsAfkSignalOk && statsGameStartTs > 0 && full.length >= 2 &&
        (now - statsGameStartTs) >= 60000 && statsRealActivityEvents === 0) {
        statsAfkSignalOk = false;
        console.log('stats: onPlayerActivity produced zero events across a ' +
            Math.round((now - statsGameStartTs) / 1000) + 's game with ' + full.length +
            ' participants — AFK signal presumed broken, disabling AFK classification until the room restarts');
    }
    var afkCount = 0, taintedKills = 0;
    for (var fpx of parts) {
        fpx.afk = statsIsAfk(fpx, now);
        if (fpx.afk) {
            afkCount++;
            // §7 phase-1 half: DETECTION + reporting only — no aggregate
            // change. Every non-suicide death this round was a kill scored
            // against a whole-round-AFK victim; killer aggregates are left
            // exactly as written below (policy/reversal is phase 2).
            taintedKills += Math.max(0, fpx.dDeaths - (statsSuicides.get(fpx.auth) || 0));
        }
    }

    // ranking + ELO over FULL-GAME participants only — ranked on rankScore
    // (§3 phase 1b), not dScore. In up-modes rankScore === dScore, so this is
    // byte-identical to today there; in LMS it is now the lives stock.
    if (N >= 2) {
        statsAssignRanks(full);              // sets p.rank
        statsComputeElo(full, N);            // sets p.newElo
    }

    // @@GAME@@.exits counts only THIS round's exits — statsExits.size also
    // includes records carried over from an earlier discarded round (§4),
    // which still get counters (below) but must not inflate this game's row.
    var gameExitsCount = 0;
    for (var xcount of statsExits.values()) { if (xcount.roundSeq === statsRoundSeq) gameExitsCount++; }

    var newToday = 0; // distinct auths first seen today, counted THIS game
    for (var p of parts) {
        var base = `players/${p.auth}`;
        // activity credit for ALL participants
        updates[`${base}/kills`] = statsInc(p.dKills);
        updates[`${base}/deaths`] = statsInc(p.dDeaths);
        updates[`${base}/scoreSum`] = statsInc(p.dScore);
        updates[`${base}/lastSeen`] = now;
        updates[`${base}/name`] = p.name;
        if (!p.exists) updates[`${base}/firstSeen`] = now;
        gameKills += p.dKills;

        var formEntry = { ts: now, kills: p.dKills, deaths: p.dDeaths, suicides: (statsSuicides.get(p.auth) || 0) };
        if (p.midSession || N < 2) {
            updates[`${base}/partialGames`] = statsInc(1);
            formEntry.partial = true;
        } else {
            updates[`${base}/games`] = statsInc(1);
            var norm = N > 1 ? (N - p.rank) / (N - 1) : 1;
            updates[`${base}/placeSumNorm`] = statsInc(norm);
            if (p.rank === 1) updates[`${base}/wins`] = statsInc(1);
            // §5 trap: skip the elo ABSOLUTE write until the seed read lands —
            // counters above are increments and unaffected.
            if (p.seeded) { updates[`${base}/elo`] = p.newElo; }
            formEntry.rank = p.rank; formEntry.N = N;
            if (p.seeded) formEntry.elo = p.newElo;
        }
        if (p.afk) {
            updates[`${base}/afkGames`] = statsInc(1);
            formEntry.afk = true;
        }
        // §4 drain: exit detail on the form entry only for a record that
        // belongs to THIS round and THIS participant — a record carried over
        // from a discarded round contributes counters only (below).
        var xrec = statsExits.get(p.auth);
        if (xrec && xrec.roundSeq === statsRoundSeq) {
            formEntry.exit = xrec.kind;
            if (statsIsAbandon(xrec)) formEntry.abandon = true;
        }
        // form: append + cap (absolute write of the trimmed ring) — same §5
        // trap as elo: skip until seeded, or a short game truncates a 20-entry
        // ring to 1.
        if (p.seeded) {
            var form = (p.form || []).concat([formEntry]);
            if (form.length > STATS_FORM_CAP) form = form.slice(form.length - STATS_FORM_CAP);
            updates[`${base}/form`] = form;
        }

        // daily uniques (approx): count each auth once per day
        if (!statsSeenToday.has(p.auth)) { statsSeenToday.add(p.auth); newToday++; }
    }

    // between-game accrued joins/chat for ANY auth
    for (var e of statsPending.entries()) {
        var a = e[0], pend = e[1], b = `players/${a}`;
        if (pend.joins) updates[`${b}/joins`] = statsInc(pend.joins);
        if (pend.chat) updates[`${b}/chat`] = statsInc(pend.chat);
        if (pend.rejoins) updates[`${b}/rejoins`] = statsInc(pend.rejoins);
        if (pend.name) updates[`${b}/name`] = pend.name;
    }
    statsPending.clear();

    // Auth -> display name, for the admin-facing notifyAdmins line below
    // (never leak a raw auth id to admins when the participant row has a name).
    var nameByAuth = new Map();
    for (var np of parts) { nameByAuth.set(np.auth, np.name); }

    // §4 drain: counters for ANY auth, participant or not — same rule as
    // statsPending above. Exit detail (form/@@GAME@@) is gated per-record
    // above/below by roundSeq; these counters are not.
    for (var xe of statsExits.entries()) {
        var xAuth = xe[0], dxrec = xe[1], xb = `players/${xAuth}`;
        updates[`${xb}/exits`] = statsInc(1);
        updates[`${xb}/lastExitTs`] = dxrec.atMs;
        if (dxrec.kind === 'spec') updates[`${xb}/specOuts`] = statsInc(1);
        if (dxrec.kind === 'kick') updates[`${xb}/kickedOuts`] = statsInc(1);
        if (statsIsAbandon(dxrec)) {
            updates[`${xb}/abandons`] = statsInc(1);
            updates[`${xb}/lastAbandonTs`] = dxrec.atMs;
            if (typeof CONFIG !== 'undefined' && CONFIG.stats_exit_notify && dxrec.roundSeq === statsRoundSeq &&
                typeof notifyAdmins === 'function') {
                notifyAdmins('stats: ' + (nameByAuth.get(xAuth) || xAuth) + ' abandoned (' + dxrec.kind + ', ' + dxrec.standing + ')');
            }
        }
    }
    if (statsDiscardedRounds > 0) {
        // Discards accrued since the LAST flush all land in TODAY's ("day",
        // computed above) bucket even if some happened before midnight — this
        // counter is a rate signal (§4: "discard rate went to ~0"), not an
        // exact per-day audit trail, so the off-by-a-bucket case is acceptable.
        updates[`daily/${day}/discardedRounds`] = statsInc(statsDiscardedRounds);
        statsDiscardedRounds = 0;
    }

    // Phase 2: damage + per-weapon effectiveness (weapon-enabled build only)
    if (statsWeaponsEnabled) {
        for (var de of statsDmgDealt.entries()) {
            if (de[1] > 0) updates[`players/${de[0]}/damageDealt`] = statsInc(Math.round(de[1]));
        }
        for (var te of statsDmgTaken.entries()) {
            if (te[1] > 0) updates[`players/${te[0]}/damageTaken`] = statsInc(Math.round(te[1]));
        }
        // Weapon rows are written twice: the legacy all-mods nodes (weapons/,
        // players/<auth>/weapons/) keep the overall boards + old readers
        // working, and the per-mod buckets (weaponsByMod/<modKey>/,
        // players/<auth>/weaponsByMod/<modKey>/) split them by the mod this
        // game ran — a BAZOOKA kill under one mod says nothing about another's.
        var mk = statsGameModKey;
        for (var we of statsWpnByAuth.entries()) {
            var wAuth = we[0];
            for (var wf of we[1].entries()) {
                var pb = `players/${wAuth}/weapons/${wf[0]}`;
                if (wf[1].kills) updates[`${pb}/kills`] = statsInc(wf[1].kills);
                if (wf[1].damage) updates[`${pb}/damage`] = statsInc(Math.round(wf[1].damage));
                var pmb = `players/${wAuth}/weaponsByMod/${mk}/${wf[0]}`;
                if (wf[1].kills) updates[`${pmb}/kills`] = statsInc(wf[1].kills);
                if (wf[1].damage) updates[`${pmb}/damage`] = statsInc(Math.round(wf[1].damage));
            }
        }
        for (var ge of statsWpnGlobal.entries()) {
            var gb = `weapons/${ge[0]}`;
            updates[`${gb}/name`] = ge[1].name;
            if (ge[1].kills) updates[`${gb}/kills`] = statsInc(ge[1].kills);
            if (ge[1].damage) updates[`${gb}/damage`] = statsInc(Math.round(ge[1].damage));
            var gmb = `weaponsByMod/${mk}/${ge[0]}`;
            updates[`${gmb}/name`] = ge[1].name;
            if (ge[1].kills) updates[`${gmb}/kills`] = statsInc(ge[1].kills);
            if (ge[1].damage) updates[`${gmb}/damage`] = statsInc(Math.round(ge[1].damage));
        }
        for (var fp of statsWpnSeen) {
            updates[`weapons/${fp}/games`] = statsInc(1);
            updates[`weaponsByMod/${mk}/${fp}/games`] = statsInc(1);
        }
        if (statsWpnSeen.size) {
            // mods index for the stats-page selector
            updates[`mods/${mk}/name`] = statsGameModName;
            updates[`mods/${mk}/lastUsed`] = Date.now();
            updates[`mods/${mk}/games`] = statsInc(1);
        }
    }

    // League index — UNCONDITIONAL (unlike the mods index above, which sits in
    // the weapons-enabled branch and skips hit-less games): "games increments
    // once per game" is a phase-5 assertion (arena-leagues.md §7.3).
    if (statsGameLeague) {
        updates[`leagues/${statsGameLeague.id}/name`] = statsGameLeague.name;
        updates[`leagues/${statsGameLeague.id}/lastUsed`] = Date.now();
        updates[`leagues/${statsGameLeague.id}/games`] = statsInc(1);
    }

    // suicides + timing aggregates (kept as sum+count so avgs are exact across
    // games). avg time-to-death = lifeSum/lifeCount, etc. Rendered by the panel.
    for (var se of statsSuicides.entries()) if (se[1]) updates[`players/${se[0]}/suicides`] = statsInc(se[1]);
    var timeMaps = [
        ['lifeSum', statsLifeSum], ['lifeCount', statsLifeCount],
        ['killGapSum', statsKillGapSum], ['killGapCount', statsKillGapCount],
        ['spawnKillSum', statsSpawnKillSum], ['spawnKillCount', statsSpawnKillCount]
    ];
    for (var tm of timeMaps) {
        for (var e2 of tm[1].entries()) {
            if (e2[1]) updates[`players/${e2[0]}/${tm[0]}`] = statsInc(Math.round(e2[1]));
        }
    }

    // ── 1v1 extras (arena-style ladder stats) — only for true duels: exactly
    // two FULL-game participants. All bounded: per-auth absolutes (streaks,
    // fastest win), per-pair h2h counters, per-auth-per-map counters, duel
    // duration as sum+count. Never per-game rows (spec: plugin-architecture §6d
    // — the scalable replacement for arena's unbounded gamestats replay).
    if (N === 2) {
        var d0 = full[0], d1 = full[1];
        var duelMs = statsGameStartTs > 0 ? (now - statsGameStartTs) : 0;
        var winner = null, loser = null;
        // §3 phase 1b: rankScore, not dScore — in up-modes they're the same
        // value (byte-identical regression), in LMS this is what makes the
        // duel winner (and h2h/streak/fastestWinMs below) work at all.
        if (d0.rankScore !== d1.rankScore) {
            winner = d0.rankScore > d1.rankScore ? d0 : d1;
            loser = winner === d0 ? d1 : d0;
        }
        for (var dp of [d0, d1]) {
            var db = `players/${dp.auth}`;
            // §5 trap: streak/bestStreak/fastestWinMs are absolutes seeded
            // from the same read as elo/form — skip until it lands.
            if (dp.seeded) {
                if (winner === dp) {
                    var ns = (dp.streak || 0) + 1;
                    updates[`${db}/streak`] = ns;                                   // absolute
                    if (ns > (dp.bestStreak || 0)) updates[`${db}/bestStreak`] = ns; // absolute
                    if (duelMs > 0 && (!dp.fastestWinMs || duelMs < dp.fastestWinMs)) {
                        updates[`${db}/fastestWinMs`] = duelMs;                     // absolute
                    }
                } else if (loser === dp) {
                    updates[`${db}/streak`] = 0;
                } // tie: streaks unchanged
            }
            if (duelMs > 0) { // a mid-game script reload zeroes statsGameStartTs — skip the bogus sample
                updates[`${db}/duelMsSum`] = statsInc(duelMs);
                updates[`${db}/duelCount`] = statsInc(1);
            }
        }
        // head-to-head: one bounded node per PAIR, key = sorted auths; w0/w1 =
        // wins for the first/second auth in the sorted key (stable positions).
        var pa = [statsSafeKey(d0.auth), statsSafeKey(d1.auth)].sort();
        var hb = `h2h/${pa[0]}__${pa[1]}`;
        updates[`${hb}/games`] = statsInc(1);
        // Store the RAW auth pair too (absolute, same every game): the key is
        // built from safe-keyed auths joined by "__", but an auth can itself
        // contain "__" — readers must not have to parse the key.
        var raw0 = statsSafeKey(d0.auth) === pa[0] ? d0.auth : d1.auth;
        updates[`${hb}/a0`] = raw0;
        updates[`${hb}/a1`] = raw0 === d0.auth ? d1.auth : d0.auth;
        if (winner) {
            updates[`${hb}/${statsSafeKey(winner.auth) === pa[0] ? 'w0' : 'w1'}`] = statsInc(1);
        }
        // per-player per-map win-rate (bounded by the maps a player actually duels on)
        var duelLvl = statsCurrentLevelName();
        if (duelLvl) {
            var lk = statsSafeKey(duelLvl);
            for (var dp2 of [d0, d1]) {
                updates[`players/${dp2.auth}/maps/${lk}/games`] = statsInc(1);
                if (winner === dp2) updates[`players/${dp2.auth}/maps/${lk}/wins`] = statsInc(1);
            }
        }
    }

    // daily rollup + level usage. Participant-less rotations (a lone
    // spectator's map cycling) are not games — the @@GAME@@ emission below
    // already skips them; the rollup must agree or daily/games and level
    // counts drift from the gamestore by hundreds overnight.
    if (parts.length > 0) {
        updates[`daily/${day}/games`] = statsInc(1);
        updates[`daily/${day}/kills`] = statsInc(gameKills);
        if (newToday > 0) updates[`daily/${day}/uniquePlayers`] = statsInc(newToday);
        var lvl = statsCurrentLevelName();
        if (lvl) updates[`levels/${statsSafeKey(lvl)}/count`] = statsInc(1);
    }

    if (statsHasIncrement) {
        statsRootRef.update(updates);
    } else {
        statsUpdateNoIncrement(updates);   // read-modify-write fallback
    }

    // @@GAME@@ emission → wlhl gamestore (spec: game-history.md §1). Console
    // line only — no RTDB write; per-game rows belong on the host's disk.
    // Fire-and-forget: history emission must never touch the game loop.
    // Skip empty games (no participants at all — e.g. a lone spectator's map
    // rotation): the store rejects them anyway, this just avoids log noise.
    try { if (parts.length === 0) { statsParticipants.clear(); statsExits.clear(); return; } } catch (e) {}
    try {
        var emitPlayers = parts.map(function (p) {
            var e = { auth: p.auth, name: p.name, team: (p.team != null ? p.team : null),
                      score: p.dScore, kills: p.dKills, deaths: p.dDeaths, rankScore: p.rankScore };
            if (p.midSession || N < 2) {
                e.partial = true; // rank/elo are undefined for these — omit
            } else {
                e.rank = p.rank;
                // §5 trap, emission side: RTDB skips the elo write until the
                // seed lands (p.seeded), so the emission must match — otherwise
                // wlhl/SQLite records an ELO movement that RTDB never took.
                if (p.seeded) { e.elo = p.newElo; e.eloDelta = p.newElo - p.elo; }
                else { e.seeded = false; }
            }
            if (p.afk) e.afk = true;
            var exrec = statsExits.get(p.auth);
            if (exrec && exrec.roundSeq === statsRoundSeq) {
                e.exit = exrec.kind; e.exitAtMs = exrec.atMs; e.standing = exrec.standing;
                if (statsIsAbandon(exrec)) e.abandon = true;
            }
            return e;
        });
        var emitWinner = null;
        if (N >= 2) {
            // statsAssignRanks averages ties (a top tie yields rank 1.5), so a
            // single rank===1 player is THE winner; anything else = null.
            var tops = full.filter(function (p) { return p.rank === 1; });
            if (tops.length === 1) emitWinner = tops[0].auth;
        }
        console.log('@@GAME@@ ' + JSON.stringify({
            ts: now,
            map: (typeof statsCurrentLevelName === 'function' && statsCurrentLevelName()) || '',
            n: N,
            mode: mode,
            nRanked: N,       // phase 1/1b: ranked === full (excuse/forfeit is phase 2)
            unranked: N < 2,
            durationMs: statsGameStartTs > 0 ? (now - statsGameStartTs) : 0, // 0 = spanned a script reload
            players: emitPlayers,
            winner: emitWinner,
            partial: N < 2,
            exits: gameExitsCount,
            afkCount: afkCount,
            taintedKills: taintedKills,
            // league is stored verbatim in gamestore raw from day one; the
            // /games API surfaces it only after the phase-5 wlhl change
            league: statsGameLeague ? statsGameLeague.id : null
        }));
    } catch (e) { console.log('stats: game emission failed: ' + ((e && e.message) || e)); }

    statsParticipants.clear();
    statsExits.clear();
}

function statsScoreById(pc) {
    // find current id for this auth (a mid-game leaver may be gone from the
    // list) — but NOT for an entry that truly left (pc.left): that auth may
    // already belong to a DIFFERENT, newer connection (§5 auth-folding), and
    // matching it here would attribute the new segment's live score to this
    // stale one too.
    var live = null;
    if (!pc.left) {
        for (var p of window.WLROOM.getPlayerList()) {
            if (auth.get(p.id) === pc.auth) { live = window.WLROOM.getPlayerScore(p.id); break; }
        }
    }
    // gone from the list: use the score snapshotted at leave/spec time, so a
    // mid-game leaver keeps what they earned; the start snapshot (zero
    // deltas) remains only for entries that never got either snapshot.
    return live || pc.scoreLeave || pc.scoreExit || { score: pc.scoreStart, kills: pc.killsStart, deaths: pc.deathsStart };
}

function statsAssignRanks(full) {
    // §3 phase 1b: rankScore, not dScore (LMS's dScore is always 0 — see
    // spec's "pre-existing bug" note; in up-modes rankScore === dScore, so
    // this is byte-identical to today there).
    var sorted = full.slice().sort(function (a, b) { return b.rankScore - a.rankScore; });
    var i = 0;
    while (i < sorted.length) {
        var j = i;
        while (j + 1 < sorted.length && sorted[j + 1].rankScore === sorted[i].rankScore) j++;
        // positions i+1 .. j+1 (1-based) share the averaged rank
        var avg = ((i + 1) + (j + 1)) / 2;
        for (var k = i; k <= j; k++) sorted[k].rank = avg;
        i = j + 1;
    }
}

function statsComputeElo(full, N) {
    for (var a of full) {
        var sum = 0;
        for (var b of full) {
            if (a === b) continue;
            var s = a.rank < b.rank ? 1 : (a.rank === b.rank ? 0.5 : 0);
            var e = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400));
            sum += (s - e);
        }
        a.newElo = a.elo + Math.round((STATS_ELO_K / (N - 1)) * sum);
    }
}

function statsCurrentLevelName() {
    try { var s = window.WLROOM.getSettings(); return (s && (s.level || s.levelName)) || null; } catch (e) { return null; }
}
function statsSafeKey(s) { return String(s).replace(/[.#$/\[\]]/g, '_').slice(0, 120); }

// Fallback when ServerValue.increment is unavailable: read participants once, add deltas.
function statsUpdateNoIncrement(updates) {
    // Only counter paths carry the raw delta (statsInc returned the number). We do a
    // best-effort read-add-write of the whole stats subtree once. Rare path (7.20 should have increment).
    statsRootRef.once('value').then(function (snap) {
        var cur = snap.val() || {};
        var out = {};
        for (var path in updates) {
            var val = updates[path];
            if (typeof val === 'number' && statsIsCounterPath(path)) {
                out[path] = statsDeepGet(cur, path) + val;
            } else {
                out[path] = val;
            }
        }
        statsRootRef.update(out);
    });
}
function statsIsCounterPath(p) {
    // §5 trap: cleanStreak is an ABSOLUTE and must stay OUT of this regex —
    // it is not written yet (phase 2's gate/decay), but when it is, it must
    // never land here.
    return /\/(kills|deaths|scoreSum|joins|chat|games|partialGames|wins|placeSumNorm|playtime|count|uniquePlayers|damage|damageDealt|damageTaken|suicides|lifeSum|lifeCount|killGapSum|killGapCount|spawnKillSum|spawnKillCount|duelMsSum|duelCount|w0|w1|exits|abandons|specOuts|kickedOuts|rejoins|afkGames|discardedRounds)$/.test(p);
}
function statsDeepGet(obj, path) {
    var parts = path.split('/'), o = obj;
    for (var i = 0; i < parts.length; i++) { if (o == null) return 0; o = o[parts[i]]; }
    return typeof o === 'number' ? o : 0;
}

// ── !stats command ──────────────────────────────────────────────────────────
// A public link to the room's stats page + the top 5 players by ELO (and the
// caller's own rank if they're outside the top 5). Reads stats/players once;
// keys match the writer (raw auth). Base URL is CONFIG.stats_base_url or the
// ext-proxy default.
var STATS_BASE_URL = (typeof CONFIG !== 'undefined' && CONFIG.stats_base_url) || "https://ext-proxy.fly.dev";
var STATS_MEDALS = ["🥇", "🥈", "🥉"];

function statsPageLink() {
    return STATS_BASE_URL.replace(/\/+$/, "") + "/stats/" + encodeURIComponent(CONFIG.room_id);
}
function statsEloLine(rank, r, medal) {
    return rank + ". " + r.name + " — " + Math.round(r.elo) + " ELO with " + r.games +
        " game" + (r.games === 1 ? "" : "s") + " played" + (medal ? " " + medal : "");
}

COMMAND_REGISTRY.add("stats", ["!stats: room stats page link + top 5 players by ELO"], function (player) {
    var link = statsPageLink();
    if (!statsRootRef) { announce("Room stats: " + link, player.id, COLORS.INFO); return false; }
    var myAuth = player.auth || (typeof auth !== 'undefined' && auth.get ? auth.get(player.id) : null);
    statsRootRef.child('players').once('value').then(function (snap) {
        var rows = [];
        snap.forEach(function (c) {
            var v = c.val() || {};
            if (typeof v.elo !== 'number' && !(v.games > 0)) return; // only ranked players
            rows.push({
                key: c.key, name: v.name || c.key,
                elo: (typeof v.elo === 'number' ? v.elo : STATS_COLD_ELO), games: v.games || 0
            });
        });
        rows.sort(function (a, b) { return (b.elo - a.elo) || (b.games - a.games); });

        announce("=== TOP 5 ELO ===", player.id, COLORS.IMPORTANT);
        var top = rows.slice(0, 5);
        top.forEach(function (r, i) { announce(statsEloLine(i + 1, r, STATS_MEDALS[i]), player.id, COLORS.ANNOUNCE); });
        if (!top.length) announce("(no ranked games recorded yet)", player.id, COLORS.NORMAL);

        // the caller's own standing, only if they're ranked and outside the top 5
        if (myAuth) {
            var myIdx = -1;
            for (var i = 0; i < rows.length; i++) { if (rows[i].key === myAuth) { myIdx = i; break; } }
            if (myIdx >= 5) announce("You: " + statsEloLine(myIdx + 1, rows[myIdx], null), player.id, COLORS.PRIVATE);
        }
        announce("Full stats: " + link, player.id, COLORS.INFO);
    }).catch(function () {
        announce("Room stats: " + link, player.id, COLORS.INFO); // link still works even if the read fails
    });
    return false;
});

// ── !leavers command (§8) ───────────────────────────────────────────────────
// Admin-only, modelled on !stats: one stats/players read, top 10 by abandons.
// `!leavers <name>` prints one player's line + their last 20 form entries
// condensed to a string (. played, X exit, A abandon, ~ AFK).
function statsLeaversLine(r) {
    return r.name + " — " + r.abandons + " abandons / " + r.exits + " exits / " + r.games + " games" +
        " (cleanStreak " + r.cleanStreak + "/25)" +
        (r.lastAbandonTs ? ", last abandon " + new Date(r.lastAbandonTs).toISOString().slice(0, 10) : "");
}
function statsFormCondensed(form) {
    return (form || []).slice(-STATS_FORM_CAP).map(function (f) {
        if (f.abandon) return "A";
        if (f.exit) return "X";
        if (f.afk) return "~";
        return ".";
    }).join("");
}

COMMAND_REGISTRY.add("leavers", ["!leavers: top players by abandons (admin only)", "!leavers <name>: one player's leaver record"], function (player, name) {
    if (!statsRootRef) return false;
    statsRootRef.child('players').once('value').then(function (snap) {
        var rows = [];
        snap.forEach(function (c) {
            var v = c.val() || {};
            rows.push({
                key: c.key, name: v.name || c.key,
                abandons: v.abandons || 0, exits: v.exits || 0,
                games: (v.games || 0) + (v.partialGames || 0),
                cleanStreak: v.cleanStreak || 0, lastAbandonTs: v.lastAbandonTs || 0,
                form: Array.isArray(v.form) ? v.form : []
            });
        });

        if (name) {
            var needle = String(name).toLowerCase();
            var row = rows.find(function (r) { return r.key === name || r.name.toLowerCase() === needle; });
            if (!row) { announce('no leaver record for "' + name + '"', player.id, COLORS.ERROR); return; }
            announce(statsLeaversLine(row), player.id, COLORS.ANNOUNCE);
            announce(statsFormCondensed(row.form) || "(no games yet)", player.id, COLORS.INFO);
            return;
        }

        // A fresh room has every player at exits:0 — printing ten empty rows
        // is noise, not a leaderboard.
        rows = rows.filter(function (r) { return r.exits > 0; });
        rows.sort(function (a, b) { return b.abandons - a.abandons; });
        announce("=== TOP LEAVERS (by abandons) ===", player.id, COLORS.IMPORTANT);
        var top = rows.slice(0, 10);
        if (!top.length) announce("(no data yet)", player.id, COLORS.NORMAL);
        top.forEach(function (r) { announce(statsLeaversLine(r), player.id, COLORS.ANNOUNCE); });
    }).catch(function () {
        announce("leavers: read failed", player.id, COLORS.ERROR);
    });
    return false;
}, COMMAND.ADMIN_ONLY);
