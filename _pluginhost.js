/**
 * Plugin host + loader. Spec: _specs/plugin-architecture.md.
 *
 * Loads after _init.js (which defines `chainFunction`, `auth`, and assigns
 * `window.WLROOM` inside an async IIFE) but before any lowercase plugin/feature
 * file — the `_p` prefix guarantees that order (`_c` < `_i` < `_p` < a…).
 *
 * WL_HOST is the ONE dependency object every plugin gets at init. Every late
 * binding is a getter or a call-time closure, so nothing is read at THIS file's
 * load time (WLROOM/COMMAND/JSZip/fdb don't exist yet) — only when a plugin
 * actually uses it, well after boot.
 *
 * WL_PLUGINS holds the registration array. It must exist before the plugin files
 * (which call WL_PLUGINS.register at their own load), hence it lives here, not in
 * a lowercase plugin_loader.js.
 */

window.WL_HOST = {
  // baseRoomName is defined later (firebase.js), so a getter, not an eager copy.
  get baseRoomName()  { return (typeof baseRoomName !== 'undefined') ? baseRoomName : 'simple'; },
  get room()          { return window.WLROOM; },
  get config()        { return (typeof CONFIG !== 'undefined') ? CONFIG : {}; },
  get roomId()        { return (typeof CONFIG !== 'undefined') ? CONFIG.room_id : undefined; },
  get registry()      { return (typeof COMMAND_REGISTRY !== 'undefined') ? COMMAND_REGISTRY : null; },
  get fdb()           { return (typeof fdb !== 'undefined') ? fdb : null; },
  get auth()          { return (typeof auth !== 'undefined') ? auth : null; },      // THE _init.js Map
  get chainFunction() { return chainFunction; },                                    // reuse _init.js's
  get COMMAND()       { return (typeof COMMAND !== 'undefined') ? COMMAND : null; },
  get JSZip()         { return (typeof JSZip !== 'undefined') ? JSZip : null; },
  announce:         function () { return announce.apply(null, arguments); },
  notifyAdmins:     function () { return (typeof notifyAdmins === 'function') ? notifyAdmins.apply(null, arguments) : undefined; },
  getActivePlayers: function () { return (typeof getActivePlayers === 'function') ? getActivePlayers() : []; },
  isSuperAdmin:     function (p) { return (typeof isSuperAdmin === 'function') ? isSuperAdmin(p) : false; },
};

window.WL_PLUGINS = {
  _all: [],
  register: function (p) {
    if (!p || !p.manifest || !p.manifest.id) { console.log('WL_PLUGINS: ignoring a plugin with no manifest.id'); return; }
    // Replace any prior registration of the same id (a hot-reloaded plugin file
    // re-runs register) so _all never holds two instances under one id.
    for (var i = 0; i < this._all.length; i++) {
      if (this._all[i].manifest.id === p.manifest.id) { this._all[i] = p; return; }
    }
    this._all.push(p);
  },
  initAll: function () {
    var conf = (window.WL_HOST.config && window.WL_HOST.config.plugins) || {};
    for (var i = 0; i < this._all.length; i++) {
      var p = this._all[i];
      var id = p.manifest.id;
      var pconf = conf[id];
      // Strict opt-in: a plugin runs only if the room's CONFIG.plugins names it
      // (and doesn't set enabled:false). No entry = dormant, so dropping a plugin
      // file into the bundle never changes a room that hasn't asked for it.
      if (!pconf || pconf.enabled === false) { console.log('plugin ' + id + ' not enabled'); continue; }
      try {
        p.init(window.WL_HOST, pconf);
        publishPluginManifest(p, pconf);
        console.log('plugin ' + id + ' initialized');
      } catch (e) {
        console.log('plugin ' + id + ' init failed: ' + ((e && e.message) || e));
      }
    }
  },
};

/**
 * publishPluginManifest is the SINGLE writer/reader of the panel contract:
 *   simple/<room_id>/plugins/<id>      = {name, settings[], status?, updatedAt}   (room → panel)
 *   simple/<room_id>/pluginconf/<id>   = {<key>: value}                            (panel → room)
 * The panel renders a config form from settings[]; saving writes pluginconf,
 * which we relay to the plugin's loadSettings. Mirrors the mod/weapons contract.
 */
function publishPluginManifest(plugin, initialConf) {
  var host = window.WL_HOST;
  var fdbRef = host.fdb;
  if (!fdbRef) { setTimeout(function () { publishPluginManifest(plugin, initialConf); }, 300); return; }
  var base = host.baseRoomName + '/' + host.roomId + '/plugins/' + plugin.manifest.id;
  var confPath = host.baseRoomName + '/' + host.roomId + '/pluginconf/' + plugin.manifest.id;
  try {
    fdbRef.ref(base).set({
      name: plugin.manifest.name || plugin.manifest.id,
      settings: plugin.manifest.settings || [],
      status: plugin.manifest.status || null,
      updatedAt: Date.now(),
    });
  } catch (e) { console.log('publishPluginManifest ' + plugin.manifest.id + ': ' + e); }
  // Live config: panel writes pluginconf/<id>, relay to loadSettings.
  try {
    fdbRef.ref(confPath).on('value', function (snap) {
      var v = snap.val();
      if (v && typeof plugin.loadSettings === 'function') {
        try { plugin.loadSettings(v); } catch (e) { console.log('plugin ' + plugin.manifest.id + ' loadSettings: ' + e); }
      }
    });
  } catch (e) { console.log('pluginconf listen ' + plugin.manifest.id + ': ' + e); }
}
