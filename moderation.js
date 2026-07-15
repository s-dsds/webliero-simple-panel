/** room-admin-panel contract v1: !kick/!ban/!unban + join-time ban enforcement.
 * The moderation node is an EVENT LOG (epoch-keyed records); the room replays
 * it at boot and then keeps listening, so records appended by the admin PANEL
 * (kick/ban/unban) apply live too. activeBans is mirrored into a `bans`
 * summary node so the panel can show the authoritative active-ban list
 * without reading the unbounded log. */

var activeBans = new Map(); // auth -> {name, auth, conn, expiresAt, reason, at}
var bannedConns = new Map(); // hex conn IP -> auth (autokick same-IP ban evaders)
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

function applyModerationRecord(r, live) {
    const now = Date.now();
    if (r.type == "ban") {
        if (r.expiresAt && r.expiresAt <= now) {
            return;
        }
        // Panel bans carry no conn (the panel doesn't know it). If the target
        // is online, backfill their IP now so same-IP autokick still works.
        var banConn = r.target.conn || null;
        if (!banConn) {
            var online = findOnlinePlayersByAuth(r.target.auth)[0];
            if (online) { banConn = conn.get(online.id) || null; }
        }
        activeBans.set(r.target.auth, {name: r.target.name || "", auth: r.target.auth, conn: banConn, expiresAt: r.expiresAt ?? null, reason: r.reason || "", at: r.at});
        if (banConn) { bannedConns.set(banConn, r.target.auth); }
        if (live) {
            // several connections can share one auth — kick them all, plus
            // anyone on the banned IP (same-IP autokick).
            var toKick = findOnlinePlayersByAuth(r.target.auth);
            if (banConn) {
                for (const p of findOnlinePlayersByConn(banConn)) {
                    if (toKick.indexOf(p) < 0) { toKick.push(p); }
                }
            }
            for (const p of toKick) {
                window.WLROOM.kickPlayer(p.id, r.reason ? `banned: ${r.reason}` : "banned");
            }
        }
        syncBansNode();
    } else if (r.type == "unban") {
        var b = activeBans.get(r.target.auth);
        if (b && b.conn) { bannedConns.delete(b.conn); }
        activeBans.delete(r.target.auth);
    } else if (r.type == "kick" && live) {
        for (const p of findOnlinePlayersByAuth(r.target.auth)) {
            window.WLROOM.kickPlayer(p.id, r.reason || "kicked by admin");
        }
    }
}

function findOnlinePlayersByAuth(a) {
    if (!a) {
        return [];
    }
    return window.WLROOM.getPlayerList().filter((p) => auth.get(p.id) == a);
}

function findOnlinePlayersByConn(c) {
    if (!c) {
        return [];
    }
    return window.WLROOM.getPlayerList().filter((p) => conn.get(p.id) == c);
}

// Mirror activeBans into the `bans` summary node (auth -> record). Whole-node
// set: bans are few and this self-heals stale entries after expiry pruning.
function syncBansNode() {
    if (!moderationReplayed) {
        return;
    }
    const out = {};
    const now = Date.now();
    for (const [a, rec] of activeBans) {
        if (rec.expiresAt && rec.expiresAt <= now) {
            activeBans.delete(a);
            if (rec.conn) { bannedConns.delete(rec.conn); }
            continue;
        }
        out[a] = rec;
    }
    bansRef.set(out);
}

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

function resolveBanTarget(token) {
    if (!token) {
        return null;
    }
    if (activeBans.has(token)) {
        return token;
    }
    const needle = token.toLowerCase();
    for (const [bannedAuth, rec] of activeBans) {
        if (rec.name && rec.name.toLowerCase().startsWith(needle)) {
            return bannedAuth;
        }
    }
    return null;
}

function doKick(byPlayer, targetPlayer, reason) {
    window.WLROOM.kickPlayer(targetPlayer.id, reason || "kicked by admin");
    const now = Date.now();
    const record = {
        type: "kick",
        target: {name: targetPlayer.name, auth: auth.get(targetPlayer.id)},
        by: {name: byPlayer.name, auth: auth.get(byPlayer.id)},
        reason: reason || "",
        at: now,
        formatted: (new Date(now).toLocaleString())
    };
    persistModeration(record);
    announce(`${targetPlayer.name} was kicked${reason ? " (" + reason + ")" : ""}`, null, COLORS.ANNOUNCE_BRIGHT);
}

function doBan(byPlayer, targetPlayer, minutes, reason) {
    const targetAuth = auth.get(targetPlayer.id);
    const targetConn = conn.get(targetPlayer.id) || null;
    const now = Date.now();
    const expiresAt = minutes ? now + minutes * 60000 : null;
    const record = {
        type: "ban",
        target: {name: targetPlayer.name, auth: targetAuth, conn: targetConn},
        by: {name: byPlayer.name, auth: auth.get(byPlayer.id)},
        reason: reason || "",
        at: now,
        formatted: (new Date(now).toLocaleString()),
        expiresAt: expiresAt
    };
    activeBans.set(targetAuth, {name: targetPlayer.name, auth: targetAuth, conn: targetConn, expiresAt: expiresAt, reason: reason || "", at: now});
    if (targetConn) { bannedConns.set(targetConn, targetAuth); }
    // kick the target AND any other connection sharing the banned IP
    var toKick = findOnlinePlayersByAuth(targetAuth);
    for (const p of findOnlinePlayersByConn(targetConn)) {
        if (toKick.indexOf(p) < 0) { toKick.push(p); }
    }
    if (toKick.indexOf(targetPlayer) < 0) { toKick.push(targetPlayer); }
    for (const p of toKick) {
        window.WLROOM.kickPlayer(p.id, reason || "banned by admin");
    }
    persistModeration(record);
    syncBansNode();
    announce(`${targetPlayer.name} was banned${minutes ? " for " + minutes + " minutes" : " permanently"}${reason ? " (" + reason + ")" : ""}`, null, COLORS.ANNOUNCE_BRIGHT);
}

function doUnban(byPlayer, targetAuth) {
    const rec = activeBans.get(targetAuth);
    if (rec && rec.conn) { bannedConns.delete(rec.conn); }
    activeBans.delete(targetAuth);
    syncBansNode();
    const now = Date.now();
    const record = {
        type: "unban",
        target: {name: rec ? rec.name : "", auth: targetAuth},
        by: {name: byPlayer.name, auth: auth.get(byPlayer.id)},
        at: now,
        formatted: (new Date(now).toLocaleString())
    };
    persistModeration(record);
    announce(`${targetAuth} was unbanned`, null, COLORS.ANNOUNCE_BRIGHT);
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

COMMAND_REGISTRY.add("unban", ["!unban <auth-or-name>: removes an active ban"], (player, target) => {
    const bannedAuth = resolveBanTarget(target);
    if (!bannedAuth) {
        announce(`no active ban found for "${target}"`, player, COLORS.ERROR);
        return false;
    }
    doUnban(player, bannedAuth);
    return false;
}, COMMAND.ADMIN_ONLY);

chainFunction(window.WLROOM, 'onPlayerJoin', (player) => {
    const now = Date.now();
    const notExpired = (rec) => rec && (!rec.expiresAt || rec.expiresAt > now);
    // 1) direct auth ban
    let rec = activeBans.get(player.auth);
    // 2) same-IP autokick: a different auth on a banned connection (ban evasion)
    if (!notExpired(rec) && player.conn && bannedConns.has(player.conn)) {
        rec = activeBans.get(bannedConns.get(player.conn));
    }
    if (notExpired(rec)) {
        window.WLROOM.kickPlayer(player.id, rec.reason ? `banned: ${rec.reason}` : "banned");
    }
});
