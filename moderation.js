/** room-admin-panel contract v1: !kick/!ban/!unban + join-time ban enforcement.
 * The moderation node is an EVENT LOG (epoch-keyed records); the room replays
 * it at boot and then keeps listening, so records appended by the admin PANEL
 * (kick/ban/unban) apply live too. activeBans is mirrored into a `bans`
 * summary node so the panel can show the authoritative active-ban list
 * without reading the unbounded log.
 *
 * A ban matches on any of three dimensions (checked at join and on a live
 * ban): AUTH (the player's stable identity), CONN (their IP, hex-encoded —
 * catches ban-evaders on a new auth from the same IP), and NAME (kicks anyone
 * using that name — a single-player targeted autokick when you don't have or
 * don't want to blanket an auth/IP). A ban record can carry any subset; its
 * map key is the auth if present, else name:<lower>, else conn:<hex>. */

var activeBans = new Map();  // key -> {name, nameLower, auth, conn, expiresAt, reason, at}
var bannedConns = new Map(); // hex conn IP -> ban key
var bannedNames = new Map(); // lowercased name -> ban key
var moderationRef;
var bansRef;
var moderationBootAt = Date.now();
var moderationReplayed = false;

function initModeration() {
    if (typeof fdb == 'undefined' || !fdb) {
        setTimeout(initModeration, 200);
        return;
    }
    moderationRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/moderation`);
    bansRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/bans`);
    // Replay history, then stay subscribed: child_added fires in key order
    // (epoch-ms keys), first for every existing record, then for each new one
    // (panel writes included). Records older than boot only rebuild state;
    // records appended after boot also enforce (kick the online target).
    moderationRef.once('value').then((snapshot) => {
        const v = snapshot.val() || {};
        const records = Object.values(v).sort((a, b) => a.at - b.at);
        for (const r of records) {
            applyModerationRecord(r, false);
        }
        moderationReplayed = true;
        syncBansNode();
        console.log(`moderation: loaded ${activeBans.size} active ban(s)`);
        moderationRef.orderByKey().startAt(String(moderationBootAt)).on('child_added', (snap) => {
            const r = snap.val();
            if (!r || !r.target) {
                return;
            }
            applyModerationRecord(r, true);
            syncBansNode();
        });
    });
}
initModeration();

// key under which a ban is stored: auth wins, else a name-only ban, else IP-only.
function banKeyFor(t) {
    if (t.auth) { return t.auth; }
    if (t.name) { return "name:" + String(t.name).toLowerCase(); }
    if (t.conn) { return "conn:" + t.conn; }
    return null;
}

function registerBan(key, rec) {
    activeBans.set(key, rec);
    if (rec.conn) { bannedConns.set(rec.conn, key); }
    if (rec.nameLower) { bannedNames.set(rec.nameLower, key); }
}

function unregisterBan(key) {
    const rec = activeBans.get(key);
    if (!rec) { return null; }
    if (rec.conn && bannedConns.get(rec.conn) == key) { bannedConns.delete(rec.conn); }
    if (rec.nameLower && bannedNames.get(rec.nameLower) == key) { bannedNames.delete(rec.nameLower); }
    activeBans.delete(key);
    return rec;
}

function notExpired(rec) {
    return rec && (!rec.expiresAt || rec.expiresAt > Date.now());
}

// Return the active ban matching a descriptor {auth, conn, name}, or null.
function matchActiveBan(d) {
    let rec = d.auth ? activeBans.get(d.auth) : null;
    if (!notExpired(rec) && d.conn && bannedConns.has(d.conn)) {
        rec = activeBans.get(bannedConns.get(d.conn));
    }
    if (!notExpired(rec) && d.name && bannedNames.has(String(d.name).toLowerCase())) {
        rec = activeBans.get(bannedNames.get(String(d.name).toLowerCase()));
    }
    return notExpired(rec) ? rec : null;
}

function applyModerationRecord(r, live) {
    const now = Date.now();
    if (r.type == "ban") {
        if (r.expiresAt && r.expiresAt <= now) {
            return;
        }
        // Panel bans carry no conn (the panel doesn't know it). If the target
        // is online (by auth or name), backfill their IP now so same-IP
        // autokick still works.
        var banConn = r.target.conn || null;
        if (!banConn) {
            var online = findOnlinePlayersByAuth(r.target.auth)[0] || findOnlinePlayersByName(r.target.name)[0];
            if (online) { banConn = conn.get(online.id) || null; }
        }
        const nameLower = r.target.name ? String(r.target.name).toLowerCase() : null;
        const rec = {
            name: r.target.name || "",
            nameLower: r.target.matchName ? nameLower : null, // only name-BANS enforce by name
            auth: r.target.auth || null,
            conn: banConn,
            expiresAt: r.expiresAt ?? null,
            reason: r.reason || "",
            at: r.at
        };
        registerBan(banKeyFor(r.target) || ("at:" + r.at), rec);
        if (live) {
            for (const p of onlinePlayersMatching(rec)) {
                banKick(p.id, rec.reason);
            }
        }
        syncBansNode();
    } else if (r.type == "unban") {
        // unban by whatever key the ban was stored under
        unregisterBan(banKeyFor(r.target) || "");
        if (live) { try { window.WLROOM.clearBans(); } catch (e) {} }
    } else if (r.type == "kick" && live) {
        // targeted single kick: by auth if known, else by name
        var kicked = findOnlinePlayersByAuth(r.target.auth);
        if (!kicked.length && r.target.name) { kicked = findOnlinePlayersByName(r.target.name); }
        for (const p of kicked) {
            window.WLROOM.kickPlayer(p.id, r.reason || "kicked by admin");
        }
    }
}

// online players matching a ban record on any of its dimensions
function onlinePlayersMatching(rec) {
    const out = [];
    const push = (p) => { if (out.indexOf(p) < 0) { out.push(p); } };
    if (rec.auth) { findOnlinePlayersByAuth(rec.auth).forEach(push); }
    if (rec.conn) { findOnlinePlayersByConn(rec.conn).forEach(push); }
    if (rec.nameLower) { findOnlinePlayersByName(rec.name).forEach(push); }
    return out;
}

// A ban uses webliero's NATIVE ban (kickPlayer's 3rd arg = true) so the room
// enforces it server-side too and it shows in the normal webliero admin UI —
// not just our kick-on-join layer. A plain kick passes no ban flag.
function banKick(id, reason) {
    window.WLROOM.kickPlayer(id, reason ? `banned: ${reason}` : "banned", true);
}

function findOnlinePlayersByAuth(a) {
    if (!a) { return []; }
    return window.WLROOM.getPlayerList().filter((p) => auth.get(p.id) == a);
}
function findOnlinePlayersByConn(c) {
    if (!c) { return []; }
    return window.WLROOM.getPlayerList().filter((p) => conn.get(p.id) == c);
}
function findOnlinePlayersByName(n) {
    if (!n) { return []; }
    const needle = String(n).toLowerCase();
    return window.WLROOM.getPlayerList().filter((p) => (p.name || "").toLowerCase() == needle);
}

// Mirror activeBans into the `bans` summary node (key -> record). Whole-node
// set: bans are few and this self-heals stale entries after expiry pruning.
function syncBansNode() {
    if (!moderationReplayed) {
        return;
    }
    const out = {};
    const now = Date.now();
    for (const [key, rec] of activeBans) {
        if (rec.expiresAt && rec.expiresAt <= now) {
            unregisterBan(key);
            continue;
        }
        // firebase keys can't contain . # $ [ ] / — sanitize for the node
        out[statsSafeBanKey(key)] = {
            name: rec.name, auth: rec.auth || null, conn: rec.conn || null,
            byName: !!rec.nameLower, expiresAt: rec.expiresAt || null,
            reason: rec.reason, at: rec.at
        };
    }
    bansRef.set(out);
}
function statsSafeBanKey(k) { return String(k).replace(/[.#$/\[\]]/g, "_").slice(0, 200); }

function persistModeration(record) {
    moderationRef.child(record.at).set(record);
}

function findTargetPlayer(token) {
    if (!token) {
        return null;
    }
    const stripped = token.replace("#", "");
    if (stripped !== "" && !isNaN(stripped)) {
        return window.WLROOM.getPlayer(parseInt(stripped)) || null;
    }
    const needle = token.toLowerCase();
    return window.WLROOM.getPlayerList().find((p) => p.name.toLowerCase().startsWith(needle)) || null;
}

function resolveBanKey(token) {
    if (!token) { return null; }
    if (activeBans.has(token)) { return token; }               // exact auth key
    const lower = token.toLowerCase();
    if (bannedNames.has(lower)) { return bannedNames.get(lower); } // exact name
    for (const [key, rec] of activeBans) {                       // name prefix
        if (rec.name && rec.name.toLowerCase().startsWith(lower)) { return key; }
    }
    return null;
}

function doKick(byPlayer, targetPlayer, reason) {
    window.WLROOM.kickPlayer(targetPlayer.id, reason || "kicked by admin");
    const now = Date.now();
    persistModeration({
        type: "kick",
        target: {name: targetPlayer.name, auth: auth.get(targetPlayer.id)},
        by: {name: byPlayer.name, auth: auth.get(byPlayer.id)},
        reason: reason || "", at: now, formatted: (new Date(now).toLocaleString())
    });
    announce(`${targetPlayer.name} was kicked${reason ? " (" + reason + ")" : ""}`, null, COLORS.ANNOUNCE_BRIGHT);
}

// Shared ban path. target = {name, auth, conn, matchName} — matchName true
// makes the ban enforce by NAME (kicks anyone using it). byName-only bans pass
// auth/conn null.
function doBanTarget(byPlayer, target, minutes, reason, announceName) {
    const now = Date.now();
    const expiresAt = minutes ? now + minutes * 60000 : null;
    const record = {
        type: "ban",
        target: {name: target.name || "", auth: target.auth || null, conn: target.conn || null, matchName: !!target.matchName},
        by: {name: byPlayer.name, auth: auth.get(byPlayer.id)},
        reason: reason || "", at: now, formatted: (new Date(now).toLocaleString()), expiresAt: expiresAt
    };
    const nameLower = target.name ? String(target.name).toLowerCase() : null;
    const rec = {
        name: target.name || "", nameLower: target.matchName ? nameLower : null,
        auth: target.auth || null, conn: target.conn || null,
        expiresAt: expiresAt, reason: reason || "", at: now
    };
    registerBan(banKeyFor(target) || ("at:" + now), rec);
    for (const p of onlinePlayersMatching(rec)) {
        banKick(p.id, reason);
    }
    persistModeration(record);
    syncBansNode();
    announce(`${announceName} was banned${minutes ? " for " + minutes + " minutes" : " permanently"}${reason ? " (" + reason + ")" : ""}`, null, COLORS.ANNOUNCE_BRIGHT);
}

function doBan(byPlayer, targetPlayer, minutes, reason) {
    doBanTarget(byPlayer, {
        name: targetPlayer.name,
        auth: auth.get(targetPlayer.id),
        conn: conn.get(targetPlayer.id) || null
    }, minutes, reason, targetPlayer.name);
}

function doBanName(byPlayer, name, minutes, reason) {
    doBanTarget(byPlayer, {name: name, matchName: true}, minutes, reason, `anyone named "${name}"`);
}

function doUnban(byPlayer, key) {
    const rec = unregisterBan(key);
    // Clear webliero's native bans, then let the custom layer re-cover the
    // rest: our activeBans is the source of truth (it re-bans any still-banned
    // player on their next join), so wiping all native bans here safely undoes
    // just the one we removed without needing webliero's opaque per-ban key.
    try { window.WLROOM.clearBans(); } catch (e) {}
    syncBansNode();
    const now = Date.now();
    persistModeration({
        type: "unban",
        // echo the ban's identifying fields so replay unregisters the same key
        target: {name: rec ? rec.name : "", auth: rec ? rec.auth : null, conn: rec ? rec.conn : null, matchName: rec ? !!rec.nameLower : false},
        by: {name: byPlayer.name, auth: auth.get(byPlayer.id)},
        at: now, formatted: (new Date(now).toLocaleString())
    });
    announce(`ban removed (${rec ? (rec.name || rec.auth || key) : key})`, null, COLORS.ANNOUNCE_BRIGHT);
}

COMMAND_REGISTRY.add("kick", ["!kick <name-or-#id> [reason...]: kicks a player"], (player, target, ...reasonParts) => {
    const targetPlayer = findTargetPlayer(target);
    if (!targetPlayer) {
        announce(`player "${target}" not found`, player, COLORS.ERROR);
        return false;
    }
    doKick(player, targetPlayer, reasonParts.join(" "));
    return false;
}, COMMAND.ADMIN_ONLY);

COMMAND_REGISTRY.add("ban", ["!ban <name-or-#id> [minutes] [reason...]: bans a player, permanent if minutes omitted"], (player, target, ...rest) => {
    const targetPlayer = findTargetPlayer(target);
    if (!targetPlayer) {
        announce(`player "${target}" not found`, player, COLORS.ERROR);
        return false;
    }
    let minutes = null;
    let reasonParts = rest;
    if (rest.length > 0 && rest[0] !== "" && !isNaN(rest[0])) {
        minutes = parseInt(rest[0]);
        reasonParts = rest.slice(1);
    }
    doBan(player, targetPlayer, minutes, reasonParts.join(" "));
    return false;
}, COMMAND.ADMIN_ONLY);

COMMAND_REGISTRY.add("banname", ["!banname <name> [minutes] [reason...]: autokicks anyone using this name (offline-target ok)"], (player, name, ...rest) => {
    if (!name) {
        announce("usage: !banname <name> [minutes] [reason]", player, COLORS.ERROR);
        return false;
    }
    let minutes = null;
    let reasonParts = rest;
    if (rest.length > 0 && rest[0] !== "" && !isNaN(rest[0])) {
        minutes = parseInt(rest[0]);
        reasonParts = rest.slice(1);
    }
    doBanName(player, name, minutes, reasonParts.join(" "));
    return false;
}, COMMAND.ADMIN_ONLY);

COMMAND_REGISTRY.add("unban", ["!unban <auth-or-name>: removes an active ban"], (player, target) => {
    const key = resolveBanKey(target);
    if (!key) {
        announce(`no active ban found for "${target}"`, player, COLORS.ERROR);
        return false;
    }
    doUnban(player, key);
    return false;
}, COMMAND.ADMIN_ONLY);

chainFunction(window.WLROOM, 'onPlayerJoin', (player) => {
    const rec = matchActiveBan({auth: player.auth, conn: player.conn, name: player.name});
    if (rec) {
        banKick(player.id, rec.reason);
    }
});
