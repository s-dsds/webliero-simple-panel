/** room-admin-panel contract v1: mod + weapons listeners, weaponlist/meta writers */

var panelModCache = new Map();
var panelModBaseUrl = "https://webliero.gitlab.io/webliero-mods";
var panelModRef;
var panelWeaponsRef;
var panelWeaponlistRef;
var panelMetaRef;
var lastAppliedModKey = null;
var lastWeaponsNode;

function initPanel() {
    if (typeof fdb == 'undefined' || !fdb) {
        setTimeout(initPanel, 200);
        return;
    }
    panelModRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/mod`);
    panelWeaponsRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/weapons`);
    panelWeaponlistRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/weaponlist`);
    panelMetaRef = fdb.ref(`${baseRoomName}/${CONFIG.room_id}/meta`);

    panelModRef.on('value', handlePanelModChange);
    panelWeaponsRef.on('value', handlePanelWeaponsChange);

    writePanelMeta();
    console.log('panel ok');
}
initPanel();

function writePanelMeta() {
    let meta = {
        contractVersion: 1,
        panel: "webliero-simple-panel",
        updatedAt: Date.now()
    };
    if (typeof window.WLROOM.getWeapons == 'function') {
        meta.weapons = true;
    }
    panelMetaRef.set(meta);
}

async function getPanelModData(url) {
    if (panelModCache.has(url)) {
        return panelModCache.get(url);
    }
    let data;
    try {
        let res = await fetch(url);
        if (!res.ok) {
            // a 404 (bad mod name) returns an HTML error page — never feed
            // those bytes to loadMod, which throws parsing them as a zip
            console.log("panel: mod fetch failed", res.status, url);
            return null;
        }
        data = await res.arrayBuffer();
    } catch (e) {
        return null;
    }
    panelModCache.set(url, data);
    return data;
}

function resolvePanelModUrl(v) {
    if (v.url) {
        return v.url;
    }
    if (v.name) {
        return panelModBaseUrl + '/' + v.name;
    }
    return null;
}

async function handlePanelModChange(snapshot) {
    let v = snapshot.val();
    if (!v || (!v.url && !v.name)) {
        return;
    }
    let modKey = v.url || v.name;
    if (modKey === lastAppliedModKey) {
        return;
    }
    let modUrl = resolvePanelModUrl(v);
    let data = await getPanelModData(modUrl);
    if (!data) {
        console.log("panel: mod could not be loaded", modUrl);
        return;
    }
    window.WLROOM.loadMod(data);
    lastAppliedModKey = modKey;
    console.log("panel: mod loaded", modUrl);

    if (typeof window.WLROOM.getWeapons == 'function') {
        await refreshWeaponlistAndReapply();
    }
}

// the engine wipes the ban set on loadMod, so getWeapons() can be briefly empty right after
async function refreshWeaponlistAndReapply(retriesLeft = 5) {
    let weapons = window.WLROOM.getWeapons();
    if ((!weapons || weapons.length === 0) && retriesLeft > 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return refreshWeaponlistAndReapply(retriesLeft - 1);
    }
    if (!weapons || weapons.length === 0) {
        // getWeapons() exists (meta.weapons was set) but stays empty after a
        // real mod load — the weapon-ban hack is half-applied (e.g. the wlhl
        // anchor drifted on a webliero re-minify). Bans silently won't work;
        // flag it so the panel can warn the admin instead of failing quietly.
        console.log("panel: getWeapons() empty after mod load — flagging weaponsError");
        panelMetaRef.child('weaponsError').set(
            'Weapon control is not responding on this room (getWeapons empty after a mod load). ' +
            'Bans will not apply until the room is re-hosted with a working weapon build.');
        return;
    }
    let snapshot = weapons.map((w, i) => ({index: i, name: w.name}));
    panelWeaponlistRef.set(snapshot);
    applyPanelWeaponsNode(lastWeaponsNode); // apply bans first — never let a metadata write block this
    panelMetaRef.child('weaponsError').remove(); // recovered
}

function handlePanelWeaponsChange(snapshot) {
    lastWeaponsNode = snapshot.val();
    applyPanelWeaponsNode(lastWeaponsNode);
}

function applyPanelWeaponsNode(v) {
    if (typeof window.WLROOM.getWeapons != 'function') {
        return;
    }
    window.WLROOM.unbanAllWeapons();
    if (!v) {
        return;
    }
    if (typeof v.banById != 'undefined') {
        for (const id of v.banById) {
            window.WLROOM.banWeaponById(id, true);
        }
    } else if (typeof v.onlyById != 'undefined') {
        window.WLROOM.getWeapons().forEach((w, i) => {
            window.WLROOM.banWeaponById(i, !v.onlyById.includes(i));
        });
    } else if (typeof v.only != 'undefined') {
        for (const w of window.WLROOM.getWeapons()) {
            window.WLROOM.banWeapon(w.name, !v.only.includes(w.name));
        }
    } else if (typeof v.ban != 'undefined') {
        for (const name of v.ban) {
            window.WLROOM.banWeapon(name, true);
        }
    }
}
