# cache-status

A Claude Code mod that draws a band above the prompt showing whether the
session's prompt cache is warm or cold.

- `● CACHE WARM` (green) with time left and the last request's cache-hit share
- `● CACHE WARM` (yellow) under 5 minutes left
- under 10 minutes left the time reads as a `m:ss` countdown that ticks every
  second down to `0:00` (`· 9:59 left of 1h`); otherwise the row redraws every 15 s
- `○ CACHE COLD · lapsed 12m ago · next message re-caches` (red) once the
  lifetime has lapsed
- `○ CACHE COLD · expired while away · next message re-caches` after a resume
  the engine reported as expired
- `○ CACHE COLD · last response used no cache` when the last request read
  nothing from the cache
- `○ cache · waiting for first response` (dim) before the first reply, and
  again after `/clear`, `/resume` or `/branch`
- `· N cold restarts · N misses · Xk re-cached` once a big context has been
  written again after a lapse, or missed inside a known lifetime; each part
  shows only when it is not zero, and `re-cached` sums both (tokens, never dollars; also logged to
  `~/.claude/metrics/cache-restarts.jsonl`; rows are appended with `sh -c`
  because `$.fs.write` only replaces a file, and several sessions append to
  the log at once, so a read-then-write would lose rows)

The lifetime is counted from the start of each main-conversation request, and
from the transcript's real idle time after a resume or fork; `/clear` starts
the row over. The TTL (1h or 5m) comes from, in order: the request's own
1h/5m cache-write split, when its usage carries one; the engine's `cache_ttl`
at a main-conversation model switch, for that model only; the configured controls in Anthropic's order
(`FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the
`promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`); an earlier lifetime
this session observed; else 1h, drawn as `(assumed)`. The hit share is measured. Model, effort,
MCP and plugin changes and compaction invalidate the cache without the band
knowing until the next response.

Optional **cold-send guard** (`coldSendGuard`, default off; `bigTokens`,
default 150000, both in `/config` under cache-status, or in `settings.json`
under `pluginConfigs` → `cache-status` → `options`, as in
`{ "pluginConfigs": { "cache-status": { "options": { "coldSendGuard": true, "bigTokens": 150000 } } } }`): before
a typed prompt (slash commands pass through) enters a lapsed cache with a big
context, a `Cache cold` dialog asks `Cache lapsed 12m ago. Sending now
re-caches about 180k tokens. What should happen?` and offers Send anyway /
Compact now, then send (the prompt goes back in the box and compaction runs;
press Enter once the row shows the smaller context) / Cancel. A dismissed
dialog sends as typed. The row hides while a survey shows.

It stacks with other mods that draw in the same band (such as usage-hp) in `CLAUDE_CODE_PLUGIN_DIRS` order: on Claude Code 2.1.323 and later the first mod listed draws at the top.

Optional **expiry heads-up** (`expiryNotice`, default off): when you have left a
session whose cache is warm, a notification about a minute before it expires,
so you can send something and keep it. It is booked when a turn of the main
conversation ends and the session waits for you; the desktop or mobile app holds
it and throws it away if you come back first. Any new turn, a compaction, a model
switch or the session ending takes it back, and the next turn's end books it
again. Only when the cache lifetime is known (from a cache write, the engine or
your settings), never when it is only assumed, and never where a terminal is
attached, since a terminal would show a delayed notification at once.

Under a subagent's transcript the row says `main session`: the cache it counts
is the main conversation's, not the subagent's.

## Install

Requires a Claude Code version with mods: the docs say v2.1.287 or later; seen working in the desktop app on 2.1.284 and 2.1.286.

1. Clone the mods repository (see the mods README one folder up), so this mod sits at, for example, `~/.claude/mods/cache-status`.
2. Load it:
   - one session: `claude --plugin-dir ~/.claude/mods/cache-status`
   - every session, desktop app included: in `~/.claude/settings.json` add
     `"env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/cache-status" }`
     (several paths are separated by `:`, or `;` on Windows), then start a new session.
3. Check: `claude plugin validate ~/.claude/mods/cache-status`

## 0.5.0 (2026-10-16)

- The cold-send guard lets slash commands through (`/compact`, `/clear`, the mods' own).
- A prompt the box cannot take back and too long for a drop reason (over 3,500 characters; the engine cuts a reason at 4,096) is sent as typed, with a toast, rather than risk losing text.
- `/resume` and `/branch` reset the row like `/clear`.

## 0.6.0 (2026-10-16)

- **The lifetime is grounded, not guessed.** The hit-rate inference that flipped the countdown to 5m is gone: on 2026-10-16 every observed main-conversation cache write over a week was 1h, and the 13 restarts the mod had logged at an inferred 5m were prefix misses inside a 1h lifetime. The row reads the engine's `cache_ttl` after a main-conversation model switch (kept in session state with the model switched to, applied only to that model's responses, forgotten on `/clear` and `/resume`, a subagent's switch ignored), then your configuration in the documented order, else shows `1h (assumed)`. A cache write's own 1h/5m split is used when the step usage carries it: on 2.1.330 it does, as `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` on the step's usage.
- **Misses are not cold restarts.** A big re-write is judged by the lifetime the earlier cache had: at or past it, or after a resume the engine called expired, it is a cold restart; inside a known (not assumed) lifetime it is a miss (`· 1 miss`), something changed the prefix; inside an assumed one it is not counted. Each logged row now carries `kind` (`lapse`/`miss`), `ttl_basis` and `split_seen`.
- **A resume the engine calls expired** reads `expired while away`, and the cold-send guard asks before a big send, without inventing a 5m lifetime. The next response or a compaction clears it.
- `tests/mutate.py` (this mod's; each mod has its own) runs a clean baseline first and counts a mutant as detected only when the module still loaded.

## 0.7.0 (2026-10-16)

- **An offer, never a switch.** With the cold-send guard off, the first lapse in a conversation whose context is at least `bigTokens` shows one toast saying what it re-cached and that the guard can be turned on in `/config` under cache-status. Once per conversation; `/clear` and `/resume` start over. The guard is never turned on for you, and a failure in the offer never stops the lapse being counted.

## 0.8.0 (2026-11-23)

- **Expiry heads-up** (`expiryNotice`, default off): a notification about a minute before a warm cache expires, booked when a main turn ends, held by the desktop or mobile app and dropped if you come back first; any new turn, compaction, model switch or session end takes it back. Only for a known lifetime, never where a terminal is attached.
- **Whose cache.** Under a subagent's transcript the row reads `main session`.
- The row's words cut at the band's edge instead of wrapping beside a docked pane.
- The 1h/5m split of a cache write is read where Claude Code 2.1.330 reports it; the row stacks with other mods the way 2.1.323+ stacks band rows.

## 0.9.0 (2026-11-23)

- **Final-stretch countdown.** Under 10 minutes left, the time reads `m:ss` and ticks every second down to `0:00`; a 5m cache counts down this way from the start. Above 10 minutes, and once the cache is cold, the row redraws every 15 s as before.
