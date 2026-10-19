import type { EngineInterface, Register } from 'claude-code'

import type {
  UsageHpBudget,
  UsageHpBasis,
  UsageHpCalibration,
  UsageHpCost,
  UsageHpPriced,
  UsageHpLedger,
  UsageHpOthers,
  UsageHpReading,
  UsageHpSample,
  UsageHpStyle,
  UsageHpSync,
} from '../types'

const CELLS = 20
const HEART =
  'M8 14.6 L1.7 8.3 A3.85 3.85 0 0 1 8 3.4 A3.85 3.85 0 0 1 14.3 8.3 Z'
// The quadrants a heart keeps as it drains: top-right goes first, top-left last.
const QUADRANTS = [
  '<rect x="0" y="0" width="8" height="8"/>',
  '<rect x="0" y="8" width="8" height="8"/>',
  '<rect x="8" y="8" width="8" height="8"/>',
  '<rect x="8" y="0" width="8" height="8"/>',
]
const TICK = 60_000
const READING = { plugin: 'usage-hp', key: 'reading' } as const
const COUNTED = { plugin: 'usage-hp', key: 'counted' } as const
const COSTS = { plugin: 'usage-hp', key: 'costs' } as const
const BASIS = { plugin: 'usage-hp', key: 'basis' } as const
const COLORS = { plugin: 'usage-hp', key: 'colors' } as const
const SAMPLES = { plugin: 'usage-hp', key: 'samples' } as const
const SEEN = { plugin: 'usage-hp', key: 'seen' } as const
const LEDGER = { plugin: 'usage-hp', key: 'ledger' } as const
const OTHERS = { plugin: 'usage-hp', key: 'others' } as const
const SHOWN = { plugin: 'usage-hp', key: 'style' } as const
// The style chosen with /hp style, kept in $.store for every session.
const STYLE = 'style'
const STYLES: readonly UsageHpStyle[] = ['bar', 'used', 'hearts', 'text']
const HIDDEN = { plugin: 'usage-hp', key: 'hidden' } as const
// Whether the session bills an API key or a cloud provider directly: no
// Settings › Usage page to enter, so no setup line is drawn.
const METERED = { plugin: 'usage-hp', key: 'metered' } as const
// Whether /hp hide stands, kept in $.store for every session.
const HIDE = 'hidden'
// The hearts style: ten hearts of four quarters, a quarter is 2.5%.
const HEARTS = 10
// How long the other sessions' total is trusted before the store is read again.
const OTHERS_TTL = 2 * 60_000
// The pace is read over the last hour, once five minutes of it are in hand.
const PACE_WINDOW = 60 * 60_000
const PACE_MIN = 5 * 60_000
// A reading older than this says how old it is.
const STALE = 10 * 60_000
// What $.store keeps across sessions: the limit as entered, under `budget`,
// and beside it one key per session holding what that session has added.
// Each session writes its own key alone, so two finishing at once lose nothing.
const BUDGET = 'budget'
const SPEND = 'spend:'
// Beside each session's key, its count at recent turns: what it had added by
// the moment a dashboard figure was read, which a sync file applies later.
const TRAIL = 'trail:'
// Each re-entry of /hp keeps what the sessions counted beside what the
// dashboard said, one key per interval: the spend range learns from them.
const CALIB = 'calib:'
const CALIB_KEEP = 8
// An interval the sessions counted less than this for says nothing of a ratio.
const CALIB_MIN = 1
// The range's half-width, as a share of what the sessions counted since the
// entry: a guess until three re-entries are in hand, then what they showed.
// Before calibration, what the sessions count is still priced call by call
// at the official rates: a tenth above covers the cache writes it cannot
// tell apart (the rest of the doubt is unseen spend's), a fifth below the
// writes it prices at the hour's rate that were the five minutes'.
const SPREAD = 0.1
const SPREAD_BELOW = 0.2
const SPREAD_MIN = 0.15
// Spend the mod never sees (the desktop chat, a session without the mod) only
// ever adds: the high end grows by a rate a day learned from the re-entries,
// never less than this.
const DRIFT_PER_DAY = 0.25
// An interval shorter than this says too little of a daily rate to learn from.
const UNSEEN_MIN_SPAN = 6 * 60 * 60_000
// The hours a day's unseen spend is taken to land in.
const UNSEEN_HOURS = 10
// The unseen allowance a day, as a share of the limit, with 0 and 1 re-entries in hand.
const COLD_SHARE = [0.02, 0.01]
// How far the learned ratio may run: past 1.5 was flattened silently before.
const RATIO_MIN = 0.5
const RATIO_MAX = 3
const DAY = 24 * 60 * 60_000
// When to ask for a fresh figure: an entry this old, or a range this wide.
const RESYNC_AGE = 7 * DAY
const RESYNC_WIDTH = 0.05

/**
 * Whether a fresh figure is worth asking for: it is over a week old, the
 * range runs across a colour line (a figure would say which side), or it is
 * wider than a twentieth of the limit. A range that is merely a few dollars
 * wide and clear of the lines changes nothing the bar says.
 */
const needsResync = (budget: UsageHpBudget, age: number): boolean => {
  // The low end counts only what the sessions saw: once it is past a line
  // the bar really is past it, and a fresh figure would not change that.
  // While the range runs across one (the limit itself included), it would.
  const most = ((budget.limitUsd - budget.lowUsd) / budget.limitUsd) * 100
  const least = ((budget.limitUsd - budget.highUsd) / budget.limitUsd) * 100
  const across = [50, 20, 0].some(line => least <= line && most > line)

  return age > RESYNC_AGE || across || budget.highUsd - budget.lowUsd > budget.limitUsd * RESYNC_WIDTH
}
// Each agent's calls priced at the official rates, one key per agent of a
// session: an agent's calls come one after another, so no write is lost.
const PRICED = 'priced:'
// Keys of sessions that have not written for this long are pruned.
const PRICED_TTL = 3 * DAY
// The ledger, the mod's own and never shown: what each session's calls cost
// on each local day, one key per session and day (`day:<YYYY-MM-DD>:<session>`),
// so no two sessions share a write. An entry from the dashboard leaves it
// alone. A week is kept: the spend pace reads it.
const DAY_KEY = 'day:'
const LEDGER_DAYS = 7
// The resync log: one key per figure entered (`sync:<at>`), a week of them.
const SYNC_KEY = 'sync:'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The local calendar day of `ms`, as `YYYY-MM-DD`. */
const dayOf = (ms: number): string => {
  const d = new Date(ms)

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `08:43` on the same local day as `now`, else `Oct 13 08:43`; no `now`, always the date. */
const stamp = (ms: number, now?: number): string => {
  const d = new Date(ms)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  return now !== undefined && dayOf(ms) === dayOf(now) ? time : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`
}

/** Local midnight at the start of `day` (`YYYY-MM-DD`), ms. */
const midnightOf = (day: string): number =>
  new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))).getTime()

/**
 * The official prices, US dollars per million tokens, from Anthropic's pricing
 * page (platform.claude.com/docs/en/about-claude/pricing, 2026-10-13):
 * input, output, cache read, and a 1-hour cache write (the TTL Claude Code
 * writes). First match wins, so a longer id comes before its prefix.
 */
type Price = { input: number; output: number; read: number; write: number }

const PRICES: readonly (readonly [string, Price, Price?])[] = [
  ['fable-5-1', { input: 10, output: 50, read: 0.25, write: 20 }],
  ['mythos-5-1', { input: 10, output: 50, read: 0.25, write: 20 }],
  ['fable-5', { input: 10, output: 50, read: 1, write: 20 }],
  ['mythos-5', { input: 10, output: 50, read: 1, write: 20 }],
  ['opus-5-5', { input: 4, output: 20, read: 0.2, write: 8 }],
  ['opus-5', { input: 5, output: 25, read: 0.5, write: 10 }],
  ['opus-4-8', { input: 5, output: 25, read: 0.5, write: 10 }],
  ['opus-4-7', { input: 5, output: 25, read: 0.5, write: 10 }],
  ['opus-4-6', { input: 5, output: 25, read: 0.5, write: 10 }],
  ['opus-4-5', { input: 5, output: 25, read: 0.5, write: 10 }],
  ['sonnet-5-5', { input: 2, output: 10, read: 0.1, write: 4 }],
  ['sonnet-5', { input: 2, output: 10, read: 0.2, write: 4 }],
  ['sonnet-4-6', { input: 3, output: 15, read: 0.3, write: 6 }],
  ['sonnet-4-5', { input: 3, output: 15, read: 0.3, write: 6 }],
  // Haiku 5.5 has two rate cards: a prompt over 100,000 tokens pays the second.
  [
    'haiku-5-5',
    { input: 0.1, output: 0.5, read: 0.01, write: 0.2 },
    { input: 0.5, output: 2.5, read: 0.05, write: 1 },
  ],
  ['haiku-4-5', { input: 1, output: 5, read: 0.1, write: 2 }],
]

// Where Claude Code's own price table differs from the official one, as
// measured on 2026-10-13: it charges Sonnet 5.5 cache reads at $0.20.
const ENGINE_PRICES: readonly (readonly [string, Price, Price?])[] = PRICES.map(row =>
  row[0] === 'sonnet-5-5' ? ([row[0], { ...row[1], read: 0.2 }] as const) : row,
)

/** What one call cost at the official prices, or null for a model not listed. */
const priceOf = (
  usage: {
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  },
  table: readonly (readonly [string, Price, Price?])[] = PRICES,
): number | null => {
  const found = table.find(([id]) => usage.model.includes(id))

  if (found === undefined) {
    return null
  }

  const prompt =
    usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const rate = prompt > 100_000 && found[2] !== undefined ? found[2] : found[1]

  return (
    (usage.input_tokens * rate.input +
      usage.output_tokens * rate.output +
      usage.cache_read_input_tokens * rate.read +
      usage.cache_creation_input_tokens * rate.write) /
    1_000_000
  )
}

const isPriced = (value: unknown): value is UsageHpPriced =>
  typeof value === 'object' &&
  value !== null &&
  Number.isFinite((value as UsageHpPriced).usd) &&
  Number.isFinite((value as UsageHpPriced).at)

/**
 * What this session's agents have cost at the official prices; other
 * sessions' keys gone quiet for days are pruned on the way.
 */
const pricedOf = async (
  $: EngineInterface,
  session: string,
  now: number,
): Promise<{ usd: number; engine: number }> => {
  let usd = 0
  let engine = 0

  for (const key of await $.store.keys()) {
    if (!key.startsWith(PRICED)) {
      continue
    }

    const value = await $.store.get(key)

    if (key.startsWith(`${PRICED}${session}:`)) {
      usd += isPriced(value) ? value.usd : 0
      engine += isPriced(value) ? (value.engine ?? 0) : 0
    } else if (!isPriced(value) || now - value.at > PRICED_TTL) {
      await $.store.delete(key)
    }
  }

  return { usd, engine }
}

// A figure read off the dashboard by something else (a scheduled task) and
// left here as `{ spentUsd, limitUsd, at }`, under the Claude config folder:
// the next turn enters it as if typed with /hp.
const SYNC_FILE = 'state/usage-hp-sync.json'
// How far ahead of this clock a sync file's time may be.
const SKEW = 10 * 60_000

type StoredBudget = {
  limitUsd: number
  /** Spend as entered, for `month`; the sessions' keys add to it. */
  spentUsd: number
  month: string
  /** When it was entered, ms: a new entry starts every session's count over. */
  epoch?: number
  /** A sync file's own time, when it ran ahead of this clock: what the next file is held against. */
  readAt?: number
}

/** What moved a reading: the session starting, a turn ending, or /hp. */
type Cause = 'start' | 'turn' | 'command'

const LABELS: Record<string, string> = {
  five_hour: '5H',
  seven_day: '7D',
  spend_limit: 'SPEND',
}

const until = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  if (days > 0) {
    return `${days}d ${hours}h`
  }

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

type Color = 'green' | 'yellow' | 'red'
const RANK: Record<Color, number> = { green: 0, yellow: 1, red: 2 }
// How far past a line a bar must climb back before its colour improves.
const HYSTERESIS = 2

/**
 * A bar's colour from what is left: worse at once when a line is crossed (warn
 * early), better only once it is HYSTERESIS points back over it, so a bar
 * sitting on 50% or 20% does not flicker turn to turn.
 */
const colorOf = (left: number, prior?: Color): Color => {
  const raw: Color = left > 50 ? 'green' : left > 20 ? 'yellow' : 'red'

  if (prior === undefined || RANK[raw] >= RANK[prior]) {
    return raw
  }

  const line = raw === 'green' ? 50 : 20

  return left > line + HYSTERESIS ? raw : prior
}

/**
 * The spend range read afresh from the store, for a session that has not taken
 * a turn in a while: what the others counted since moves without it.
 */
const freshRange = async ($: EngineInterface, now: number): Promise<UsageHpBudget | null> => {
  const stored = await $.store.get(BUDGET)

  if (!isStored(stored)) {
    return null
  }

  const prefix = `${SPEND}${stored.epoch ?? 0}:${monthOf(now)}:`
  let tally = 0

  for (const key of await $.store.keys()) {
    const value = key.startsWith(prefix) ? await $.store.get(key) : null
    tally += typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  return withBurn($, rangeOf(stored, tally, calibrate(await calibrationsOf($)), now), now)
}

/** A reset far off reads in days alone: hours are noise two days out. */
const untilReset = (ms: number): string =>
  ms > 2 * DAY ? `${Math.round(ms / DAY)}d` : until(ms)

const isStyle = (value: unknown): value is UsageHpStyle =>
  STYLES.includes(value as UsageHpStyle)

/** How many quarter-hearts of the row are left; any health keeps one. */
const rowQuartersOf = (left: number): number =>
  left <= 0 ? 0 : Math.max(1, Math.min(HEARTS * 4, Math.ceil(left / 2.5)))

/** The row of hearts with `quarters` quarter-hearts filled, as one SVG. */
export const heartsSvg = (quarters: number): string => {
  const hearts = Array.from({ length: HEARTS }, (_, index) => {
    const kept = Math.max(0, Math.min(4, quarters - index * 4))
    const empty = `<path d="${HEART}" fill="#3b1d1d" stroke="#7f2a2a" stroke-width="1"/>`
    const full =
      kept === 0
        ? ''
        : // Named by what it holds: two rows in one document never share an
          // id with different quarters.
          `<clipPath id="hq${kept}">${QUADRANTS.slice(0, kept).join('')}</clipPath>` +
          `<path d="${HEART}" fill="#ef3b36" stroke="#ef3b36" stroke-width="1" clip-path="url(#hq${kept})"/>`

    return `<g transform="translate(${index * 18} 0)">${empty}${full}</g>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${HEARTS * 18}" height="18" viewBox="0 0 ${HEARTS * 18} 18">${hearts.join('')}</svg>`
}

export const FILLS = { green: '#4fb36b', yellow: '#e0b93a', red: '#ef3b36' }

// The desktop bar: twenty rounded cells, each 6px wide with a 1px gap.
const CELL_W = 6
const CELL_GAP = 1
const BAR_W = CELLS * (CELL_W + CELL_GAP) - CELL_GAP
const BAR_H = 10

/**
 * The bar as one SVG: `full` cells lit in `fill`, then `ghost` half-lit cells
 * where a range is unsure, the rest a faint track.
 */
export const barSvg = (full: number, fill: string, ghost = 0): string => {
  const cells = Array.from({ length: CELLS }, (_, index) => {
    const x = index * (CELL_W + CELL_GAP)

    if (index < full) {
      return (
        `<rect x="${x}" y="0" width="${CELL_W}" height="${BAR_H}" rx="1.5" fill="${fill}"/>` +
        `<rect x="${x}" y="1" width="${CELL_W}" height="3" rx="1" fill="#fff" fill-opacity="0.22"/>`
      )
    }

    const opacity = index < full + ghost ? 0.45 : 0.14

    return `<rect x="${x}" y="0" width="${CELL_W}" height="${BAR_H}" rx="1.5" fill="${fill}" fill-opacity="${opacity}"/>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="${BAR_H}" viewBox="0 0 ${BAR_W} ${BAR_H}">${cells.join('')}</svg>`
}

/** How many quarters of the heart are left: one per 25%, any health keeps one. */
const quartersOf = (left: number): number =>
  left <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil(left / 25)))

/** The heart with `kept` of its quarters filled, as one SVG document. */
export const heartSvg = (kept: number, fill: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 18">' +
  `<path d="${HEART}" fill="none" stroke="${fill}" stroke-opacity="0.55" stroke-width="1.2"/>` +
  // An id of its own per fill: two rows' hearts may share one document.
  `<clipPath id="hp${kept}">${QUADRANTS.slice(0, kept).join('')}</clipPath>` +
  `<path d="${HEART}" fill="${fill}" clip-path="url(#hp${kept})"/>` +
  '</svg>'

/**
 * Adds a reading to a bar's samples: a bar that went up started over, and
 * readings older than the pace window fall away.
 */
const sampled = (
  samples: UsageHpSample[],
  left: number,
  now: number,
): UsageHpSample[] => {
  const last = samples[samples.length - 1]
  const kept =
    last !== undefined && left > last.left
      ? []
      : samples.filter(one => now - one.at <= PACE_WINDOW)

  return [...kept, { at: now, left }].slice(-120)
}

/**
 * What the pace says: when the bar empties if the last hour's rate holds, or
 * that it outlasts its reset. Nothing while too little is known, or it is idle.
 */
const paceOf = (
  samples: UsageHpSample[],
  left: number,
  now: number,
  resetIn: number | null,
): string => {
  const first = samples[0]
  const last = samples[samples.length - 1]

  if (first === undefined || last === undefined || left <= 0) {
    return ''
  }

  // The rate is the samples' own; `left` may be a range's pessimistic end.
  const elapsed = now - first.at
  const drop = first.left - last.left

  if (elapsed < PACE_MIN || drop <= 0) {
    return ''
  }

  const emptyIn = (left / drop) * elapsed

  return resetIn !== null && emptyIn >= resetIn
    ? ' · lasts past reset'
    : ` · empty in ~${until(emptyIn)} at this pace`
}

/** A dollar figure for the row: whole dollars as entered, cents when it has them. */
const dollars = (usd: number): string =>
  Number.isInteger(usd) ? usd.toFixed(0) : usd.toFixed(2)

const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7)

const monthEnd = (now: number): number => {
  const date = new Date(now)

  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

/**
 * The spend range: the dashboard figure is exact, and only what came since is
 * estimated: the sessions' count scaled by the calibration, plus spend they
 * never saw at a rate a day. Time runs on an activity clock: a busy morning
 * has used up more of a typical day than the wall clock says.
 */
const rangeOf = (
  stored: StoredBudget,
  tally: number,
  { ratio, unseen, unseenHigh, spreadLow, spreadHigh, perDay, n, long }: Calibration,
  now: number,
): UsageHpBudget => {
  const month = monthOf(now)
  const isSameMonth = stored.month === month
  const base = isSameMonth ? stored.spentUsd : 0
  // A store from before entries kept their time counts from the month's start.
  const since = Math.max(stored.epoch ?? 0, Date.parse(`${month}-01T00:00:00Z`))
  // A day's spend lands in its working hours, not spread over all 24: the
  // allowance for it builds over UNSEEN_HOURS, then waits for the next day.
  const wall = Math.max(0, now - since) / DAY
  // Each whole day since, plus the day under way: its allowance builds over
  // its first UNSEEN_HOURS. Busy counted work moves the clock on too; a binge
  // day may count as more than one: wider, but warning early is the rule.
  const whole = Math.floor(wall)
  const days = Math.max(
    whole + Math.min(1, ((wall - whole) * 24) / UNSEEN_HOURS),
    perDay > 0 ? tally / perDay : 0,
  )
  const center = base + ratio * tally + unseen * days

  return {
    limitUsd: stored.limitUsd,
    baseUsd: base,
    spentUsd: center,
    // Unseen spend may be none: the low end counts only what the sessions saw.
    lowUsd: Math.max(base, base + (ratio - spreadLow) * tally),
    // Before two re-entries have shown what this seat spends unseen, allow a
    // share of the limit a day: a stranger's desktop chat is a guess.
    // Unseen spend comes in bursts, not a steady trickle: from the moment
    // after a figure, the high end allows at least a whole day's worst. With
    // nothing measured yet, a share of the limit a day stands in for it: by
    // days, not their square root, since unseen spend adds up by days.
    highUsd:
      base +
      (ratio + spreadHigh) * tally +
      Math.max(unseenHigh, (COLD_SHARE[long] ?? 0) * stored.limitUsd) * (now > since ? Math.max(1, days) : 0),
    resetsAt: monthEnd(now),
    // When the figure was really read, though the count runs from the month's turn.
    syncedAt: stored.epoch ?? since,
    syncs: n,
    ratio,
  }
}

const isStored = (value: unknown): value is StoredBudget =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as StoredBudget).limitUsd === 'number' &&
  Number.isFinite((value as StoredBudget).limitUsd) &&
  (value as StoredBudget).limitUsd > 0 &&
  typeof (value as StoredBudget).spentUsd === 'number' &&
  typeof (value as StoredBudget).month === 'string'

/** Removes every session's key: the limit was entered again, or cleared. */
const forget = async ($: EngineInterface, keep?: string): Promise<void> => {
  for (const key of await $.store.keys()) {
    const prefix = key.startsWith(SPEND) ? SPEND : key.startsWith(TRAIL) ? TRAIL : null

    // A session that entered the same figure a moment ago keeps what it wrote.
    if (prefix !== null && (keep === undefined || !key.startsWith(`${prefix}${keep}`))) {
      await $.store.delete(key)
    }
  }
}

/** Whether a key's `<epoch>:<month>:…` belongs to an entry or month before `tag`'s. */
const isOlderTag = (rest: string, tag: string): boolean => {
  const [epoch = '', month = ''] = rest.split(':')
  const [nowEpoch = '', nowMonth = ''] = tag.split(':')

  return month < nowMonth || (month === nowMonth && Number(epoch) < Number(nowEpoch))
}

/**
 * What the other sessions have added under `tag`, from the store; keys of an
 * earlier entry or month are removed on the way.
 */
const othersOf = async (
  $: EngineInterface,
  tag: string,
  own: string,
): Promise<number> => {
  let usd = 0

  for (const key of await $.store.keys()) {
    const prefix = key.startsWith(SPEND) ? SPEND : key.startsWith(TRAIL) ? TRAIL : null

    if (prefix === null || key === own) {
      continue
    }

    if (!key.startsWith(`${prefix}${tag}:`)) {
      // Only an older entry's or month's keys go: a session still holding an
      // earlier entry must not sweep away what a newer one has started.
      if (isOlderTag(key.slice(prefix.length), tag)) {
        await $.store.delete(key)
      }

      continue
    }

    if (prefix === TRAIL) {
      continue
    }

    const value = await $.store.get(key)
    usd += typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  return usd
}

const isCalibration = (value: unknown): value is UsageHpCalibration =>
  typeof value === 'object' &&
  value !== null &&
  Number.isFinite((value as UsageHpCalibration).est) &&
  Number.isFinite((value as UsageHpCalibration).real)

/** The intervals kept from earlier re-entries, oldest first. */
const calibrationsOf = async ($: EngineInterface): Promise<UsageHpCalibration[]> => {
  const kept: UsageHpCalibration[] = []

  for (const key of await $.store.keys()) {
    if (key.startsWith(CALIB)) {
      const value = await $.store.get(key)

      // Intervals counted at Claude Code's own prices measured a different
      // thing: only those counted at the official prices are kept.
      if (isCalibration(value) && value.basis === 'priced') {
        kept.push(value)
      }
    }
  }

  return kept.sort((a, b) => a.at - b.at).slice(-CALIB_KEEP)
}

/**
 * What the kept intervals say. Each is fitted as `real = ratio × counted +
 * unseen × days`: billing scales what the sessions count, while spend they
 * never saw (the desktop chat, a session without the mod) adds dollars a day.
 * A least-squares fit of both, held toward a ratio of 1 and no unseen spend
 * while few intervals are in hand. The high end allows the worst excess any
 * interval showed, as dollars a day; the low end the typical shortfall.
 */
type Calibration = {
  ratio: number
  unseen: number
  unseenHigh: number
  spreadLow: number
  spreadHigh: number
  /** What the sessions count on a typical day, for the activity clock; 0 unknown. */
  perDay: number
  n: number
  /** How many intervals were long enough to say a daily rate of unseen spend. */
  long: number
}

const calibrate = (intervals: UsageHpCalibration[]): Calibration => {
  const n = intervals.length
  const ordered = [...intervals].sort((a, b) => a.at - b.at)
  // Each interval's length in days, where its start is known.
  // An interval shorter than UNSEEN_MIN_SPAN says nothing of a daily rate: it
  // is fitted as all counted spend (no days), so it informs the ratio alone.
  const spans = ordered.map((one, index) => {
    const length = one.at - (one.from ?? ordered[index - 1]?.at ?? one.at)

    return { ...one, days: length >= UNSEEN_MIN_SPAN ? length / DAY : 0, wall: length / DAY }
  })

  if (n === 0) {
    return { ratio: 1, unseen: 0, unseenHigh: DRIFT_PER_DAY, spreadLow: SPREAD_BELOW, spreadHigh: SPREAD, perDay: 0, n, long: 0 }
  }

  // The fit, with two make-believe intervals at a ratio of 1 holding it there
  // while few are real: sums of squares and cross products.
  const pull = 2 / Math.max(1, n)
  const ee = spans.reduce((sum, one) => sum + one.est ** 2, 0)
  const prior = pull * Math.max(ee, 1)
  const es = spans.reduce((sum, one) => sum + one.est * one.days, 0)
  const ss = spans.reduce((sum, one) => sum + one.days ** 2, 0)
  const er = spans.reduce((sum, one) => sum + one.est * one.real, 0)
  const sr = spans.reduce((sum, one) => sum + one.days * one.real, 0)
  const det = (ee + prior) * ss - es * es
  let ratio = 1
  let unseen = 0

  if (ss > 0 && det > 1e-9) {
    ratio = ((er + prior) * ss - es * sr) / det
    unseen = ((ee + prior) * sr - es * (er + prior)) / det
  }

  // No negative unseen spend, and a ratio within bounds: refit the other.
  if (unseen < 0 || ss === 0 || det <= 1e-9) {
    unseen = 0
    const all = ordered.reduce((sum, one) => sum + one.est * one.real, 0)
    const squares = ordered.reduce((sum, one) => sum + one.est ** 2, 0)
    ratio = (all + pull * Math.max(squares, 1)) / (squares + pull * Math.max(squares, 1))
  }

  if (ratio < RATIO_MIN || ratio > RATIO_MAX) {
    ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio))
    unseen = ss > 0 ? Math.max(0, spans.reduce((sum, one) => sum + one.days * (one.real - ratio * one.est), 0) / ss) : 0
  }

  // What the fit left: past it per day for the high end (the worst interval
  // long enough to say), short of it as a share of the count for the low.
  const excess = spans
    .filter(one => one.days > 0)
    // A gap of several days is charged as one day's burst, not a rate spread
    // thin over all of them: unseen spend comes in lumps.
    .map(one => Math.max(0, one.real - ratio * one.est - unseen * one.days) / Math.min(one.days, 1))
  const unseenHigh = Math.max(DRIFT_PER_DAY, unseen + Math.max(0, ...excess))
  const shortfall = ordered
    .filter(one => one.est > 0)
    .map(one => ({ miss: Math.max(0, ratio * one.est - one.real) / one.est, weight: one.est }))
    .sort((a, b) => a.miss - b.miss)
  const half = shortfall.reduce((sum, one) => sum + one.weight, 0) / 2
  let seen = 0
  const typical = shortfall.find(one => (seen += one.weight) >= half)?.miss ?? 0
  // A typical day's count averages over every interval's whole length, the
  // short ones included: those are the working hours between two entries on
  // one day, and leaving them out left only the overnight gaps, which made a
  // day look idle and an afternoon's work look like days of it.
  const spanned = spans.reduce((sum, one) => sum + one.wall, 0)

  return {
    ratio,
    unseen,
    unseenHigh,
    spreadLow: Math.max(n < 3 ? SPREAD_BELOW : SPREAD_MIN, typical),
    // What the sessions count is priced call by call: above it, only the
    // ratio's own uncertainty while it is young.
    spreadHigh: n < 3 ? SPREAD : SPREAD_MIN / 3,
    perDay: spanned >= 1 ? spans.filter(one => one.wall > 0).reduce((sum, one) => sum + one.est, 0) / spanned : 0,
    n,
    long: spans.filter(one => one.days > 0).length,
  }
}

/** A dollar range for the row: whole dollars outward, or the figure when it is narrow. */
const dollarRange = (low: number, high: number, point: number): string => {
  // Past the limit, what is left reads as none rather than a negative.
  const [from, to, at] = [low, high, point].map(one => Math.max(0, one)) as [number, number, number]

  return to - from < 1 ? at.toFixed(2) : `${Math.floor(from)}–${Math.ceil(to)}`
}

/**
 * Reads the engine's figures and the entered limit, writes what this session
 * has spent toward that limit under the session's own key, and publishes it
 * all to draw.
 */
/**
 * `isRead` marks an entry of a figure read before now (the routine's sync
 * file): this session's spend after it was read is not in it.
 */
const refresh = async ($: EngineInterface, cause: Cause, isRead = false): Promise<void> => {
  const usage = await $.session.usage()
  const now = await $.clock.now()
  // Claude Code's own figure, as /usage shows it; and, for a session priced
  // call by call, the same at the official prices, which is what it counts.
  const engineUsd = usage.cost?.usd ?? null
  const { value: basis = 'engine' } = await $.state.get(BASIS)
  // Claude Code's total holds calls no turn shows (titles, summaries): what
  // it counted beyond the turns, at its own prices, is added as it stands.
  // Every session's calls are priced both ways as they come, whichever
  // basis it counts on.
  const both = await pricedOf($, await $.session.id(), now)
  const priced = basis === 'priced' ? both : null
  const pricedUsd =
    priced === null
      ? null
      : priced.usd + Math.max(0, (engineUsd ?? priced.engine) - priced.engine)
  const usd = pricedUsd ?? engineUsd
  const windows = usage.rateLimits.map(one => ({ ...one }))
  const { value: before } = await $.state.get(READING)
  const { value: counted } = await $.state.get(COUNTED)
  const { value: wasSeen = false } = await $.state.get(SEEN)
  const isSeen = wasSeen || windows.length > 0
  const at = cause === 'start' ? (before?.at ?? null) : now
  const stored = await $.store.get(BUDGET)
  let budget: UsageHpBudget | null = null

  if (isSeen !== wasSeen) {
    await $.state.set(SEEN, isSeen)

    // Calls written before the engine first reported this session's limits
    // were a subscription seat's: they leave the ledger.
    // So do its spend keys, which every other session would add up.
    if (isSeen) {
      const session = await $.session.id()

      for (const key of await $.store.keys()) {
        const isDay = key.startsWith(DAY_KEY) && key.split(':')[2] === session
        const isSpend = (key.startsWith(SPEND) || key.startsWith(TRAIL)) && key.endsWith(`:${session}`)

        if (isDay || isSpend) {
          await $.store.delete(key)
        }
      }
    }
  }

  // The entered limit is for sessions the engine reports no limit for, and
  // which one that is shows only once a reply has come back.
  if (isStored(stored) && !isSeen && at !== null) {
    const month = monthOf(now)
    const epoch = stored.epoch ?? 0
    const tag = `${epoch}:${month}`
    const own = `${SPEND}${tag}:${await $.session.id()}`
    const { value: held = null } = await $.state.get(LEDGER)
    let ledger: UsageHpLedger | null = held
    let mine = 0

    if (usd !== null) {
      // An entry made just now holds this session's cost so far, whatever the tag.
      if (ledger === null || ledger.tag !== tag || cause === 'command') {
        // What the session cost before this entry or month is not its to add.
        // A figure read off the dashboard a while ago (a sync file) holds only
        // what was spent by then: when a reading came after it, the count
        // starts from the last reading at or before it. Otherwise from the
        // cost now for an entry made here, or from the last reading (all of
        // it for a session older than the entry that kept none).
        // In a month after the entry's, the count starts at the month's turn:
        // what the session spent before it belongs to the month before.
        const cut = Math.max(epoch, Date.parse(`${month}-01T00:00:00Z`))
        const { value: costs = [] } = await $.state.get(COSTS)
        const isPast = costs.some(one => one.at > cut)
        const atEntry = [...costs].reverse().find(one => one.at <= cut)
        // A figure read before now (the routine's, picked up at the end of a
        // later turn) holds nothing this session spent after it was read:
        // that turn's spend counts from the last reading at or before it.
        const isEarlier = cause === 'command' && isRead
        const baseUsd = isPast || isEarlier
          ? (atEntry?.usd ??
            // Every reading this session kept came after the cut: it had
            // counted nothing before it (a turn under way then lands after).
            (usage.startedAt >= cut || (costs[0] !== undefined && costs[0].at > cut) ? 0 : (counted ?? usd)))
          : cause === 'command'
            ? usd
            : (counted ?? (usage.startedAt >= cut ? 0 : usd))
        // A key this session already wrote (before a restart lost its
        // state) carries on from where it stood.
        const written = await $.store.get(own)
        const already = typeof written === 'number' ? written : 0
        ledger = {
          tag,
          baseUsd:
            cause === 'command'
              ? baseUsd
              : Math.min(baseUsd, (counted ?? usd) - already),
        }
        await $.state.set(LEDGER, ledger)
      }

      // A session counting at Claude Code's own prices adds in official
      // dollars too, scaled by what its calls cost each way: every key the
      // calibration sums is then in the same money.
      const official = basis === 'engine' && both.engine > 0 ? Math.min(1, Math.max(0.5, both.usd / both.engine)) : 1
      mine = Math.max(0, usd - ledger.baseUsd) * official

      if ((await $.store.get(own)) !== mine) {
        await $.store.set(own, mine)

        const trailKey = `${TRAIL}${own.slice(SPEND.length)}`
        const trail = await $.store.get(trailKey)
        // Two days, and the newest reading before them: a figure read after a
        // quiet weekend still finds what this session had added by then.
        // The anchor has a slot of its own: the cap trims the recent ones.
        const held = Array.isArray(trail) ? (trail as UsageHpCost[]) : []
        const anchor = held.filter(one => now - one.at >= 2 * DAY).slice(-1)
        const recent = [...held.filter(one => now - one.at < 2 * DAY), { at: now, usd: mine }]
        await $.store.set(trailKey, [...anchor, ...recent.slice(-99)])
      }
    }

    const { value: cached = null } = await $.state.get(OTHERS)
    let others: UsageHpOthers | null = cached

    if (
      others === null ||
      others.tag !== tag ||
      now - others.at >= OTHERS_TTL
    ) {
      others = { tag, usd: await othersOf($, tag, own), at: now }
      await $.state.set(OTHERS, others)
    }

    budget = await withBurn(
      $,
      rangeOf(stored, others.usd + mine, calibrate(await calibrationsOf($)), now),
      now,
    )
  }

  if (usd !== null) {
    await $.state.set(COUNTED, usd)
    const { value: costs = [] } = await $.state.get(COSTS)

    if (costs[costs.length - 1]?.usd !== usd) {
      // Two days are kept, and the newest reading before them: a figure read
      // after a quiet weekend still finds where this session's count stood.
      const recent = costs.filter(one => now - one.at < 2 * DAY)
      const before = costs.filter(one => now - one.at >= 2 * DAY).slice(-1)
      await $.state.set(COSTS, [...before, ...[...recent, { at: now, usd }].slice(-199)])
    }
  }

  const { value: samples = {} } = await $.state.get(SAMPLES)
  const lefts: Record<string, number> = {}

  for (const one of windows) {
    lefts[one.kind] = 100 - one.percentUsed
  }

  if (windows.length === 0 && budget !== null) {
    lefts[BUDGET] = ((budget.limitUsd - budget.spentUsd) / budget.limitUsd) * 100
  }

  const kept: Record<string, UsageHpSample[]> = {}

  for (const kind of Object.keys(lefts)) {
    // An entry made just now is no drop to read a pace from: it starts over.
    const past = cause === 'command' && kind === BUDGET ? [] : samples[kind]
    kept[kind] = sampled(past ?? [], lefts[kind] ?? 0, now)
  }

  await $.state.set(SAMPLES, kept)

  // Each bar's colour, carried from one reading to the next for the hysteresis.
  const { value: colors = {} } = await $.state.get(COLORS)
  const worst: Record<string, number> = { ...lefts }

  if (lefts[BUDGET] !== undefined && budget !== null) {
    worst[BUDGET] = ((budget.limitUsd - budget.highUsd) / budget.limitUsd) * 100
  }

  await $.state.set(
    COLORS,
    Object.fromEntries(
      Object.entries(worst).map(([kind, left]) => [kind, colorOf(left, colors[kind] as Color | undefined)]),
    ),
  )

  const style = await $.store.get(STYLE)
  await $.state.set(SHOWN, isStyle(style) ? style : 'bar')
  await $.state.set(HIDDEN, (await $.store.get(HIDE)) === true)

  const reading: UsageHpReading = { windows, usd: engineUsd, pricedUsd, budget, at }
  await $.state.set(READING, reading)
}

/**
 * Drops what the ledger and the resync log hold from before the last
 * LEDGER_DAYS days: the mod keeps a week, no more.
 */
const pruneLedger = async ($: EngineInterface, now: number): Promise<void> => {
  const oldest = dayOf(now - LEDGER_DAYS * DAY)

  for (const key of await $.store.keys()) {
    if (
      (key.startsWith(DAY_KEY) && key.slice(DAY_KEY.length, DAY_KEY.length + 10) < oldest) ||
      (key.startsWith(SYNC_KEY) && Number(key.slice(SYNC_KEY.length)) < now - (LEDGER_DAYS + 1) * DAY)
    ) {
      await $.store.delete(key)
    }
  }
}

/**
 * The budget with its daily burn in dashboard dollars: the resync log's where
 * it has a day's span, else the ledger's week scaled by the calibration.
 */
const withBurn = async (
  $: EngineInterface,
  budget: UsageHpBudget,
  now: number,
): Promise<UsageHpBudget> => {
  const fromSyncs = await syncBurnOf($, now)
  const fromLedger = fromSyncs === null ? await burnOf($, now) : null

  return {
    ...budget,
    burnUsd: fromSyncs ?? (fromLedger === null ? null : fromLedger * budget.ratio),
  }
}

/**
 * What the dashboard says is spent a day: the resync log's first and last
 * figures this month within the week, read at least a day apart. It holds
 * everything, spend the mod never sees included. Null without such a pair.
 */
const syncBurnOf = async ($: EngineInterface, now: number): Promise<number | null> => {
  const month = monthOf(now)
  const held: UsageHpSync[] = []

  for (const key of await $.store.keys()) {
    const value = key.startsWith(SYNC_KEY) ? await $.store.get(key) : null

    if (
      typeof value === 'object' &&
      value !== null &&
      Number.isFinite((value as UsageHpSync).at) &&
      Number.isFinite((value as UsageHpSync).spentUsd) &&
      now - (value as UsageHpSync).at <= (LEDGER_DAYS + 1) * DAY &&
      monthOf((value as UsageHpSync).at) === month
    ) {
      held.push(value as UsageHpSync)
    }
  }

  held.sort((a, b) => a.at - b.at)
  const first = held[0]
  const last = held[held.length - 1]

  return first === undefined || last === undefined || last.at - first.at < DAY || last.spentUsd <= first.spentUsd
    ? null
    : ((last.spentUsd - first.spentUsd) / (last.at - first.at)) * DAY
}

/**
 * What the sessions spend a day, from the ledger: its week's total over the
 * time from the first day it holds to now. Null until it holds a full day
 * before today, when an hour's pace is all there is.
 */
const burnOf = async ($: EngineInterface, now: number): Promise<number | null> => {
  const today = dayOf(now)
  const oldest = dayOf(now - (LEDGER_DAYS - 1) * DAY)
  let first = today
  let total = 0

  for (const key of await $.store.keys()) {
    const day = key.startsWith(DAY_KEY) ? key.slice(DAY_KEY.length, DAY_KEY.length + 10) : null

    if (day === null || day < oldest) {
      continue
    }

    const value = await $.store.get(key)
    total += typeof value === 'number' && Number.isFinite(value) ? value : 0
    first = day < first ? day : first
  }

  return first === today ? null : (total / (now - midnightOf(first))) * DAY
}

/** Keeps one figure entered in the resync log, with when it was read and entered. */
const logSync = async ($: EngineInterface, sync: UsageHpSync): Promise<void> => {
  await $.store.set(`${SYNC_KEY}${sync.at}`, sync)
}

/**
 * Enters a figure from the dashboard, read at `at`: a re-entry in the same
 * month first keeps what the sessions counted against it, then every session
 * counts afresh from it. Says what the calibration learned, if anything.
 */
const enter = async (
  $: EngineInterface,
  spent: number,
  limit: number,
  at: number,
  source: UsageHpSync['source'],
  readAt = at,
): Promise<string> => {
  const prior = await $.store.get(BUDGET)
  let learned = ''
  let measured: { est: number; real: number } | null = null

  // A re-entry in the same month is a measurement: what the sessions
  // counted since the last entry, against what the dashboard now says.
  if (isStored(prior) && prior.month === monthOf(at) && prior.epoch !== undefined) {
    // This session's key first, so the count holds its latest turn.
    await queueRefresh($, 'turn')
    // What each session had added by `at`: from its trail where it keeps
    // one, else its key as it stands.
    const tag = `${prior.epoch}:${prior.month}:`
    const counts = new Map<string, number>()

    for (const key of await $.store.keys()) {
      if (key.startsWith(`${SPEND}${tag}`)) {
        const value = await $.store.get(key)

        if (typeof value === 'number' && Number.isFinite(value)) {
          counts.set(key.slice(`${SPEND}${tag}`.length), value)
        }
      }
    }

    for (const id of counts.keys()) {
      const trail = await $.store.get(`${TRAIL}${tag}${id}`)

      if (Array.isArray(trail) && trail.length > 0) {
        const byThen = [...(trail as UsageHpCost[])].reverse().find(one => one.at <= at)
        counts.set(id, byThen?.usd ?? 0)
      }
    }

    const est = [...counts.values()].reduce((sum, one) => sum + one, 0)

    const real = spent - prior.spentUsd
    measured = { est, real }

    if (est >= CALIB_MIN && real >= 0) {
      await $.store.set(`${CALIB}${at}`, { est, real, at, from: prior.epoch, basis: 'priced' })
      const intervals = await calibrationsOf($)

      for (const key of await $.store.keys()) {
        const value = key.startsWith(CALIB) ? await $.store.get(key) : null

        // Only the most recent intervals are kept: billing and habits drift.
        if (isCalibration(value) && value.at < intervals[0]!.at) {
          await $.store.delete(key)
        }
      }

      const { ratio, unseen, n } = calibrate(intervals)
      learned = ` Sessions counted $${est.toFixed(2)} since the last entry against $${real.toFixed(2)} on the dashboard; from ${n} re-entr${n === 1 ? 'y' : 'ies'}, the estimate now scales counted spend by ${ratio.toFixed(2)} and adds $${unseen.toFixed(2)} a day the sessions do not see.`
    }
  }

  const entered: StoredBudget = {
    limitUsd: limit,
    spentUsd: spent,
    month: monthOf(at),
    epoch: at,
    ...(readAt > at ? { readAt } : {}),
  }
  // Another session may have entered a newer figure while this one worked:
  // the newer stands.
  const latest = await $.store.get(BUDGET)

  if (isStored(latest) && (latest.epoch ?? 0) > at) {
    return learned
  }

  // The figure entered holds everything spent so far: the sessions' own
  // counts start over from it.
  await forget($, `${at}:`)
  await $.store.set(BUDGET, entered)
  await $.state.set(OTHERS, null)
  await logSync($, { at, enteredAt: await $.clock.now(), spentUsd: spent, limitUsd: limit, source, ...measured })
  await queueRefresh($, 'command', source === 'file')

  return learned
}

type SyncFile = { spentUsd: number; limitUsd: number; at: number }

const isSyncFile = (value: unknown): value is SyncFile =>
  typeof value === 'object' &&
  value !== null &&
  Number.isFinite((value as SyncFile).spentUsd) &&
  (value as SyncFile).spentUsd >= 0 &&
  Number.isFinite((value as SyncFile).limitUsd) &&
  (value as SyncFile).limitUsd > 0 &&
  Number.isFinite((value as SyncFile).at)

/**
 * Enters a dashboard figure left in the sync file, once: only where a limit
 * was set with /hp (so /hp off stays off), only a figure newer than the one
 * held, and only one from this month.
 */
const synced = async ($: EngineInterface): Promise<void> => {
  let file: unknown

  // Any refusal on the way (no HOME, a filesystem hook, a bad file) leaves the
  // bar as it is: the sync is a convenience, never a reason to stop counting.
  try {
    const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
    const home = await $.env.get('HOME')
    const dir = configDir ?? (home === undefined ? undefined : `${home}/.claude`)

    if (dir === undefined || !(await $.fs.exists(`${dir}/${SYNC_FILE}`))) {
      return
    }

    file = JSON.parse(String(await $.fs.read(`${dir}/${SYNC_FILE}`)))
  } catch {
    return
  }

  const prior = await $.store.get(BUDGET)
  const now = await $.clock.now()

  if (
    !isSyncFile(file) ||
    !isStored(prior) ||
    file.at <= (prior.readAt ?? prior.epoch ?? 0) ||
    // A few minutes ahead is the other machine's clock, not the future.
    file.at > now + SKEW ||
    monthOf(file.at) !== monthOf(now)
  ) {
    return
  }

  await enter($, file.spentUsd, file.limitUsd, Math.min(file.at, now), 'file', file.at)
}

/** The quiet-session re-read the band last drew, and when; reused between redraws. */
let quietRange: { at: number; ident: string; budget: Promise<UsageHpBudget | null> } | null = null

/**
 * Work that reads and writes the spend figures (a refresh at a turn end, a measure, a
 * command; a step's ledger write) runs one piece at a time: a refresh that finds a
 * subscription seat clears the ledger, and no step's write may land in the middle.
 * A piece that fails hands the chain on to the next.
 */
let refreshing: Promise<void> = Promise.resolve()

const inTurn = ($: EngineInterface, work: () => Promise<void>): Promise<void> => {
  const run = refreshing.then(work)
  refreshing = run.catch(() => undefined)

  return run
}

const queueRefresh = ($: EngineInterface, cause: Cause, isRead = false): Promise<void> =>
  inTurn($, () => refresh($, cause, isRead))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hp',
      description:
        'HP bar: /hp <limit> or /hp <spent> <limit> sets the monthly spend limit, /hp off clears it, /hp style bar|used|hearts|text picks the look, /hp hide and /hp show turn the row off and on',
    })
    // The time to reset moves with the clock, not with any state write.
    $.clock.every(TICK, () => $.ui.invalidate('ui.render'))

    // A session the mod sees from its first call is priced call by call; one
    // it joined after spending (a reload, an upgrade) keeps Claude Code's figure.
    const { value: held } = await $.state.get(BASIS)

    if (held === undefined) {
      const spent = (await $.session.usage()).cost?.usd ?? 0
      const basis: UsageHpBasis = spent < 0.005 ? 'priced' : 'engine'
      await $.state.set(BASIS, basis)
    }

    // Each named literally: the engine lists what a module reads. A refused
    // read leaves the setup line as it was.
    let isMetered = false

    try {
      isMetered = [
        await $.env.get('ANTHROPIC_API_KEY'),
        await $.env.get('CLAUDE_CODE_USE_BEDROCK'),
        await $.env.get('CLAUDE_CODE_USE_VERTEX'),
        await $.env.get('CLAUDE_CODE_USE_FOUNDRY'),
      ].some(Boolean)
    } catch {
      isMetered = false
    }

    await $.state.set(METERED, isMetered)
    // A sync file waits for the first finished turn: before a reply, the
    // engine has not said whether this session has limits of its own.
    await queueRefresh($, 'start')
    await pruneLedger($, await $.clock.now())

    return next(e)
  })

  // A limit window moved (a whole point, appeared or left) mid-turn: read it now,
  // not at the turn's end. Cost and context alone wait for the turn end.
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)

    if (e.changed.includes('rateLimits')) {
      // At a turn end the turn's own refresh may already hold these figures: a second
      // read would only add a duplicate pace sample.
      const { value: reading } = await $.state.get(READING)
      const held = reading?.windows ?? []
      const isHeld =
        held.length === e.rateLimits.length &&
        e.rateLimits.every(w => held.some(r => r.kind === w.kind && Math.floor(r.percentUsed) === Math.floor(w.percentUsed)))

      if (!isHeld) {
        await queueRefresh($, 'turn')
      }
    }

    return measured
  }).catch(($, e, next) => next(e))

  // Each finished turn moves the figures: read them again.
  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)

    if (e.agentId === undefined) {
      await synced($)
      await queueRefresh($, 'turn')
    }

    return answer
  })

  // Every call, the main thread's and each subagent's, priced by the model
  // that answered it, under that agent's own key.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)

    if (result.usage !== null) {
      const usd = priceOf(result.usage)
      const engine = priceOf(result.usage, ENGINE_PRICES)
      const key = `${PRICED}${await $.session.id()}:${e.agentId ?? 'main'}`
      const held = await $.store.get(key)
      const prior = isPriced(held) ? held : { usd: 0, engine: 0, unknown: 0, at: 0 }
      await $.store.set(key, {
        usd: prior.usd + (usd ?? 0),
        engine: (prior.engine ?? 0) + (engine ?? 0),
        unknown: prior.unknown + (usd === null ? 1 : 0),
        at: await $.clock.now(),
      })
      // The ledger: the same call under this session's key for today. A model
      // with no official price goes in at Claude Code's. Only a session the
      // engine reports no limits for spends the entered budget: one on a
      // subscription seat (it has its own limits) is never written.
      // On the spend chain: a refresh that finds a subscription seat mid-turn clears the
      // ledger, and this write must land before that clearing or not at all.
      await inTurn($, async () => {
        const { value: isSeen = false } = await $.state.get(SEEN)

        if (!isSeen && (await $.session.usage()).rateLimits.length === 0 && isStored(await $.store.get(BUDGET))) {
          // One key per agent too: an agent's calls come one after another,
          // while two agents of a session may finish at once.
          const dayKey = `${DAY_KEY}${dayOf(await $.clock.now())}:${await $.session.id()}:${e.agentId ?? 'main'}`
          const day = await $.store.get(dayKey)
          await $.store.set(
            dayKey,
            (typeof day === 'number' && Number.isFinite(day) ? day : 0) + (usd ?? engine ?? 0),
          )
        }
      }).catch(() => undefined)
    }

    return result
  })

  on('command.run', { command: 'hp' }, async ($, e) => {
    const args = e.args.trim()

    if (args === 'hide' || args === 'show') {
      await $.store.set(HIDE, args === 'hide')
      await $.state.set(HIDDEN, args === 'hide')

      return {
        text:
          args === 'hide'
            ? 'HP row hidden; usage is still tracked. /hp show brings it back.'
            : 'HP row shown.',
      }
    }

    if (args === 'style' || args.startsWith('style ')) {
      const style = args.slice('style'.length).trim()

      if (!isStyle(style)) {
        return {
          text: 'Usage: /hp style bar (drains from full), /hp style used (fills as you spend), /hp style hearts (a row of hearts), /hp style text (figures only).',
        }
      }

      await $.store.set(STYLE, style)
      await $.state.set(SHOWN, style)

      return { text: `HP style: ${style}. Other open sessions pick it up after their next reply.` }
    }

    if (args === 'off') {
      await $.store.delete(BUDGET)
      await forget($)
      await queueRefresh($, 'command')

      return { text: 'Spend limit cleared.' }
    }

    // `/hp 300` is the whole setup: the limit alone, spend starting at zero.
    // `/hp 12.21 300` adds what is already spent this month.
    const figures = args
      .split(/\s+/)
      .filter(Boolean)
      .map(one =>
        // `47,53` is a decimal comma; `1,234.50` a thousands separator.
        Number(/^\$?\d+,\d{1,2}$/.test(one) ? one.replace('$', '').replace(',', '.') : one.replace(/[$,]/g, '')),
      )
    const [spent, limit] =
      figures.length === 1 ? [0, figures[0]] : [figures[0], figures[1]]

    if (
      figures.length > 2 ||
      spent === undefined ||
      limit === undefined ||
      !Number.isFinite(spent) ||
      !Number.isFinite(limit) ||
      spent < 0 ||
      limit <= 0
    ) {
      return {
        text: 'Usage: /hp <spent> <limit>, the two figures Settings › Usage shows, as in /hp 12.21 300. At the very start of a month, /hp <limit> alone. /hp off clears it. /hp style bar|used|hearts|text picks the look. /hp hide and /hp show turn the row off and on.',
      }
    }

    const isFirst = !isStored(await $.store.get(BUDGET))
    const { value: isSeen = false } = await $.state.get(SEEN)
    // A session with limits of its own draws those, never this one.
    const seat = isSeen
      ? ' This session reports usage limits of its own, so it shows those; sessions that report none show this limit.'
      : ''
    const learned = await enter($, spent, limit, await $.clock.now(), 'command')
    // The first entry is the moment to say the figure can arrive by itself.
    const routine = isFirst
      ? ' To keep the range tight without typing figures, a figure can also arrive through the sync file (README › Sync file).'
      : ''

    return {
      text: `Tracking $${spent.toFixed(2)} of $${limit.toFixed(2)} spent this month; sessions add their cost from here.${figures.length === 1 ? ' That assumes nothing is spent yet this month: if some is, enter /hp <spent> <limit> from Settings › Usage.' : ''}${learned}${routine}${seat}`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever another mod draws in the band stays, above this one's rows.
    const beneath = await next(e)

    const { value: isHidden = false } = await $.state.get(HIDDEN)

    if (e.props.hasSurvey || isHidden) {
      return beneath
    }

    const { value: isMetered = false } = await $.state.get(METERED)

    const { Box, Text } = $.ui.resolve(e)
    const { Svg } = $.ui.resolve({ ...e, surface: 'desktop' })
    const { value: reading } = await $.state.get(READING)
    const { value: samples = {} } = await $.state.get(SAMPLES)
    const { value: style = 'bar' } = await $.state.get(SHOWN)
    const now = await $.clock.now()
    const age = reading?.at == null ? 0 : now - reading.at
    const usd = reading?.usd ?? null
    const spent = usd === null ? '' : ` · $${usd.toFixed(2)} this session`
    const { value: colors = {} } = await $.state.get(COLORS)
    let budget = reading?.budget ?? null
    // Quiet a while: the other sessions' counts are read again, so the spend
    // row keeps up without a turn here.
    const isFresh =
      budget !== null && (reading?.windows ?? []).length === 0 && age > OTHERS_TTL

    if (isFresh) {
      // A limit cleared elsewhere (/hp off) clears the row here too: one read, every redraw.
      const stored = await $.store.get(BUDGET)

      if (!isStored(stored)) {
        budget = null
        quietRange = null
      } else {
        // The full re-read scans the store several times: at most once per OTHERS_TTL,
        // and at once when the entered figure or the month changes. Redraws in between,
        // and redraws that arrive while one is reading, share it. (A newer reading of
        // this session is under OTHERS_TTL old, so this path waits for the cache to age.)
        const ident = JSON.stringify([stored.epoch ?? 0, stored.spentUsd, stored.limitUsd, monthOf(now)])
        const cached = quietRange
        const isCurrent = cached !== null && now - cached.at < OTHERS_TTL && cached.ident === ident

        if (!isCurrent) {
          quietRange = { at: now, ident, budget: freshRange($, now).catch(() => null) }
        }

        budget = (await quietRange!.budget) ?? budget
      }
    }

    // The age line is for figures that only a turn here refreshes.
    const asOf = age > STALE && !isFresh ? ` · as of ${until(age)} ago` : ''
    type Bar = {
      /** Its kind: the colour carried between readings is kept under it. */
      key: string
      label: string
      left: number
      detail: string
      isReset: boolean
      /** Where a range runs, % left from its pessimistic to its optimistic end. */
      range?: [number, number]
    }
    const bars: Bar[] = (reading?.windows ?? []).map(one => {
      const left = 100 - one.percentUsed
      const resetIn =
        one.resetsAt === undefined ? null : Date.parse(one.resetsAt) - now

      // The window ended while nothing was sent: it is full again, and the
      // engine says so with the next reply.
      if (resetIn !== null && resetIn <= 0) {
        return {
          key: one.kind,
          label: LABELS[one.kind] ?? one.kind,
          left: 100,
          detail: ' · window reset',
          isReset: true,
        }
      }

      return {
        key: one.kind,
        label: LABELS[one.kind] ?? one.kind,
        left,
        isReset: false,
        detail:
          (resetIn === null ? '' : ` · resets in ${untilReset(resetIn)}`) +
          paceOf(samples[one.kind] ?? [], left, now, resetIn),
      }
    })

    let spendPace = ''
    let spendReset = ''

    // No limit from the engine: the one the person entered stands in, as a
    // range: the spend is somewhere between low and high.
    if (bars.length === 0 && budget !== null) {
      const limit = budget.limitUsd
      const low = budget.lowUsd ?? budget.spentUsd
      const high = budget.highUsd ?? budget.spentUsd
      const center = budget.spentUsd
      const resetIn = budget.resetsAt - now
      // Colour, heart and pace follow the pessimistic end: warn early, never late.
      const worst = ((limit - high) / limit) * 100
      bars.push({
        key: BUDGET,
        label: 'SPEND',
        left: worst,
        ...(high - low < 1
          ? {}
          : { range: [((limit - high) / limit) * 100, ((limit - low) / limit) * 100] as [number, number] }),
        isReset: false,
        // The first line holds the money alone; the rest goes beneath.
        detail:
          style === 'used'
            ? ` · $${dollarRange(low, high, center)} / $${dollars(limit)}`
            : ` · $${dollarRange(limit - high, limit - low, limit - center)} left of $${dollars(limit)}`,
      })
      // The resync log's or the ledger's week paces the month better than the
      // last hour does.
      const burn = budget.burnUsd ?? 0
      spendPace = (
        burn > 0
          ? resetIn !== null && ((limit - high) / burn) * DAY >= resetIn
            ? ' · lasts past reset'
            : ` · empty in ~${until(Math.max(0, ((limit - high) / burn) * DAY))} at this pace`
          : paceOf(samples[BUDGET] ?? [], worst, now, resetIn)
      ).replace(/^ · /, '')
      spendReset = `resets in ${untilReset(resetIn)}`
    }

    const width = Math.max(0, ...bars.map(bar => bar.label.length))
    // What every row shares goes on one line beneath them, said once.
    const synced = budget === null || spendReset === '' ? null : now - budget.syncedAt
    // The line beneath: this session's cost first and bold, then what the
    // rows share, and the spend's reset and sync age last.
    // Once a re-entry has calibrated it, what the session likely costs on the bill.
    // Priced call by call, the official figure is the bill's own; else
    // Claude Code's figure scaled by what the re-entries showed.
    const pricedUsd = reading?.pricedUsd ?? null
    const billed =
      usd === null || spendReset === '' || budget === null
        ? ''
        : pricedUsd !== null
          ? ` (~$${(pricedUsd * budget.ratio).toFixed(2)} billed)`
          : budget.syncs > 0
            ? ` (~$${(usd * budget.ratio).toFixed(2)} billed)`
            : ''
    const lead = usd === null ? '' : `$${usd.toFixed(2)} this session${billed}`
    const middle = [
      spendPace,
      bars.some(bar => bar.isReset) ? 'reset windows refill on your next reply' : '',
      asOf.replace(/^ · /, ''),
    ].filter(Boolean)
    const last = [
      spendReset,
      // How old the dashboard figure is: the range's width comes from that.
      synced === null || synced < 60 * 60_000 || budget === null
        ? ''
        : `synced ${until(synced)} ago (${stamp(budget.syncedAt, now)})`,
    ].filter(Boolean)
    const footer = [lead, ...middle, ...last].filter(Boolean)
    // A stale entry or a wide range: a fresh figure from the dashboard tightens it.
    const resync =
      budget !== null && synced !== null && needsResync(budget, synced)
        ? ` · re-sync: /hp <spent> ${dollars(budget.limitUsd)}`
        : ''

    return (
      <Box flexDirection="column">
        {beneath}
        {bars.length === 0 && !(isMetered && budget === null) && (
          <Box>
            <Text color="magenta" bold>
              ♥ HP
            </Text>
            <Text dimColor wrap="truncate-end">
              {reading?.at == null
                ? ' waiting for the first reply'
                : ` no usage limit reported${spent} · enter what Settings › Usage shows: /hp <spent> <limit>, e.g. /hp 47.53 300`}
            </Text>
          </Box>
        )}
        {bars.map(bar => {
          const left = Math.max(0, Math.min(100, bar.left))
          const used = 100 - left
          // The cells still lit: a twentieth each, and any health keeps one.
          // `used` lights the rest, so the two styles are exact complements
          // rather than each rounding its own half-cell up.
          const lit = left === 0 ? 0 : Math.max(1, Math.round((left / 100) * CELLS))
          let full = style === 'used' ? CELLS - lit : lit
          let ghost = 0
          let percent = `${Math.round(style === 'used' ? used : left)}%`.padStart(4)

          // A range lights the cells it is sure of, half-lights the ones it
          // runs across (at least one, so the doubt always shows), and says
          // its ends in whole percent, outward.
          if (bar.range !== undefined) {
            const [worst, best] = bar.range.map(one => Math.max(0, Math.min(100, one))) as [number, number]
            const [from, to] = style === 'used' ? [100 - best, 100 - worst] : [worst, best]
            full = Math.min(CELLS - 1, Math.floor((from / 100) * CELLS))
            ghost = Math.max(1, Math.ceil((to / 100) * CELLS) - full)
            const [lo, hi] = [Math.floor(from), Math.ceil(to)]
            percent = lo === hi ? `${lo}%` : `${lo}–${hi}%`
          }

          const color = colorOf(left, colors[bar.key] as Color | undefined)
          // The skull waits until even the hopeful end is spent.
          const quarters = Math.max(
            quartersOf(left),
            bar.range !== undefined && bar.range[1] > 0 ? 1 : 0,
          )
          const row = rowQuartersOf(left)
          const whole = Math.floor(row / 4)
          const hasPart = row % 4 > 0

          return (
            <Box flexDirection="row" alignItems="center">
              <Box flexShrink={0}>
                {quarters === 0 ? (
                  <Text color="red" bold>
                    ☠
                  </Text>
                ) : e.surface === 'desktop' ? (
                  <Svg
                    source={heartSvg(quarters, FILLS[color])}
                    alt={`${quarters} of 4 heart quarters left`}
                    width={14}
                    height={14}
                  />
                ) : (
                  <Text color={color} bold>
                    {quarters > 2 ? '♥' : '♡'}
                  </Text>
                )}
                <Text color={color} bold>
                  {` ${bar.label.padEnd(width)}  `}
                </Text>
              </Box>
              <Box flexShrink={0}>
                {style === 'text' ? (
                  <Text />
                ) : style !== 'hearts' ? (
                  e.surface === 'desktop' ? (
                    <Svg
                      source={barSvg(full, FILLS[color], ghost)}
                      alt={
                        ghost === 0
                          ? `${full} of ${CELLS} cells lit`
                          : `${full} to ${full + ghost} of ${CELLS} cells lit`
                      }
                      width={BAR_W}
                      height={BAR_H}
                    />
                  ) : (
                    <Box>
                      <Text color={color}>{'█'.repeat(full) + '▒'.repeat(ghost)}</Text>
                      <Text dimColor>{'░'.repeat(CELLS - full - ghost)}</Text>
                    </Box>
                  )
                ) : e.surface === 'desktop' ? (
                  <Svg
                    source={heartsSvg(row)}
                    alt={`${row / 4} of ${HEARTS} hearts left`}
                    height={18}
                  />
                ) : (
                  <Box>
                    <Text color="red">{'♥'.repeat(whole)}</Text>
                    <Text color="red" dimColor>
                      {hasPart ? '♥' : ''}
                    </Text>
                    <Text dimColor>
                      {'♡'.repeat(HEARTS - whole - (hasPart ? 1 : 0))}
                    </Text>
                  </Box>
                )}
                <Text color={color} bold>
                  {` ${percent}`}
                </Text>
                <Text color={color}>{style === 'used' ? ' used' : ' left'}</Text>
              </Box>
              <Box flexShrink={1} minWidth={0}>
                <Text dimColor wrap="truncate-end">
                  {bar.detail}
                </Text>
              </Box>
            </Box>
          )
        })}
        {bars.length > 0 && footer.length > 0 && (
          <Box>
            <Text>{' '.repeat(width + 4)}</Text>
            {lead !== '' && <Text bold>{lead}</Text>}
            {middle.length > 0 && (
              <Text dimColor wrap="truncate-end">
                {`${lead === '' ? '' : ' · '}${middle.join(' · ')}`}
              </Text>
            )}
            {resync !== '' && (
              <Text color="yellow" wrap="truncate-end">
                {lead === '' && middle.length === 0 ? resync.replace(/^ · /, '') : resync}
              </Text>
            )}
            {last.length > 0 && (
              <Text dimColor wrap="truncate-end">
                {`${lead === '' && middle.length === 0 && resync === '' ? '' : ' · '}${last.join(' · ')}`}
              </Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
