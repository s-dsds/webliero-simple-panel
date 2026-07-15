/** room-stats contract v1 (Phase 1: stock stats). Single writer.
 *  Filename `z_` so it loads AFTER command_log.js (which assigns onPlayerChat
 *  raw, not via chainFunction) — see room-stats.md. Keyed on auth.get(id),
 *  snapshotted at game start so a mid-game leaver is still credited. */

var STATS_ELO_K = (typeof CONFIG !== 'undefined' && CONFIG.stats_elo_k) || 32;
var STATS_COLD_ELO = 1500;
var STATS_FORM_CAP = 20;

var statsRootRef;
var statsSV;            // firebase.database.ServerValue
var statsHasIncrement;  // confirmed at init (Risk 3 smoke)
var statsGameInProgress = false;
var statsParticipants = new Map();   // id -> {auth,name,scoreStart,killsStart,deathsStart,elo,form,midSession}
var statsPending = new Map();         // auth -> {joins,chat,name} accrued between flushes
var statsTeamSince = new Map();        // id -> epoch ms (playtime timer)
var statsSeenToday = new Set();        // auths credited to daily uniques today
var statsTodayKey = null;

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
    if (!p) { p = { joins: 0, chat: 0, name: name || "" }; statsPending.set(auth, p); }
    if (name) p.name = name;
    return p;
}

function initStats() {
    if (typeof fdb == 'undefined' || !fdb) { setTimeout(initStats, 200); return; }
    statsRootRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/stats`);

    statsSV = firebase.database.ServerValue;
    statsHasIncrement = !!(statsSV && typeof statsSV.increment === 'function');
    console.log("stats: ServerValue.increment available =", statsHasIncrement);

    statsRootRef.child('meta/playtimeSince').once('value').then(function (s) {
        if (!s.exists()) statsRootRef.child('meta/playtimeSince').set(Date.now());
    });

    chainFunction(window.WLROOM, 'onPlayerJoin', statsOnJoin);
    chainFunction(window.WLROOM, 'onPlayerChat', statsOnChat);
    chainFunction(window.WLROOM, 'onPlayerLeave', statsOnLeave);
    chainFunction(window.WLROOM, 'onPlayerTeamChange', statsOnTeamChange);
    chainFunction(window.WLROOM, 'onGameStart', statsOnGameStart);
    chainFunction(window.WLROOM, 'onGameEnd', statsOnGameEnd);
    // onPlayerKilled is stock — kill feed, suicides and kill-timing work on any
    // build. onPlayerSpawn is our injected callback (exact spawn times); on a
    // build without it the timing maps just stay empty.
    chainFunction(window.WLROOM, 'onPlayerKilled', statsOnKilled);
    chainFunction(window.WLROOM, 'onPlayerSpawn', statsOnSpawn);

    // Phase 2: weapon effectiveness + damage, only on the weapon-enabled
    // (hacked) build. onPlayerHit is our injected callback.
    statsWeaponsEnabled = typeof window.WLROOM.getWeapons === 'function';
    if (statsWeaponsEnabled) {
        chainFunction(window.WLROOM, 'onPlayerHit', statsOnHit);
        console.log('stats: weapon/damage tracking enabled');
    }

    // Live scoreboard: aggregates only flush at game end, so during a game the
    // panel would look frozen. Write a small `live` node (current players +
    // their in-game scores) every few seconds so viewers see the game as it
    // happens. One whole-node overwrite per tick, only while a game runs.
    setInterval(statsWriteLive, STATS_LIVE_MS);

    console.log('stats ok');
}
initStats();

var STATS_LIVE_MS = 4000;
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
    // mid-session joiner: a game is already running → still accrue their stats
    if (statsGameInProgress && player.team && player.team != 0) {
        statsAddParticipant(player, true);
    }
    if (player.team && player.team != 0) statsTeamSince.set(player.id, Date.now());
}

function statsOnChat(player) {
    var a = player.auth || auth.get(player.id);
    if (a) statsPend(a, player.name).chat++;
}

function statsOnTeamChange(player) {
    // team>0 = playing; team 0 = spectator. Accumulate playtime across transitions.
    var since = statsTeamSince.get(player.id);
    if (player.team && player.team != 0) {
        if (since == null) statsTeamSince.set(player.id, Date.now());
        // spectator -> team while a game runs = mid-session participant
        if (statsGameInProgress && !statsParticipants.has(player.id)) statsAddParticipant(player, true);
    } else {
        if (since != null) { statsFlushPlaytime(player.id, since); statsTeamSince.delete(player.id); }
    }
}

function statsOnLeave(player) {
    var since = statsTeamSince.get(player.id);
    if (since != null) { statsFlushPlaytime(player.id, since); statsTeamSince.delete(player.id); }
    // keep the participant entry (with its snapshotted auth) so game-end still credits a mid-game leaver
}

function statsFlushPlaytime(id, since) {
    var a = auth.get(id);
    if (!a) return;
    var secs = Math.round((Date.now() - since) / 1000);
    if (secs > 0) statsRootRef.child(`players/${a}/playtime`).set(statsInc(secs));
}

function statsAddParticipant(player, midSession) {
    var a = auth.get(player.id) || player.auth;
    if (!a) return;
    var sc = window.WLROOM.getPlayerScore(player.id) || { score: 0, kills: 0, deaths: 0 };
    statsParticipants.set(player.id, {
        auth: a, name: player.name,
        // snapshot the score at the moment we start tracking them; deltas from here
        scoreStart: sc.score, killsStart: sc.kills, deathsStart: sc.deaths,
        elo: STATS_COLD_ELO, form: [], midSession: !!midSession
    });
    statsSeedParticipant(a, player.id);
}

// bounded read of the player's stored elo/form (only path the fork reads)
function statsSeedParticipant(a, id) {
    statsRootRef.child(`players/${a}`).once('value').then(function (snap) {
        var pc = statsParticipants.get(id);
        if (!pc) return;
        var v = snap.val();
        if (v) { pc.elo = (typeof v.elo == 'number') ? v.elo : STATS_COLD_ELO; pc.form = Array.isArray(v.form) ? v.form : []; pc.exists = true; }
    });
}

function statsOnGameStart() {
    statsGameInProgress = true;
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

function statsOnGameEnd() {
    statsGameInProgress = false;
    var updates = {};
    var now = Date.now();
    var day = statsDayKey(now);
    if (statsTodayKey !== day) { statsTodayKey = day; statsSeenToday.clear(); }

    // per-game deltas for every participant (full + mid-session)
    var parts = [];
    for (var pc of statsParticipants.values()) {
        var live = statsScoreById(pc);
        pc.dScore = Math.max(0, live.score - pc.scoreStart);
        pc.dKills = Math.max(0, live.kills - pc.killsStart);
        pc.dDeaths = Math.max(0, live.deaths - pc.deathsStart);
        parts.push(pc);
    }

    var full = parts.filter(function (p) { return !p.midSession; });
    var N = full.length;
    var gameKills = 0;

    // ranking + ELO over FULL-GAME participants only
    if (N >= 2) {
        statsAssignRanks(full);              // sets p.rank
        statsComputeElo(full, N);            // sets p.newElo
    }

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

        var formEntry = { ts: now, kills: p.dKills, deaths: p.dDeaths };
        if (p.midSession || N < 2) {
            updates[`${base}/partialGames`] = statsInc(1);
            formEntry.partial = true;
        } else {
            updates[`${base}/games`] = statsInc(1);
            var norm = N > 1 ? (N - p.rank) / (N - 1) : 1;
            updates[`${base}/placeSumNorm`] = statsInc(norm);
            if (p.rank === 1) updates[`${base}/wins`] = statsInc(1);
            updates[`${base}/elo`] = p.newElo;               // absolute
            formEntry.rank = p.rank; formEntry.N = N; formEntry.elo = p.newElo;
        }
        // form: append + cap (absolute write of the trimmed ring)
        var form = (p.form || []).concat([formEntry]);
        if (form.length > STATS_FORM_CAP) form = form.slice(form.length - STATS_FORM_CAP);
        updates[`${base}/form`] = form;

        // daily uniques (approx)
        if (!statsSeenToday.has(p.auth)) statsSeenToday.add(p.auth);
    }

    // between-game accrued joins/chat for ANY auth
    for (var e of statsPending.entries()) {
        var a = e[0], pend = e[1], b = `players/${a}`;
        if (pend.joins) updates[`${b}/joins`] = statsInc(pend.joins);
        if (pend.chat) updates[`${b}/chat`] = statsInc(pend.chat);
        if (pend.name) updates[`${b}/name`] = pend.name;
    }
    statsPending.clear();

    // Phase 2: damage + per-weapon effectiveness (weapon-enabled build only)
    if (statsWeaponsEnabled) {
        for (var de of statsDmgDealt.entries()) {
            if (de[1] > 0) updates[`players/${de[0]}/damageDealt`] = statsInc(Math.round(de[1]));
        }
        for (var te of statsDmgTaken.entries()) {
            if (te[1] > 0) updates[`players/${te[0]}/damageTaken`] = statsInc(Math.round(te[1]));
        }
        for (var we of statsWpnByAuth.entries()) {
            var wAuth = we[0];
            for (var wf of we[1].entries()) {
                var pb = `players/${wAuth}/weapons/${wf[0]}`;
                if (wf[1].kills) updates[`${pb}/kills`] = statsInc(wf[1].kills);
                if (wf[1].damage) updates[`${pb}/damage`] = statsInc(Math.round(wf[1].damage));
            }
        }
        for (var ge of statsWpnGlobal.entries()) {
            var gb = `weapons/${ge[0]}`;
            updates[`${gb}/name`] = ge[1].name;
            if (ge[1].kills) updates[`${gb}/kills`] = statsInc(ge[1].kills);
            if (ge[1].damage) updates[`${gb}/damage`] = statsInc(Math.round(ge[1].damage));
        }
        for (var fp of statsWpnSeen) updates[`weapons/${fp}/games`] = statsInc(1);
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

    // daily rollup + level usage
    updates[`daily/${day}/games`] = statsInc(1);
    updates[`daily/${day}/kills`] = statsInc(gameKills);
    updates[`daily/${day}/uniquePlayers`] = statsInc(parts.length);
    var lvl = statsCurrentLevelName();
    if (lvl) updates[`levels/${statsSafeKey(lvl)}/count`] = statsInc(1);

    if (statsHasIncrement) {
        statsRootRef.update(updates);
    } else {
        statsUpdateNoIncrement(updates);   // read-modify-write fallback
    }

    statsParticipants.clear();
}

function statsScoreById(pc) {
    // find current id for this auth (a mid-game leaver may be gone from the list)
    var live = null;
    for (var p of window.WLROOM.getPlayerList()) {
        if (auth.get(p.id) === pc.auth) { live = window.WLROOM.getPlayerScore(p.id); break; }
    }
    return live || { score: pc.scoreStart, kills: pc.killsStart, deaths: pc.deathsStart };
}

function statsAssignRanks(full) {
    var sorted = full.slice().sort(function (a, b) { return b.dScore - a.dScore; });
    var i = 0;
    while (i < sorted.length) {
        var j = i;
        while (j + 1 < sorted.length && sorted[j + 1].dScore === sorted[i].dScore) j++;
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
    return /\/(kills|deaths|scoreSum|joins|chat|games|partialGames|wins|placeSumNorm|playtime|count|uniquePlayers|damage|damageDealt|damageTaken|suicides|lifeSum|lifeCount|killGapSum|killGapCount|spawnKillSum|spawnKillCount)$/.test(p);
}
function statsDeepGet(obj, path) {
    var parts = path.split('/'), o = obj;
    for (var i = 0; i < parts.length; i++) { if (o == null) return 0; o = o[parts[i]]; }
    return typeof o === 'number' ? o : 0;
}
