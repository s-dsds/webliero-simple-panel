// OPT-IN (used by one room only): force players to blank their name before playing.
// Enable with `forbbid_team_change: true` in _conf.js. OFF by default — when active,
// every named player (bots included) is bounced back to spectator on team join.
if (CONFIG.forbbid_team_change) {
    window.WLROOM.onPlayerTeamChange = (p, bp) => {
        if (p.name.trim()!="") {
            moveToSpec(p);
            announce("you're not allowed to play with a non-empty name, please come back after changing your name", p, 0xFFF0000);
        }
    }
}
