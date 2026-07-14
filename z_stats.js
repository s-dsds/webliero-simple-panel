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
    console.log('stats ok');
}
initStats();

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
    for (var p of window.WLROOM.getPlayerList()) {
        if (p.team && p.team != 0) statsAddParticipant(p, false);
        if (p.team && p.team != 0 && !statsTeamSince.has(p.id)) statsTeamSince.set(p.id, Date.now());
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
    return /\/(kills|deaths|scoreSum|joins|chat|games|partialGames|wins|placeSumNorm|playtime|count|uniquePlayers)$/.test(p);
}
function statsDeepGet(obj, path) {
    var parts = path.split('/'), o = obj;
    for (var i = 0; i < parts.length; i++) { if (o == null) return 0; o = o[parts[i]]; }
    return typeof o === 'number' ? o : 0;
}
