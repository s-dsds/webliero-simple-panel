initFirebase();

chainFunction(window.WLROOM, 'onPlayerJoin', (player) => {
	if (admins.has(player.auth) ) {
		window.WLROOM.setPlayerAdmin(player.id, true);
	}
	auth.set(player.id, player.auth);
	// conn = hex-encoded connection IP (moderation.js decodes it for
	// same-IP autokick of ban-evaders on a different auth).
	if (player.conn) { conn.set(player.id, player.conn); }
	writeLogins(player);

	announce(CONFIG.motd, player, 0xFF2222, "bold");
	
	announce("please join us on discord if you're not there yet! "+CONFIG.discord_invite, player, 0xDD00DD, "italic");
	if (player.auth){		
		auth.set(player.id, player.auth);
	}
}
)

chainFunction(window.WLROOM, 'onPlayerLeave', function(player) {
	writeLogins(player, "logout");

	auth.delete(player.id);
	conn.delete(player.id);
}
)

function announce(msg, player, color, style) {
	// Accept a player OBJECT or a numeric player id: several callers pass
	// player.id, and `id.id` is undefined — which sendAnnouncement treats as
	// broadcast-to-all, leaking private replies (and !listadmins' auth list)
	// to the whole room.
	var target = null;
	if (typeof player == 'number') target = player;
	else if (player != null && typeof player.id == 'number') target = player.id;
	window.WLROOM.sendAnnouncement(msg, target, color!=null?color:0xb2f1d3, style !=null?style:"", 1);
}

function notifyAdmins(msg, logNotif = false) {
	getAdmins().forEach((a) => { window.WLROOM.sendAnnouncement(msg, a.id); });
	if (logNotif) {
		notifsRef.push({msg:msg, time:Date.now(), formatted:(new Date(Date.now()).toLocaleString())});
	}
}

function getAdmins() {
	return window.WLROOM.getPlayerList().filter((p) => p.admin);
}

function moveAllPlayersToSpectator() {
    for (let p of window.WLROOM.getPlayerList()) {
        window.WLROOM.setPlayerTeam(p.id, 0);
    }
}
