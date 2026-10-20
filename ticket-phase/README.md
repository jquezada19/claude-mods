# ticket-phase

One row above the prompt, in any session that has a phase row in the sink (see [What feeds it](#what-feeds-it)).
In the desktop app it is drawn: the eight phases as a bar, the current one as a
pill with the next one ghosted after it, and the phase's Clawd mascot at the end,
walking while the phase is open:

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/row-dark.svg"><img alt="#12345 full: phases 1 to 4 worked, 5 Implement as a green pill, 6 ghosted, then 23m/41m · ~2h10m left · 184k · R6×2 and the hammer Clawd" src="docs/row.svg"></picture>

Past the phase's median the row turns yellow (red past twice it):

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/row-slow-dark.svg"><img alt="The same row in yellow at 52m/41m, ~1h52m left" src="docs/row-slow.svg"></picture>

Done, the bar fills and the Clawd throws a party:

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/row-done-dark.svg"><img alt="#12345 full: the whole bar filled, done 3h0m, the party Clawd" src="docs/row-done.svg"></picture>

One Clawd per phase, plus between phases and done:

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/mascots-dark.svg"><img alt="The ten mascots: 1 wizard-hat, 2 magnifier, 3 clipboard, 4 flask, 5 hammer, 6 reading-glasses, 7 rocket, 8 checkered-flag, thinking-dots between phases, party when done" src="docs/mascots.svg"></picture>

In the terminal the row is text:

    #12345 full ◆◆◆◆◈◇◇◇ 5 Implement 23m/41m · ~2h10m left · 184k · R6×2

- `#12345 full` — the ticket this session's latest phase row names, and the `tier:` from its Work Item note (`?` when none). Every tier draws eight cells; the tier is a label.
- cells — ◆ a phase entered below the current one, ◈ the current, ◇ everything above it (re-entering 5 after 6 draws 6 as ahead again). With no phase open, ◆ wherever a phase was entered.
- `23m/41m` — time in the phase / your own median for it, from paired enter/exit rows across every ticket. `23m/—` with no median. Green under the median, yellow to twice it, red past that; grey with no median. In the terminal the colour covers the title, the cells and the phase; the stats after it are dim. On the desktop the title is ordinary text and the colour drives the dot before it, the bar's dots and the current-phase pill; the stats are grey.
- `~2h10m left` — the medians of the phases ahead plus what the current one's median still allows; shown only when every summed phase has pairs from two tickets, else `ETA —` (the basis is in `/phase`).
- `184k` — this session's new tokens since the phase began (uncached input, output and cache writes; the cached context read back at each step is left out), subagents included, kept across a restart. The step whose Bash call writes the boundary lands wholly on one side; that is noise.
- `R6×2` — a phase entered again after it was left (by an exit, or by entering another phase). A resume, or a second session joining an open phase, is not a round. Several phases list in phase order, space-joined: `R5×3 R6×2`.
- `between phases` after an exit with nothing open; `done 3h0m` once the ticket's latest row is an exit of Phase 8, with the total from the first enter to that exit. A later enter reopens the ticket. No token figure shows between phases or when done (only an open phase has a tally): `between phases · ~1h5m left`, `done 3h0m · R6×2`. In the terminal done is grey; the desktop draws it green.

**A ticket is in one phase at a time.** An `enter` opens its phase and leaves every other open phase, whichever session held it (a workflow may move to a new session at its seams, so a dead session's unanswered `enter` is the common case, not an error). An `enter` on a phase that is already open is a resume: the phase keeps its original start. An `exit` closes the phase for everyone. An `exit` with nothing open is an orphan: counted in `/phase`, no effect on the band.

**Desktop drawing.** The same row as an eight-segment bar, after a coloured dot and the title. On a narrow pane the stats column goes first, then the Clawd, then the title's share shrinks. The bar is one length in every phase: the stats sit in a fixed-width column (between phases, its text leads it). Done is the one exception: nothing follows it that could move the bar again, so the column shrinks to the `done 3h0m` text (plus any rounds) and the bar runs the rest of the way to it. The current phase is a solid chevron whose right edge is always its own boundary; its label is centred, a name too long for the segment stretches the chevron back over earlier phases as far as it needs (never forward), and with no room at all only the number shows. The next phase is a ghost chevron with its name (or number), from 5 % visible as the phase starts to 55 % at the median (12 % with no median). Worked phases are a dither that runs right up to the chevron, dense and bold behind it and thinning further back, so earlier phases fade away as the ticket moves on; the tail reaches further in later phases (about 2 segments in phase 2, 4.5 in phase 8). Each dot blinks on one of twelve rhythms (a shimmer, a slow fade nearly out, a quick blink), and a ragged pulse runs back from the chevron, barely dimming the dots nearest it. **Done** is the celebration: the whole bar fills with dots at one density whatever was entered (no tail, no fade, no boundary ticks), every dot flashing on its own beat (twelve rhythms × sixteen starts, so no two patches of the bar flash in step), and bright sparks popping all over the field; under reduced motion the dots sit lit and the sparks stay hidden. The row ends in the pixel Clawd holding a prop for the state (`hooks/mascot.ts`, original pixel art): 1 a wizard hat, 2 a sweeping magnifier, 3 a clipboard ticking off, 4 a bubbling flask, 5 a tapping hammer, 6 reading glasses with scanning eyes, 7 a launching rocket, 8 a checkered flag waving at the finish line, thinking dots between phases, and a party hat with confetti (tinted green) when done. It walks while a phase is open. A phase entered in the last 4 s slides in from the one before. Every motion stops under reduced motion.

List this mod first in `CLAUDE_CODE_PLUGIN_DIRS` to draw it under the other rows: the first mod listed draws at the bottom of the band. The row is laid out to fit 80 columns in its longest normal state (two round markers, a day-long elapsed, a megatoken tally); a narrower pane wraps it.

`/phase` prints every phase with its enters, exits, rounds, median and sample counts, the ETA basis, the token tally and the skipped-row count. `/phase hide` / `/phase show` turn the row off and on; tracking continues while hidden.

The mod reads the sink (default `~/.claude/metrics/ticket-phase-tokens.jsonl`) and the notes folder's `Work Items/` notes (`In Flight`, `In Testing`, `Backlog`, the root, then every folder under `Done/`, first match wins); it writes nothing but its own `$.store` keys. Paths are `userConfig` (`sink`, `vault`; `~` expands to your home). It re-reads when a Bash call whose command contains `ticket-phase.sh` lands, at each finished turn, and once a minute when the sink's or the note's mtime moved (or a ticket with no note gains one). Medians pair each exit with its own session's enter first, so interleaved sessions measure their own stretches.

Tests: `claude plugin test .` (91 cases) and `python3 tests/mutate.py` (63 mutants, each must be detected).

## What feeds it

Nothing draws until something appends phase rows to the sink, a JSONL file (`userConfig.sink`, default `~/.claude/metrics/ticket-phase-tokens.jsonl`). This repo ships no writer: a workflow script (yours) appends one line per phase boundary. Name it `ticket-phase.sh`, or have its command line contain that string, and the row refreshes as soon as the Bash call that runs it lands; otherwise it catches up at the next finished turn or minute tick.

Each line is one JSON object. The mod reads only these five fields; anything else on the line is ignored:

| Field | Type | Meaning |
|---|---|---|
| `ts` | string | When the boundary happened; anything `Date.parse` accepts (ISO 8601 with a zone, e.g. `2026-01-05T14:03:00Z`). |
| `session` | string, non-empty | The Claude Code session id. The row shows the ticket named by this session's newest row. |
| `ticket` | string or number | The ticket id; a number is read as its string. |
| `phase` | integer 1–8, or a string of one | The phase the boundary belongs to. |
| `event` | `"enter"` or `"exit"` | Entering or leaving that phase. |

A line that is not JSON, or misses or mistypes any of the five, is skipped and counted in `/phase`. The tier is not a row field and the rows carry no tokens: the token figure is counted by the mod itself from the session's own API responses while a phase is open.

    {"ts":"2026-01-05T14:03:00Z","session":"0b7c2d5e-1f4a-4c1e-9a7d-3e2b6f8a9c10","ticket":"12345","phase":5,"event":"enter"}

**Notes folder (optional).** The tier label comes from a markdown note named `<ticket> - <title>.md` (e.g. `12345 - Dark mode toggle.md`) under `<vault>/Work Items/`, searched in `In Flight/`, `In Testing/`, `Backlog/`, `Work Items/` itself, then each folder under `Done/` (first match wins). The note's YAML frontmatter needs a `tier:` field with a single alphabetic word (`tier: full`, read case-insensitively); without a note, or without the field, the tier shows `?`. `userConfig.vault` (the key is `vault` for historical reasons) sets the notes folder (default `~/Documents/Obsidian Vault`, Obsidian's own first-run vault path; any folder with the same layout works).

## 0.3.0 (2026-10-16)

- **The band counts new tokens.** The figure after the stats is now uncached input + output + cache writes for the phase. The cached context read back on every step is left out, so a warm 200k context no longer adds ~200k per step. `/phase` shows both: `6k new · 206k processed`. A tally stored before 0.3.0 counts its new tokens from the upgrade.

## 0.4.0 (2026-10-17)

- **A sink past the read limit still shows.** Over 3 MiB the mod reads the newest 3 MiB (`tail -c`, one byte more so a window that opens on a whole row keeps it) and drops a cut first row; `/phase` says the history is the newest part. Output the engine cut short is not taken as the history. A row's order is now its place among rows with the same timestamp, so a phase's tally keeps its identity as old rows leave the window; tallies stored before 0.4.0 restart once.
- **Old tallies leave the store.** At session start, a tally untouched for 30 days is deleted. Activity counts, not phase age: a tally that took tokens recently stays however long ago its phase began.
- **A ticket with no Work Item note is looked for at most every ten minutes**, on every path that looks (ticks, finished turns, the `ticket-phase.sh` Bash call), not every minute. A search is claimed before it walks the folders, so two refreshes at once walk them once.

