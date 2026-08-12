# Leaver & AFK stats policy — make quitting and idling visible, then accountable

Status: design (2026-08-12; revised twice the same day — after spec review, then
after the owner resolved the open questions). Implements the owner's three
rules: (1) a lost connection must never dock stats or ELO, (2) *repeated*
leave-before-you-lose must become visible and eventually cost something, (3) a
player who has been inactive since the round started must not feed the killer's
kill/ELO credit (otherwise "spawn idle bots, shoot them, farm rank" is free).

Companions: `_specs/arena-leagues.md` (house shapes for additive stats fields
and the `@@GAME@@` payload), `_specs/plugin-architecture.md` §6d (stats have ONE
owner: `z_stats.js`; plugins drive no stats writes),
`headless-launcher-go/_specs/game-history.md` (`@@GAME@@` → SQLite gamestore),
`ext-proxy/_specs/room-admin-panel.md` (Stats tab, governed nodes).

## Goal & non-goals

**Goal.** `z_stats.js` records, for every game, *how each participant's game
ended* (played to the end / left / spectated out / kicked) and *whether they
ever touched their controls*, so that (a) a disconnect costs nothing, (b) a
serial quitter is identifiable and, past a tuned threshold, forfeits the game
they walked out of, and (c) kills scored on a player who was idle for the whole
round credit nobody.

**Non-goals (v1).**
1. Automatic kicks, bans or mutes. The only consequences are stats-side
   (forfeit / exclusion) plus admin visibility. Moderation stays human.
2. Cross-room reputation. Counters live in this room's `stats/players/<auth>`
   like every other aggregate.
3. Replacing `d_anti-afk.js`. That plugin owns *moving idle players to
   spectators*; this spec owns *how idleness and exits score*. They share one
   input signal and nothing else.
4. Queue consequences in the arena plugin (send an abandoner to the back of the
   queue, cool-down before re-entry). Sketched in phase 4, not specified here.
5. Detecting collusion, score-fixing, aim-bots, or any other cheat that is not
   "left early" / "never moved".
6. Positional or per-tick analysis of play. The activity signal is event-driven
   (§2); no polling loop is added to the game loop.
7. Per-league or per-mod integrity buckets. One set of counters per player per
   room, matching the one-ladder-per-room decision (`arena-leagues.md` §7.4).
8. Rewriting the stats lifecycle for gamemodes the panel cannot select. §3
   covers all nine engine modes but only `dm` / `lms` / `htf` / `tdm` are
   reachable from the panel (`roomadmin.go:642`).

## What already exists (don't reinvent)

- **Participant tracking.** `statsParticipants` (id → `{auth, name, scoreStart,
  killsStart, deathsStart, elo, form, midSession, team, …}`) is built at
  `onGameStart` for every non-spectator (`z_stats.js:266-293`) and extended
  mid-game for joiners/team-changers with `midSession:true`
  (`z_stats.js:153-178`, `statsAddParticipant` at `z_stats.js:204-217`).
- **Mid-session participants are ALREADY excluded from rank/ELO**
  (`full = parts.filter(p => !p.midSession)`, `z_stats.js:432`), get
  `partialGames` instead of `games`, and are emitted with `partial:true`
  (`z_stats.js:456-459, 637-639`). *This spec reuses that exclusion path
  verbatim rather than inventing a second one.*
- **An accrue-between-flushes store already exists.** `statsPending` (auth →
  `{joins, chat, name}`) accumulates outside the participant map and is drained
  into the game-end batch for **any** auth, participant or not
  (`z_stats.js:48-54, 476-482`). The exit store in §4 is deliberately the same
  pattern, for the same reason: it must outlive a round boundary.
- **Leave snapshot.** `statsOnLeave` sets `pc.left` and snapshots
  `pc.scoreLeave` (`z_stats.js:180-195`) because the engine destroys the score
  entry moments after the player goes; `statsScoreById` falls back to it
  (`z_stats.js:668-678`).
- **Per-player seed read.** `statsSeedParticipant` does one `players/<auth>`
  read per participant and keeps `elo`, `form`, `streak`, `bestStreak`,
  `fastestWinMs` in memory (`z_stats.js:220-236`). Every new value the policy
  needs (`abandons`, `cleanStreak`) rides in on that same read — **no extra RTDB
  traffic**.
- **Ranking + ELO.** `statsAssignRanks` (score-descending, averaged ties,
  `z_stats.js:680-691`) and `statsComputeElo` (pairwise, `K/(N-1) · Σ(S−E)`,
  `z_stats.js:693-704`).
- **Kill events.** `onPlayerKilled(killed, killer)` is stock and already chained
  (`z_stats.js:350-405`); `onPlayerHit(attacker, victim, damage, weaponID)` is
  the injected hacked-build callback (`z_stats.js:319-335`).
- **An AFK detector on the exact signal we need.** `d_anti-afk.js` chains
  `onPlayerActivity` and `onPlayerChat` (`d_anti-afk.js:190-191`) and moves a
  player who has produced neither for `settings.timeout` (default 20 000 ms,
  `d_anti-afk.js:28`) to spectators after a 5 s grace warning
  (`evictPlayer`, `d_anti-afk.js:57-79`). Admins retune or disable it with
  `!afk <seconds>` (`d_anti-afkinit.js:3-11`).
- **`detectBadRunaway` is missing on purpose.** The arena port dropped it —
  "arena latent bug: bare `wasLosing` → ReferenceError on mid-game leave; and
  `wasLosing` always returned true — log-only feature, not worth carrying"
  (`arena_plugin.js:23-26`). **This spec is its replacement**, in the component
  that owns stats.
- **Additive fields are safe for readers.** `ext-proxy` reads
  `stats/players/<auth>` into `map[string]interface{}` and plucks known keys
  (`statsread.go:66-107, 167-216`); wlhl stores the whole `@@GAME@@` payload
  verbatim in `games.raw` and unmarshals it into a struct that silently drops
  unknown keys (`gamestore.go:40-51, 118-152, 211`).

## Design

### 1. Vocabulary

Fixed terms; used exactly this way everywhere below.

| term | meaning |
|---|---|
| **participant** | has an entry in `statsParticipants`. **full** = on a team at `onGameStart`; **midSession** = joined or un-spectated after it. |
| **round** | one `onGameStart` → `onGameEnd` span. A reset (`restartGame`, level load) starts a new round without ending the old one (§4). `statsRoundSeq` numbers them. |
| **exit** | a participant stops playing *while a game is in progress*. Three kinds: **leave** (`onPlayerLeave`), **spec** (`onPlayerTeamChange` to team 0), **kick** (a leave that `onPlayerKicked` retracts, §4). |
| **rankScore** | the per-gamemode quantity a player is ranked on (§3). Not the same thing as `dScore`. |
| **standing** | the exiting player's `rankScore` against the best `rankScore` among the *other* participants at the instant of the exit: `winning` / `tied` / `losing` / `solo` (no other participant). |
| **material** | the round was far enough along for the exit to mean something (§4). |
| **abandon** | a *full* participant's `leave`-or-`spec` exit that is **not `winning` and not `solo`**, is `material`, is not `afk`, and was not retracted (§4). The only counter with teeth. |
| **AFK** | produced zero *input* activity for the whole round, from their own start baseline, with at least `STATS_AFK_MIN_MS` of that baseline elapsed (§2). A per-round property of a player, not of a person. |
| **tainted kill** | a kill whose victim turns out, at round end, to have been AFK for the whole round (§7). Provisional while the round runs. |
| **excused** | an exiting participant removed from the ranked set — no ELO, no win, no rank (§6). |
| **forfeit** | an exiting participant kept in the ranked set but pinned below every player who finished (§6). |

A leave with **no game in progress** is not an exit and is recorded nowhere —
joining a room, looking at the map and leaving must stay invisible.

### 2. The activity signal: `onPlayerActivity`, plus damage and kills

`onPlayerActivity(player)` is a **stock** callback: the vanilla
`headless-min.js` dispatches it
(`tmp/www.webliero.com/14AHELuk/__cache_static__/g/headless-min.js:272`,
readable equivalent `dock/webliero-extended-scripts/headless-extended.js:6843`).
It fires server-side when a client's input command is *applied*, from four
places: aim-offset change (`headless-extended.js:9265`), rope fire/release
(`:10083`), input-state change (`:10150`, `b.Ef = this.input`) and weapon change
(`:10231`).

> That vanilla-client evidence is a **March 2023 cache** of webliero.com. It
> establishes that the callback is not a wlhl injection; it does **not**
> establish that today's build still dispatches it. The capability probe at the
> end of this section is the live check, and it is not optional.

**It is edge-triggered, not a poll.** A player holding keys down produces no
events until something changes. So "no activity events" is *not* literally "no
input" — it is "no input *change*". Two consequences:

- Cost is bounded by how often players change their inputs (a handful per second
  per player under combat), and the handler is a `Map` write. No polling loop,
  no `getPlayerList()` scan, nothing per-frame. **Position polling is rejected**:
  it costs a player-list scan per tick-group, it cannot see aiming or firing (a
  stationary sniper looks identical to a corpse), and the room already has a
  server-authoritative input signal `d_anti-afk.js` has used for years.
- The one false positive that matters is a player who takes up a position, holds
  a key (e.g. fire) and changes nothing for ≥20 s. That is closed by counting
  **damage dealt** (`statsOnHit`, hacked build only) and **kills scored**
  (`statsOnKilled` with `killer === them`, stock) as activity. A player who is
  hurting somebody is by definition not AFK.

**Chat is deliberately NOT activity** for the AFK/taint predicate (owner's call,
2026-08-12): a player in a live round *should be playing seriously* — killing
someone who stopped to type is bad manners, but the person who parked mid-round
to type is the bigger offender, and the room's stats should not take their side.
The accepted residue is that a chat-only client (a bot that says "hi" once a
round) is farmable exactly like a silent one; that is risk 5, monitored, not
designed around. Chat *does* count for the exit classification's
involuntary-eviction test (§4 step 4), where the question is a different one:
"did the anti-afk plugin move them, or did they choose to leave".

Per-round state, reset in `statsOnGameStart`:

    statsAct  = Map(playerId -> { firstMs, lastMs, n })   // input | damage dealt | kill scored
    statsSeen = Map(playerId -> lastMs)                   // the above, plus chat

**Per-player baseline.** `pc.startedAt` is stamped in `statsAddParticipant`.
The AFK clock runs from `baseline = Math.max(statsGameStartTs, pc.startedAt)`,
never from the round start alone — otherwise a player who joins at minute 5 is
"AFK since round start" from their very first frame, and a kill on them 3 s
later is tainted.

    statsIsAfk(pc, now) = !statsAct.has(pc.id) && (now - baseline(pc)) >= STATS_AFK_MIN_MS

**Missing entries mean idle, not unknown.** Both maps are empty for a player who
has done nothing — a `now - statsSeen.get(id)` expression on a missing key is
`NaN`, and every comparison against `NaN` is false, which would classify the
exact player the rule protects as *active*. Every read of these maps therefore
goes through helpers that substitute the baseline:

    idleInputMs(pc, now) = now - (statsAct.get(pc.id)?.lastMs  ?? baseline(pc))
    idleAnyMs(pc, now)   = now - (statsSeen.get(pc.id)         ?? baseline(pc))

**No round clock ⇒ no AFK classification.** A mid-game `z_stats.js` hot reload
leaves `statsGameStartTs === 0` (the same condition that already emits
`durationMs: 0`, `z_stats.js:655`), which would make every baseline the epoch
and every player AFK for the rest of the round. When `statsGameStartTs === 0`,
AFK classification is skipped entirely for that round — one condition, matching
how the duel-duration code already distrusts that state (`z_stats.js:579`).

`STATS_AFK_MIN_MS` defaults to 20 000 (mirroring `d_anti-afk.js`'s default
timeout so the two features agree about who is idle), read from
`CONFIG.stats_afk_min_ms` if present. It is **independent of `!afk <n>`** —
retuning the eviction timer must not silently retune scoring.

**What the anti-afk plugin already covers, precisely.** With the plugin enabled
at defaults, any idle player on a team is warned at 15 s and moved to spectators
at 20 s, so the AFK window in a normal room is seconds wide. Its one escape
hatch, `hasOnlyOneActivePlayer()`, counts **non-spectators, not non-idle
players** (`states.js:13-18`) — so "attacker + idle bot" is two active players
and the bot *is* evicted. The AFK rules therefore exist for: rooms where an
admin ran `!afk 0`; rooms that don't load the plugin; the seconds before an
eviction lands; and any future breakage of the plugin's own chain.

**Capability probe (hard requirement).** If a completed round had ≥2 full
participants, lasted ≥60 s, and produced **zero** activity events from
*anybody*, the signal is not wired on this build: set `statsAfkSignalOk = false`,
log once, and from then on treat nobody as AFK (all AFK logic no-ops) until the
room restarts. Without this, a build whose `Gb` hook drifted would flag the
entire room AFK and void every game's ELO.

### 3. The score model per gamemode — LMS counts DOWN

**This section exists because the arena runs Last Man Standing, and every
score-derived rule in `z_stats.js` was written for deathmatch.**

The engine picks a gamemode class from the numeric `gameMode` setting
(`Cb.ql`, `headless-extended.js:7610-7635`) and each class defines what
`getPlayerScore().score` (`Fg`) means:

| `gameMode` | class | `Fg` is | direction |
|---|---|---|---|
| `dm` (0), `tdm` (3) | `Ba` (`:7363`, qg `:7386`) | kills − own-goals | **up** |
| `lms` (1) | `gb` (`:8275`, qg `:8300`) | **lives remaining** | **down** |
| `htf` (2) | `hb` (`:8172`, qg `:8211`) | ticks holding the flag | up |
| `dtf` (4), `ctf` (7), `ctf2` (8), `haz` (5) | `dtf`/`ctf`/`haz` | flag/zone tick counters | up |
| `pred` (6) | `pred` (`:7431`, "copy of dm") | kills − own-goals | up |

In LMS the class seeds every player with `fc = Jc = max(scoreLimit, 1)`
(`gb.ec`, `:8291-8296`; `scoreLimit` is the `Yb` setting, `:8552-8562`) and
decrements it on each death (`gb.Ng`: `a.xa++, a.fc--`, `:8313-8317`). The
round ends as soon as at most one player is still alive
(`gb.update`: `(1 < c && 1 >= d || 1 == c && 0 == d) && a.tc()`, `:8332`).
So the owner's description — *"counts down from max-life to 0, looser has 0"* —
is exactly the engine's behaviour, and `score` in LMS is an **absolute stock of
lives, not an accumulator**.

`WLROOM.getSettings().gameMode` returns the **string** form (`"dm"`, `"lms"`,
`"htf"`, …) via `Cb.yl` (`:7655-7677`), so the room script reads the mode
directly with no numeric mapping.

> **Pre-existing bug this exposes, and it is not small.** `z_stats.js` computes
> `pc.dScore = Math.max(0, live.score - pc.scoreStart)` (`z_stats.js:426`). In
> LMS `live.score ≤ scoreStart` always, so **every participant's `dScore` is 0**.
> Consequences today, in exactly the rooms this policy is for:
> `statsAssignRanks` puts everyone in one tie group with one averaged rank →
> `statsComputeElo` sees `S = 0.5` for every pair → **ELO never moves**;
> `scoreSum` never accrues; and the duel block's `d0.dScore !== d1.dScore` test
> (`z_stats.js:564`) is never true → **no h2h wins, no streaks, no
> `fastestWinMs`**. The arena ladder is inert. (`arena_plugin.js:127-152` is
> unaffected — it compares raw `score.score`, where more lives correctly means
> winner.) Fixing this is a prerequisite for the policy, not a bonus: a forfeit
> that pins someone below the finishers means nothing when every finisher is
> already tied at zero. Lands in phase 1b.

**`rankScore`, the one quantity everything ranks on:**

    up-modes:  rankScore = dScore = max(0, live.score - pc.scoreStart)   // as today
    lms:       rankScore = live.score                                     // absolute lives left
               dScore    = 0                                              // unchanged from today

`rankScore` drives `statsAssignRanks`, `statsComputeElo`, `standing` (§4), the
duel winner, h2h, `streak` and `fastestWinMs`. `dScore` keeps its current
meaning and remains what feeds `scoreSum` and `@@GAME@@ players[].score`;
`rankScore` is emitted additively alongside it. **`scoreSum` deliberately does
not accrue in LMS**: a lifetime counter that mixes "kills scored" from a dm room
with "lives left" from an arena room is worse than an empty one.

**LMS carve-out — eliminated players.** `rankScore === 0` in LMS means
eliminated. An exit at zero lives is **never an abandon**: the round is already
decided for them, the engine ends it as soon as one player remains, and there is
nothing left to forfeit. (This is not a loophole — reaching zero is losing.)

**Unknown modes.** If `gameMode` is something this table doesn't cover, fall
back to **deaths-relative standing** (fewest `dDeaths` among the others =
winning), use `dScore` for ranking as today, and log once per round
(`stats: unknown gameMode <x> — standing falls back to deaths`). The panel can
only set the four documented modes, so this is a room-side `setSettings` path.

### 4. Exit records live outside the participant map

#### The restart discard: intentional invalidation, now superseded

`WLROOM.restartGame()` sends the `la` message, whose `apply` calls `Tf`
(`headless-extended.js:10295, 8911-8928`). `Tf` resets the world, rebuilds the
score object, and finishes with `Ma.fa(this.Fk, null)` — the **onGameStart**
dispatcher (`:6863`). `onGameEnd` is only ever reached through `tc()` (`:8964`).
**A reset therefore fires `onGameStart` with no `onGameEnd`**, and
`statsOnGameStart` clears `statsParticipants` and every per-game accumulator
(`z_stats.js:271-282`), so the interrupted round's stats are discarded: no
`@@GAME@@` row, no kills, no ELO. Level loads take the same path — `L.apply`
also calls `a.Tf(...)` (`:9945`), so a mid-round `!map` discards the round too.

**That discard was the original design, not an accident**: one player leaves →
the game is invalidated → nobody is credited. It is a defensible rule in a
friendly room. It is also, as the owner put it, abusable — *invalidation is
exactly what a losing player can trigger on demand.* Walk out, the round
evaporates, and the loss with it. That is the same exploit as the leaver gate,
one level down.

**So the leaver policy supersedes it.** Once excuse/forfeit exists (§6), a round
interrupted by a leave should **count**: the leaver is excused or forfeited per
the gate, and everyone who was still playing keeps what they earned. Two things
are needed beyond the exit store below:

1. **A pre-reset score snapshot.** `Tf` rebuilds the score object *before*
   dispatching `onGameStart`, so a flush at the restart edge would read the new,
   zeroed scores for every player who stayed. `z_stats.js` therefore wraps the
   three API entry points that reset — `restartGame` (`:6551`), `loadPNGLevel`
   (`:6574`) and `loadRawLevel` (`:6577`), all plain writable function
   properties on the object `WLInit` returns — to snapshot every participant's
   score into `pc.scorePreReset` before calling through. Installed once behind a
   hot-reload sentinel, wrapped in `try/catch`, and it must log if any of the
   three names is missing at install time (risk 8).
2. **A flush at the reset edge.** `statsOnGameStart`, on detecting that
   `statsGameInProgress` was already `true`, runs the normal game-end path
   against `pc.scorePreReset` (emission, aggregates, ELO, `@@GAME@@`) *before*
   clearing state, and marks the row `interrupted: true`.

This lands in **phase 2b**, after the policy itself — an interrupted round that
counted while excuse/forfeit did not yet exist would score the leaver as an
ordinary full participant on a stale snapshot, which is worse than discarding
it. There is **no urgency: no arena rooms are running right now**, so nothing is
being lost today.

Until 2b, phase 1 only *measures* the discard: `statsOnGameStart` increments
`statsRoundSeq` (every start, reset or not) and, when a round was in progress,
logs `stats: reset detected — round N discarded (P participants)` and bumps an
in-memory `statsDiscardedRounds`, flushed at the next game end as
`daily/<day>/discardedRounds` (a new counter — §5's `statsIsCounterPath` trap
applies). That counter stays after 2b as the verification that the discard rate
went to ~0.

The rest of this section is written so that nothing depends on
`statsParticipants` surviving a round, because it doesn't.

#### `statsExits`

    statsExits = Map(auth -> { kind, atMs, standing, material, afk,
                               full, roundSeq, awayAt })

Auth-keyed (not id-keyed) so a leave-then-rejoin cannot produce two records, and
module-level so a reset cannot destroy it. Bounded by distinct auths seen
between flushes.

`statsOnLeave` (`z_stats.js:180`) and `statsOnTeamChange`'s spectator branch
(`z_stats.js:175-177`) each call one new `statsRecordExit(pc, kind)` when
`statsGameInProgress` and a participant entry exists. It:

1. Snapshots the score — `pc.scoreLeave` for `leave` (already done today),
   `pc.scoreExit` for `spec` (new). **This must happen inside the callback**:
   the gamemode's per-tick `update()` deletes the score entry of any player
   whose team is 0 or who is gone from the player map
   (`headless-extended.js:7413-7418`, and the same loop in every mode class),
   so `getPlayerScore()` returns `null` from the next tick onward. This is
   exactly why `pc.scoreLeave` exists.
2. Computes `standing` by comparing the exiting player's `rankScore` (§3) with
   the best `rankScore` among the other participants — O(P²) with
   P ≤ `CONFIG.max_players` (12), on a rare event.
3. Computes `material`: `elapsedMs >= STATS_EXIT_MATERIAL_MS` (default 45 000)
   **or** the round has visibly moved — in up-modes the best other `rankScore`
   ≥ `STATS_EXIT_MATERIAL_SCORE` (default 2); in LMS at least one participant
   has lost a life (best `rankScore < scoreLimit`). Without a materiality gate,
   "joined, disliked the map, left after 8 s" is an abandon and the counter
   drowns in noise.
4. Computes `afk = idleAnyMs(pc, now) >= STATS_AFK_MIN_MS`. An involuntary
   eviction by the anti-afk plugin (which calls `setPlayerTeam(id, 0)`,
   producing a `spec` exit indistinguishable from `!q`) always satisfies this,
   so **an anti-afk eviction can never be an abandon**. A player who rage-types
   `!q` has fresh chat activity and is classified normally.
5. Stores the record with `roundSeq` and `awayAt = now`. **Writes nothing** —
   the record is drained at the next game end (below), which is what makes the
   two retractions possible.

#### Two retractions

**Kick.** A kicked player fires `onPlayerLeave` *first* and `onPlayerKicked`
*second*, and only when a reason string was supplied
(`headless-extended.js:6847-6851`; same order in vanilla). `z_stats.js` chains
`onPlayerKicked` (inside the existing `__Z_STATS_CHAINED` block,
`z_stats.js:82-102`) and sets `kind = 'kick'`. `moderation.js` autokicks
same-IP ban evaders; a moderator's kick must never read as a rage quit.

**Re-entry.** If the same auth is back on a team (`statsOnTeamChange` with
team > 0, or `statsOnJoin` onto a team) before the record is flushed, the record
is **deleted**: they came back, there was no abandonment. Two notes:

- This is what makes `!jq` / `!joinquit` harmless. It does `moveToSpec` then
  `moveToGame` in the same tick (`mappool.js:589-595`) — a routine weapon reset
  in non-arena rooms, used constantly. Without retraction it would score
  `exits` +1 every time, and `abandons` +1 whenever the user happened to be
  behind.
- A `rejoins` counter increments **only** when `now - awayAt >=
  STATS_REENTRY_QUIET_MS` (default 5 000), so a same-tick `!jq` records nothing
  at all while a genuine leave-and-come-back stays visible.

#### Draining at game end

The drain runs alongside the existing `statsPending` loop (`z_stats.js:476-482`)
and follows the same rule — **counters for any auth, participant or not**:

- Always: `exits`, and the matching `abandons` / `specOuts` / `kickedOuts` /
  `lastExitTs` / `lastAbandonTs` (§5).
- Only when `record.roundSeq === statsRoundSeq` **and** the auth is a
  participant of the round being flushed: the `form` entry's `exit` key and the
  excuse/forfeit decision. A record carried over from a discarded round
  contributes counters only — it must not excuse or forfeit anyone in a *later*
  game.
- `statsExits` is cleared after the batch is built.

**`abandon = full && kind !== 'kick' && standing ∈ {losing, tied} && material
&& !afk`.** Tied standings count (owner's call, 2026-08-12): *there is no
difference between quitting a tie and quitting while losing* — in LMS a tie is
equal lives with the fight still open, and walking out denies the opponent the
result just as much as bailing from behind. Only a **clearly winning** exit (and
`solo`, where there is nobody to deny) is exempt. A second exit in the same
round overwrites the first (`kind` becomes `leave`). **midSession participants
get `exits` but never `abandons`** — their window is not comparable to anyone
else's.

### 5. What gets written

**RTDB — additive fields on `players/<auth>`** (`z_stats.js:444-473`),
`statsInc` counters unless noted:

    exits        every mid-game exit, any kind, any standing
    abandons     exits meeting the abandon test (and decremented by decay, §6)
    specOuts     exits with kind === 'spec' (subset of exits)
    kickedOuts   exits retracted to kind === 'kick' (subset of exits)
    rejoins      retracted exits where the player was away >= 5s
    afkGames     rounds where this player was AFK for the whole round
    cleanStreak  ABSOLUTE: consecutive ranked games with no exit (§6 decay)
    lastExitTs      absolute ms
    lastAbandonTs   absolute ms

> **Trap.** Every new counter name must be added to `statsIsCounterPath`'s regex
> (`z_stats.js:729-731`). That regex is the whitelist the no-`ServerValue.increment`
> fallback (`statsUpdateNoIncrement`, `z_stats.js:712-728`) uses to decide
> "read-add-write" vs "overwrite". A counter missing from it is written as the
> raw per-game delta and **clobbers the lifetime total**. `cleanStreak` is an
> absolute and must stay OUT of that regex.

**One participant entry per auth before `updates` is built.** `statsParticipants`
is keyed by *player id*, so a leave-and-rejoin inside one round yields two
entries with the same auth — and since `updates` is a flat path→value object,
the second entry's `players/<auth>/kills` assignment silently **replaces** the
first's instead of adding to it. (Pre-existing: today that quietly drops the
pre-leave segment of such a player's game.) Game end therefore folds
participants by auth first: sum `dScore`/`dKills`/`dDeaths` across segments,
take the **last** segment's `rankScore` (in LMS the lives stock is absolute, so
summing it would be nonsense), `midSession` only if *every* segment was
midSession, keep the earliest `startedAt`, and take the latest exit record.
Ranking, ELO and the emission all run on the folded list.

**The `form` ring carries the per-game detail** (`z_stats.js:454-469`). The ring
is 20 entries, rewritten absolutely each game, and `ext-proxy` passes it through
untouched (`statsread.go:183`) — so per-game history costs no new storage and no
new read. Added keys, each **only when true/non-null** so the common entry does
not grow:

    { …existing…, exit: "leave"|"spec"|"kick", abandon: true, afk: true,
                  excused: true, forfeit: true, Nfull: <int> }

> **Trap (pre-existing, closed here).** `pc.form` is `[]` until
> `statsSeedParticipant`'s async read lands, and the write is absolute:
> `(p.form || []).concat([entry])` (`z_stats.js:467-469`). A game that ends
> before the seed resolves therefore **replaces a 20-entry ring with a 1-entry
> ring**. The same window resets `pc.elo` to `STATS_COLD_ELO`, and `elo` is
> written absolutely too (`:463`) — a 1700-rated player can be knocked to ~1500
> by one very short game. Fix (phase 1b): set `pc.seeded = true` in the seed
> callback and **skip the absolute writes** (`form`, `elo`, `streak`,
> `bestStreak`, `fastestWinMs`, `cleanStreak`) for any participant whose seed
> has not landed. Counters are unaffected — they are increments.

**`@@GAME@@`** (`z_stats.js:651-662`). Existing keys **keep their current
meaning**, because `games.n` is a stored, indexed column and a `QueryOpts.N`
filter (`gamestore.go:46, 156, 186`) where `n === 2` means "duel":

| key | meaning | changed? |
|---|---|---|
| `n` | count of **full** participants | no |
| `partial` | `n < 2` | no |
| `players[].score` | `dScore` (0 in LMS) | no |
| `players[].partial` | this player got `partialGames`, not `games` | no (gains new causes) |
| `players[].rankScore` | **new**: the §3 ranking quantity | additive |
| `nRanked` / `unranked` | **new**: size of the ranked set / no ranking happened | additive |
| `mode` | **new**: `getSettings().gameMode` string, so a reader can interpret `rankScore` | additive |
| `players[].exit / exitAtMs / standing / abandon / afk / excused / forfeit` | **new** | additive |
| `exits` / `afkCount` / `taintedKills` / `interrupted` | **new**, game level | additive |

`formEntry.N` stays paired with `formEntry.rank` and therefore means *the ranked
set size* — the only value that makes "rank r of N" true. When it differs from
the full-participant count, `formEntry.Nfull` carries the latter.

wlhl keeps the payload verbatim in `games.raw` but its `Game`/`GamePlayer`
structs have no such fields (`gamestore.go:27-51`), so the new data is **durable
history that the `/games` API does not surface** until a wlhl change — the same
standing arrangement as `league` (`arena-leagues.md` risk 7). Payload growth is
a few short keys per player under an enforced 64-player / 64 KB cap
(`gamestore.go:125-131`).

**Nothing is written to `notifs`.** That node has no reader anywhere in
`ext-proxy`; admin visibility goes through §8.

### 6. Scoring policy: excuse below the line, forfeit above it

**Start from what happens today, because it is not what it looks like.** A
mid-game leaver is currently a *full* participant ranked on their leave-time
score against opponents who kept scoring — so in a deathmatch room they almost
always rank last and lose ELO exactly like a player who stayed (in an LMS room
they rank nowhere at all, §3). **Leaving while losing is not currently
profitable for ELO.** What it does buy is a truncated `deaths` count — and, in
an arena room, a discarded round (§4).

So the abuse in requirement 2 is *created by leniency*: the moment we stop
docking ELO for a disconnect (requirement 1), "I'm losing → pull the plug" is
free. That is why the two halves ship as one unit:

> **Phase 2 must never be split into "forgive now, punish later."** Shipping the
> excuse without the abandon gate opens the exploit outright. It also means
> **requirement 1 is not satisfied until phase 2 ships** — during phase 1 a
> disconnect costs exactly what it costs today.

Let `ranked` be the set used for `statsAssignRanks` / `statsComputeElo`,
`N = ranked.length`:

| participant | in `ranked`? | outcome |
|---|---|---|
| played to the end, full | yes | unchanged |
| midSession | no (today's rule) | `partialGames`, no ELO |
| **AFK for the whole round** | **no** | `partialGames`, no ELO, no win. Their own deaths/score still accrue (open question 2) |
| **exit, below the abandon gate** — *excused* | **no** | `partialGames`, **no ELO change, no win, no rank**. Kills/deaths/score accrue from the snapshot |
| **exit, at/above the abandon gate** — *forfeit* | **yes, pinned last** | `games` +1, `wins` +0, `placeSumNorm` at the last rank, ELO written. No synthetic score, no extra K |

**Excused leavers keep the kills, deaths and score they earned** (owner's call,
2026-08-12). Exclusion is about *rating*, not about erasing what happened, and
zeroing a disconnected player's segment would re-punish the disconnect
requirement 1 protects. The cost — a truncated `deaths` count still flatters
K/D — is accepted and monitored as risk 4.

#### The gate: 4 abandons, with decay

- **Forfeit when the exiting player's lifetime `abandons` ≥ 4.** Below that,
  excused.
- **Decay: `cleanStreak` reaches 25 ⇒ `abandons` −1, `cleanStreak` → 0.**
  `cleanStreak` increments by 1 for every game in which the player was in
  `ranked` and had no exit; **any** exit resets it to 0. A gated player at 4
  abandons therefore drops back below the gate after 25 clean ranked games, and
  a full pardon from 4 to 0 takes 100. Both values are scalars seeded by the
  existing `statsSeedParticipant` read — **no new RTDB read**.
- Only **ranked** games count toward `cleanStreak`. Otherwise a pair of friends
  could grind pardons in a dead room where nothing is at stake; requiring a
  ranked game means at least two non-excused, non-AFK participants.
- The decrement is emitted as `statsInc(-1)` **only when the seeded `abandons`
  is > 0** — RTDB increments have no floor and a negative `abandons` would
  silently disable the gate forever.

**Why a lifetime counter and not a rate over the `form` ring:** the ring is
rewritten absolutely and can be truncated by a short game (§5 trap), so gating
on it would hand a serial abandoner a laundering vector *through the deterrent*
— end one short game, ring resets, gate reopens. The counter is an increment and
cannot be laundered; decay is what keeps it forgiving. The ring stays useful for
**display** (§8), where a wrong value is cosmetic. If the seed has not landed,
**fail open: excuse.**

#### Ranking mechanics

**Pinning last, exactly.** `statsAssignRanks`' comparator gains a primary key:
finishers before forfeiters, `rankScore` descending within each group; averaged
ties are unchanged. So two forfeiters share the averaged bottom rank, and a
forfeiter never outranks a finisher even with a higher leave-time `rankScore`.
ELO is then the *unmodified* formula over `ranked`.

**Three guards that must be implemented together, or the two stores disagree:**

1. **All-forfeit ⇒ no ranking.** If `ranked` contains no finisher (everyone in
   it walked out), there is one group, somebody gets rank 1, gains ELO and is
   named `winner` in `@@GAME@@` — while the table above says forfeiters get
   `wins` +0. RTDB and SQLite would then disagree about who won. Rule: **if no
   member of `ranked` finished, no ranking happens at all** — the whole game is
   `unranked`, every participant gets `partialGames`, exactly as in the
   `N < 2` case.
2. **`wins` requires finishing.** The existing `if (p.rank === 1)` win
   increment (`z_stats.js:462`) becomes `if (p.rank === 1 && !p.forfeit)`.
3. **The `@@GAME@@` winner must be a finisher.** `emitWinner`
   (`z_stats.js:644-650`) additionally requires the single `rank === 1` player
   to not be a forfeiter, so `winner` is `null` rather than wrong.

**N shrinks for excusals.** With one player excused from a 4-player game,
`N = 3`: the survivors' pairwise sums lose that term and the `K/(N−1)`
normalization tightens. This is the same arithmetic `midSession` already
produces. Two consequences to state plainly:

- **If `N < 2` after exclusions, nobody is ranked** — the existing `N < 2` path
  (`z_stats.js:437, 457`) marks every participant partial. In a 1v1, an excused
  disconnect voids the duel *for both players*: no ELO, and the duel block (h2h,
  streaks, fastest win, per-map win rate, `z_stats.js:559-607`) does not run,
  since its gate becomes `ranked.length === 2`. The survivor gets their raw
  kills and nothing else.
- **A forfeit keeps `N = 2`**, so the survivor gets the h2h win, the streak and
  the ELO. That asymmetry *is* the consequence.

### 7. AFK taint: what a kill on an idle player is worth

**The predicate that decides taint is "idle for the WHOLE round", resolved at
game end** — not "idle up to this kill", resolved at the kill. The event-time
version turns *deliberate 21-second idling* into a grief tool (void an
opponent's early kills, potentially flip a duel) and makes a slow-loading client
cost the killer real kills. Whole-round idleness is also the literal reading of
the owner's requirement 3, and it cannot be gamed: to protect a bot farm the bot
must never move at all, which is precisely the case being blocked.

The cost is that credit is **provisional** while the round runs. When a hit or
kill lands on a victim who is *currently* AFK, the normal accumulators are
updated as usual **and** the same amounts are mirrored into a reversal buffer:

    statsAfkCredit = Map(victimAuth -> {
      kills:  Map(killerAuth -> n),          // statsMapAdd, never .set
      damage: Map(killerAuth -> amount),
      wpn:    Map(killerAuth + " " + fp -> { kills, damage, name })
    })

A summed structure, not a log, so it is bounded by victims × killers × weapons
and cannot grow with round length.

At game end, for each victim who **never** produced an input event this round,
reverse their buffer:

- `dKills[killer] -= kills`, clamped at 0. **Always**, in every gamemode.
- `dScore[killer] -= kills` **only in kill-derived-score modes** (`dm`, `tdm`,
  `pred` — the `Fg = na − Ke` classes, §3). In `htf`/`ctf`/`dtf`/`haz` the score
  is a tick counter and in **`lms` it is the killer's own remaining lives** —
  subtracting kills from either would corrupt the ranking.
- **LMS needs the exclusion, not the subtraction.** Killing an idle bot in LMS
  raises nobody's score: the farmer's payoff is *outliving* the bots and taking
  the round. The taint arithmetic alone would do nothing there — what blocks the
  farm is §6's exclusion of AFK players from `ranked`, which drops a
  farmer-plus-bots round to `N < 2` and makes it `unranked`. Both mechanisms are
  needed, and in the arena the exclusion is the load-bearing one.
- `statsDmgDealt[killer] -= damage`; the corresponding `statsWpnByAuth` and
  `statsWpnGlobal` entries -= their buffered kills/damage — otherwise a bot farm
  rewrites the room's weapon-effectiveness board. Recompute `statsWpnSeen` after
  the reversal as "fingerprints with any remaining kills or damage this game",
  so a weapon used only on idle bots takes no `weapons/<fp>/games` credit.
- The victim's own `damageTaken` and `deaths` are **not** reversed (open
  question 2).
- `daily/<day>/kills` needs no separate handling: `gameKills` is summed from
  `p.dKills` *after* the reversal (`z_stats.js:444-449`), so subtracting there
  as well would double-count.
- The kill feed (`z_stats.js:371-377`) is cosmetic and keeps the event, marked
  `afk:true`.

### 8. Admin visibility

**Phase 1, in-room:**

- A console line per classified exit (`stats: exit …`), which wlhl's log tail
  already captures. This is the primary phase-1 surface: auditable, reaches
  nobody in the room, accuses nobody.
- `!leavers` (`COMMAND.ADMIN_ONLY`), modelled on `!stats`
  (`z_stats.js:754-786`): one `stats/players` read, rows sorted by `abandons`
  descending, top 10, showing `abandons / exits / games`, `cleanStreak` progress
  toward the next decay, and the last-abandon date. `!leavers <name>` prints one
  player's line plus their last 20 `form` entries condensed to a string like
  `..X.A~.X.` (`.` played, `X` exit, `A` abandon, `~` AFK).
- `notifyAdmins` on an abandon-classified exit is specced but **gated behind
  `CONFIG.stats_exit_notify` (default false)** until phase-1 data has set the
  remaining thresholds. Announcing "X abandoned" while the material rule is
  still a guess trains admins to distrust the feature. When enabled it fires at
  game end (the classification is only final then), never at the exit itself,
  and never to non-admins — a false accusation against somebody with bad wifi is
  worse than a missed one.

**Phase 3, panel** (`ext-proxy`): `readStatsPlayer` gains the new scalars using
the same "only when non-zero" pattern as the 1v1 extras
(`statsread.go:187-199`), plus a derived `abandonRate` computed from the `form`
ring server-side (`form` is already passed through untouched at
`statsread.go:183`). The Stats tab's player card grows an **Integrity** line;
the leaderboard grows an optional `abandons` sort key. The **public** stats page
shows none of this by default (open question 3).

### 9. Interactions

- **`d_anti-afk.js`** keeps evicting idle players; §4 step 4 guarantees its
  evictions never read as abandons. If an admin disables it (`!afk 0`), this
  spec's AFK rules become the only defence — which is the point.
- **`arena_plugin.js`** is unchanged in behaviour, but it is why §4 exists at
  all: four of its paths call `restartGame()` — the chained `onPlayerLeave`
  backfill (`:284-294`), `!q` (`:311-322` → `:207`), `!j` into an empty seat
  (`:324-331`) and the mid-round manual-join restart (`:299-307`). Its header
  comment (`:23-26`) should point at this spec instead of saying
  `detectBadRunaway` was dropped, so the next reader does not re-add a duplicate
  detector inside the plugin (single-owner rule).
- **`!q`/`!quit`** in an arena room produces a `spec` exit with fresh chat
  activity → classified normally, and it *is* an abandon when the player was not
  winning and the round was material. That is the intended reading of
  rage-quit-lite. `!jq` is retracted (§4) and scores nothing.
- **Score reset on re-entry.** A player who spectates out and rejoins mid-round
  gets a **brand-new** engine score entry (`headless-extended.js:7420` and the
  parallel branches at `:7807, :7960, :8236`; in LMS `gb.update` seeds the new
  entry with `f.fc = this.Jc`, i.e. the *current* low-water lives count, not a
  fresh full stock). Today that makes `max(0, live − scoreStart)` collapse a
  dm player's whole game to 0. The arena plugin works around it by restarting
  the game on a mid-round manual join ("restarting game to get correct start
  score", `arena_plugin.js:299-307`) — corroborating evidence the behaviour is
  real. Phase 1b carries the pre-exit snapshot instead: on re-entry,
  `pc.scoreCarry += (snapshot − scoreStart)` and `scoreStart` is rebased to the
  fresh entry's value, so `dScore = pc.scoreCarry + max(0, live − scoreStart)`.
  `statsScoreById`'s fallback order becomes **`live` → `pc.scoreLeave` →
  `pc.scoreExit` → start-snapshot**. In LMS `rankScore` reads the live lives
  stock directly and needs no carry.

## Files to create / modify

| File | Change | ~LOC |
|---|---|---|
| `webliero-simple-panel/z_stats.js` | Activity maps + per-participant baseline + `statsOnActivity`; `statsIsAfk` + capability probe; per-gamemode `rankScore` + standing model; `statsExits` store, `statsRecordExit`, `onPlayerKicked` chain, re-entry retraction, reset detector; exit-drain in the game-end batch; spec-out snapshot + `scoreCarry` rebase; auth-folding of participants; `pc.seeded` guard; provisional AFK credit buffer + reversal; `ranked`-set split + comparator + three winner guards; gate + `cleanStreak` decay; new counters + `statsIsCounterPath` entries; `form`/`@@GAME@@` fields; `!leavers` | +340 |
| `webliero-simple-panel/z_stats.js` (phase 2b) | `restartGame`/`loadPNGLevel`/`loadRawLevel` wrappers + interrupted-round flush | +60 |
| `webliero-simple-panel/arena_plugin.js` | Header comment only: `detectBadRunaway` → "replaced by `_specs/leaver-afk-stats-policy.md`" | +3 |
| `ext-proxy/statsread.go` | Phase 3: new scalars + derived `abandonRate` in `readStatsPlayer`; optional `abandons` leaderboard sort | +35 |
| `ext-proxy/embed/roomadmin.html` | Phase 3: Integrity line on the player card; sort option | +40 |
| `headless-launcher-go/internal/gamestore/gamestore.go` | **NO CHANGE** — new fields ride in `games.raw`; surfacing them is a later wlhl task | 0 |

## Phases

Fork changes deploy with a **room restart, not a hot reload**: `z_stats.js`'s
handlers are chained exactly once per room lifetime and a reload keeps the old
function bodies (`z_stats.js:76-81`).

There is **no schedule pressure**: no arena rooms are running right now. Phase 1
should collect enough real games to set the remaining constants (open question
1) — proposed 200 ranked games or three weeks of a live room, whichever comes
first — rather than a fixed date.

### Phase 1 — observation: zero SCORING change

Everything in §2, §4, §5 and §8's console + `!leavers` surfaces, plus §3's
`rankScore` computed and **emitted** but not yet used for ranking. Rank, ELO,
kills, deaths, score and the duel block stay byte-identical to today; the new
writes are counters, new `form` keys and new `@@GAME@@` keys. `pc.scoreExit` is
captured and used **only** to classify `standing`. Consequence to accept for the
duration: when a participant spectated out *earlier* in the round, their delta
still reads as 0 in the standing comparison, so a later leaver can be classified
`winning` when they were in fact behind. Rare, self-correcting at 1b, and it
only mis-sorts an observational counter.

- [ ] A player who leaves between games produces no counters at all.
- [ ] LMS room: `@@GAME@@` shows `mode:"lms"`, every `players[].score` is 0 and
      every `rankScore` equals that player's remaining lives (this is the
      regression test that §3's model matches the engine).
- [ ] Leaving an LMS duel at 2 lives vs 4: `standing:"losing"`, `abandons` +1.
      Leaving at 4 vs 2: `standing:"winning"`, `abandons` +0.
- [ ] Leaving an LMS duel at 3 lives vs 3: `standing:"tied"`, `abandons` **+1**
      (owner's tie rule).
- [ ] Leaving an LMS round at 0 lives: `exits` +1, `abandons` +0 (eliminated
      carve-out).
- [ ] Leaving 12 s into a round where nobody has lost a life: not material → no
      abandon.
- [ ] `!jq` in a non-arena room: **nothing** recorded — no `exits`, no
      `abandons`, no `rejoins`.
- [ ] Leave, wait 10 s, rejoin the same round: `rejoins` +1, `exits` +0.
- [ ] `!kick` a player mid-game: `kickedOuts` +1, `abandons` +0.
- [ ] Idle player evicted by `d_anti-afk.js` while losing: `specOuts` +1,
      `abandons` +0, `afk:true`.
- [ ] **Arena reset path**: two players duelling, one leaves → the backfill
      calls `restartGame()` → the log shows `reset detected — round N
      discarded`, and when the *next* game ends the leaver's `exits`/`abandons`
      are still credited (the regression test for the §4 store).
- [ ] `daily/<day>/discardedRounds` is non-zero on an arena room after an hour.
- [ ] A player idle the whole round is flagged `afk:true` and gets `afkGames`
      +1; a player idle 25 s who then plays is **not** flagged, and the
      `@@GAME@@` line reports `taintedKills` — with the killer's aggregates
      still unchanged (policy is phase 2).
- [ ] A player who joins at minute 5 and is killed 3 s later is not AFK.
- [ ] Capability probe: with `onPlayerActivity` stubbed out, one long 2-player
      game flips `statsAfkSignalOk` false and logs once; no `afk` flags after.
- [ ] Hot-reload `z_stats.js` mid-round: no AFK flags for that round
      (`statsGameStartTs === 0` guard).
- [ ] Counter totals survive a room with `ServerValue.increment` unavailable
      (exercise `statsUpdateNoIncrement` — the `statsIsCounterPath` test), and
      `cleanStreak` is not treated as a counter.

### Phase 1b — score-accounting corrections (isolated, changes existing numbers)

Five fixes that are prerequisites for phase 2 doing arithmetic on trustworthy
values, grouped because they all move existing numbers and must therefore have
one unambiguous cause: **`rankScore` replacing `dScore` in ranking / duel-winner
/ h2h / streaks (§3)**, the `scoreExit` snapshot entering `statsScoreById`, the
`scoreCarry` rebase on re-entry (§9), auth-folding of duplicate participants
(§5), and the `pc.seeded` guard on absolute writes (§5 trap).

- [ ] **LMS duel: ELO moves for the first time.** Winner (more lives) gains,
      loser loses, and the numbers match a hand-computed `K · (S − E)`.
- [ ] LMS duel: `h2h/<pair>/w0|w1`, `streak`, `bestStreak` and `fastestWinMs`
      all update (today: never).
- [ ] dm room: ELO, ranks and `scoreSum` are **unchanged** from phase 1
      (`rankScore === dScore` in up-modes).
- [ ] Score 2 kills, `!q`, let the game end → 2 kills credited (today: 0).
- [ ] Score 2 kills, `!q`, `!j`, score 1 more → 3 kills credited; **one**
      participant row in the emission, one `form` entry (auth folding).
- [ ] `pc.scoreExit` is non-null in the team-change callback — i.e. the callback
      really does run before the tick that prunes the score entry (§4 step 1).
- [ ] Force the seed read to hang, end a game: the player's `form`, `elo` and
      `cleanStreak` nodes are **untouched**, while their counters still
      increment.

### Phase 2 — policy: excuse, forfeit, taint, decay (one unit)

§6 and §7 together. The remaining constants are set from phase-1 data; the gate
(4) and the decay period (25 clean ranked games) are already fixed.

- [ ] Player with a clean record leaves a 4-player game while losing → excused:
      `partialGames` +1, `elo` unchanged, `games` unchanged; the other three are
      ranked with `nRanked = 3`. `@@GAME@@.n` is still **4**.
- [ ] Player at 4 abandons leaves the same game → forfeit: ranked 4th of 4,
      `games` +1, ELO drops, `form.forfeit:true`.
- [ ] Forfeiter with a *higher* leave-time `rankScore` than a finisher still
      ranks below them.
- [ ] **Decay**: seed a player at 4 abandons, play 25 ranked games with no exit
      → `abandons` becomes 3 and `cleanStreak` resets to 0; an exit at game 12
      resets `cleanStreak` without touching `abandons`; a player at 0 abandons
      never goes negative.
- [ ] Unranked games (1 participant, or everyone excused) do **not** advance
      `cleanStreak`.
- [ ] **All-forfeit**: both players in a duel walk out and both are gated →
      `unranked:true`, no `wins`, `winner:null`, both `partialGames`.
- [ ] 1v1, clean-record disconnect → both get `partialGames`, no ELO, no h2h, no
      streak change. Same duel with a gated player → survivor gets the win, the
      h2h row and the streak.
- [ ] **LMS bot farm**: one shooter + idle bots, anti-afk disabled → the round
      is `unranked`, the shooter's `elo`, `wins`, `kills`, weapon rows and
      `daily/<day>/kills` are all unchanged. The bots' `deaths` do increment.
- [ ] Same setup but a bot moves once, 3 minutes in: **every** kill on it
      counts, including those scored while it was idle (retraction).
- [ ] `htf` room: tainted kills reduce the killer's `kills` but leave `scoreSum`
      and their rank untouched (gamemode scoping).

### Phase 2b — interrupted rounds start counting

The §4 supersession: API wrappers for `restartGame` / `loadPNGLevel` /
`loadRawLevel`, `pc.scorePreReset`, and the flush-at-reset-edge path. Ships
after phase 2 because an interrupted round must be able to excuse or forfeit its
leaver.

- [ ] Two players duelling, one leaves → the round is **written** (a `@@GAME@@`
      row with `interrupted:true`), the stayer keeps their kills and gets a
      ranked result, and the leaver is excused or forfeited per the gate.
- [ ] `daily/<day>/discardedRounds` stops advancing on an arena room.
- [ ] A mid-round `!map` writes the interrupted round rather than discarding it.
- [ ] Install-time probe logs if any of the three API names is missing.

### Phase 3 — panel surfacing

`statsread.go` fields + the player-card Integrity line + the leaderboard sort.
Verify a room with no phase-1 data yet renders unchanged (all fields absent).

### Phase 4 (optional) — arena queue consequences

If the counters show it is needed: an abandoner returns to the **back** of the
arena queue rather than the front, and/or sits out one rotation. Belongs in
`arena_plugin.js`, reading a value `z_stats.js` publishes on `window` — the
plugin still writes no stats.

## Risks

1. **The activity signal is absent or renamed on some client build.** Webliero
   re-minifies on release, and the only vanilla evidence in this repo is a
   March-2023 cache. If `onPlayerActivity` stops firing, every player looks AFK
   and every game's ELO is voided. Mitigated by the §2 capability probe, which
   fails *open* (AFK logic off) rather than closed.

2. **Held-key camper false positive.** A player who holds fire and changes
   nothing for ≥20 s produces no input edges. Mitigated by counting damage and
   kills as activity (§2); the residual case is a camper who neither changes
   input nor hits anybody for a whole round.

3. **Excusing a disconnect lets a griefer void an opponent's duel.** In a 1v1,
   an excused exit gives the survivor no ELO, no h2h and no streak (§6) — a
   player can repeatedly deny an opponent progression at no ELO cost. Bounded by
   the gate flipping them to forfeit after four, but the first four are free,
   and decay slowly returns those four. The deliberate price of requirement 1.

4. **Excused leavers keep the flattering K/D.** Owner-accepted (§6), monitored:
   a player who bails at 1–8 banks a truncated `deaths` count, so K/D,
   deaths-per-game and `avgTimeToDeath` improve relative to someone who played
   it out. Phase 2 makes leaving ELO-neutral, which *strengthens* that incentive
   for anyone who reads the ratio columns. The abandon counter standing next to
   those columns on the player card is the whole mitigation.

5. **A chat-only client is farmable.** Chat is excluded from the AFK predicate
   by decision (§2), so a bot that types once a round — or a human who parks to
   argue — is treated as idle and their deaths credit nobody. Accepted; revisit
   only if a chat-only farm actually appears.

6. **Thresholds tuned on deterrent-free data.** Phase-1 abandon rates are
   measured in a world with no consequence; they will drop once phase 2 ships.
   Resist re-tuning for at least a few weeks after phase 2.

7. **`statsIsCounterPath` mistakes.** A new counter missing from the regex is
   clobbered by the no-increment fallback; `cleanStreak` wrongly *added* to it
   would be summed instead of set. Both directions are covered by an explicit
   phase-1 check.

8. **The reset wrappers are a monkey-patch on engine API objects** (phase 2b).
   `restartGame` / `loadPNGLevel` / `loadRawLevel` are plain properties on the
   object `WLInit` returns; a webliero rename would break the pre-reset snapshot
   silently and interrupted rounds would be written with zeroed scores.
   Mitigated by an install-time probe that logs missing names, and by keeping
   `daily/<day>/discardedRounds` as the ongoing signal.

9. **Kick retraction depends on a reason string.** `onPlayerKicked` only fires
   when the kick carried a non-null reason (`headless-extended.js:6847-6851`).
   A reason-less programmatic kick would read as a leave and possibly an
   abandon. All current `moderation.js` callers pass a reason; a future one
   might not.

10. **The spec-out snapshot assumes the team-change callback runs before the
    pruning tick.** True for `onPlayerLeave` (that is why `scoreLeave` works);
    asserted but not proven for `onPlayerTeamChange`. Phase 1b's sixth check is
    exactly this assertion — if it fails, the fallback is to poll the score for
    spectators once per `statsWriteLive` tick (4 s, `z_stats.js:113`).

11. **`players[].partial` gains new causes.** From phase 2 an excused leaver and
    an AFK player are emitted with `partial:true` and no `rank`/`elo`. Existing
    readers handle it (`omitempty` pointers, `gamestore.go:27-38`), but analysis
    reading `partial` as "joined mid-game" becomes subtly wrong; the new `exit`
    / `excused` / `afk` keys disambiguate, and `n` / game-level `partial` keep
    their old meanings (§5).

12. **Phase 1b visibly changes LMS ladders.** ELO, streaks and h2h have been
    inert in every LMS room (§3), so stored `elo` values there are cold-start
    noise. The moment 1b ships they start moving, and historical LMS "rankings"
    become meaningless. Correct, and it should be announced rather than
    discovered.

13. **Phase 1b breaks K/D comparability for habitual `!q` users**, whose
    spec-outs start counting.

14. **Exit records still die with the room.** `statsExits` survives a reset but
    not a shutdown or a `z_stats.js` hot reload, and it is only drained at a
    *game end* — a room that never finishes another game loses the pending
    records. Same durability as every other in-memory accumulator here; not
    worth an RTDB write per exit.

## Open questions

1. **The remaining threshold constants**, all proposed and all to be confirmed
   against phase-1 data (the gate = 4 and the decay = 25 clean ranked games are
   settled): `STATS_EXIT_MATERIAL_MS` 45 000; `STATS_EXIT_MATERIAL_SCORE` 2 for
   up-modes; the **LMS materiality rule** ("at least one life lost") — which is
   the one with no precedent and the one most likely to be wrong, since in a
   fast LMS duel the first life can go in seconds; `STATS_AFK_MIN_MS` 20 000;
   `STATS_REENTRY_QUIET_MS` 5 000.

2. **Does an AFK player's own `deaths` still count?** As specced: yes (they were
   present, they died), while their ELO is untouched by exclusion. The argument
   for zeroing them: a player killed 15 times by a spawn-camper while their
   client was frozen carries a permanent K/D scar. The argument against: it
   makes "go AFK" a way to stop your deaths from counting, and the taint already
   removes the *attacker's* reward, which was the stated requirement.

3. **Does anything reach the public stats page?** As specced: console +
   `!leavers` in phase 1, `notifyAdmins` behind a default-off flag, panel player
   card in phase 3, **nothing public**. Open: whether the public page should
   carry an integrity badge (deterrence vs. shaming somebody's ISP), and whether
   `!leavers` should exist for non-admins in a reduced "your own record" form.

## Alternatives considered

- **Ranking LMS on a score delta**, i.e. leaving `dScore` as the ranking key.
  That is today's behaviour and it silently ties every player at 0 (§3) — the
  ladder looks like it works and moves nobody. `rankScore` exists because the
  gamemode's score is a *stock*, not a flow.
- **Accruing LMS lives-left into `scoreSum`.** Rejected: `scoreSum` is a
  lifetime counter shared across every room and mode a player touches; mixing
  "kills scored" with "lives left" makes the column meaningless. LMS
  contributes nothing to it, as today.
- **Deciding taint at the moment of the kill.** Rejected: a monotone event-time
  predicate is elegant but makes 21 seconds of deliberate idling a way to void
  an opponent's kills, and punishes a killer whose victim had a slow-loading
  client. The whole-round predicate needs a bounded reversal buffer (§7) and is
  worth it.
- **Gating the forfeit on a rate over the `form` ring.** Rejected: the ring is
  an absolute write a short game truncates (`z_stats.js:467-469`), so the gate
  could be reset by *ending a game* — laundering routed through the deterrent.
  Decay (§6) provides the forgiveness a rate would have.
- **Keeping the leave-driven round discard.** It was the original design and it
  is not absurd — an interrupted game *is* less meaningful. Rejected because the
  invalidation is triggerable on demand by the player it protects: leaving while
  losing erases the loss. Phase 2b replaces "invalidate" with "count, and hold
  the leaver responsible per the gate".
- **Writing exit records to RTDB at the exit event.** It would survive anything,
  including a room shutdown. Rejected: it puts an RTDB write on a game-loop
  callback, and it makes both retractions (kick reclassification, `!jq`
  re-entry) impossible — they depend on the record still being mutable. Risk 14
  is the accepted residue.
- **Keying exit records off `statsParticipants`.** The obvious home, and wrong:
  `onGameStart` clears that map (`z_stats.js:271`) and a reset fires
  `onGameStart` with no `onGameEnd` (§4), so every arena leave would destroy the
  record it just created.
- **Position polling to detect AFK.** Rejected: a player-list scan on the live
  game loop, blind to aiming and firing, needing a per-map movement tolerance,
  and duplicating a signal the room already receives.
- **Punish the disconnect directly.** Rejected by requirement 1 — and it is the
  wrong shape regardless: it converts every connection problem into a rating
  problem.
- **Excuse every leave, with no gate.** The friendliest option, and the exploit
  the owner predicted: leaving while losing becomes strictly better than
  playing.
- **A separate `integrity/<auth>` RTDB subtree** instead of additive fields on
  `players/<auth>`. Rejected: it doubles the reads on the player card and
  `!leavers` for a handful of scalars, and would not be covered by the seed read
  that already happens per participant.
- **Implementing the check inside `arena_plugin.js`**, where `detectBadRunaway`
  used to live. Rejected by the single-owner rule (`plugin-architecture.md` §6d):
  the plugin would need its own participant tracking, score snapshots and RTDB
  writer, all duplicating `z_stats.js`, and would only work in arena rooms.
