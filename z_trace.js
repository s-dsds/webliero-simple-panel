// z_trace.js — per-player worm-position tracing (host-side).
//
// The room host is server-authoritative and holds every worm's live position at
// player.worm.ua.x/y (the client build calls the same slot `qa`; `ua.xa` is
// health 0..100). This records a downsampled PATH per player plus spawn/death
// points, and writes it to RTDB so the stats page can render BOTH a heatmap
// (density) and a tracing view (polylines), and let the viewer show/hide
// individual players — neither is possible from a pre-aggregated grid, hence
// per-player storage.
//
//   simple/<roomId>/trace/live            refreshed while a game runs
//   simple/<roomId>/trace/recent/<pushId> final snapshot per finished game (last few)
//
// Snapshot shape:
//   { inProgress, ts, startTs, durationMs, level, w, h, cell, sampleMs,
//     players: { "<id>": {
//       name, team, color(int 0xRRGGBB), joinTs, leftTs|null, present,
//       kills, deaths, score,               // from the live scoreboard
//       path: "<base64 LE Int16 x,y pairs>",// downsampled positions
//       spts: [[x,y],...],                  // spawn points
//       dpts: [[x,y],...]                   // death points
//     } } }
//
// Keyed by player id: a player who leaves keeps their trace (leftTs set); a
// joiner is added on first sight. Positions clamp to the map's real dims
// (mappool.currentMapW/H) — maps aren't always 504x350.

var TRACE_CELL = 7;                 // px per heatmap cell (client derives the grid)
var TRACE_SAMPLE_MS = 250;          // position sample cadence
var TRACE_FLUSH_MS = 3000;          // live-node write cadence
var TRACE_RECENT_KEEP = 4;          // finished-game snapshots retained
var TRACE_MAX_PTS = 600;            // path points/player before decimation
var TRACE_MAX_MARKS = 60;           // cap spawn/death markers per player
var TRACE_BREAK = -32768;           // path sentinel: lift the pen between lives
                                    // (death -> respawn), so the trace isn't a
                                    // straight teleport line across the map

var TRACE_W = 504, TRACE_H = 350;
function traceResolveDims() {
    TRACE_W = (typeof currentMapW === 'number' && currentMapW > 0) ? currentMapW : 504;
    TRACE_H = (typeof currentMapH === 'number' && currentMapH > 0) ? currentMapH : 350;
}

var traceRef = null;
var traceRecs = null;        // id -> per-player record
var traceGameStart = 0;
var traceLevel = null;       // sticky: last non-empty level seen
var traceSampleTimer = null;
var traceFlushTimer = null;
var traceRunning = false;

function traceLevelName() {
    var l = (typeof currentMapName === 'string' && currentMapName) ? currentMapName
        : (statsCurrentLevelName ? statsCurrentLevelName() : null);
    if (l) traceLevel = l;       // remember it so a transient empty doesn't blank the map
    return traceLevel;
}

function initTrace() {
    if (typeof fdb == 'undefined' || !fdb) { setTimeout(initTrace, 200); return; }
    traceRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/trace`);
    chainFunction(window.WLROOM, 'onGameStart', traceOnGameStart);
    chainFunction(window.WLROOM, 'onGameEnd', traceOnGameEnd);
    chainFunction(window.WLROOM, 'onPlayerSpawn', traceOnSpawn);
    chainFunction(window.WLROOM, 'onPlayerKilled', traceOnKilled);
    chainFunction(window.WLROOM, 'onPlayerLeave', traceOnLeave);
    traceStartSampling(); // a hot-reload can land mid-game
    console.log('trace ok');
}

function traceNewRun() {
    traceResolveDims();
    traceRecs = {};
    traceGameStart = Date.now();
    traceLevelName();
}

// Key with a "p" prefix: bare small integer keys ("1","2") make Firebase coerce
// the players node into an ARRAY with null holes, which breaks readers.
function traceKey(p) { return 'p' + p.id; }

function traceRec(p) {
    var k = traceKey(p);
    var r = traceRecs[k];
    if (!r) {
        r = {
            name: p.name || '?', team: p.team || 0, color: 0xffffff,
            joinTs: Date.now(), leftTs: null, present: true,
            kills: 0, deaths: 0, score: 0,
            path: [], spts: [], dpts: [], lastX: null, lastY: null,
            pendingSpawn: true // capture the first sampled position as a spawn point
        };
        traceRecs[k] = r;
    }
    return r;
}

function traceWormXY(p) {
    var w = p && p.worm && p.worm.ua;
    if (!w) return null;
    if (typeof w.xa == 'number' && w.xa <= 0) return null; // dead
    var x = w.x, y = w.y;
    if (typeof x != 'number' || typeof y != 'number' || !isFinite(x) || !isFinite(y)) return null;
    if (x < 0 || y < 0 || x >= TRACE_W || y >= TRACE_H) return null;
    return { x: x, y: y, color: (typeof w.color == 'number' ? w.color : null) };
}

function traceStartSampling() {
    if (traceSampleTimer) return;
    if (!traceRecs) traceNewRun();
    traceRunning = true;
    traceSampleTimer = setInterval(traceSample, TRACE_SAMPLE_MS);
    traceFlushTimer = setInterval(traceFlushLive, TRACE_FLUSH_MS);
}

function traceStopSampling() {
    traceRunning = false;
    if (traceSampleTimer) { clearInterval(traceSampleTimer); traceSampleTimer = null; }
    if (traceFlushTimer) { clearInterval(traceFlushTimer); traceFlushTimer = null; }
}

function traceSample() {
    try {
        var list = window.WLROOM.getPlayerList();
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            if (!p.team || p.team == 0) continue; // spectators
            var pos = traceWormXY(p);
            if (!pos) continue;
            var r = traceRec(p);
            r.present = true; r.leftTs = null;
            r.name = p.name || r.name; r.team = p.team;
            if (pos.color != null) r.color = pos.color;
            var x = pos.x | 0, y = pos.y | 0;
            if (r.pendingSpawn) {
                // start of a new life: break the polyline so the previous
                // death and this spawn aren't joined by a line, and record the
                // spawn location.
                if (r.path.length) r.path.push(TRACE_BREAK, TRACE_BREAK);
                if (r.spts.length < TRACE_MAX_MARKS) r.spts.push([x, y]);
                r.pendingSpawn = false;
            }
            r.path.push(x, y); r.lastX = x; r.lastY = y;
            if (r.path.length > TRACE_MAX_PTS * 2) traceDecimate(r);
        }
        traceLevelName(); // keep level current (updates when currentMapName appears; sticky otherwise)
    } catch (e) {}
}

// Halve a path in place (keep every other point) when it gets too long, so the
// wire size stays bounded on a long game.
function traceDecimate(r) {
    // Halve the path (keep every other real point) but ALWAYS keep the break
    // sentinels, so life boundaries survive decimation.
    var out = [], keep = true;
    for (var i = 0; i + 1 < r.path.length; i += 2) {
        if (r.path[i] === TRACE_BREAK) { out.push(TRACE_BREAK, TRACE_BREAK); keep = true; continue; }
        if (keep) out.push(r.path[i], r.path[i + 1]);
        keep = !keep;
    }
    r.path = out;
}

function traceOnSpawn(player) {
    try {
        if (!traceRunning || !player) return;
        var r = traceRec(player);
        var pos = traceWormXY(player);
        // The worm's position often isn't set yet at the spawn callback, so mark
        // it pending and let the next sample record the actual spawn location.
        if (pos && r.spts.length < TRACE_MAX_MARKS) r.spts.push([pos.x | 0, pos.y | 0]);
        else r.pendingSpawn = true;
    } catch (e) {}
}

function traceOnKilled(killed) {
    try {
        if (!traceRunning || !killed) return;
        var r = traceRecs[traceKey(killed)];
        if (!r) return;
        // worm may already be gone; use the last sampled position
        var pos = traceWormXY(killed);
        var x = pos ? pos.x | 0 : r.lastX, y = pos ? pos.y | 0 : r.lastY;
        if (x != null && y != null && r.dpts.length < TRACE_MAX_MARKS) r.dpts.push([x, y]);
    } catch (e) {}
}

function traceOnLeave(player) {
    try {
        if (!player) return;
        var r = traceRecs[traceKey(player)];
        if (r) { r.present = false; r.leftTs = Date.now(); } // keep the trace
    } catch (e) {}
}

// base64 of a little-endian Int16 array (matches stats.html traceDecodePath).
function tracePackPath(arr) {
    var n = arr.length, i16 = new Int16Array(n);
    for (var i = 0; i < n; i++) { var v = arr[i]; i16[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
    var bytes = new Uint8Array(i16.buffer), bin = '';
    for (var j = 0; j < bytes.length; j += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 8192));
    return btoa(bin);
}

function traceRefreshStats() {
    // Pull current-game kills/deaths/score for players still present.
    try {
        for (var k in traceRecs) {
            var r = traceRecs[k];
            if (!r.present) continue;
            var sc = window.WLROOM.getPlayerScore(+k.replace(/^p/, ''));
            if (sc) { r.kills = sc.kills || 0; r.deaths = sc.deaths || 0; r.score = sc.score || 0; }
        }
    } catch (e) {}
}

function traceSnapshot(inProgress) {
    traceRefreshStats();
    var players = {};
    var count = 0;
    for (var k in traceRecs) {
        var r = traceRecs[k];
        if (!r.path.length && !r.spts.length) continue;
        players[k] = {
            name: r.name, team: r.team, color: r.color,
            joinTs: r.joinTs, leftTs: r.leftTs, present: !!r.present,
            kills: r.kills, deaths: r.deaths, score: r.score,
            path: tracePackPath(r.path), spts: r.spts, dpts: r.dpts
        };
        count++;
    }
    return {
        inProgress: !!inProgress, ts: Date.now(), startTs: traceGameStart,
        durationMs: Date.now() - traceGameStart,
        level: traceLevel || null, w: TRACE_W, h: TRACE_H, cell: TRACE_CELL,
        sampleMs: TRACE_SAMPLE_MS, playerCount: count, players: players
    };
}

function traceHasData() {
    if (!traceRecs) return false;
    for (var k in traceRecs) if (traceRecs[k].path.length) return true;
    return false;
}

function traceFlushLive() {
    try { if (traceRef && traceHasData()) traceRef.child('live').set(traceSnapshot(true)); } catch (e) {}
}

function traceOnGameStart() {
    traceStopSampling();
    traceNewRun();
    traceStartSampling();
}

function traceOnGameEnd() {
    traceStopSampling();
    try {
        if (traceRef && traceHasData()) traceRef.child('recent').push(traceSnapshot(false)).then(traceTrimRecent);
        if (traceRef) traceRef.child('live').update({ inProgress: false, ts: Date.now() });
    } catch (e) {}
    traceRecs = null; // next onGameStart / hot-reload starts fresh
}

function traceTrimRecent() {
    try {
        traceRef.child('recent').once('value').then(function (snap) {
            var keys = [];
            snap.forEach(function (c) { keys.push(c.key); });
            keys.sort();
            for (var i = 0; i < keys.length - TRACE_RECENT_KEEP; i++) traceRef.child('recent/' + keys[i]).remove();
        });
    } catch (e) {}
}

initTrace();
