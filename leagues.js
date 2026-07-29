/** arena-leagues phase 1 (settings facet): catalog + pointer + commands + mirror.
 * Spec: _specs/arena-leagues.md. Nodes: `leagues` (catalog, panel-written),
 * `league` (active pointer, panel+room), `leaguestate` (room-written mirror).
 * The room NEVER validates the catalog (ext-proxy does) — it resolves and
 * applies defensively: garbage is logged, surfaced in leaguestate.warnings and
 * skipped, never allowed to wedge the room.
 *
 * Mod/pool/poolbounds/weapons facets are phase 1b/4 — ignored here if present
 * (a warning notes the ignored facets so admins aren't left guessing).
 */

var leaguesCatalog = null;   // raw `leagues` node value
var leagueActive = null;     // { id, name, settings, appliedAt } — what is LIVE
var leaguePending = null;    // { id } awaiting the next onGameStart
var leagueNodeCache = null;  // cache-only mirror of the `settings` node (never applies)
var leagueGameInProgress = false;
var leagueWarnings = [];
var leaguesRef = null, leaguePtrRef = null, leagueStateRef = null;
var leagueBootDone = false;  // pointer replay done (needs catalog + pointer + settings)
var leagueBootPtr = undefined; // last seen pointer value (undefined = not arrived yet)

// Settings driven continuously by plugins: carried forward from the LIVE value
// unless the settings node or the league explicitly names them (spec §3 trap 3).
// teamsLocked: arena plugin setLock; expandLevel: newjohn read-modify-write.
var LEAGUE_RUNTIME_KEYS = ["teamsLocked", "expandLevel"];

// ── loadSettings wrap (spec §3) ─────────────────────────────────────────────
// Wrapped at FILE LOAD (firebase.js's settings listener can fire before our
// async init) and guarded against double-wrap on a hot reload. NOTE a hot
// reload of firebase.js would silently UN-wrap us — fork deploys are
// room-restart-only for this file pair.
if (!window.__LEAGUE_WRAPPED) {
    window.__LEAGUE_WRAPPED = true;
    var leagueBaseLoadSettings = loadSettings;
    loadSettings = function (sett) {
        leagueBaseLoadSettings(leagueOverlay(sett));
    };
}

// Effective settings = engine defaults ⊕ settings node ⊕ league overrides,
// rebuilt from clean sources every time — getSettings() reflects CURRENT state
// (including the outgoing league), so patching `sett` in place would leak keys
// between leagues. Node-only keys (afkLimit…) ride in via the node cache.
function leagueOverlay(sett) {
    if (!window.__LEAGUE_BOOT_SETTINGS) {
        // First invocation IS the first application of the settings node: the
        // engine still holds its defaults. Sentinel survives hot reloads.
        window.__LEAGUE_BOOT_SETTINGS = Object.assign({}, window.WLROOM.getSettings());
    }
    // Zero behavior change until a league has EVER been active this lifetime.
    // After that, ALWAYS rebuild — including deactivation: the settings node
    // can be SPARSE (only panel-touched keys), so `sett`/settingsSnap stays
    // polluted with the outgoing league's values for every key the node
    // doesn't name (found live: bonusDrops/weaponChangeDelay survived
    // !leagueoff on a sparse node).
    if (!leagueActive && !window.__LEAGUE_TOUCHED) return sett;
    // On the very first call the cache may not have fired yet; at that moment
    // `sett` IS defaults ⊕ node (unpolluted), so it's a safe fallback.
    var node = leagueNodeCache || sett || {};
    var lgSettings = leagueActive ? leagueActive.settings : {};
    var out = Object.assign({}, window.__LEAGUE_BOOT_SETTINGS, node, lgSettings);
    var live = window.WLROOM.getSettings();
    for (var i = 0; i < LEAGUE_RUNTIME_KEYS.length; i++) {
        var k = LEAGUE_RUNTIME_KEYS[i];
        var named = (k in node) || (k in lgSettings);
        if (!named && (k in live)) out[k] = live[k];
    }
    return out;
}

// ── resolution (single-level extends, spec §2) ──────────────────────────────
function leagueResolve(id) {
    var cat = leaguesCatalog || {};
    var L = cat[id];
    if (!L || typeof L !== "object") return null;
    var settings = {};
    var warnings = [];
    if (typeof L.extends === "string" && L.extends) {
        var P = cat[L.extends];
        if (!P || typeof P !== "object") {
            warnings.push('parent "' + L.extends + '" missing — extends ignored');
        } else {
            if (P.extends) warnings.push('parent "' + L.extends + '" itself extends — grandparent ignored');
            if (P.settings && typeof P.settings === "object") Object.assign(settings, P.settings);
        }
    }
    if (L.settings && typeof L.settings === "object") Object.assign(settings, L.settings);
    var ignored = ["mod", "pool", "poolbounds", "weapons"].filter(function (f) {
        return L[f] || (L.extends && cat[L.extends] && cat[L.extends][f]);
    });
    if (ignored.length) warnings.push("facets not supported yet (ignored): " + ignored.join(", "));
    return {
        id: id,
        name: (typeof L.name === "string" && L.name) || id,
        settings: settings,
        warnings: warnings,
    };
}

// ── apply machinery ─────────────────────────────────────────────────────────
// Gate: apply immediately when idle or forced "now"; otherwise queue to the
// next onGameStart (a pending switch never waits on an idle room — checked at
// queue time AND replayed at game start).
function leagueRequest(id, applyAt, opts) {
    id = typeof id === "string" ? id : "";
    var force = opts && opts.force;
    // dedup (spec: mirrors lastAppliedModKey): re-pointing at the applied
    // league must not re-queue anything
    var activeID = leagueActive ? leagueActive.id : "";
    if (!force && id === activeID && !leaguePending) return;
    if (applyAt === "now" || !leagueGameInProgress) {
        leagueApply(id);
    } else {
        leaguePending = { id: id };
        console.log('league: "' + (id || "(off)") + '" queued for next game start');
        writeLeagueState();
    }
}

function leagueApply(id) {
    leaguePending = null;
    leagueWarnings = [];
    if (!id) {
        if (leagueActive) console.log("league: deactivated (base config)");
        leagueActive = null;
        window.leagueCurrent = null;
    } else {
        var r = leagueResolve(id);
        if (!r) {
            // unknown id: keep whatever is live, surface it (spec §6)
            leagueWarnings.push('unknown league "' + id + '" — kept current config');
            console.log('league: unknown id "' + id + '"');
            writeLeagueState();
            return;
        }
        leagueWarnings = r.warnings;
        leagueActive = { id: id, name: r.name, settings: r.settings, appliedAt: Date.now() };
        window.__LEAGUE_TOUCHED = true; // from now on the overlay always rebuilds
        window.leagueCurrent = { id: id, name: r.name }; // consumed by z_stats
        console.log('league: applied "' + id + '" (' + Object.keys(r.settings).length + " setting(s))");
    }
    leagueReapplySettings();
    writeLeagueState();
}

function leagueReapplySettings() {
    // Route through the wrapped loadSettings so the overlay is the ONE place
    // effective settings are computed. settingsSnap is undefined until the
    // settings listener first fires — fall back to the cache, then to live.
    var base = window.settingsSnap || leagueNodeCache || window.WLROOM.getSettings();
    loadSettings(Object.assign({}, base));
}

// ── mirror (leaguestate) ────────────────────────────────────────────────────
function writeLeagueState() {
    if (!leagueStateRef) return;
    leagueStateRef.set({
        id: leagueActive ? leagueActive.id : "",
        name: leagueActive ? leagueActive.name : "",
        appliedAt: leagueActive ? leagueActive.appliedAt : 0,
        facets: leagueActive ? ["settings"] : [],
        pending: leaguePending ? { id: leaguePending.id } : null,
        warnings: leagueWarnings.slice(0, 10),
        updatedAt: Date.now(),
    });
}

// ── boot + listeners ────────────────────────────────────────────────────────
function initLeagues() {
    if (typeof fdb == "undefined" || !fdb || typeof window.WLROOM == "undefined") {
        setTimeout(initLeagues, 200);
        return;
    }
    var basePath = baseRoomName + "/" + CONFIG.room_id;
    leaguesRef = fdb.ref(basePath + "/leagues");
    leaguePtrRef = fdb.ref(basePath + "/league");
    leagueStateRef = fdb.ref(basePath + "/leaguestate");

    // The capability flag (meta.leagues) is written by panel.js's
    // writePanelMeta alongside meta.weapons/meta.stats — it SETs the whole
    // meta node, so an update() here would just get wiped.

    // cache-only settings listener: never applies, only lets the overlay know
    // the node's actual keys (getSettings() can't reconstruct them)
    fdb.ref(basePath + "/settings").on("value", function (snap) {
        leagueNodeCache = snap.val() || {};
    });

    leaguesRef.on("value", function (snap) {
        var v = snap.val();
        if (v && typeof v === "object" && Object.keys(v).length > 64) {
            leagueWarnings.push("catalog oversized (" + Object.keys(v).length + " entries) — ignored");
            console.log("league: oversized catalog ignored");
            writeLeagueState();
            return; // keep the previous catalog
        }
        leaguesCatalog = v && typeof v === "object" ? v : null;
        if (leagueActive) {
            var r = leagueResolve(leagueActive.id);
            if (!r) {
                // the ACTIVE league vanished (delete / undo / {}): revert to
                // base through the same gate as any switch (spec §3)
                leagueWarnings.push('league "' + leagueActive.id + '" removed from catalog — reverting to base');
                leagueRequest("", null, { force: true });
            } else if (JSON.stringify(r.settings) !== JSON.stringify(leagueActive.settings) || r.name !== leagueActive.name) {
                // resolution changed under us (panel edit): re-apply, gated
                leagueRequest(leagueActive.id, null, { force: true });
            }
        }
        maybeLeagueBoot();
    });

    leaguePtrRef.on("value", function (snap) {
        leagueBootPtr = snap.val() || {};
        if (leagueBootDone) handleLeaguePointer(leagueBootPtr);
        else maybeLeagueBoot();
    });

    chainFunction(window.WLROOM, "onGameStart", function () {
        leagueGameInProgress = true;
        if (leaguePending) {
            var p = leaguePending;
            leaguePending = null;
            leagueApply(p.id);
        }
    });
    chainFunction(window.WLROOM, "onGameEnd", function () {
        leagueGameInProgress = false;
    });

    console.log("leagues ok");
}

// Boot replay: wait for BOTH nodes (pointer may be legitimately absent — an
// empty object arrives as {}) so a persisted pointer survives a room restart.
function maybeLeagueBoot() {
    if (leagueBootDone || leagueBootPtr === undefined) return;
    // catalog may be null (no leagues configured) — that's a valid boot state
    leagueBootDone = true;
    handleLeaguePointer(leagueBootPtr);
}

function handleLeaguePointer(v) {
    var id = (v && typeof v.id === "string") ? v.id.toLowerCase() : "";
    var applyAt = (v && v.applyAt === "nextGame") ? "nextGame" : "now";
    leagueRequest(id, applyAt);
}

// Room-originated pointer write (commands). Bypasses recordAndWrite, so also
// bump _meta/versions/league — the documented exception (spec §5) that keeps
// the panel's 5s live-sync honest about in-room switches.
function leagueWritePointer(id, applyAt, player) {
    var setBy = "room:" + ((typeof auth !== "undefined" && auth.get(player.id)) || player.name || "?");
    leaguePtrRef.set({ id: id, applyAt: applyAt, setAt: Date.now(), setBy: setBy });
    fdb.ref(baseRoomName + "/" + CONFIG.room_id + "/_meta/versions/league").set(Date.now());
}

// ── commands ────────────────────────────────────────────────────────────────
// Registered FOR_ALL with in-handler admin checks for the write paths (one
// tier per name — two-tier registration is the collision class that bit the
// arena plugin, commit eeee7ae).
COMMAND_REGISTRY.add(["leagues"], ["!leagues: list this room's leagues"], function (player) {
    var cat = leaguesCatalog || {};
    var ids = Object.keys(cat).sort();
    if (!ids.length) {
        announce("no leagues configured", player);
        return false;
    }
    var activeID = leagueActive ? leagueActive.id : "";
    for (var i = 0; i < ids.length; i++) {
        var L = cat[ids[i]] || {};
        var mark = ids[i] === activeID ? " [ACTIVE]" : "";
        var ext = L.extends ? " (extends " + L.extends + ")" : "";
        announce("!league " + ids[i] + " — " + (L.name || ids[i]) + ext + mark, player);
    }
    return false;
}, COMMAND.FOR_ALL);

COMMAND_REGISTRY.add(["league"], [
    "!league: show the active league · !league <id> [now]: switch (admin) — applies next game while a game runs unless 'now'",
], function (player, id, when) {
    if (!id) {
        if (leagueActive) announce("league: " + leagueActive.name + " (" + leagueActive.id + ")", player);
        else announce("league: none (base config)", player);
        if (leaguePending) announce("pending: " + (leaguePending.id || "(off)") + " applies next game", player);
        if (leagueWarnings.length) announce("warning: " + leagueWarnings[0], player);
        return false;
    }
    if (!player.admin) {
        announce("!league <id> is admin-only", player);
        return false;
    }
    id = String(id).toLowerCase();
    if (!leaguesCatalog || !leaguesCatalog[id]) {
        announce('unknown league "' + id + '" — see !leagues', player);
        return false;
    }
    var applyAt = (when === "now" || !leagueGameInProgress) ? "now" : "nextGame";
    leagueWritePointer(id, applyAt, player);
    announce(applyAt === "now" ? "league " + id + " applied" : "league " + id + " applies next game");
    return false;
}, COMMAND.FOR_ALL);

COMMAND_REGISTRY.add(["leagueoff"], ["!leagueoff: back to base config (admin)"], function (player) {
    if (!player.admin) {
        announce("!leagueoff is admin-only", player);
        return false;
    }
    var applyAt = leagueGameInProgress ? "nextGame" : "now";
    leagueWritePointer("", applyAt, player);
    announce(applyAt === "now" ? "league off — base config" : "league turns off next game");
    return false;
}, COMMAND.FOR_ALL);

initLeagues();
