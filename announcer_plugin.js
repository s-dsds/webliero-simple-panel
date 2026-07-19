/**
 * announcer — the reference plugin proving the framework end to end.
 * Spec: _specs/plugin-architecture.md. Deliberately touches NOTHING fragile
 * (no maps, no queue, no rotation): it only reads player events and announces.
 * It exercises every part of the plugin contract:
 *   - IIFE singleton + window sentinel (idempotent across hot reloads)
 *   - init(host, conf) taking ALL deps from host (no bare globals)
 *   - host.chainFunction to hook onPlayerJoin WITHOUT clobbering existing handlers
 *   - host.registry.add to register a command at the right permission tier
 *   - a manifest whose settings[] drive the panel's auto-generated config tab
 *   - loadSettings for live reconfiguration from the panel (pluginconf)
 *
 * A room enables it with CONFIG.plugins = { announcer: { enabled:true, ... } }.
 */
var ANNOUNCER_PLUGIN = (function () {
  var host = null;
  var timer = null;
  var settings = {
    welcome: 'Welcome, %name%!',   // %name% is substituted; empty = no welcome
    tips: [],                       // rotating messages
    tipIntervalSec: 0,              // 0 = tips off
  };

  var manifest = {
    id: 'announcer',
    name: 'Announcer',
    settings: [
      { key: 'welcome', label: 'Welcome message (%name% = player name)', type: 'string', default: 'Welcome, %name%!' },
      { key: 'tipIntervalSec', label: 'Tip interval (seconds, 0 = off)', type: 'number', min: 0, default: 0 },
      { key: 'tips', label: 'Rotating tips (one per line)', type: 'text', default: '' },
    ],
  };

  function applyTipTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    var secs = parseInt(settings.tipIntervalSec, 10) || 0;
    var tips = normalizeTips(settings.tips);
    if (secs <= 0 || tips.length === 0) return;
    var i = 0;
    // setInterval id kept in module scope so a hot reload / reconfigure clears it.
    timer = setInterval(function () {
      try { host.announce(tips[i % tips.length], null, 0x88ccff); } catch (e) {}
      i++;
    }, secs * 1000);
  }

  function normalizeTips(t) {
    if (Array.isArray(t)) return t.filter(function (s) { return s && String(s).trim(); });
    if (typeof t === 'string') return t.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    return [];
  }

  function onJoin(player) {
    if (!settings.welcome || !player) return;
    var name = (player && player.name) || 'worm';
    // announce (zz_1v1.js) takes the player OBJECT (it reads .id itself); pass
    // `player`, not player.id, or it falls through to a room-wide broadcast.
    try { host.announce(settings.welcome.replace(/%name%/g, name), player, 0x88ff88); } catch (e) {}
    // returning nothing keeps the chain going (don't veto join handling)
  }

  function loadSettings(conf) {
    if (!conf) return;
    if (typeof conf.welcome === 'string') settings.welcome = conf.welcome;
    if (conf.tipIntervalSec != null) settings.tipIntervalSec = conf.tipIntervalSec;
    if (conf.tips != null) settings.tips = conf.tips;
    if (host) applyTipTimer(); // live reconfigure from the panel
  }

  function init(h, conf) {
    if (window.__ANNOUNCER_PLUGIN) { console.log('announcer already loaded'); return; }
    window.__ANNOUNCER_PLUGIN = true;
    host = h;
    loadSettings(conf);

    // chain (not assign) so command_log.js's onPlayerJoin still runs.
    host.chainFunction(host.room, 'onPlayerJoin', onJoin);

    // A tiny command to prove registry integration + the permission tier.
    if (host.registry && host.COMMAND) {
      host.registry.add(['tip', 'tips'], ['!tip: show a random room tip'], function (player) {
        var tips = normalizeTips(settings.tips);
        if (!tips.length) { host.announce('no tips configured', player, 0xffaa55); return false; }
        var t = tips[Math.floor(Math.random() * tips.length)];
        host.announce(t, player, 0x88ccff); // player OBJECT — a raw id broadcasts
        return false; // consume the chat line
      }, host.COMMAND.FOR_ALL);
    }

    applyTipTimer();
  }

  return { manifest: manifest, init: init, loadSettings: loadSettings };
})();

if (window.WL_PLUGINS) {
  window.WL_PLUGINS.register(ANNOUNCER_PLUGIN);
} else {
  console.log('announcer: WL_PLUGINS not present — is _pluginhost.js loaded before this file?');
}
