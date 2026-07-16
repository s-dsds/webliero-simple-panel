// z_trace.js — worm-position tracing + heatmap (host-side).
//
// The room host IS server-authoritative and holds every worm's live position,
// so tracing runs right here in the fork — no observer bot, always-on for any
// room running this script. Reverse-engineered live on the headless build:
//
//   player            = WLROOM.getPlayerList()[i]     (wrapper: {worm, name, team, id})
//   player.worm       = the engine player record (Ra/ta/ia + score)
//   player.worm.ua    = the WORM entity (minified `ua` on headless; the client
//                       build calls the same slot `qa`). Fields:
//                         .x, .y        pixel position (NOT minified; sub-pixel floats)
//                         .xa           health 0..100 (0 / absent = dead)
//                         .direction    facing, .ya = y-velocity, .fa = {x,y} rope hook
//
// Positions advance every game tick (verified: a worm walked 128,220 → 106,257
// → 281,308 across samples). We accumulate a coarse density grid and write it to
//   simple/<roomId>/trace/live            (refreshed while a game runs)
//   simple/<roomId>/trace/recent/<pushId> (final snapshot per finished game)
// ext-proxy's /stats/<room>/api/trace + the Heatmap tab render it over the map.
// Wire format: base64 of little-endian Uint16 counts (see stats.html traceDecode).
//
// NOTE: an alternate CLIENT tracer (bot-commander scripts/bots/tracer.js) writes
// the same schema by reading ROOMOBJECT.Tb.W.B.qa on a spectator bot. Only ONE
// writer per room — this host-side tracer is the default; don't also run the bot.

var TRACE_CELL = 7;                               // downsample factor (px per cell)
// Map dims are resolved per-game from the loaded level (mappool.js tracks
// currentMapW/currentMapH). Classic .lev is 504x350 but PNG/raw maps vary, so
// these are NOT hardcoded — a fixed box would clip worms on a larger map.
var TRACE_W = 504, TRACE_H = 350;
var TRACE_GW = 72, TRACE_GH = 50;
function traceResolveDims() {
    TRACE_W = (typeof currentMapW === 'number' && currentMapW > 0) ? currentMapW : 504;
    TRACE_H = (typeof currentMapH === 'number' && currentMapH > 0) ? currentMapH : 350;
    TRACE_GW = Math.ceil(TRACE_W / TRACE_CELL);
    TRACE_GH = Math.ceil(TRACE_H / TRACE_CELL);
}
var TRACE_SAMPLE_MS = 250;                        // position sample cadence
var TRACE_FLUSH_MS = 3000;                        // live-node write cadence
var TRACE_RECENT_KEEP = 4;                        // finished-game snapshots retained

var traceRef = null;
var traceGrid = null;        // Uint32Array(GW*GH) — aggregate visit density
var traceSamples = 0;        // sample ticks that saw at least one worm
var traceWormSamples = 0;    // total worm positions recorded
var traceGameStart = 0;
var traceLevel = null;
var tracePlayers = null;     // key -> sample count (distinct-player estimate)
var traceSampleTimer = null;
var traceFlushTimer = null;

function initTrace() {
    if (typeof fdb == 'undefined' || !fdb) { setTimeout(initTrace, 200); return; }
    traceRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/trace`);
    chainFunction(window.WLROOM, 'onGameStart', traceOnGameStart);
    chainFunction(window.WLROOM, 'onGameEnd', traceOnGameEnd);
    // A hot-reload can land mid-game; start sampling now so the live heatmap
    // doesn't blank until the next onGameStart.
    traceStartSampling();
    console.log('trace ok');
}

function traceNewGrid() { return new Uint32Array(TRACE_GW * TRACE_GH); }

// traceWormXY resolves a player wrapper to its worm's pixel position, or null
// if the player has no live in-bounds worm (spectator, dead, not spawned).
function traceWormXY(p) {
    if (!p || !p.team || p.team == 0) return null;   // spectators excluded
    var w = p.worm && p.worm.ua;                       // the worm entity
    if (!w) return null;
    if (typeof w.xa == 'number' && w.xa <= 0) return null; // dead (health 0)
    var x = w.x, y = w.y;
    if (typeof x != 'number' || typeof y != 'number') return null;
    if (!isFinite(x) || !isFinite(y)) return null;
    if (x < 0 || y < 0 || x >= TRACE_W || y >= TRACE_H) return null;
    return { x: x, y: y };
}

// Prefer the fork's currentMapName (the actual loaded level); getSettings has
// no current-level field on the headless build.
function traceLevelName() {
    if (typeof currentMapName === 'string' && currentMapName) return currentMapName;
    return statsCurrentLevelName ? statsCurrentLevelName() : null;
}

function traceStartSampling() {
    if (traceSampleTimer) return;
    if (!traceGrid) {
        traceResolveDims();
        traceGrid = traceNewGrid();
        traceSamples = 0; traceWormSamples = 0;
        traceGameStart = Date.now(); tracePlayers = {};
        traceLevel = traceLevelName();
    }
    traceSampleTimer = setInterval(traceSample, TRACE_SAMPLE_MS);
    traceFlushTimer = setInterval(traceFlushLive, TRACE_FLUSH_MS);
}

function traceStopSampling() {
    if (traceSampleTimer) { clearInterval(traceSampleTimer); traceSampleTimer = null; }
    if (traceFlushTimer) { clearInterval(traceFlushTimer); traceFlushTimer = null; }
}

function traceSample() {
    try {
        var list = window.WLROOM.getPlayerList();
        var any = false;
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            var pos = traceWormXY(p);
            if (!pos) continue;
            var gx = (pos.x / TRACE_CELL) | 0, gy = (pos.y / TRACE_CELL) | 0;
            traceGrid[gy * TRACE_GW + gx]++;
            traceWormSamples++;
            any = true;
            var key = p.auth || (auth && auth.get(p.id)) || p.name;
            if (key) tracePlayers[key] = (tracePlayers[key] || 0) + 1;
        }
        if (any) {
            traceSamples++;
            if (!traceLevel && statsCurrentLevelName) traceLevel = statsCurrentLevelName();
        }
    } catch (e) {}
}

// traceEncode packs the grid as base64 of a little-endian Uint16 array (counts
// clamped to 65535). 72*50 cells -> 7200 bytes -> ~9.6 KB base64: one small,
// fixed-size field regardless of game length or player count.
function traceEncode(grid) {
    var n = grid.length;
    var u16 = new Uint16Array(n);
    for (var i = 0; i < n; i++) u16[i] = grid[i] > 65535 ? 65535 : grid[i];
    var bytes = new Uint8Array(u16.buffer);
    var bin = '';
    for (var j = 0; j < bytes.length; j += 8192) {
        bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 8192));
    }
    return btoa(bin);
}

function traceSnapshot(inProgress) {
    return {
        inProgress: !!inProgress,
        ts: Date.now(),
        startTs: traceGameStart,
        durationMs: Date.now() - traceGameStart,
        level: traceLevel || (statsCurrentLevelName ? statsCurrentLevelName() : null) || null,
        gw: TRACE_GW, gh: TRACE_GH, cell: TRACE_CELL, w: TRACE_W, h: TRACE_H,
        samples: traceSamples,
        wormSamples: traceWormSamples,
        players: tracePlayers ? Object.keys(tracePlayers).length : 0,
        grid: traceEncode(traceGrid)
    };
}

function traceFlushLive() {
    try {
        if (!traceRef || !traceGrid || !traceSamples) return;
        traceRef.child('live').set(traceSnapshot(true));
    } catch (e) {}
}

function traceOnGameStart() {
    traceStopSampling();
    traceResolveDims();
    traceGrid = traceNewGrid();
    traceSamples = 0; traceWormSamples = 0;
    traceGameStart = Date.now();
    traceLevel = traceLevelName();
    tracePlayers = {};
    traceStartSampling();
}

function traceOnGameEnd() {
    traceStopSampling();
    try {
        if (traceRef && traceGrid && traceSamples) {
            traceRef.child('recent').push(traceSnapshot(false)).then(traceTrimRecent);
        }
        if (traceRef) traceRef.child('live').update({ inProgress: false, ts: Date.now() });
    } catch (e) {}
    traceGrid = null; // next onGameStart / hot-reload allocates a fresh one
}

// Keep only the newest TRACE_RECENT_KEEP snapshots (push ids sort chronologically).
function traceTrimRecent() {
    try {
        traceRef.child('recent').once('value').then(function (snap) {
            var keys = [];
            snap.forEach(function (c) { keys.push(c.key); });
            keys.sort();
            var extra = keys.length - TRACE_RECENT_KEEP;
            for (var i = 0; i < extra; i++) traceRef.child('recent/' + keys[i]).remove();
        });
    } catch (e) {}
}

initTrace();
