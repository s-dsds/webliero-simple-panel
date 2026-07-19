/**
 * Plugin boot. Loads LAST: `zz_z` sorts after `zz_1v1.js` (which calls
 * initFirebase), so every plugin file has registered and every host global
 * exists by now. There's no fdb-ready callback — initFirebase assigns `fdb`
 * inside an async IIFE — so mirror panel.js/mappool.js and poll until both `fdb`
 * and `window.WLROOM` are live, then init every registered plugin once.
 *
 * A room with no CONFIG.plugins block loads this harmlessly: initAll skips every
 * plugin that the room hasn't explicitly named (strict opt-in), so shipping the
 * framework + a plugin file never changes a room that hasn't asked for it.
 */
(function bootPlugins() {
  if (typeof fdb === 'undefined' || !fdb || !window.WLROOM || !window.WL_PLUGINS) {
    setTimeout(bootPlugins, 200);
    return;
  }
  try {
    window.WL_PLUGINS.initAll();
  } catch (e) {
    console.log('WL_PLUGINS.initAll failed: ' + ((e && e.message) || e));
  }
})();
