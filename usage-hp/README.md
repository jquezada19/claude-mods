# usage-hp

A Claude Code mod that draws a video-game health bar above the prompt for
each usage limit your account has.

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/subscription-dark.svg"><img alt="Desktop rows on a subscription: 5H 62% left in green with three quarters of a heart, 7D 34% left in yellow with half a heart and empty in about 2d 9h at this pace, then $0.30 this session" src="docs/subscription.svg"></picture>

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/spend-dark.svg"><img alt="Desktop row on a capped seat: SPEND 82–85% left as a range, $246–255 left of $300, and the footer line with this session, billed, reset and sync age" src="docs/spend.svg"></picture>

In the terminal:

    ♥ 5H  ████████████░░░░░░░░  62% left · resets in 2h 14m · lasts past reset
    ♡ 7D  ███████░░░░░░░░░░░░░  34% left · resets in 4d · empty in ~2d 9h at this pace
          $0.30 this session

On an Enterprise seat with a monthly spend limit it draws a SPEND bar instead,
an estimate shown as a range:

    ♥ SPEND  ████████████████▒░░░ 82–85% left · $246–255 left of $300
             $0.27 this session (~$0.26 billed) · lasts past reset · resets in 12d · synced 5d 2h ago (Oct 14 08:43)

## What the bars show

- One bar per limit: `five_hour` and `seven_day` (Pro, Max), a gateway's
  `spend_limit`, or the SPEND estimate on Enterprise
- Green above 50% left, yellow above 20% up to 50%, red at 20% or below. A bar turns worse the
  moment it crosses a line, but better only once it is two points back over it,
  so one sitting on 50% does not flicker
- On desktop the heart drains a quarter per 25% used, like a Legend of Zelda
  heart; the terminal shows `♥` above 50% left and `♡` below. Both become a
  skull (`☠`) at 0%; on SPEND the skull waits until even the hopeful end of
  the range is spent
- **Pace:** once five minutes of readings are in hand and the bar has
  dropped, a bar says when it empties if the last hour's rate holds
  (`empty in ~1h 10m at this pace`), or `lasts past reset` when it will not
  run out first. On SPEND it comes from the last week's billed spend when
  there is one, and sits on the line beneath
- **Beneath the bars:** this session's cost in bold (`$0.30 this session`),
  then `as of 14m ago` once 5H/7D figures are ten minutes old
- **Idle reset:** a window that ended while nothing was sent reads
  `100% left · window reset`, with `reset windows refill on your next reply`
  beneath
- **No limit yet:** a magenta `♥ HP waiting for the first reply`, or
  `♥ HP no usage limit reported · … enter what Settings › Usage shows: /hp <spent> <limit>`;
  an API-key, Bedrock, Vertex or Foundry session with no limit entered draws
  no row
- The row hides while a survey shows
- The desktop app draws the heart and bar as vector images; the terminal shows
  `█` cells and `♥`/`♡`

On Pro, Max and gateway accounts Claude Code reports the limits itself and the
bars just work. Everything below is about the Enterprise SPEND bar.

## Enterprise setup (once)

Claude Code does not tell plugins what an Enterprise seat has really spent; that
figure lives only in **Settings › Usage** of the Claude desktop app (or
claude.ai), which reads like `$47.53 of $300.00 spent`. Type those two figures:

    /hp 47.53 300      what Settings › Usage says you have spent, and your limit
    /hp 300            the limit alone, only at the very start of a month (assumes $0 spent)
    /hp off            clear the limit (see "What it keeps" below)

`/hp` also takes `$47.53`, `47,53` and `1,234.50`. The first entry's reply
also points you to the sync file below, which lets a figure arrive without
typing.

That is the whole setup. From then on every session adds what it costs, and
each re-entry of `/hp` tightens the estimate. To have the figure arrive by
itself, see the [sync file](#sync-file-optional).

## Reading the SPEND row

**Line one** is the money: the bar, the percent and the dollar range against
your limit. The default style counts what is **left** (`82–85% left · $246–255
left of $300`); `/hp style used` counts what is spent (`15–18% used · $45–54 /
$300`), the way Settings › Usage reads. Cells the range is sure of are lit; the
ones it runs across are half-lit (`▒`). A range under $1 wide, which happens only at the moment of an
entry (the next refresh widens it), shows the figure itself (`$252.47 left of $300`, or `$47.53 / $300`
when counting used).

**Line two**, in order:

| Part | Meaning |
|---|---|
| **`$0.27 this session`** (bold) | This session's cost as Claude Code counts it, the same figure `/usage` shows |
| `(~$0.26 billed)` | The same session at the official per-model prices, scaled by the calibration: what it most likely adds to the bill |
| `lasts past reset` / `empty in ~9d 4h at this pace` | Pace, from the pessimistic end of the range |
| `re-sync: /hp <spent> 300` (yellow) | A fresh figure would change what the bar says: the range crosses a colour line, is wider than 5% of the limit, or is over a week old |
| `resets in 12d` | When the month turns (UTC; days only when more than two days off) |
| `synced 5d 2h ago (Oct 14 08:43)` | How old the dashboard figure is, and when it was read, once it is an hour old; the range widens with it |

## How the estimate works

The figure you enter with `/hp` is exact. What sessions spend after it is
counted by the mod and is not, so it is shown as a range around that count.

### Priced by model

Claude Code's own session cost over-counts some models: it charges Sonnet 5.5
cache reads at $0.20 per million tokens, while the official price is $0.10. So
the mod prices every API call itself, the main thread's and each subagent's,
by **the model that answered it**, at the official rates:

| Model | Input | Output | Cache read | Cache write (1 h) |
|---|---|---|---|---|
| Fable 5.1, Mythos 5.1 | $10 | $50 | $0.25 | $20 |
| Fable 5, Mythos 5 | $10 | $50 | $1.00 | $20 |
| Opus 5.5 | $4 | $20 | $0.20 | $8 |
| Opus 5, 4.8, 4.7, 4.6, 4.5 | $5 | $25 | $0.50 | $10 |
| Sonnet 5.5 | $2 | $10 | **$0.10** | $4 |
| Sonnet 5 | $2 | $10 | $0.20 | $4 |
| Sonnet 4.6, 4.5 | $3 | $15 | $0.30 | $6 |
| Haiku 5.5, prompt up to 100K tokens | $0.10 | $0.50 | $0.01 | $0.20 |
| Haiku 5.5, prompt over 100K tokens | $0.50 | $2.50 | $0.05 | $1 |
| Haiku 4.5 | $1 | $5 | $0.10 | $2 |

US dollars per million tokens, from Anthropic's pricing page
(platform.claude.com/docs/en/about-claude/pricing) as of 2026-10-13. Claude
Code writes the 1-hour cache, so writes are priced at that rate. The only
difference measured against Claude Code's own table is the Sonnet 5.5 cache
read in bold; Opus and Haiku came out the same, and the bill matched them.

Calls no turn shows (session titles, summaries) and calls to a model not in
the table still count: the mod also prices every call at Claude Code's own
rates, and whatever Claude Code's total holds beyond that is added as Claude
Code priced it. A session the mod joins after it has already spent (a reload,
an upgrade) keeps Claude Code's figure for the rest of its life.

### The range

What came since the last figure is two things, estimated apart:

- **What the sessions counted**, scaled by a learned **ratio** (the bill per
  counted dollar: cache writes the mod prices at the one-hour rate make it a
  little under 1).
- **Spend the mod cannot see** (the desktop or web chat on the same account, a
  session that never loaded the mod), learned as **dollars a day**, since it
  adds whatever the sessions count.

The high end allows for unseen spend coming in **bursts**, not a steady
trickle:

- Its rate is the worst any interval of six hours or more showed, with a
  multi-day interval's excess charged as one day's burst rather than spread
  thin over the gap.
- From the moment after a figure, a whole day of that rate is allowed at once.
  Each further day adds another, building over that day's first ten hours; a
  busy morning of counted work moves the clock on too. What counts as a day's
  work is the average over every interval between figures, the short daytime
  ones included: read from the overnight gaps alone (the only intervals long
  enough to teach a daily rate), a day looked nearly idle and an afternoon's
  work moved the clock on by days, which asked for a re-sync within an hour
  of a fresh figure.
- Until two such intervals are in hand it allows 2% of the limit a day (1%
  with one). A stranger who never re-syncs keeps that allowance, so their
  range widens by about that much a day and, once the figure is a week old,
  the row asks for a new one on every turn. That is the honest answer when
  nothing has been measured: a narrower guess (one growing as the square root
  of the days was tried) left a stranger with heavy desktop chat late most of
  the time.

Before calibration the count itself is trusted to a tenth above (each call is
priced at the official rates; only cache writes it cannot tell apart are in
doubt) and a fifth below. The low end counts only what the sessions saw, less
their typical shortfall: unseen spend may be none. Colour, heart and pace all follow the pessimistic
end: it warns early, and is late as rarely as it can manage. Spend the mod has
never seen the like of can still outrun it; only a fresh figure fixes that.

### Calibration

Each time a figure is entered again in the same month (by `/hp` or a sync-file
update), the mod keeps what the sessions counted since the last one beside
what the dashboard says was really spent, and the reply says so:

    Sessions counted $1.87 since the last entry against $2.06 on the dashboard;
    from 1 re-entry, the estimate now scales counted spend by 1.00 and adds
    $0.19 a day the sessions do not see.

The last eight intervals are fitted together as `billed = ratio × counted +
unseen × days`, held toward a ratio of 1 and no unseen spend while few are in
hand. Where the two cannot be told apart (one interval, or every interval a
day of steady work), the fit leans on the ratio being 1: the sessions price
each call at the official rates, so a bill above their count is taken as spend
they did not see. An interval under six hours long says nothing of a daily
rate, so it informs the ratio alone. The ratio is held between 0.5 and 3. One
the sessions counted under $1 for teaches nothing.

### When it asks for a re-sync

The row adds `re-sync: /hp <spent> <limit>` only when a fresh figure would
change what the bar tells you: the range runs across a colour line (50% or 20%
left, or the limit itself), it is wider than 5% of the limit, or the figure is
over a week old. A range a few dollars wide and clear of the lines is left
alone. Once even the low end, which counts only spend the sessions saw, is
past a line, the bar is past it, and a figure would not change that.

A figure left in the sync file is entered at the end of a
session's first finished turn, not when it opens: until a reply, Claude Code
has not said whether the session has limits of its own.

### Tested by simulation

`tests/sim.test.tsx` drives the mod through forty simulated days (across a
month's turn) in sixteen scenarios, each on three seeds (48 runs): steady work, heavy
desktop chat, chat on any day, chat at any hour (before the morning sync
included), over-priced cache writes, a bill above the count, missed and broken
syncs, a sync file updated mid-afternoon, a spiky week, a person who types
`/hp` every few days, a stranger who set it up once, and several sessions at
once (a long one, a fresh one each afternoon priced call by call with a
subagent, and a subscription seat whose spend must never count), with and
without a sync file. One scenario also scores the bar as drawn in idle hours,
evenings and weekends. At every turn it holds the range against the true bill and
scores coverage, how often and how far the bill ran past the high end, the
width, the centre's miss, how often a re-sync was asked for, and the pace's
error, and in idle hours how often the bar as drawn was late. Each scenario
has floors the estimate must keep (`FLOORS`: lateness, miss, re-sync rate,
coverage, width, pace error): a change that makes any of them worse fails the
tests.

What it does not cover yet: billing lag on the dashboard, a person who answers
the re-sync prompt (it measures how often it is asked, not what happens next),
and real usage, which no simulation stands in for.

## Several sessions at once

Run as many sessions side by side as you like; each one counts only itself,
and every bar shows the total.

- **One key per session.** Each session writes what it has spent since the
  last entry under a key of its own, so sessions finishing turns at the same
  moment never overwrite each other. Within a session, the main thread and each
  subagent price their calls under keys of their own too, so parallel
  subagents never lose an update.
- **Every bar is the machine total:** the entered figure plus all sessions'
  keys. Line two's `this session` is that session's own cost only.
- **It keeps up while idle.** A session reads the others' keys after its own
  turns, and after two quiet minutes again each time it redraws (at least once
  a minute), so a session you are not using catches up within a few minutes.
- **`/hp` in any session resets the count for all of them**; the others pick
  it up on their next turn or redraw. A session still holding an earlier entry
  never sweeps away what a newer one has started.
- **What it cannot see:** sessions on other machines (the keys live in
  `~/.claude` on this one), sessions not running the mod (an older Claude Code,
  a headless `claude -p` without it, claude.ai on the web), and sessions that
  report their own 5H/7D limits, which neither show nor add to SPEND. The next
  `/hp` or sync file brings everything back in line, since the dashboard
  figure includes it all.

## Sync file (optional)

The mod reads one file, and enters what it finds there as if typed with `/hp`,
calibration included: `~/.claude/state/usage-hp-sync.json` (under
`$CLAUDE_CONFIG_DIR` when that is set).

    {"spentUsd": 47.69, "limitUsd": 300, "at": 1791914147525}

`at` is when the figure was read, in epoch milliseconds. The file is used only
after you have set a limit with `/hp` once (so `/hp off` stays off), only once,
and only when it is newer than the figure held and from this month. A figure
read at 7:00 and applied at 10:00 loses nothing in between: each session keeps
a short trail of its count, so it carries on from where it stood at 7:00, and
the calibration compares the dashboard with what had been counted by then.

Anything you trust can write that file, from a figure you copy by hand to a
script of your own. The mod only reads it; it never contacts claude.ai or any
other service itself. Feed it only from sources your account's terms allow.

## Styles

Pick how the bars look; the choice is kept for every session on the machine.

    /hp style bar       a bar that drains from full: `94% left · $282.02 left of $300` (the default)
    /hp style used      a bar that fills as you spend: `6% used · $17.98 / $300`
    /hp style hearts    ten hearts at 2.5% a quarter (the desktop draws quarters; the terminal dims a part-full heart)
    /hp style text      the figures alone, no bar

An open session picks up a new style after its next reply. `/hp hide` turns the
row off and `/hp show` brings it back; usage is still tracked while hidden.

## All commands

    /hp <spent> <limit>       enter the dashboard figure (e.g. /hp 47.53 300)
    /hp <limit>               the limit alone, spend starting at 0
    /hp off                   stop tracking (calibration is kept)
    /hp style bar|used|hearts|text
    /hp hide | /hp show

## What it cannot know

- A turn in flight when a figure is entered, or when the UTC month turns,
  lands wholly on the new side (at most one turn per open session).
- The dashboard's header updates within about a minute, but a slice of spend
  can land a little later; the daily chart under it lags much more, so take
  figures from the header.
- The price table is fixed in the mod (`PRICES` in `hooks/register.tsx`, dated
  2026-10-13). When Anthropic changes a price or ships a model, update it there;
  until then a new model is counted through Claude Code's own figure.
- **One budget per Claude config folder.** Claude Code tells a mod nothing of
  which account a session is signed in to, so every session that reports no
  limits of its own adds to the one budget entered. A session on a Pro or Max
  seat reports its limits and is left out (anything it counted before they
  showed is taken back out); two Enterprise accounts sharing one config folder
  would be added together.
- Months turn in UTC, as Claude Code's own usage does; an organization billed
  on another cycle will see the reset on the wrong day.
- A session that bills an API key, Bedrock, Vertex or Foundry directly has no
  Settings › Usage page, so no setup line is drawn for it unless a limit is
  entered.
- **What it keeps, and where:** dollar totals, timestamps and session ids, in
  Claude Code's local plugin store on this machine, plus the sync file if you
  use one. Nothing is sent anywhere. `/hp off` clears the limit and the
  sessions' counts and stops the daily ledger; the calibration (eight
  intervals) and eight days of the resync log stay for the next limit, and each
  call's price is still kept for the session's own cost line. The ledger and
  log are pruned when a session starts, so a session left open for weeks
  holds older entries until the next one opens.

## Install

Requires a Claude Code version with mods: the docs say v2.1.287 or later; seen
working in the desktop app on 2.1.284 through 2.1.293.

**From the zip** (no repository needed):

1. Unzip it so the folder sits at `~/.claude/mods/usage-hp` (the folder holding
   this README).
2. Load it in every session, desktop app included: in `~/.claude/settings.json`
   add

   ```json
   "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/usage-hp" }
   ```

   (several paths are separated by `:`, or `;` on Windows), then start a new
   session. For one terminal session only: `claude --plugin-dir ~/.claude/mods/usage-hp`.
3. Check: `claude plugin validate ~/.claude/mods/usage-hp`, then on Enterprise
   type `/hp <spent> <limit>` once (see [Enterprise setup](#enterprise-setup-once)).

**From a clone of the repository** holding this folder: copy or link the
cloned `usage-hp` folder to `~/.claude/mods/usage-hp` and follow steps 2 and 3
above, or see the [top-level README's install section](../README.md#install),
which loads several mods at once. The `.claude-plugin/marketplace.json` lives in
this `usage-hp` folder, not at the repository root, so a marketplace added from
the repository root will not find it.

It stacks with other mods that draw in the same band, in `CLAUDE_CODE_PLUGIN_DIRS`
order: the first mod listed draws at the bottom of the band, the last at the top.

## The ledger and the resync log

The mod keeps a small database of its own in the background; nothing shows it
and there is no command for it.

- **Ledger:** each API call, the main thread's and each subagent's, is added to
  that session's total for the local day: one key per session and day, so
  sessions never overwrite each other. An entry from the dashboard leaves it
  alone. A week is kept.
- **Resync log:** each figure entered, with when the dashboard was read, when
  the mod entered it, whether it came from `/hp` or the sync file,
  and (for a same-month re-entry) what the sessions counted against what the
  dashboard said. Eight days are kept; `/hp off` leaves it.
- **What reads them:** the SPEND pace (`empty in ~12d at this pace`) comes,
  first, from the resync log: the first and last dashboard figures this month
  within the week, at least a day apart. Those are billed dollars, spend the
  mod never sees included. Without such a pair it comes from the ledger's
  week, scaled by the calibration, once the ledger holds a day before today.
  Failing both, it comes from the last hour.
- **Seats:** only a session the engine reports no limits for spends the
  entered budget, so only such a session writes the ledger. A session on a
  subscription seat (Pro, Max) is never written, and any calls it made before
  the engine first reported its limits are taken back out.

Both are pruned when a session starts.

## 0.26.0 (2026-10-19)

- **The dollars say which way they count.** In the bar, hearts and text styles the SPEND row's dollars are what is left, but `$127–129 / $300` beside the SPEND label read as spent. They now read `$127–129 left of $300`; `/hp style used` keeps `$171–173 / $300`, which counts the spend.

## 0.25.0 (2026-10-16)

- **Limits move mid-turn.** The engine raises `session.measure` when a plan limit's percent moves a whole point (or a window appears or leaves); the 5H/7D bars now re-read then, not only when this session's turn ends. A measure of cost or context alone waits for the turn end.
- **One refresh at a time.** A turn end, a measure, an `/hp` entry and each step's ledger write run one after the other, so a refresh that finds a subscription seat mid-turn clears the ledger before or after a step's write, never in the middle. A refresh that fails hands on to the next. A measure that reports the limits the last refresh already read is skipped, so a turn end adds one pace sample, not two.
- **A quiet band stops rescanning.** After two quiet minutes the SPEND row re-reads the other sessions' counts; that re-read (several full store scans) now runs at most once per two minutes instead of on every redraw, redraws that arrive while it reads share it, and it is redone at once when the entered figure changes or the month turns. `/hp off` in another session still clears the row on the next redraw.
- `tests/mutate.py` (new): a clean baseline first, then one mutant per guard above.

