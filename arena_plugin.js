/**
 * arena — rotating 1v1 ladder plugin (the arena room's queue, ported onto the
 * plugin framework). Spec: _specs/plugin-architecture.md §6.
 *
 * Exactly 2 players fight; at game end the loser (or a maxed-out winner) is
 * swapped for the head of a FIFO queue. Faithful port of arena's queue with its
 * safeguards preserved (spec §6b), adapted to run as a GUEST of the fork:
 *
 *  - All hooks CHAIN (host.chainFunction) — arena assigned them, which would
 *    clobber the fork's handlers.
 *  - Rotation ownership: the fork's command_log.js onGameEnd2 → next() does the
 *    single map advance. This plugin does the seat swap in its own chained
 *    onGameEnd2 and NEVER calls next() (arena's did — chaining that verbatim
 *    would double-advance the pool). Chain order: fork's next() runs first,
 *    then the swap; team changes are synchronous and land before the async map
 *    load applies, so the new round starts with the swapped pair.
 *  - Queue liveness is id-based (cleanQueue via getPlayer) because the fork's
 *    zz_1v1 leave handler deletes the auth map entry BEFORE our chained leave
 *    handler runs — removal by auth would miss, pruning by id never does.
 *  - Duplicate-auth kick (queue integrity) is LIVENESS-CHECKED: only kick when
 *    another CONNECTED player holds the same auth (arena kicked on any stale
 *    map entry).
 *  - detectBadRunaway was dropped (arena latent bug: bare `wasLosing` →
 *    ReferenceError on mid-game leave; and wasLosing always returned true —
 *    log-only feature, not worth carrying). Kill logging is z_stats.js's job
 *    (spec §6d: stats have ONE owner — this plugin drives no stats writes).
 *
 * Strict opt-in via CONFIG.plugins.arena = { enabled:true, maxGames:3 }.
 */
var ARENA_PLUGIN = (function () {
  var host = null;
  var settings = {
    maxGames: 3, // win-streak cap; a winner rotates out after this many games (0 = unlimited)
  };

  var manifest = {
    id: 'arena',
    name: 'Arena (1v1 ladder)',
    settings: [
      { key: 'maxGames', label: 'Max games in a row before rotating out (0 = unlimited)', type: 'number', min: 0, default: 3 },
    ],
  };

  // ── helpers (fork parity for what arena's base provided) ──
  function isFull() { return host.getActivePlayers().length >= 2; }
  function hasActive() { return host.getActivePlayers().length > 0; }
  function playerAuth(p) { return (p && p.auth) || host.auth.get(p && p.id); }
  function moveToGame(p) { host.room.setPlayerTeam(p.id, 1); }
  function moveToSpec(p) { host.room.setPlayerTeam(p.id, 0); }
  function setLock(b) {
    try {
      var sett = host.room.getSettings();
      if (sett.teamsLocked !== b) { sett.teamsLocked = b; host.room.setSettings(sett); }
    } catch (e) { console.log('arena: setLock failed: ' + e); }
  }
  // arena's announceEmphasizeToPlayerOnly: loud+pinged for the target, silent
  // text for everyone else. Inlined (the fork's announce hardcodes sound=1).
  function announceEmphasize(msg, target, color, style) {
    var list = host.room.getPlayerList();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.id === target.id) host.room.sendAnnouncement(msg, p.id, color, style, 2);
      else host.room.sendAnnouncement(msg, p.id, 0xb2f1d3, '', 0);
    }
  }

  // ── PlayerQueue (arena game_queue.js, id-liveness preserved) ──
  function PlayerQueue() { this.q = []; }
  PlayerQueue.prototype.has = function (a) { return this.q.some(function (e) { return e.auth === a; }); };
  PlayerQueue.prototype.getIdx = function (a) {
    for (var i = 0; i < this.q.length; i++) if (this.q[i].auth === a) return i;
    return -1;
  };
  PlayerQueue.prototype.add = function (player) {
    var a = playerAuth(player);
    if (a == null || this.has(a)) return false; // never queue an auth-less player (dedup key)
    this.q.push({ auth: a, name: player.name, id: player.id });
    return true;
  };
  PlayerQueue.prototype.remove = function (player) {
    var a = playerAuth(player);
    var before = this.q.length;
    // by auth when resolvable, ALWAYS also by id (leave-chain order: the fork
    // deletes the auth entry before we run, so id is the reliable key there).
    this.q = this.q.filter(function (e) { return e.id !== player.id && (a == null || e.auth !== a); });
    return this.q.length !== before;
  };
  PlayerQueue.prototype.cleanQueue = function () {
    this.q = this.q.filter(function (e) { return host.room.getPlayer(e.id) != null; });
  };
  PlayerQueue.prototype.isEmpty = function () { this.cleanQueue(); return this.q.length === 0; };
  PlayerQueue.prototype.shift = function () { this.cleanQueue(); return this.q.shift(); };
  PlayerQueue.prototype.getNextPlayer = function () { return this.isEmpty() ? null : this.q[0]; };
  PlayerQueue.prototype.getPlace = function (player) {
    this.cleanQueue();
    var idx = this.getIdx(playerAuth(player));
    return {
      playercount: this.q.length,
      idx: idx,
      nextingame: idx === 0,
      prevPlayer: idx > 0 ? this.q[idx - 1].name : false,
    };
  };

  // ── OutQueue (arena game_outqueue.js) ──
  var REASON_OUT_MAX = 0, REASON_OUT_LOOSE = 1, REASON_OUT_TIE = 2;
  function OutQueue() { this.currentOut = null; this.lastGames = []; }
  OutQueue.prototype.resetOut = function () { this.currentOut = null; };
  OutQueue.prototype.hasPlayedTooMuch = function (player) {
    var mg = settings.maxGames | 0;
    if (!mg) return false;
    return this.lastGames.filter(function (s) {
      return s.some(function (g) { return g.team !== 0 && g.player.auth === player.auth; });
    }).length >= mg;
  };
  OutQueue.prototype.computeScores = function (scores) {
    // SAFEGUARD (2-player gate): a non-duel yields no ejection.
    if (scores == null || scores.length !== 2) { this.currentOut = null; return null; }
    var s0 = scores[0].score.score, s1 = scores[1].score.score;
    var mg = settings.maxGames | 0;
    if (mg && this.lastGames.length >= mg) this.lastGames.shift();
    this.lastGames.push(scores);
    if (s0 === s1) {
      for (var i = 0; i < scores.length; i++) {
        if (this.hasPlayedTooMuch(scores[i].player)) {
          this.currentOut = { reasonOut: REASON_OUT_MAX, player: scores[i].player };
          return this.currentOut;
        }
      }
      this.currentOut = { reasonOut: REASON_OUT_TIE, player: scores[Math.round(Math.random())].player };
      return this.currentOut;
    }
    var winner = s0 > s1 ? 0 : 1, looser = winner ? 0 : 1;
    if (this.hasPlayedTooMuch(scores[winner].player)) {
      this.currentOut = { reasonOut: REASON_OUT_MAX, player: scores[winner].player };
      return this.currentOut;
    }
    this.currentOut = { reasonOut: REASON_OUT_LOOSE, player: scores[looser].player };
    return this.currentOut;
  };

  var playerqueue = null;
  var outQueue = null;
  var gameLive = false; // arena's currentGame!=null gate: scores only for games that STARTED full

  function resolveInfo(p) { return { name: p.name, auth: playerAuth(p), id: p.id }; }

  // arena flushScoreLogs, minus the RTDB gamestats write (z_stats owns stats).
  function flushScores() {
    if (!gameLive) return null;
    gameLive = false;
    var scores = host.getActivePlayers().map(function (p) {
      return { player: resolveInfo(p), team: p.team, score: host.room.getPlayerScore(p.id) };
    });
    if (scores.length !== 2) {
      console.log('arena: incorrect number of players, scores dropped');
      return null; // SAFEGUARD: a game that decayed below 2 players ejects nobody
    }
    return scores;
  }

  function notifyNextPlayer(out) {
    if (out == null) return;
    var next = playerqueue.getNextPlayer();
    if (next == null) return;
    var outmsg = out.reasonOut === REASON_OUT_MAX ? out.player.name + ' (max games played)'
      : out.reasonOut === REASON_OUT_LOOSE ? out.player.name + ' who lost'
      : out.player.name + ' (randomly chosen) >> TIE <<';
    announceEmphasize('>> @' + next.name + ' is to enter the arena next replacing ' + outmsg + ' <<', next, 0xDD91C6, 'bold');
  }

  function moveToGameIfSomeoneIsWaiting(force) {
    if ((force || (!isFull() && hasActive())) && !playerqueue.isEmpty()) {
      var pe = playerqueue.shift();
      console.log('arena: moving ' + pe.name + ' to the game');
      moveToGame(pe);
      host.room.restartGame();
    }
  }

  function loadSettings(conf) {
    if (!conf) return;
    if (conf.maxGames != null && !isNaN(conf.maxGames)) settings.maxGames = Math.max(0, parseInt(conf.maxGames, 10));
  }

  function init(h, conf) {
    if (window.__ARENA_PLUGIN) { console.log('arena already loaded'); return; }
    window.__ARENA_PLUGIN = true;
    host = h;
    loadSettings(conf);
    playerqueue = new PlayerQueue();
    outQueue = new OutQueue();
    var chain = host.chainFunction;
    var room = host.room;

    // onGameStart — arena startScoreLogs: only a game that STARTS as a full
    // duel produces scores/ejection.
    chain(room, 'onGameStart', function () {
      if (isFull()) { outQueue.resetOut(); gameLive = true; }
      else gameLive = false;
    });

    // onGameEnd — compute who rotates out (scores are readable here).
    chain(room, 'onGameEnd', function () {
      var out = outQueue.computeScores(flushScores());
      notifyNextPlayer(out);
    });

    // onGameEnd2 — the swap. Runs AFTER the fork's next() in the chain; never
    // advances the map itself (rotation ownership — see header).
    chain(room, 'onGameEnd2', function () {
      var out = outQueue.currentOut;
      if (out != null && out.player != null && !playerqueue.isEmpty()) {
        moveToSpec(out.player);
        // SAFEGUARD (ordering): re-queue the ejected player BEFORE shifting —
        // with a 1-deep queue the same two rematch; deeper, they go to the back.
        var lp = host.room.getPlayer(out.player.id);
        if (lp) playerqueue.add(lp);
        var pe = playerqueue.shift();
        if (pe) {
          console.log('arena: switching ' + out.player.name + ' with ' + pe.name);
          moveToGame(pe);
        }
        // SAFEGUARD (self-heal): backfill if a seat vanished mid-swap.
        if (!isFull() && !playerqueue.isEmpty()) {
          var pe2 = playerqueue.shift();
          moveToGame(pe2);
          console.log('arena: added ' + pe2.name + ' to complete the game');
        }
      }
      outQueue.resetOut(); // consumed — never eject twice off one result
    });

    // onPlayerJoin — SAFEGUARD (duplicate-auth kick): two sessions on one auth
    // corrupt the auth-keyed queue. Runs after the fork's join handler (which
    // has already auth.set this player), so look for a DIFFERENT live player
    // with the same auth.
    chain(room, 'onPlayerJoin', function (player) {
      var a = playerAuth(player);
      if (a != null) {
        var dupe = room.getPlayerList().some(function (p) { return p.id !== player.id && playerAuth(p) === a; });
        if (dupe) {
          room.kickPlayer(player.id, 'duplicate player detected, this room doesn\'t allow you to connect twice for the queue to work correctly, sorry', false);
          return;
        }
      }
      if (isFull()) {
        playerqueue.add(player);
        host.announce('game is running already, you\'ve been automatically added to the queue, type !quit or !q to stay only as a spectator', player, 0xDD2222, 'bold');
      }
    });

    // onPlayerLeave — free the seat, backfill, relock.
    chain(room, 'onPlayerLeave', function (player) {
      playerqueue.remove(player);
      var full = isFull();
      if (!full && hasActive() && !playerqueue.isEmpty()) {
        var pe = playerqueue.shift();
        moveToGame(pe);
        room.restartGame();
      }
      setLock(full); // SAFEGUARD: teamsLocked tracks fullness
    });

    // onPlayerTeamChange — SAFEGUARDS: lock tracking; a player who entered the
    // game leaves the queue (no double-booking); a manual mid-round join
    // restarts so starting scores are correct.
    chain(room, 'onPlayerTeamChange', function (p, bp) {
      setLock(isFull());
      if (p.team !== 0) playerqueue.remove(p);
      if (bp !== null && bp !== undefined && isFull()) {
        console.log('arena: restarting game to get correct start score');
        room.restartGame();
      }
    });

    // ── commands (arena game_queue.js, verbatim behavior) ──
    var C = host.COMMAND;
    host.registry.add(['q', 'quit'], ["!quit or !q: leave the waiting queue / go back to spectating"], function (player) {
      if (playerqueue.remove(player)) {
        host.announce('>> ' + player.name + ' was removed from the queue <<');
        host.announce("you'll have to type !join to go back in queue", player);
        return false;
      }
      host.announce("you'll have to type !join to play again", player);
      var full = player.team !== 0 && isFull();
      moveToSpec(player);
      moveToGameIfSomeoneIsWaiting(full);
      return false;
    }, C.FOR_ALL);

    host.registry.add(['j', 'join'], ["!join or !j: join the game, or the queue when a duel is running"], function (player) {
      if (player.team !== 0) { host.announce("you're already playing", player); return false; }
      if (!isFull()) {
        moveToGame(player);
        host.room.restartGame();
        return false;
      }
      if (playerqueue.add(player)) {
        var place = playerqueue.getPlace(player);
        var after = place.prevPlayer !== false ? ' after "' + place.prevPlayer + '"' : '';
        host.announce('>> ' + player.name + ' was added to the queue' + after + ' <<');
      } else {
        host.announce("you're already in the queue", player);
      }
      return false;
    }, C.FOR_ALL);

    host.registry.add(['p', 'place'], ['!place or !p: your place in the waiting queue'], function (player) {
      var place = playerqueue.getPlace(player);
      if (place.playercount === 0) { host.announce('the queue is empty', player); return false; }
      if (place.playercount === 1) host.announce("there's only one player in queue", player);
      else host.announce('there are ' + place.playercount + ' players in queue', player);
      if (place.idx === -1) host.announce('but sadly, you are not in the queue', player);
      else if (place.nextingame) host.announce('you are the next player to enter the game', player);
      else if (place.prevPlayer !== false) host.announce('there are ' + place.idx + ' players before you, you will play after "' + place.prevPlayer + '"', player);
      return false;
    }, C.FOR_ALL);

    setLock(isFull()); // establish lock state at boot
  }

  return { manifest: manifest, init: init, loadSettings: loadSettings };
})();

if (window.WL_PLUGINS) {
  window.WL_PLUGINS.register(ARENA_PLUGIN);
} else {
  console.log('arena: WL_PLUGINS not present — is _pluginhost.js loaded before this file?');
}
