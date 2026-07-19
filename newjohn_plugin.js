/**
 * newjohn — map-manipulation plugin (the newjohn room's effects, ported onto the
 * plugin framework). Spec: _specs/plugin-architecture.md §7.
 *
 * Uses the WL_MAP_TRANSFORM hook in mappool.js: the fork fetches map bytes with
 * its own timeouts/error-skips/race guard, and hands them here; when effects are
 * queued (manual !fx) or autoFx is on, we decode to palette indices, run the
 * chain (newjohn_effects.js — the capped buildinggame implementations), and the
 * fork loads the result via loadRawLevel on its normal guarded path. This
 * structurally removes every newjohn freeze: no unguarded fetches (fork owns
 * them), no unbounded growth (3000px caps), no O(n²) concat, no torn .lev
 * buffers (decode trims the CRLF-appended bytes 70% of repo .lev files carry —
 * newjohn declared 504x350 but shipped 176402+ bytes to loadRawLevel).
 *
 * PNG decode: prefers window.__ReadPNG (the engine's OWN parser, hacked builds —
 * exact palette indices); falls back to canvas + classic-palette nearest lookup
 * (newjohn's original approach: approximate under non-classic palettes), with
 * img.onerror + timeout so a bad PNG can never hang the chain (newjohn's did).
 */
var NEWJOHN_PLUGIN = (function () {
  var host = null;
  var settings = {
    autoFx: 0,        // 0 = off; N = apply N random effects on every map load
    autoExpand: -1,   // -1 = never touch expandLevel; N = expand when >=N active players
  };
  var pendingFx = null; // one-shot effect list queued by !fx for the next load

  // The classic newjohn random set — autoFx draws from these; manual !fx may use
  // ANY effect in effectList (including the material/cosmetic buildinggame ones).
  var RANDOM_POOL = ['stretch', 'stretchy', 'rotate', 'bigger', 'reverse', 'mirror',
    'expand', 'double', 'expandrev', 'expandalt', 'top', 'bottom', 'left', 'right'];

  var manifest = {
    id: 'newjohn',
    name: 'newjohn (map effects)',
    settings: [
      { key: 'autoFx', label: 'Auto effects per map (0 = off, max 5)', type: 'number', min: 0, max: 5, default: 0 },
      { key: 'autoExpand', label: 'Auto-expand when ≥N players (-1 = off)', type: 'number', min: -1, default: -1 },
    ],
    status: { effects: (typeof effectList !== 'undefined') ? effectList : [] },
  };

  // ── classic palette (newjohn/palette.js) — canvas-decode fallback only ──
  var njInvPal = null;
  function njBuildInvPal() {
    if (njInvPal) return njInvPal;
    var pal = ["0_0_0","108_56_0","108_80_0","164_148_128","0_144_0","61_173_61","252_84_84","168_168_168","85_85_85","84_84_252","84_216_84","84_252_252","120_64_8","128_68_8","136_72_12","144_80_16","152_84_20","160_88_24","172_96_28","76_76_76","84_84_84","92_92_92","100_100_100","109_109_109","116_116_116","125_125_125","132_132_132","140_140_140","148_148_148","157_157_157","56_56_136","81_81_193","105_105_249","145_145_245","185_185_245","110_110_110","145_145_145","181_181_181","217_217_217","32_96_32","45_133_45","62_174_62","113_189_113","165_213_165","111_111_111","146_146_146","182_182_182","218_218_218","168_168_248","208_208_244","252_252_244","60_80_0","88_112_0","116_144_0","148_176_0","120_72_52","157_121_89","197_169_125","237_217_161","156_120_88","196_168_124","236_216_160","200_100_0","160_80_0","72_72_72","108_108_108","147_147_147","180_180_180","216_216_216","253_253_253","196_196_196","144_144_144","152_60_0","180_100_0","208_140_0","236_180_0","168_84_0","217_1_1","189_1_1","165_1_1","200_0_0","172_0_0","218_2_2","190_2_2","166_2_2","216_0_0","188_0_0","164_0_0","82_82_194","106_106_250","146_146_246","80_80_192","107_107_251","147_147_247","149_137_1","136_124_0","124_112_0","116_100_0","132_92_40","160_132_72","188_176_104","216_220_136","248_248_188","244_244_252","253_1_1","248_24_4","248_52_8","248_80_16","248_108_20","248_136_24","248_164_32","248_192_36","248_220_40","245_233_61","244_244_80","244_244_112","244_244_148","240_240_180","240_240_212","240_240_248","46_134_46","63_175_63","114_190_114","47_135_47","64_176_64","115_191_115","248_60_60","244_124_124","244_188_188","104_104_248","148_148_248","184_184_244","144_144_244","65_177_65","116_192_116","164_212_164","112_188_112","148_136_0","136_116_0","124_96_0","112_76_0","100_56_0","89_41_1","104_104_136","144_144_192","188_188_248","200_200_244","220_220_244","40_112_40","44_132_44","52_152_52","60_172_60","252_200_200","245_165_165","248_92_92","245_77_77","244_60_60","244_76_76","244_92_92","244_164_164","84_40_0","88_40_0","92_44_0","96_48_0","60_28_0","64_28_0","68_32_0","72_36_0","252_252_252","221_221_221","189_189_189","158_158_158","124_124_124","156_156_156","188_188_188","220_220_220","108_76_44","124_84_48","140_96_56","156_108_64","172_120_72","0_0_0","40_36_8","80_76_20","120_116_28","160_152_40","200_192_48","244_232_60","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","0_0_0","254_2_2","252_36_0","252_72_0","252_108_0","252_144_0","252_180_0","252_216_0","252_252_0","168_240_0","84_232_0","0_224_0","252_0_0","232_4_20","216_12_44","196_20_68","180_24_88","160_32_112","144_40_136","124_44_156","108_52_180","88_60_204","72_68_228"];
    njInvPal = new Map();
    for (var i = 0; i < pal.length; i++) njInvPal.set(pal[i], i);
    return njInvPal;
  }
  // NOTE: the pal table above is newjohn/palette.js's 256-entry classic table,
  // copied VERBATIM (scripted extraction — do not hand-edit). Unknown colors
  // fall back to 1 (dirt), matching newjohn's getbestpixelValue fallback.

  // ── decoding: raw bytes → {width, height, data:[indices]} ──
  var LEV_W = 504, LEV_H = 350, LEV_BYTES = LEV_W * LEV_H;

  function decodeLev(ab) {
    var bytes = new Uint8Array(ab);
    if (bytes.length < LEV_BYTES) {
      throw new Error('lev too short: ' + bytes.length + ' < ' + LEV_BYTES);
    }
    // Trim to exactly w*h: many repo .lev files carry +2 CRLF-normalized bytes
    // (or an appended palette block) — newjohn fed those to loadRawLevel with a
    // mismatched declared size; we never do.
    return { width: LEV_W, height: LEV_H, data: Array.from(bytes.subarray(0, LEV_BYTES)) };
  }

  async function decodePng(ab) {
    if (typeof window.__ReadPNG === 'function') {
      var d = window.__ReadPNG(ab);
      var plane = d.image != null ? d.image : d.data;
      return { width: d.width, height: d.height, data: Array.from(new Uint8Array(plane)) };
    }
    // canvas fallback (vanilla build): RGB → nearest classic palette entry.
    var inv = njBuildInvPal();
    var blob = new Blob([ab]);
    var img = new Image();
    var url = URL.createObjectURL(blob);
    try {
      await new Promise(function (resolve, reject) {
        var t = setTimeout(function () { reject(new Error('png decode timeout')); }, 10000);
        img.onload = function () { clearTimeout(t); resolve(); };
        img.onerror = function () { clearTimeout(t); reject(new Error('png decode failed')); };
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
    var w = img.width, h = img.height;
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(img, 0, 0, w, h);
    var px = ctx.getImageData(0, 0, w, h).data;
    var out = new Array(w * h);
    for (var i = 0, o = 0; i < px.length; i += 4, o++) {
      var key = px[i] + '_' + px[i + 1] + '_' + px[i + 2];
      var idx = inv.get(key);
      out[o] = idx == null ? 1 : idx; // unknown color → dirt (newjohn fallback)
    }
    return { width: w, height: h, data: out };
  }

  function decode(name, ab) {
    return name.split('.').pop().toLowerCase() === 'png' ? decodePng(ab) : Promise.resolve(decodeLev(ab));
  }

  // ── the transform (called by mappool.js's WL_MAP_TRANSFORM hook) ──
  function randomFxList(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)]);
    return out;
  }

  async function transform(name, ab) {
    var fxs = null;
    if (pendingFx) {
      // One-shot AND target-bound: a stale queue entry (its reload superseded
      // by a newer load before the transform ran) must not fire on whatever
      // map loads next — consume only when the names match, discard otherwise.
      var pf = pendingFx; pendingFx = null;
      if (pf.name === name && pf.fxs.length) fxs = pf.fxs;
      else console.log('newjohn: discarding stale queued fx for ' + pf.name + ' (loading ' + name + ')');
    }
    if (!fxs && settings.autoFx > 0) {
      fxs = randomFxList(Math.min(5, settings.autoFx | 0));
    }
    if (!fxs) {
      applyExpand(); // autoExpand is independent of effects — apply on EVERY load
      return null;   // no effects wanted → fork loads normally
    }

    var map = await decode(name, ab);
    map.name = name;
    for (var i = 0; i < fxs.length; i++) {
      var spec = fxs[i]; // "name" or "name:arg1:arg2" (manual !fx supports args)
      var parts = String(spec).split(':');
      var fn = effects[parts[0]];
      if (typeof fn !== 'function') { console.log('newjohn: unknown effect ' + parts[0] + ' — skipped'); continue; }
      map = fn.apply(null, [map].concat(parts.slice(1)));
    }
    applyExpand();
    console.log('newjohn: applied [' + fxs.join(', ') + '] to ' + name + ' → ' + map.width + 'x' + map.height);
    return map;
  }

  function applyExpand() {
    if (settings.autoExpand < 0) return; // never touch engine settings unless enabled
    try {
      var expand = host.getActivePlayers().length >= settings.autoExpand;
      var sets = host.room.getSettings();
      if (sets.expandLevel !== expand) { sets.expandLevel = expand; host.room.setSettings(sets); }
    } catch (e) { console.log('newjohn: expand toggle failed: ' + e); }
  }

  function loadSettings(conf) {
    if (!conf) return;
    if (conf.autoFx != null && !isNaN(conf.autoFx)) settings.autoFx = Math.max(0, Math.min(5, parseInt(conf.autoFx, 10)));
    if (conf.autoExpand != null && !isNaN(conf.autoExpand)) settings.autoExpand = parseInt(conf.autoExpand, 10);
  }

  function init(h, conf) {
    if (window.__NEWJOHN_PLUGIN) { console.log('newjohn already loaded'); return; }
    window.__NEWJOHN_PLUGIN = true;
    host = h;
    loadSettings(conf);

    // Register the transform with the fork's map loader. Single owner: if some
    // other plugin claimed the hook, refuse loudly rather than silently chain.
    if (typeof window.WL_MAP_TRANSFORM === 'function') {
      console.log('newjohn: WL_MAP_TRANSFORM already claimed — effects disabled');
      return;
    }
    window.WL_MAP_TRANSFORM = transform;

    var C = host.COMMAND;
    host.registry.add('fx', [function () { return '!fx [name[:arg…]] …: apply effects to the current map (random if none). Available: ' + effectList.join(', '); }], function (player) {
      var args = Array.prototype.slice.call(arguments, 1);
      var fxs = args.map(function (s) { return String(s).trim(); })
        .filter(function (s) { return s && typeof effects[s.split(':')[0]] === 'function'; })
        .slice(0, 5);
      if (fxs.length === 0) fxs = randomFxList(1); // FIX vs newjohn: name, not numeric index
      var target = window.currentMapName;
      if (!target || target.substring(0, 7) === 'random#') {
        host.announce('cannot apply effects to the current map (subpool/unknown) — use !map first', player, 0xffaa55);
        return false;
      }
      pendingFx = { name: target, fxs: fxs }; // target-bound one-shot (see transform)
      host.announce('applying: ' + fxs.join(', '), null, 0x88ccff);
      window.loadMapByName(target); // the fork's guarded path picks pendingFx up via the hook
      return false;
    }, C.ADMIN_ONLY);

    host.registry.add('fxlist', ['!fxlist: list available map effects'], function (player) {
      host.announce(effectList.join(', '), player, 0x88ccff);
      return false;
    }, C.FOR_ALL);

    host.registry.add('autofx', ['!autofx #n#: apply n random effects on every map load (0 = off)'], function (player, n) {
      // FIX vs newjohn: the count is used (theirs generated maxEffects+1 always)
      var v = parseInt(n, 10);
      settings.autoFx = isNaN(v) ? 0 : Math.max(0, Math.min(5, v));
      host.notifyAdmins('autofx set to ' + settings.autoFx);
      return false;
    }, C.ADMIN_ONLY);

    host.registry.add('autoexp', ['!autoexp #n#: auto-expand level when ≥n active players (no arg = off)'], function (player, n) {
      var v = parseInt(n, 10);
      settings.autoExpand = isNaN(v) ? -1 : v;
      host.notifyAdmins(settings.autoExpand < 0 ? 'auto-expand off' : 'auto-expand at ≥' + settings.autoExpand + ' players');
      return false;
    }, C.ADMIN_ONLY);
  }

  return { manifest: manifest, init: init, loadSettings: loadSettings };
})();

if (window.WL_PLUGINS) {
  window.WL_PLUGINS.register(NEWJOHN_PLUGIN);
} else {
  console.log('newjohn: WL_PLUGINS not present — is _pluginhost.js loaded before this file?');
}
