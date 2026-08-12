# Leaver & AFK stats policy — make quitting and idling visible, then accountable

Status: design (2026-08-12, revised after spec review same day). Implements the
owner's three rules: (1) a lost connection must never dock stats or ELO,
(2) *repeated* leave-before-you-lose must become visible and eventually cost
something, (3) a player who has been inactive since the round started must not
feed the killer's kill/ELO credit (otherwise "spawn idle bots, shoot them, farm
rank" is free).

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
8. **Fixing the restart data-loss bug** (§3 "The restart trap"). This spec makes
   exit records survive it and makes it *measurable*; recovering the rest of a
   restarted game's stats is a separate job.

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
  (`z_stats.js:48-54, 476-482`). The exit store in §3 is deliberately the same
  pattern, for the same reason: it must outlive a round boundary.
- **Leave snapshot.** `statsOnLeave` sets `pc.left` and snapshots
  `pc.scoreLeave` (`z_stats.js:180-195`) because the engine destroys the score
  entry moments after the player goes; `statsScoreById` falls back to it
  (`z_stats.js:668-678`).
- **Per-player seed read.** `statsSeedParticipant` does one `players/<auth>`
  read per participant and keeps `elo`, `form`, `streak`, `bestStreak`,
  `fastestWinMs` in memory (`z_stats.js:220-236`). New history the policy needs
  rides in on that same read — **no extra RTDB traffic**.
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
| **round** | one `onGameStart` → `onGameEnd` span. A `restartGame()` starts a new round without ending the old one (§3). `statsRoundSeq` numbers them. |
| **exit** | a participant stops playing *while a game is in progress*. Three kinds: **leave** (`onPlayerLeave`), **spec** (`onPlayerTeamChange` to team 0), **kick** (a leave that `onPlayerKicked` retracts, §3). |
| **standing** | the exiting player's score delta vs the best score delta among the *other* participants at the instant of the exit: `losing` / `winning` / `tied` / `solo` (no other participant). |
| **material** | the round was far enough along for the exit to mean something (§3). |
| **abandon** | a *full* participant's `leave`-or-`spec` exit that is `losing` **and** `material` **and** not `afk`, and that was not retracted (§3). This is the only counter with teeth. |
| **AFK** | produced zero *input* activity for the whole round, from their own start baseline, with at least `STATS_AFK_MIN_MS` of that baseline elapsed (§2). A per-round property of a player, not of a person. |
| **tainted kill** | a kill whose victim turns out, at round end, to have been AFK for the whole round (§6). Provisional while the round runs. |
| **excused** | phase 2: an exiting participant removed from the ranked set — no ELO, no win, no rank (§5). |
| **forfeit** | phase 2: an exiting participant kept in the ranked set but pinned below every player who finished (§5). |

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

What is **not** activity: taking damage, dying, respawning (an idle bot does all
three constantly), and — for the AFK predicate — **chat** (open question 3).
Chat *does* count for the exit classification's involuntary-eviction test (§3
step 4), where the question is "did the anti-afk plugin move them, or did they
choose to leave".

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
eviction lands; and any future breakage of the plugin's own chain. That is a
narrower brief than "the anti-afk plugin can't see this", and it is the honest
one.

**Capability probe (hard requirement).** If a completed round had ≥2 full
participants, lasted ≥60 s, and produced **zero** activity events from
*anybody*, the signal is not wired on this build: set `statsAfkSignalOk = false`,
log once, and from then on treat nobody as AFK (all AFK logic no-ops) until the
room restarts. Without this, a build whose `Gb` hook drifted would flag the
entire room AFK and void every game's ELO.

### 3. Exit records live outside the participant map

#### The restart trap (read this before anything else)

`WLROOM.restartGame()` sends the `la` message, whose `apply` calls `Tf`
(`headless-extended.js:10295, 8911-8928`). `Tf` resets the world, rebuilds the
score object, and finishes with `Ma.fa(this.Fk, null)` — the **onGameStart**
dispatcher (`:6863`). `onGameEnd` is only ever reached through `tc()`
(`:8964`, from the time/score limit or the `za` end-game message). **A restart
therefore fires `onGameStart` with no `onGameEnd`.**

`statsOnGameStart` clears `statsParticipants` and every per-game accumulator
(`z_stats.js:271-282`). So **today, every `restartGame()` mid-round silently
discards that round's entire stats** — no `@@GAME@@` row, no kills, no ELO, no
playtime flush. In arena rooms this is routine, not exotic: the chained
`onPlayerLeave` backfill (`arena_plugin.js:284-294`), `!q`
(`:311-322` → `moveToGameIfSomeoneIsWaiting` → `:207`), `!j` into an empty seat
(`:324-331`), and the mid-round manual-join restart (`:299-307`) all call it.

Fixing that data loss is out of scope (non-goal 8). What is **in** scope is that
this spec must not build on `statsParticipants` surviving a round, because it
doesn't. Two things follow:

1. Exit records live in their own auth-keyed store that `onGameStart` does not
   clear (below).
2. `statsOnGameStart` increments `statsRoundSeq` (every start, restart or not)
   and gains a restart detector: if `statsGameInProgress` was already `true`,
   log `stats: restart detected — round N discarded (P participants)` and bump
   an in-memory `statsDiscardedRounds`, flushed at the next game end as
   `daily/<day>/discardedRounds`. Cheap, additive, and it finally puts a number
   on how often this happens. (`daily/<day>/discardedRounds` is a new counter —
   §4's `statsIsCounterPath` trap applies to it too.)

#### `statsExits`

    statsExits = Map(auth -> { kind, atMs, standing, material, afk,
                               full, roundSeq, awayAt })

Auth-keyed (not id-keyed) so a leave-then-rejoin cannot produce two records, and
module-level so a restart cannot destroy it. Bounded by distinct auths seen
between flushes.

`statsOnLeave` (`z_stats.js:180`) and `statsOnTeamChange`'s spectator branch
(`z_stats.js:175-177`) each call one new `statsRecordExit(pc, kind)` when
`statsGameInProgress` and a participant entry exists. It:

1. Snapshots the score — `pc.scoreLeave` for `leave` (already done today),
   `pc.scoreExit` for `spec` (new). **This must happen inside the callback**:
   the gamemode's per-tick `update()` deletes the score entry of any player
   whose team is 0 or who is gone from the player map
   (`headless-extended.js:7413-7418`), so `getPlayerScore()` returns `null`
   from the next tick onward. This is exactly why `pc.scoreLeave` exists.
2. Computes `standing` from score *deltas* over the other participants — O(P²)
   with P ≤ `CONFIG.max_players` (12), on a rare event.
3. Computes `material`: `elapsedMs >= STATS_EXIT_MATERIAL_MS` (default 45 000)
   **or** the best other delta ≥ `STATS_EXIT_MATERIAL_SCORE` (default 2).
   Without it, "joined, disliked the map, left after 8 s while 0–1 down" is an
   abandon and the counter drowns in noise.
4. Computes `afk = idleAnyMs(pc, now) >= STATS_AFK_MIN_MS`. An involuntary
   eviction by the anti-afk plugin (which calls `setPlayerTeam(id, 0)`,
   producing a `spec` exit indistinguishable from `!q`) always satisfies this,
   so **an anti-afk eviction can never be an abandon**. A player who rage-types
   `!q` has fresh chat activity and is classified normally.
5. Stores the record with `roundSeq` and `awayAt = now`. **Writes nothing** —
   the record is drained at the next game end (below), which is what makes the
   two retraction rules possible.

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
  `lastExitTs` / `lastAbandonTs` (§4).
- Only when `record.roundSeq === statsRoundSeq` **and** the auth is a
  participant of the round being flushed: the `form` entry's `exit` key, and
  (phase 2) the excuse/forfeit decision. A record carried over from a
  restart-discarded round contributes counters only — it must not excuse or
  forfeit anyone in a *later* game.
- `statsExits` is cleared after the batch is built.

`abandon = full && kind !== 'kick' && standing === 'losing' && material && !afk`.
A second exit in the same round overwrites the first (`kind` becomes `leave`).
**midSession participants get `exits` but never `abandons`** — their delta is
measured over a different window than everyone else's, so calling them "losing"
is not comparable.

### 4. What gets written

**RTDB — additive scalars on `players/<auth>`** (`z_stats.js:444-473`), all
`statsInc` counters unless noted:

    exits        every mid-game exit, any kind, any standing
    abandons     exits meeting the abandon test
    specOuts     exits with kind === 'spec' (subset of exits)
    kickedOuts   exits retracted to kind === 'kick' (subset of exits)
    rejoins      retracted exits where the player was away >= 5s
    afkGames     rounds where this player was AFK for the whole round
    lastExitTs      absolute ms
    lastAbandonTs   absolute ms

> **Trap.** Every new counter name must be added to `statsIsCounterPath`'s regex
> (`z_stats.js:729-731`). That regex is the whitelist the no-`ServerValue.increment`
> fallback (`statsUpdateNoIncrement`, `z_stats.js:712-728`) uses to decide
> "read-add-write" vs "overwrite". A counter missing from it is written as the
> raw per-game delta and **clobbers the lifetime total**.

**One participant entry per auth before `updates` is built.** `statsParticipants`
is keyed by *player id*, so a leave-and-rejoin inside one round yields two
entries with the same auth — and since `updates` is a flat path→value object,
the second entry's `players/<auth>/kills` assignment silently **replaces** the
first's instead of adding to it. (Pre-existing: today that quietly drops the
pre-leave segment of such a player's game.) Game end therefore folds
participants by auth first: sum `dScore`/`dKills`/`dDeaths` across segments,
`midSession` only if *every* segment was midSession, keep the earliest
`startedAt`, and take the latest exit record. Ranking, ELO and the emission all
run on the folded list.

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
> `bestStreak`, `fastestWinMs`) for any participant whose seed has not landed.
> Counters are unaffected — they are increments.

**`@@GAME@@`** (`z_stats.js:651-662`). Existing keys **keep their current
meaning**, because `games.n` is a stored, indexed column and a `QueryOpts.N`
filter (`gamestore.go:46, 156, 186`) where `n === 2` means "duel":

| key | meaning | changed? |
|---|---|---|
| `n` | count of **full** participants | no |
| `partial` | `n < 2` | no |
| `players[].partial` | this player got `partialGames`, not `games` | no (gains new causes) |
| `nRanked` | **new**: size of the ranked set (§5) | additive |
| `unranked` | **new**: `true` when no ranking happened this game | additive |
| `players[].exit / exitAtMs / standing / abandon / afk / excused / forfeit` | **new** | additive |
| `exits` / `afkCount` / `taintedKills` | **new**, game level | additive |

`formEntry.N` stays paired with `formEntry.rank` and therefore means *the ranked
set size* — the only value that makes "rank r of N" true. When it differs from
the full-participant count, `formEntry.Nfull` carries the latter so a reader can
tell the two apart.

wlhl keeps the payload verbatim in `games.raw` but its `Game`/`GamePlayer`
structs have no such fields (`gamestore.go:27-51`), so the new data is **durable
history that the `/games` API does not surface** until a wlhl change — the same
standing arrangement as `league` (`arena-leagues.md` risk 7). Payload growth is
a few short keys per player under an enforced 64-player / 64 KB cap
(`gamestore.go:125-131`).

**Nothing is written to `notifs`.** That node has no reader anywhere in
`ext-proxy`; admin visibility goes through §7.

### 5. Scoring policy (phase 2): excuse below the line, forfeit above it

**Start from what happens today, because it is not what it looks like.** A
mid-game leaver is currently a *full* participant ranked on their leave-time
score against opponents who kept scoring — so they almost always rank last and
lose ELO exactly like a player who stayed. **Leaving while losing is not
currently profitable for ELO.** What it does buy is a truncated `deaths` count
(and so a flattering K/D and deaths-per-game) — the recent `scoreLeave` fix
sharpened that by preserving the kills too.

So the abuse in requirement 2 is *created by leniency*: the moment we stop
docking ELO for a disconnect (requirement 1), "I'm losing → pull the plug" is
free. That is the whole reason the two halves must ship as one unit:

> **Phase 2 must never be split into "forgive now, punish later."** Shipping the
> excuse without the abandon gate opens the exploit outright. It also means
> **requirement 1 is not satisfied until phase 2 ships** — during phase 1 a
> disconnect still costs ELO exactly as it does today (open question 6).

Let `ranked` be the set used for `statsAssignRanks` / `statsComputeElo`,
`N = ranked.length`:

| participant | in `ranked`? | outcome |
|---|---|---|
| played to the end, full | yes | unchanged |
| midSession | no (today's rule) | `partialGames`, no ELO |
| **AFK for the whole round** | **no** | `partialGames`, no ELO, no win. Their own deaths/score still accrue (open question 4) |
| **exit, below the abandon gate** — *excused* | **no** | `partialGames`, **no ELO change, no win, no rank**. Kills/deaths/score accrue from the snapshot (open question 5) |
| **exit, at/above the abandon gate** — *forfeit* | **yes, pinned last** | `games` +1, `wins` +0, `placeSumNorm` at the last rank, ELO written. No synthetic score, no extra K |

**The gate** (proposed, tune on phase-1 data): the exiting player's **lifetime
`abandons` counter ≥ 5**. Deliberately *not* a rate over the `form` ring: the
ring is rewritten absolutely and can be truncated by a short game (§4 trap), so
gating on it would hand a serial abandoner a laundering vector *through the
deterrent itself* — end one short game, ring resets, gate reopens. The counter
is an increment and cannot be laundered. The ring stays useful for **display**
(§7), where a wrong value is cosmetic. The value comes from
`statsSeedParticipant`'s existing read (`z_stats.js:220-236`), extended to keep
`abandons`; **no new RTDB read**. If the seed has not landed, **fail open:
excuse** — leniency is the safe default and the next game re-evaluates.

**Pinning last, exactly.** `statsAssignRanks`' comparator gains a primary key:
finishers before forfeiters, `dScore` descending within each group; averaged
ties are unchanged. So two forfeiters share the averaged bottom rank, and a
forfeiter never outranks a finisher even with a higher leave-time score. ELO is
then the *unmodified* formula over `ranked`.

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
   Guard 1 makes this unreachable, and it stays as a belt-and-braces assertion.
3. **The `@@GAME@@` winner must be a finisher.** `emitWinner`
   (`z_stats.js:644-650`) additionally requires the single `rank === 1` player
   to not be a forfeiter, so `winner` is `null` rather than wrong.

**N shrinks for excusals.** With one player excused from a 4-player game,
`N = 3`: the survivors' pairwise sums lose that term and the `K/(N−1)`
normalization tightens. This is the same arithmetic `midSession` already
produces, so no new behaviour is introduced. Two consequences to state plainly:

- **If `N < 2` after exclusions, nobody is ranked** — the existing `N < 2` path
  (`z_stats.js:437, 457`) marks every participant partial. In a 1v1, an excused
  disconnect therefore voids the duel *for both players*: no ELO, and the duel
  block (h2h, streaks, fastest win, per-map win rate, `z_stats.js:559-607`)
  does not run, since its gate becomes `ranked.length === 2`. The survivor gets
  their raw kills and nothing else.
- **A forfeit keeps `N = 2`**, so the survivor gets the h2h win, the streak and
  the ELO. That asymmetry *is* the consequence.

### 6. AFK taint: what a kill on an idle player is worth

**The predicate that decides taint is "idle for the WHOLE round", resolved at
game end** — not "idle up to this kill", resolved at the kill. The event-time
version was the first draft's design and it is wrong: a player who idles 21 s
and then plays would have permanently voided their opponent's early kills, which
turns *deliberate 21-second idling* into a new grief tool (deny an opponent
their stats, potentially flip a duel), and makes a slow-loading client cost the
killer real kills. Whole-round idleness is also the literal reading of the
owner's requirement 3, and it cannot be gamed: to protect a bot farm the bot
must never move at all, which is precisely the case being blocked.

The cost is that credit is **provisional** while the round runs. When a hit or
kill lands on a victim who is *currently* AFK, the normal accumulators are
updated as usual **and** the same amounts are mirrored into a reversal buffer:

    statsAfkCredit = Map(victimAuth -> {
      kills:  Map(killerAuth -> n),          // statsMapAdd, never .set
      damage: Map(killerAuth -> amount),
      wpn:    Map(killerAuth + " " + fp -> { kills, damage, name })
    })

It is a summed structure, not a log, so it is bounded by
victims × killers × weapons-used and cannot grow with round length.

At game end, for each victim who **never** produced an input event this round
(`statsIsAfk` still true), reverse their buffer:

- `dKills[killer] -= kills`. Clamp at 0, `statsMapAdd`-style.
- `dScore[killer] -= kills` **only in kill-derived-score gamemodes**. The
  `Fg = na - Ke` identity (score = kills − own-goals) is the *deathmatch*
  gamemode class (`headless-extended.js:7386-7395`); `lms` and `htf` derive
  score from rounds survived and flag-hold time (`gameMode` enum:
  `dm`, `lms`, `htf`, `tdm` — `roomadmin.go:642`). Subtracting kills from an
  `htf` score would corrupt the ranking. In non-kill-score modes, `dKills` is
  corrected and `dScore`/rank are left alone.
- `statsDmgDealt[killer] -= damage`; the corresponding `statsWpnByAuth` and
  `statsWpnGlobal` entries -= their buffered kills/damage — otherwise a bot farm
  rewrites the room's weapon-effectiveness board. Recompute `statsWpnSeen` after
  the reversal as "fingerprints with any remaining kills or damage this game",
  so a weapon used only on idle bots does not take a `weapons/<fp>/games` credit.
- The victim's own `damageTaken` and `deaths` are **not** reversed — they are
  the victim's stats, not a reward (open question 4).
- `daily/<day>/kills` needs no separate handling: `gameKills` is summed from
  `p.dKills` *after* the reversal (`z_stats.js:444-449`), so subtracting there
  as well would double-count.
- The kill feed (`z_stats.js:371-377`) is cosmetic and keeps the event, marked
  `afk:true`.

The AFK victim's exclusion from `ranked` (§5) is what removes them from the ELO
maths. Net effect on the attack the owner named: shooting idle bots yields no
ELO (they are excluded, and in a 1v1 that voids ranking entirely), no kill
counter, no score, no weapon stats and no daily kills. It costs the attacker
nothing and gains them nothing, which is the correct price.

### 7. Admin visibility

**Phase 1, in-room:**

- A console line per classified exit (`stats: exit …`), which wlhl's log tail
  already captures. This is the primary phase-1 surface: it is auditable, it
  reaches nobody in the room, and it cannot accuse anyone.
- `!leavers` (`COMMAND.ADMIN_ONLY`), modelled on `!stats`
  (`z_stats.js:754-786`): one `stats/players` read, rows sorted by `abandons`
  descending, top 10, showing `abandons / exits / games` and the last-abandon
  date. `!leavers <name>` prints one player's line plus their last 20 `form`
  entries condensed to a string like `..X.A~.X.` (`.` played, `X` exit,
  `A` abandon, `~` AFK).
- `notifyAdmins` on an abandon-classified exit is specced but **gated behind
  `CONFIG.stats_exit_notify` (default false)** and stays off until the phase-1
  data has set the thresholds. Announcing "X abandoned" while the material and
  abandon rules are still guesses trains admins to distrust the feature. When
  enabled it fires at game end (the classification is only final then), never
  at the exit itself, and never to non-admins — a false accusation against
  somebody with bad wifi is worse than a missed one.

**Phase 3, panel** (`ext-proxy`): `readStatsPlayer` gains the new scalars using
the same "only when non-zero" pattern as the 1v1 extras
(`statsread.go:187-199`), plus a derived `abandonRate` computed from the `form`
ring server-side (`form` is already passed through untouched at
`statsread.go:183`). The Stats tab's player card grows an **Integrity** line;
the leaderboard grows an optional `abandons` sort key. The **public** stats page
shows none of this by default (open question 7).

### 8. Interactions

- **`d_anti-afk.js`** keeps evicting idle players; §3 step 4 guarantees its
  evictions never read as abandons. If an admin disables it (`!afk 0`), this
  spec's AFK rules become the only defence — which is the point.
- **`arena_plugin.js`** is unchanged in behaviour, but it is the reason §3's
  exit store exists at all: four of its paths call `restartGame()`. Its header
  comment (`arena_plugin.js:23-26`) should be updated to point at this spec
  instead of saying `detectBadRunaway` was dropped, so the next reader does not
  re-add a duplicate detector inside the plugin (single-owner rule).
- **`!q`/`!quit`** in an arena room produces a `spec` exit with fresh chat
  activity → classified normally, and it *is* an abandon when the player was
  losing and the game was material. That is the intended reading of
  rage-quit-lite. `!jq` is retracted (§3) and scores nothing.
- **Score reset on re-entry.** A player who spectates out and rejoins mid-round
  gets a **brand-new, zeroed** engine score entry (`headless-extended.js:7420`
  and the parallel gamemode branches at `:7807, :7960, :8236`) — today that
  makes `max(0, live − scoreStart)` collapse their whole game to 0. The arena
  plugin works around it by restarting the game on a mid-round manual join
  ("restarting game to get correct start score", `arena_plugin.js:299-307`),
  which is corroborating evidence the behaviour is real. Phase 1b carries the
  pre-exit snapshot instead: on re-entry, `pc.scoreCarry += (snapshot −
  scoreStart)` and `scoreStart` is rebased to the fresh entry's zero, so
  `delta = pc.scoreCarry + max(0, live − pc.scoreStart)`. `statsScoreById`'s
  fallback order becomes **`live` → `pc.scoreLeave` → `pc.scoreExit` →
  start-snapshot**, and every caller adds `pc.scoreCarry`.

## Files to create / modify

| File | Change | ~LOC |
|---|---|---|
| `webliero-simple-panel/z_stats.js` | Activity maps + per-participant baseline + `statsOnActivity`; `statsIsAfk` + capability probe; `statsExits` store, `statsRecordExit`, `onPlayerKicked` chain, re-entry retraction, restart detector; exit-drain in the game-end batch; spec-out snapshot + `scoreCarry` rebase; auth-folding of participants; `pc.seeded` guard; provisional AFK credit buffer + reversal; `ranked`-set split + comparator + three winner guards; new counters + `statsIsCounterPath` entries; `form`/`@@GAME@@` fields; `!leavers` | +300 |
| `webliero-simple-panel/arena_plugin.js` | Header comment only: `detectBadRunaway` → "replaced by `_specs/leaver-afk-stats-policy.md`" | +3 |
| `ext-proxy/statsread.go` | Phase 3: new scalars + derived `abandonRate` in `readStatsPlayer`; optional `abandons` leaderboard sort | +35 |
| `ext-proxy/embed/roomadmin.html` | Phase 3: Integrity line on the player card; sort option | +40 |
| `headless-launcher-go/internal/gamestore/gamestore.go` | **NO CHANGE** — new fields ride in `games.raw`; surfacing them is a later wlhl task | 0 |

## Phases

Fork changes deploy with a **room restart, not a hot reload**: `z_stats.js`'s
handlers are chained exactly once per room lifetime and a reload keeps the old
function bodies (`z_stats.js:76-81`).

### Phase 1 — observation: zero SCORING change

Everything in §2, §3, §4 and §7's console + `!leavers` surfaces. Rank, ELO,
kills, deaths, score and the duel block are **byte-identical to today**; the new
writes are counters, new `form` keys and new `@@GAME@@` keys. `pc.scoreExit` is
captured and used **only** to classify `standing` — it does not enter
`statsScoreById` until phase 1b. Consequence to accept for the duration: when a
participant spectated out *earlier* in the round, their delta still reads as 0
in the standing comparison, so a later leaver can be classified `winning` when
they were in fact behind. Rare, self-correcting at 1b, and it only mis-sorts an
observational counter.

Run it on one room long enough to have real numbers — proposed 2–3 weeks or 200
games, whichever comes first (open question 6) — before touching policy.

- [ ] A player who leaves between games produces no counters at all.
- [ ] A player who leaves mid-game while losing 1–8, after 3 min: `exits` +1,
      `abandons` +1, `form` entry has `exit:"leave", abandon:true`, and every
      other player's ELO is what it would have been yesterday.
- [ ] Same but leaving 8–1 up: `exits` +1, `abandons` **+0**, `standing:"winning"`.
- [ ] Leaving 12 s into a 0–1 game: not material → no abandon.
- [ ] `!jq` in a non-arena room: **nothing** recorded — no `exits`, no
      `abandons`, no `rejoins` (retraction inside `STATS_REENTRY_QUIET_MS`).
- [ ] Leave, wait 10 s, rejoin the same round: `rejoins` +1, `exits` +0.
- [ ] `!kick` a player mid-game: `kickedOuts` +1, `abandons` +0.
- [ ] Idle player evicted by `d_anti-afk.js` while losing: `specOuts` +1,
      `abandons` +0, `afk:true`.
- [ ] **Arena restart path**: two players duelling, one leaves →
      `arena_plugin.js`'s backfill calls `restartGame()` → the log shows
      `restart detected — round N discarded`, and when the *next* game ends the
      leaver's `exits`/`abandons` are still credited (this is the regression
      test for the whole §3 redesign).
- [ ] `daily/<day>/discardedRounds` is non-zero on an arena room after an hour.
- [ ] A player idle the whole round is flagged `afk:true` and gets `afkGames`
      +1; a player idle 25 s who then plays is **not** flagged (whole-round
      predicate), and the `@@GAME@@` line reports `taintedKills` — with the
      killer's aggregates still unchanged (policy is phase 2).
- [ ] A player who joins at minute 5 and is killed 3 s later is not AFK
      (per-participant baseline).
- [ ] Capability probe: with `onPlayerActivity` stubbed out, one long 2-player
      game flips `statsAfkSignalOk` false and logs once; no `afk` flags after.
- [ ] Counter totals survive a room with `ServerValue.increment` unavailable
      (exercise `statsUpdateNoIncrement` — this is the `statsIsCounterPath` test).

### Phase 1b — score-accounting corrections (isolated, changes existing numbers)

Four fixes that are prerequisites for phase 2 doing arithmetic on trustworthy
deltas, grouped because they all move existing numbers and must therefore have
one unambiguous cause: the `scoreExit` snapshot entering `statsScoreById`, the
`scoreCarry` rebase on re-entry (§8), auth-folding of duplicate participants
(§4), and the `pc.seeded` guard on absolute writes (§4 trap).

- [ ] Score 2 kills, `!q`, let the game end → 2 kills credited (today: 0).
- [ ] Score 2 kills, `!q`, `!j`, score 1 more, let the game end → 3 kills
      credited (today: 0). Assert on `players/<auth>/kills` and the `@@GAME@@` row.
- [ ] Leave after 2 kills, rejoin, score 1 more → 3 kills, **one** participant
      row in the emission, one `form` entry (auth folding).
- [ ] `pc.scoreExit` is non-null in the team-change callback — i.e. the callback
      really does run before the tick that prunes the score entry (§3 step 1).
- [ ] Force the seed read to hang, end a game: the player's `form` and `elo`
      nodes are **untouched** (not truncated to 1 entry, not reset to 1500),
      while their `kills`/`deaths` counters still increment.

### Phase 2 — policy: excuse, forfeit, taint (one unit)

§5 and §6 together. Thresholds set from phase-1 data. This is where requirement
1 finally lands.

- [ ] Player with a clean record leaves a 4-player game while losing → excused:
      `partialGames` +1, `elo` unchanged, `games` unchanged; the other three are
      ranked with `nRanked = 3` and their ELO deltas match a hand-computed
      `K/2 · Σ(S−E)`. `@@GAME@@.n` is still **4**.
- [ ] Player over the gate leaves the same game → forfeit: ranked 4th of 4,
      `games` +1, ELO drops, `form.forfeit:true`.
- [ ] Forfeiter with a *higher* leave-time score than a finisher still ranks
      below them.
- [ ] **All-forfeit**: both players in a duel walk out and both are over the
      gate → `unranked:true`, no `wins`, `winner:null`, both `partialGames`.
      RTDB and the `@@GAME@@` row agree.
- [ ] 1v1, clean-record disconnect → both players get `partialGames`, no ELO, no
      h2h row, no streak change. Same duel with a gated player → survivor gets
      the win, the h2h row and the streak.
- [ ] Idle bot + one shooter, 1v1, anti-afk disabled: shooter's `kills`,
      `scoreSum`, `elo`, weapon rows and `daily/<day>/kills` are all unchanged
      after the game. The bot's `deaths` do increment.
- [ ] Same setup but the bot moves once, 3 minutes in: **every** kill on it
      counts, including the ones scored while it was idle (retraction).
- [ ] `htf` room: tainted kills reduce the killer's `kills` but leave `scoreSum`
      and their rank untouched (gamemode scoping).

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
   input nor hits anybody for a whole round, which is indistinguishable from
   idle by any signal available to a room script.

3. **Excusing a disconnect lets a griefer void an opponent's duel.** In a 1v1,
   an excused exit gives the survivor no ELO, no h2h and no streak (§5) — a
   player who dislikes their opponent can repeatedly deny them progression at no
   ELO cost to themselves. Bounded by the gate flipping them to forfeit after
   five, but the first five are free. This is the deliberate price of
   requirement 1.

4. **Excused leavers keep the flattering K/D.** Exclusion removes the ELO
   consequence but not the original incentive: a player who bails at 1–8 still
   banks a truncated `deaths` count, so their K/D, deaths-per-game and
   `avgTimeToDeath` all improve relative to someone who played it out. Phase 2
   makes leaving ELO-neutral, which *strengthens* that incentive for anyone who
   cares about the ratio columns. Open question 5 is the lever; until it is
   answered, the abandon counter is the only thing standing next to it on the
   player card.

5. **Thresholds tuned on deterrent-free data.** Phase-1 abandon rates are
   measured in a world with no consequence; they will drop once phase 2 ships.
   Resist re-tuning for at least a few weeks after phase 2, or the gate will
   ratchet itself shut.

6. **`statsIsCounterPath` omission silently clobbers totals.** Only on rooms
   where `ServerValue.increment` is unavailable, which is why it will not show
   up in normal testing. Covered by an explicit phase-1 check.

7. **Kick retraction depends on a reason string.** `onPlayerKicked` only fires
   when the kick carried a non-null reason (`headless-extended.js:6847-6851`).
   A reason-less programmatic kick would be recorded as a leave and possibly an
   abandon. All current callers in `moderation.js` pass a reason; a future one
   might not.

8. **The spec-out snapshot assumes the team-change callback runs before the
   pruning tick.** True for `onPlayerLeave` (that is why `scoreLeave` works);
   asserted but not yet proven for `onPlayerTeamChange`. Phase 1b's fourth check
   is exactly this assertion — if it fails, the fallback is to poll the score
   for spectators once per `statsWriteLive` tick (4 s, `z_stats.js:113`) and
   accept ≤4 s of staleness.

9. **`players[].partial` gains new causes.** From phase 2 an excused leaver and
   an AFK player are emitted with `partial:true` and no `rank`/`elo`. Existing
   readers handle it (both are `omitempty` pointers, `gamestore.go:27-38`), but
   any analysis reading `partial` as "joined mid-game" becomes subtly wrong; the
   new `exit` / `excused` / `afk` keys disambiguate, and `n` / game-level
   `partial` keep their old meanings (§4).

10. **Publishing abandon counts is an accusation.** Somebody on a flaky
    connection accumulates `exits` honestly. Mitigated by keeping `abandons`
    (not raw `exits`) as the headline number, by the material gate, by the
    console-only phase-1 surface with `notifyAdmins` default-off, and by leaving
    the public page out (open question 7).

11. **Phase 1b breaks historical comparability.** Players who habitually `!q`
    mid-game will see their lifetime K/D move once their spec-outs start
    counting. Correct, but it will be noticed and should be announced.

12. **Exit records still die with the room.** `statsExits` survives a restart
    but not a room shutdown or a `z_stats.js` hot reload, and it is only drained
    at a *game end* — a room that never finishes another game loses the pending
    records. Same durability as every other in-memory accumulator here
    (`statsPending` included); not worth an RTDB write per exit.

## Open questions

1. **Threshold values.** Proposed gate: lifetime `abandons ≥ 5`. Proposed
   material gate: 45 s elapsed **or** leader at 2+ score. Proposed
   `STATS_AFK_MIN_MS`: 20 000. Proposed `STATS_REENTRY_QUIET_MS`: 5 000. All
   should be set from phase-1 data — but the *shape* (a lifetime counter, not a
   rate over the `form` ring — see §5) needs agreement before phase 2 is built,
   because a lifetime-only gate never forgives: a player at 5 abandons is gated
   forever unless open question 2 says otherwise.

2. **Should `abandons` decay?** With the gate now reading the lifetime counter
   (§5), decay is the *only* forgiveness mechanism, which makes this a
   materially bigger question than in the first draft. Options: no decay
   (simple, unforgiving); subtract one per N consecutive clean games (needs a
   clean-streak counter, one more scalar); or gate on `abandons − wins/50`-style
   normalisation (opaque). Recommendation: **subtract one abandon per 25
   consecutive games with no exit**, tracked by a `cleanStreak` counter reset on
   any exit — one extra scalar, no scheduled job, and it cannot be laundered by
   waiting.

3. **Should chat count as activity for the AFK/taint predicate?** As specced:
   no — a player standing still typing is not playing, and a farm could script
   chat. The cost is that a *chat-only* client (a bot that says "hi" once a
   round, or a human who parks to argue in chat) is farmable for kills exactly
   like an idle bot. Including chat closes that and costs the taint rule most of
   its teeth against a slightly-smarter farm. Recommendation: keep chat out, and
   revisit if a chat-only farm actually appears.

4. **Does an AFK player's own `deaths` still count?** As specced: yes (they were
   present, they died), while their ELO is untouched by exclusion. The argument
   for zeroing them: a player killed 15 times by a spawn-camper while their
   client was frozen carries a permanent K/D scar. The argument against: it
   makes "go AFK" a way to stop your deaths from counting, and the taint already
   removes the *attacker's* reward, which was the stated requirement.

5. **Do excused leavers keep the kills/deaths/score they earned?** As specced:
   yes — exclusion is about *rating*, not about erasing what happened, and
   zeroing them would re-punish the disconnect requirement 1 protects. But it is
   exactly what leaves risk 4 (the flattering K/D) alive. The alternative is to
   drop an excused leaver's whole segment from the aggregates, which is cleaner
   for the ratio columns and worse for requirement 1.

6. **How long does phase 1 run, and is it acceptable that requirement 1 is
   unsatisfied for that whole period?** Proposed: 2–3 weeks or 200 games. Until
   phase 2 ships, a disconnect still costs ELO exactly as today. If that is not
   acceptable, the alternative is shipping phase 2 with guessed thresholds and
   re-tuning — which is the failure mode this phasing exists to avoid.

7. **What do admins see, and where?** As specced: console + `!leavers` in phase
   1, `notifyAdmins` behind a default-off flag until thresholds land, panel
   player card in phase 3, **nothing on the public stats page**. Open: whether
   the public page should show an integrity badge at all (deterrence vs. shaming
   somebody's ISP), and whether `!leavers` should also exist for non-admins in a
   reduced form ("your own record").

8. **Should a `tied` exit ever count as an abandon?** As specced: no — only
   `standing === 'losing'` counts, so a player who bails from a 5–5 deadlock is
   invisible to the counter. Defensible (they weren't losing) and exploitable
   (bail at every tie). A stricter variant is `losing || (tied && material)`.

9. **Should the AFK rules self-disable when `statsGameStartTs === 0`?** A
   mid-game `z_stats.js` hot reload leaves it 0 (the same condition that already
   emits `durationMs: 0`, `z_stats.js:655`), which makes every baseline the
   epoch and every player AFK for the rest of that round. Recommendation: treat
   `statsGameStartTs === 0` as "no reliable round clock" and skip AFK
   classification for that round entirely — one condition, and it matches how
   the duel-duration code already distrusts that state (`z_stats.js:579`).

10. **Should `restartGame()`'s data loss be fixed rather than measured?** Out of
    scope here (non-goal 8), but `daily/<day>/discardedRounds` will make the size
    of the problem visible within a day on an arena room. The plausible fix —
    treating a restart-triggered `onGameStart` as an implicit game end and
    flushing first — is a change to the core stats lifecycle and deserves its
    own spec.

## Alternatives considered

- **Deciding taint at the moment of the kill** (the first draft). Rejected after
  review: a monotone event-time predicate is elegant but makes 21 seconds of
  deliberate idling into a way to void an opponent's kills, and punishes a
  killer whose victim had a slow-loading client. The whole-round predicate needs
  a bounded reversal buffer (§6) and is worth it.
- **Gating the forfeit on a rate over the `form` ring.** Also the first draft.
  Rejected: the ring is an absolute write that a short game truncates
  (`z_stats.js:467-469`), so the gate could be reset by *ending a game* — a
  laundering vector routed through the deterrent itself.
- **Writing exit records to RTDB at the exit event** instead of deferring to the
  next game end. It would survive anything, including a room shutdown. Rejected:
  it puts an RTDB write on a game-loop callback, and it makes both retractions
  (kick reclassification, `!jq` re-entry) impossible — they depend on the record
  still being mutable. Risk 12 is the accepted residue.
- **Keying exit records off `statsParticipants`.** The obvious home, and wrong:
  `onGameStart` clears that map (`z_stats.js:271`) and a `restartGame()` fires
  `onGameStart` with no `onGameEnd` (§3), so every arena leave would destroy the
  record it just created.
- **Position polling to detect AFK.** Rejected: a player-list scan on the live
  game loop, blind to aiming and firing, needing a per-map movement tolerance,
  and duplicating a signal the room already receives.
- **Punish the disconnect directly** (an immediate ELO penalty or a synthetic
  loss for any mid-game leave). Rejected by requirement 1 — and it is the wrong
  shape regardless: it converts every connection problem into a rating problem.
- **Excuse every leave, with no gate.** The friendliest option, and the exploit
  the owner predicted: leaving while losing becomes strictly better than
  playing. Only safe with the counter and the gate, which is why §5 forbids
  shipping the two halves separately.
- **A separate `integrity/<auth>` RTDB subtree** instead of additive fields on
  `players/<auth>`. Rejected: it doubles the reads on the player card and the
  `!leavers` command for a handful of scalars, and it would not be covered by
  the seed read that already happens per participant.
- **Implementing the check inside `arena_plugin.js`**, where `detectBadRunaway`
  used to live. Rejected by the single-owner rule (`plugin-architecture.md` §6d):
  the plugin would need its own participant tracking, score snapshots and RTDB
  writer, all duplicating `z_stats.js`, and it would only work in arena rooms.
