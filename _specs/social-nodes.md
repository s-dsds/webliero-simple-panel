# Social nodes — motd / eastereggs / vips + hidden admins

Data-driven room flavor and permissions, all under `<base>/<room_id>/` in the
rooms RTDB. Every node is OPTIONAL: a room without them behaves exactly as
before (motd falls back to `CONFIG.motd`). Loaded by `firebase.js`
(`listenForSocialNodes`, whole-node `value` listeners — these stay tiny).

## motd

A list of welcome lines; ONE is picked at random per join and announced to the
joiner (replacing the static `CONFIG.motd`). Array or index-keyed object of
strings; empty/absent → `CONFIG.motd`.

```json
["Welcome to the arena", "Fresh meat! Type !j to queue up"]
```

## eastereggs

Per-auth join announcements, broadcast to the WHOLE room (the arena's
hardcoded "lala in da house" gag, data-driven). Keyed by auth like `admins`.
`color` may be a number or a `"#RRGGBB"` / `"0xRRGGBB"` string; `style` is a
sendAnnouncement style (default `italic`).

```json
{ "<auth>": { "msg": "☢☢ Watch out, lala in da house! ☢☢", "color": "#FFFF00", "style": "italic" } }
```

## vips

Per-auth permissions that are NOT admin. Keyed by auth. One flag so far:

- `camera: true` — a filming spectator: exempt from the anti-AFK spectator
  purge (they sit still on purpose). Grants nothing else.

```json
{ "<auth>": { "name": "streamer", "camera": true } }
```

## admins.hidden

`admins/<auth>.hidden = true` keeps the record but skips BOTH auto-promotions
(join-time in `zz_1v1.js` and the panel live-promote in `loadnewAdmin`). A
hidden admin opts in by typing `!admin` or `!a`. Un-hiding via the panel
promotes live (child_changed). The panel admins tab has the checkbox
(ext-proxy `handlePutAdmins` round-trips the flag — older panels would strip
it on save).

## AFK spectator purge (d_anti-afk.js) — fixed semantics

When the room is full (`maxPlayers` from init conf), the OLDEST AFK-evicted
spectator is kicked to free the slot. Eligibility is strict; a candidate must
be all of:

- previously evicted by the anti-AFK plugin (never a plain spectator),
- still spectating (rejoining a team clears candidacy),
- not in the arena waiting queue (`window.__ARENA_IN_QUEUE`, exposed by
  arena_plugin),
- not a camera vip,
- silent (any chat/activity clears candidacy — present ≠ AFK).

Tests: `test-harness-social.html` (32 checks — hidden admins, motd, eggs,
purge exemptions, queue theater, dup-auth kick). Run:
`chrome --headless=new --virtual-time-budget=30000 --dump-dom`, verdict in
`<title>`.
