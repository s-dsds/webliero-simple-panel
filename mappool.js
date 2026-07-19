var mapCache = new Map();
var baseURL = "https://webliero.gitlab.io/webliero-maps";
var mypool = {};
var mypoolIdx = [];

var otherPools = new Map();

var currentMap = 0;
var currentMapName = "";

// Play-order mode: "shuffle" (randomized, reshuffled each full cycle, avoids
// back-to-back repeats) or "ordered" (play the pool in its saved order, or a
// manual order set from the panel). Persisted to RTDB poolmode so it survives.
var poolMode = "shuffle";
var poolModeRef;
var lastPlayedKey = null; // for the no-immediate-repeat guard across reshuffles

// Per-map player-count bounds (RTDB poolbounds: { "<mapname>": {min,max} }).
// At rotation the next map is skipped if the room's player count is outside its
// bounds — so small maps can be reserved for few players and vice-versa.
var poolBounds = {};
var poolBoundsRef;

// Consecutive map-load failures. A map that won't fetch must not wedge the
// rotation (that stalls the room on the end screen): we log it and advance to
// the next map, and only fall back to restarting the current level once we've
// tried the whole pool without a single load succeeding.
var mapLoadFailures = 0;
// A FIXED cap on consecutive load failures before we give up and restart on the
// current level. Must NOT scale with pool size: pool_war.json has ~79 maps and
// each failed attempt can now burn up to the 20s fetch-abort window, so a
// pool-sized bound could wedge the room on the end screen for ~26 minutes during
// a real outage. A small constant bounds worst-case recovery to a few seconds.
var MAX_MAP_LOAD_FAILURES = 5;
// Monotonic load generation. Every loadMapByName call claims the next value;
// when its async fetch finally resolves it only applies the result (or advances
// on failure) if it's still the newest request. Without this, a slow/aborting
// fetch for map A can resolve AFTER an admin's !map B already loaded, and stomp
// B's level + currentMapName (which z_trace + the panel read).
var mapLoadSeq = 0;

// Number of players the next map should be sized for. Uses active (non-spectator)
// worms; falls back to everyone in the room, then to "many" so bounds never wedge.
function playerCountForMaps() {
    try {
        var ps = window.WLROOM.getPlayerList();
        var active = ps.filter(function (p) { return p.team && p.team !== 0; }).length;
        return active || ps.length || 0;
    } catch (e) { return 99; }
}

function mapFitsPlayers(name, n) {
    var b = poolBounds[name];
    if (!b) return true;
    if (typeof b.min === "number" && b.min > 0 && n < b.min) return false;
    if (typeof b.max === "number" && b.max > 0 && n > b.max) return false;
    return true;
}

// rebuildPoolIdx derives the play order (mypoolIdx) from the current pool.
//   reset=true  (mode switch / initial): derive fresh — ordered = the pool's
//               saved order, shuffle = a full shuffle.
//   reset=false (a pool add/remove at runtime): PRESERVE the current order for
//               maps still present and append any new ones (shuffled in shuffle
//               mode). This is the fix for the old behaviour that reshuffled the
//               whole order — and lost a manual arrangement — on every edit.
function rebuildPoolIdx(reset) {
    var keys = Object.keys(mypool);
    if (reset) {
        mypoolIdx = keys.slice();
        if (poolMode === "shuffle") shuffleArray(mypoolIdx);
    } else {
        var kept = mypoolIdx.filter(function (k) { return mypool[k] !== undefined; });
        var added = keys.filter(function (k) { return kept.indexOf(k) < 0; });
        if (poolMode === "shuffle") shuffleArray(added);
        mypoolIdx = kept.concat(added);
    }
    if (currentMap >= mypoolIdx.length) currentMap = 0;
    publishPoolState();
}

// smartReshuffle randomizes the order and nudges the first map so it isn't the
// one we just finished playing (no back-to-back repeat across the cycle seam).
function smartReshuffle() {
    shuffleArray(mypoolIdx);
    if (mypoolIdx.length > 1 && mypoolIdx[0] === lastPlayedKey) {
        var j = 1 + Math.floor(Math.random() * (mypoolIdx.length - 1));
        var t = mypoolIdx[0]; mypoolIdx[0] = mypoolIdx[j]; mypoolIdx[j] = t;
    }
}

function loadPool(name) {
	(async () => {
	mypool = await (await fetch(baseURL + '/' +  name)).json();
	})();
}

function getMapUrl(name) {
    // http:// too — local/dev map hosts (e.g. an ext-proxy dev instance
    // serving /mapfile uploads); https-only silently glued the URL onto
    // baseURL and 404'd.
    if (/^https?:\/\//.test(name)) {
        return name;
    }
    return baseURL + '/' +  name;
}

async function getMapData(mapUrl) {
    let obj = mapCache.get(mapUrl)
    if (obj) {
      return obj;
    }
    // A HUNG fetch is worse than a failed one: a network/VPN change mid-request
    // can stall the connection without ever rejecting, and the await then wedges
    // the rotation forever (room stuck on the end screen). Abort after 20s so a
    // hang becomes a normal logged failure that skips to the next map.
    var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : null;
    try {
        var resp = await fetch(mapUrl, ctl ? { signal: ctl.signal } : {});
        if (!resp.ok) {                       // 404/5xx: log it — don't fail silently
            console.log("mappool: map fetch " + mapUrl + " -> HTTP " + resp.status);
            return null;
        }
        obj = await resp.arrayBuffer();
    } catch (e) {                             // network/CORS error or 20s abort: log it too
        console.log("mappool: map fetch " + mapUrl + " failed: " + ((e && e.message) || e));
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
    mapCache.set(mapUrl, obj)
    return obj;
}

// Current level pixel dims. Tracked at load so the heatmap tracer (z_trace.js)
// can size its grid to the real map — .lev is always 504x350, but PNG/raw maps
// vary and worms outside a fixed 504x350 box would otherwise be clipped.
var currentMapW = 504, currentMapH = 350;

// Read width/height from a PNG's IHDR (sig 8 bytes, then width@16/height@20 BE).
function pngDims(data) {
    try {
        var dv = data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer || data);
        if (dv.getUint32(0) === 0x89504e47) return { w: dv.getUint32(16), h: dv.getUint32(20) };
    } catch (e) {}
    return null;
}

// onLoadFailure: shared skip-or-restart policy for a failed load. Bounded by a
// FIXED count so a full outage restarts in seconds, not minutes.
function onLoadFailure(name, reason) {
    console.log("mappool: " + reason + " '" + name + "' — advancing to next map");
    notifyAdmins(`map ${name} could not be loaded — skipping to the next one`);
    if (++mapLoadFailures <= MAX_MAP_LOAD_FAILURES) {
        resolveNextMap();
    } else {
        mapLoadFailures = 0;
        console.log("mappool: " + MAX_MAP_LOAD_FAILURES + " maps failed to load in a row; restarting on current level");
        window.WLROOM.restartGame();
    }
}

function loadMapByName(name) {
    console.log(name);
    var myGen = ++mapLoadSeq; // claim this load; a later call supersedes us
    (async () => {
        let data = await getMapData(getMapUrl(name));
        // A newer load was requested while our fetch was in flight (e.g. auto
        // rotation raced by an admin !map). Drop this stale result entirely —
        // don't apply the level and don't advance-on-failure, or we'd stomp the
        // map the newer request already chose.
        if (myGen !== mapLoadSeq) {
            console.log("mappool: stale load of '" + name + "' (gen " + myGen + " < " + mapLoadSeq + ") — ignored");
            return;
        }
        if (data == null) {
            onLoadFailure(name, "could not load");
            return;
        }
        mapLoadFailures = 0; // a successful load clears the failure streak
        // Optional map-transform hook (plugin extension point — newjohn effects).
        // A registered async transform gets the RAW fetched bytes and may return
        // {width,height,data:[palette indices]} to load via loadRawLevel instead
        // of the plain engine load. Errors or null fall through to the normal
        // path — the hook must never be able to wedge the rotation. The stale-
        // load re-check runs again AFTER the await, since a transform can take
        // long enough for a newer load to supersede us.
        if (typeof window.WL_MAP_TRANSFORM === 'function') {
            let t = null;
            try {
                t = await window.WL_MAP_TRANSFORM(name, data);
            } catch (e) {
                console.log("mappool: map transform failed on '" + name + "': " + ((e && e.message) || e) + " — loading untransformed");
            }
            if (myGen !== mapLoadSeq) {
                console.log("mappool: stale load of '" + name + "' (post-transform) — ignored");
                return;
            }
            if (t && t.data && t.width > 0 && t.height > 0 && t.data.length === t.width * t.height) {
                try {
                    currentMapW = t.width; currentMapH = t.height;
                    currentMapName = name;
                    window.WLROOM.loadRawLevel(name, new Uint8Array(t.data).buffer, t.width, t.height);
                    return; // transformed load replaces the plain one
                } catch (e) {
                    onLoadFailure(name, "engine failed to load transformed (" + ((e && e.message) || e) + ")");
                    return;
                }
            } else if (t) {
                // A torn transform result (len !== w*h) must NEVER reach the
                // engine — that's the newjohn silent-freeze class. Load plain.
                console.log("mappool: transform returned invalid buffer for '" + name + "' (" +
                    (t.width + "x" + t.height + " vs len " + (t.data ? t.data.length : "?")) + ") — loading untransformed");
            }
        }
        try {
            if (name.split('.').pop()=="png") {
                let d = pngDims(data);
                currentMapW = d ? d.w : 504; currentMapH = d ? d.h : 350;
                currentMapName = name; // keep the name tied to the ACTUAL loaded map
                window.WLROOM.loadPNGLevel(name, data);
            } else {
                currentMapW = 504; currentMapH = 350; // classic .lev is fixed size
                currentMapName = name;
                window.WLROOM.loadLev(name, data);
            }
        } catch (e) {
            // The ENGINE rejected the bytes (e.g. a PNG layout its hand-rolled
            // parser can't read — seen live: "RangeError: Offset is outside the
            // bounds of the DataView" on a GIMP export with ancillary chunks).
            // Same policy as a failed fetch: log, warn, skip — never wedge the
            // rotation on the end screen.
            onLoadFailure(name, "engine failed to load (" + ((e && e.message) || e) + ")");
        }
    })();
}

function loadMap(name, data) {
    console.log(data.data.length);
    console.log(data.data[2]);
    let buff=new Uint8Array(data.data).buffer;
    currentMapW = data.x || 504; currentMapH = data.y || 350;
    window.WLROOM.loadRawLevel(name,buff, data.x, data.y);
}

function advanceOne() {
    if (currentMap + 1 < mypoolIdx.length) {
        currentMap = currentMap + 1;
    } else {
        // reached the end of the play list: wrap, and in shuffle mode reshuffle
        // for a fresh order each cycle (ordered mode just loops in place).
        currentMap = 0;
        if (poolMode === "shuffle") smartReshuffle();
    }
}

function resolveNextMap() {
    if (mypoolIdx.length) lastPlayedKey = mypoolIdx[currentMap];
    advanceOne();
    // Skip maps whose player-count bounds don't fit the current room (bounded
    // scan; if nothing fits we just keep wherever we landed — never wedge).
    var n = playerCountForMaps();
    for (var tries = 0; tries < mypoolIdx.length - 1 && !mapFitsPlayers(mypool[mypoolIdx[currentMap]], n); tries++) {
        advanceOne();
    }
    let nn = mypool[mypoolIdx[currentMap]];
    if (nn) currentMapName = nn; // keep the last valid name if the pool resolves empty
                                 // (don't blank it — that wedged the map underlay
                                 // and forced the empty-pool restart path)
    loadMapOrSubPool()
    publishPoolState();
}

function loadMapOrSubPool(mapName) {
    let mn = mapName ?? currentMapName
    // Empty pool → resolveNextMap sets currentMapName=undefined; without this guard the
    // substring below throws and the game-end rotation dies, wedging the room on the
    // scoreboard forever (no map load → no restart → no onGameStart).
    if (!mn) {
        console.log("mappool: pool is empty, restarting on current level");
        window.WLROOM.restartGame();
        return;
    }
    if (mn.substring(0,15)=="random#https://") {
        resolveNextSubPoolMap(mn)
    } else {
        loadMapByName(mn);
    }
}

function resolveNextSubPoolMap(mapName) {
    let mn = mapName ?? currentMapName
    let poolname = mn.replace("random#","");
    if (typeof otherPools[poolname] =="undefined") {
        loadSubPool(poolname, applyNextSubPoolMap)
    } else {
        applyNextSubPoolMap(poolname)
    }   
}

function applyNextSubPoolMap(poolname) {
    let pool = otherPools[poolname]
    pool.currentMap = pool.currentMap+1<pool.idx.length?pool.currentMap+1:0;    
    currentMapName = pool.baseURL+'/'+pool.maps[pool.idx[pool.currentMap]];
    loadMapByName(currentMapName);

}

function loadSubPool(poolURL, callback) {
    (async () => {
        let pool = await (await fetch(poolURL)).json();
        otherPools[poolURL] = {
            currentMap: 0,
            idx:Object.keys(pool),
            baseURL: pool.baseURL?? poolURL.substring(0, poolURL.lastIndexOf("/"))
        };
        shuffleArray(pool);
        otherPools[poolURL].maps= pool;
        callback(poolURL);
    })();
}

function next() {
    resolveNextMap();

    
}

function shufflePool() {
    mypoolIdx = Object.keys(mypool);
    shuffleArray(mypoolIdx)
    publishPoolState();
}

/** room-admin-panel: runtime play-order visibility + control.
 * poolstate (room → panel): the CURRENT shuffled order + position — this is
 * runtime state, distinct from the persisted pool node's order.
 * poolctl (panel → room): one-shot commands, cleared after applying:
 *   {action:"shuffle"} | {action:"setnext",index} | {action:"playnow",index}
 * index refers to a position in the published poolstate.order. */
var poolStateRef;
var poolCtlRef;

function initPoolPanel() {
    if (typeof fdb == 'undefined' || !fdb) {
        setTimeout(initPoolPanel, 200);
        return;
    }
    poolStateRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/poolstate`);
    poolCtlRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/poolctl`);
    poolModeRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/poolmode`);
    poolModeRef.once('value').then((s) => {
        var m = s.val();
        if (m === 'ordered' || m === 'shuffle') { poolMode = m; rebuildPoolIdx(true); }
    });
    poolBoundsRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/poolbounds`);
    poolBoundsRef.on('value', (s) => { poolBounds = s.val() || {}; });
    poolCtlRef.on('value', (snap) => {
        const c = snap.val();
        if (!c || !c.action) {
            return;
        }
        poolCtlRef.set(null); // one-shot: consume before applying
        applyPoolCtl(c);
    });
    publishPoolState();
    console.log("poolpanel ok");
}
initPoolPanel();

function publishPoolState() {
    if (!poolStateRef) {
        return;
    }
    poolStateRef.set({
        order: mypoolIdx.map((k) => mypool[k] ?? null),
        current: currentMap,
        currentMapName: currentMapName || null,
        mode: poolMode,
        updatedAt: Date.now()
    });
}

function applyPoolCtl(c) {
    if (c.action == "shuffle") {
        shufflePool();
        currentMap = 0;
        publishPoolState();
        notifyAdmins("map pool play order reshuffled (panel)");
    } else if (c.action == "setnext" && typeof c.index == "number" && mypoolIdx.length) {
        // next rotation lands on index: resolveNextMap advances by one first
        currentMap = ((c.index - 1) + mypoolIdx.length) % mypoolIdx.length;
        publishPoolState();
        notifyAdmins(`next map set to ${mypool[mypoolIdx[c.index]]} (panel)`);
    } else if (c.action == "playnow" && typeof c.index == "number" && mypoolIdx.length) {
        currentMap = ((c.index) + mypoolIdx.length) % mypoolIdx.length;
        currentMapName = mypool[mypoolIdx[currentMap]];
        loadMapOrSubPool();
        publishPoolState();
        notifyAdmins(`map switched to ${currentMapName} (panel)`);
    } else if (c.action == "setorder" && Array.isArray(c.order)) {
        // Manual play order: reorder mypoolIdx to match the given list of map
        // NAMES (from the panel's drag-and-drop). Names can repeat, so consume
        // pool keys per name; any pool map not listed is appended (safety).
        var byName = {};
        Object.keys(mypool).forEach(function (k) { (byName[mypool[k]] = byName[mypool[k]] || []).push(k); });
        var newIdx = [];
        c.order.forEach(function (name) { var ks = byName[name]; if (ks && ks.length) newIdx.push(ks.shift()); });
        Object.keys(mypool).forEach(function (k) { if (newIdx.indexOf(k) < 0) newIdx.push(k); });
        mypoolIdx = newIdx;
        currentMap = 0;
        publishPoolState();
        notifyAdmins("play order set manually (panel)");
    } else if (c.action == "mode" && (c.mode == "shuffle" || c.mode == "ordered")) {
        poolMode = c.mode;
        if (poolModeRef) poolModeRef.set(poolMode);
        rebuildPoolIdx(true);
        notifyAdmins("map order mode set to " + poolMode + " (panel)");
    } else if (c.action == "clearcache") {
        // Drop cached map data so the next load re-fetches from the source —
        // the panel-side twin of the in-room !clearcache command.
        var n = mapCache.size;
        mapCache.clear();
        console.log("mappool: map cache cleared (panel), " + n + " entries dropped");
        notifyAdmins("map cache cleared (panel), " + n + " entries dropped");
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

COMMAND_REGISTRY.add("map", ["!map #mapname#: load lev map from gitlab webliero.gitlab.io"], (player, ...name) => {
    let n = name.join(" ").trim();
    if (n == "") {
        announce("map name is empty ",player, 0xFFF0000);
    }
    currentMapName = n;
    loadMapOrSubPool();
    return false;
}, COMMAND.ADMIN_ONLY);

function moveToGame(player) {
    window.WLROOM.setPlayerTeam(player.id, 1);
}

function moveToSpec(player) {
    window.WLROOM.setPlayerTeam(player.id, 0);
}

COMMAND_REGISTRY.add("mapi", ["!mapi #index#: load map by pool index"], (player, idx) => {
    if (typeof idx=="undefined" || idx=="" || isNaN(idx) || idx>=mypoolIdx.length) {
        announce("wrong index, choose any index from 0 to "+(mypoolIdx.length-1),player, 0xFFF0000);
        return false;
    }
    currentMapName = mypool[idx];
    loadMapOrSubPool();
    return false;
}, COMMAND.ADMIN_ONLY);

COMMAND_REGISTRY.add("clearcache", ["!clearcache: clears local map cache"], (player) => {
    mapCache = new Map();
    return false;
}, COMMAND.ADMIN_ONLY);

COMMAND_REGISTRY.add("admin", ["!admin: if you're entitled to it, you get admin"], (player) => {
    let a = auth.get(player.id);
    if (admins.has(a) ) {
		window.WLROOM.setPlayerAdmin(player.id, true);
	}
    return false;
}, COMMAND.FOR_ALL);

COMMAND_REGISTRY.add("addmap", ["!addmap #name: adds a map to the current pool"], (player, mapname ="")=> {   
    if (mapname=="") {
        announce(`map name is empty, should be either on "https://webliero.gitlab.io/webliero-maps/pools/index.json" or a correct https link`, player.id, COLORS.ERROR)
        return false
    }
    if (mapname.indexOf(baseURL)==0) {
        mapname=mapname.substring(baseURL.length+1)
    }
    (async () => {
        // getMapData is async — the old `null == getMapData(...)` compared a
        // Promise (never null), so the "could not load" guard was dead code and
        // bad maps got added anyway. Await it.
        if (null == (await getMapData(getMapUrl(mapname)))) {
            announce(`map ${mapname} could not be loaded`, player.id, COLORS.ERROR)
            return;
        }
        addMap(mapname)
        announce(`map ${mapname} was added to the pool`, null, COLORS.ANNOUNCE_BRIGHT)
        
    })();
    return false;
},  COMMAND.SUPER_ADMIN_ONLY);

COMMAND_REGISTRY.add("delmaplast", ["!delmap: removes last map from the current pool"], (player, idx =null)=> {   
    if (mypoolIdx.length==0) {
        return false
    }
    /* if (null==idx) {
        announce(`you need to provide an index btw 0 and ${mypoolIdx.length-1}`, player.id, COLORS.ERROR)
        return false
    }*/
    delMapLast()
   // announce(`map ${idx} was removed from the pool`, null, COLORS.ANNOUNCE_BRIGHT)   
    
    return false;
},  COMMAND.SUPER_ADMIN_ONLY);

COMMAND_REGISTRY.add(["addadmin","aa"], ["!addadmin #id: adds an admin"], (player, pid ="")=> {
    pid = pid.replace("#","")
    let p = window.WLROOM.getPlayer(parseInt(pid))
    if (!p) {
        announce(`player id ${pid} not found`)
        return false
    }
    addAdmin(p)
    window.WLROOM.setPlayerAdmin(parseInt(pid), true)
    announce(`player ${p.name} as been added to the perm admin list`, null, COLORS.ANNOUNCE_BRIGHT)
    return false;
},  COMMAND.SUPER_ADMIN_ONLY);


COMMAND_REGISTRY.add(["listadmins","la"], ["!listadmins: list all admins"], (player)=> {
    for (const a of admins.values()) {
        announce(`${a.name} ${a.auth} ${a.super?'(super admin)':''}`, player.id, COLORS.ANNOUNCE_BRIGHT)
    }
    return false;
},  COMMAND.SUPER_ADMIN_ONLY);

COMMAND_REGISTRY.add(["deladmin","da"], ["!deladmin #auth: removes an admin"], (player, a="")=> {
    if (!isNaN(a.replace("#",""))) {
        let pid = parseInt(a.replace("#",""))
        let p = window.WLROOM.getPlayer(pid)
        if (p) {
            a = auth.get(p.id)        
        }
    }
    if (!admins.get(a)) {
        announce(`${a} is not perm admin`)
        return false
    }
    if (isSuperAdmin(admins.get(a))) {
        announce(`${a} cannot delete a super admin`)
        return false
    }
    try {
        const name = removeAdmin(a)
        announce(`${name} as been removed from the perm admin list`, null, COLORS.ANNOUNCE_BRIGHT)
    } catch(error) {
        announce(`error removing ${a} from admin list`, player, COLORS.ERROR)
        console.log(`------- error removing admin ${a} : ${error}`)
    }    
    
    return false;
},  COMMAND.SUPER_ADMIN_ONLY);

// When the arena ladder plugin owns this room, it registers queue-aware
// !q/!quit + !j/!join and these casual versions must NOT exist: the registry
// silently overwrites on name collision, so a hot-reload of THIS file alone
// would otherwise clobber the ladder's handlers back to these (a !q that
// leaves the player queued forever; a !j with no isFull gate that can shove a
// 3rd player into a duel). Cold boot is safe either way (this registers first,
// arena overwrites at plugin init); the sentinel makes hot-reload safe too.
if (!window.__ARENA_PLUGIN) {
    COMMAND_REGISTRY.add(["quit","q"], ["!quit or !q: spectate if in game"], (player)=> {
        moveToSpec(player);
        return false;
    }, COMMAND.FOR_ALL);


    COMMAND_REGISTRY.add(["join","j"], ["!join or !j: joins the game if spectating"], (player)=> {
        if (!window.WLROOM.getSettings().teamsLocked || player.admin) {
            moveToGame(player);
        }
        return false;
    }, COMMAND.FOR_ALL);
}

COMMAND_REGISTRY.add(["joinquit","jq", "quitjoin", "qj"], ["!joinquit or jq or quitjoin or qj: move out and back in the game"], (player)=> {
    if (window.__ARENA_PLUGIN) { return false; } // arena rooms: seats are queue-managed
    moveToSpec(player)
    moveToGame(player)
    return false;
}, COMMAND.FOR_ALL);