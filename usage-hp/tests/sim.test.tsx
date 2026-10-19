import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * A month and a half of a seat, simulated: what the sessions count, what the
 * dashboard bills (the counted spend times a billing factor, plus spend the
 * mod never sees), and a routine that reads the dashboard most mornings. At
 * every turn the mod's range is held against the true bill, and a scorecard
 * per scenario is printed as `SIM {json}` and held to floors.
 *
 * One long session carries all the counted spend: the kit holds one session's
 * state, and the estimate's arithmetic is what is scored here. How sessions
 * join and share keys is the unit tests' to cover.
 */

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
// Monday 2026-10-19, 00:00 UTC: forty days cross the turn of November.
const START = Date.UTC(2026, 9, 19)
const DAYS = 40
const LIMIT = 300
declare const console: { log: (...args: unknown[]) => void }
const DEBUG = false
const SYNC = '/home/sim/.claude/state/usage-hp-sync.json'

type Scenario = {
  name: string
  /** Counted spend a working day, its mean. */
  code: number
  /** How much a day's spend wanders: the log-normal's sigma. */
  sigma: number
  /** What the bill is per counted dollar (cache writes the mod over-prices make it < 1). */
  factor: number
  /** Unseen spend (the desktop chat) on a working day, its mean, and how often a day has any. */
  chat: number
  chatOdds: number
  /** How often the morning routine fails to run. */
  missOdds: number
  /** Days the routine is down altogether (vacation, a broken login). */
  outage?: [number, number]
  /** No routine at all: the person types /hp every few days. */
  manualEvery?: number
  /** One day that spends this many times its usual. */
  spike?: [number, number]
  /** Unseen spend on any day, weekends and code-free days included, not only beside the work. */
  chatAnytime?: boolean
  /** Nothing ever syncs after the first entry: a stranger who set it up once. */
  stranger?: boolean
  /** Unseen spend lands at any hour of the day, the small hours and before the morning sync included. */
  chatAllHours?: boolean
  /** The UTC hour the routine reads the dashboard (13 by default: just before work). */
  syncHour?: number
  /** Also score the bar as drawn in idle hours (evenings, weekends), every third hour. */
  scoreIdle?: boolean
  /**
   * Several sessions: a long one in the morning, a fresh one each afternoon
   * priced call by call (with a subagent), and some evenings a session on a
   * subscription seat whose spend must never count.
   */
  multi?: boolean
  seed: number
}

export const SCENARIOS: Scenario[] = [
  { name: 'steady', code: 12, sigma: 0.3, factor: 1, chat: 0, chatOdds: 0, missOdds: 0.05, seed: 1 },
  { name: 'chat-heavy', code: 8, sigma: 0.4, factor: 1, chat: 5, chatOdds: 0.6, missOdds: 0.05, seed: 2 },
  { name: 'overcount', code: 15, sigma: 0.3, factor: 0.85, chat: 1, chatOdds: 0.3, missOdds: 0.05, seed: 3 },
  { name: 'sync-gaps', code: 10, sigma: 0.4, factor: 1, chat: 3, chatOdds: 0.5, missOdds: 0.4, outage: [12, 16], seed: 4 },
  { name: 'spiky', code: 10, sigma: 0.8, factor: 1, chat: 1, chatOdds: 0.3, missOdds: 0.05, spike: [9, 6], seed: 5 },
  { name: 'manual', code: 10, sigma: 0.4, factor: 1, chat: 2, chatOdds: 0.4, missOdds: 1, manualEvery: 3, seed: 6 },
  { name: 'chat-anytime', code: 6, sigma: 0.5, factor: 1, chat: 6, chatOdds: 0.5, missOdds: 0.1, chatAnytime: true, seed: 7 },
  { name: 'stranger', code: 10, sigma: 0.4, factor: 0.9, chat: 2, chatOdds: 0.4, missOdds: 1, stranger: true, seed: 8 },
  { name: 'night-chat', code: 6, sigma: 0.5, factor: 1, chat: 6, chatOdds: 0.5, missOdds: 0.1, chatAnytime: true, chatAllHours: true, seed: 9 },
  { name: 'late-sync', code: 10, sigma: 0.4, factor: 1, chat: 3, chatOdds: 0.5, missOdds: 0.1, syncHour: 18, seed: 10 },
  { name: 'multi', code: 10, sigma: 0.4, factor: 1, chat: 2, chatOdds: 0.4, missOdds: 0.1, multi: true, seed: 13 },
  { name: 'multi-stranger', code: 10, sigma: 0.4, factor: 1, chat: 1, chatOdds: 0.3, missOdds: 1, multi: true, stranger: true, seed: 14 },
  { name: 'stranger-chat', code: 6, sigma: 0.5, factor: 1, chat: 6, chatOdds: 0.7, missOdds: 1, stranger: true, chatAnytime: true, chatAllHours: true, seed: 15 },
  { name: 'stranger-overbill', code: 10, sigma: 0.4, factor: 1.15, chat: 1, chatOdds: 0.3, missOdds: 1, stranger: true, seed: 16 },
  { name: 'overbill', code: 10, sigma: 0.4, factor: 1.2, chat: 1, chatOdds: 0.3, missOdds: 0.1, seed: 11 },
  { name: 'idle-chat', code: 6, sigma: 0.5, factor: 1, chat: 6, chatOdds: 0.5, missOdds: 0.3, chatAnytime: true, chatAllHours: true, scoreIdle: true, seed: 12 },
]

/** Each scenario runs on these seeds; the scorecard is their mean, `lateMax` the worst. */
const SEEDS = [0, 100, 200]

/**
 * A ratchet, not a target: each seed must do at least as well as the
 * estimator did when these were last raised (0.21, 2026-10-15), with a
 * little room. Tighten them as the estimate improves; never loosen one
 * without saying why in the commit.
 *
 * Re-based at 0.22 (round 2): late and resync tightened in every scenario;
 * width loosened by $0.3-2.2, the price of the high end allowing a whole
 * day's worst unseen spend from the moment after a figure (late fell by a
 * half to two thirds where unseen spend is heavy). Then again: width up
 * $1-2 and resync up a few points in sync-gaps, manual, chat-anytime and
 * night-chat for charging a multi-day interval's excess as one day's burst
 * (late fell to 0-2.5% in those scenarios).
 *
 * Round 3 (0.23): the stranger family's width and manual's resync went back
 * up when the no-data allowance returned to growing by days (2026-10-15):
 * square-root growth left a heavy-chat stranger late 87% of the
 * time, a case stranger-chat now guards.
 */
const FLOORS: Record<string, { late: number; miss: number; resync: number; coverage: number; width: number; idleLate?: number; pace?: number }> = {
  steady: { late: 0, miss: 0.01, resync: 0.02, coverage: 1, width: 2.3, pace: 0.17 },
  'chat-heavy': { late: 0.04, miss: 1.78, resync: 0.07, coverage: 0.78, width: 8.1, pace: 0.16 },
  overcount: { late: 0, miss: 0.44, resync: 0.03, coverage: 1, width: 3.1, pace: 0.2 },
  'sync-gaps': { late: 0.05, miss: 2.21, resync: 0.33, coverage: 0.94, width: 12.3, pace: 0.25 },
  spiky: { late: 0.04, miss: 0.41, resync: 0.04, coverage: 0.96, width: 3.8, pace: 0.21 },
  manual: { late: 0, miss: 1.36, resync: 0.18, coverage: 1, width: 9.9, pace: 0.23 },
  'chat-anytime': { late: 0.04, miss: 3.12, resync: 0.24, coverage: 0.94, width: 11.7, pace: 0.17 },
  stranger: { late: 0, miss: 1.42, resync: 0.98, coverage: 1, width: 109.1 },
  'night-chat': { late: 0.03, miss: 2.54, resync: 0.11, coverage: 0.97, width: 9.6, pace: 0.08 },
  'late-sync': { late: 0.04, miss: 0.92, resync: 0.03, coverage: 0.96, width: 4.9, pace: 0.11 },
  'multi': { late: 0.05, miss: 0.86, resync: 0.03, coverage: 0.95, width: 4.5, pace: 0.13 },
  'multi-stranger': { late: 0, miss: 2.59, resync: 0.98, coverage: 1, width: 103.7, pace: 0.14 },
  'stranger-chat': { late: 0.02, miss: 54.39, resync: 0.98, coverage: 0.97, width: 95.5 },
  'stranger-overbill': { late: 0, miss: 17.37, resync: 0.98, coverage: 1, width: 103.3 },
  'overbill': { late: 0.01, miss: 0.69, resync: 0.05, coverage: 0.98, width: 5.6, pace: 0.18 },
  'idle-chat': { late: 0.01, miss: 2.71, resync: 0.33, coverage: 0.82, width: 13.3, idleLate: 0.08, pace: 0.19 },
}

/** A small seeded generator: the same scenario gives the same month every run. */
const random = (seed: number) => {
  let a = seed * 0x9e3779b9

  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const normal = (next: () => number) =>
  Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next())

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7)

type Budget = { lowUsd: number; highUsd: number; spentUsd: number; syncedAt: number; baseUsd?: number; burnUsd?: number | null }

export type Score = {
  scenario: string
  turns: number
  /** Share of turns the true bill sat inside the range. */
  coverage: number
  /** Share of turns the true bill ran past the high end: the bar was late. */
  late: number
  /** How far past, on average, when it was. */
  lateBy: number
  /** The range's mean width, and the centre's mean miss, in dollars. */
  width: number
  miss: number
  /** Share of turns the row asked for a re-sync. */
  resync: number
  /** The pace's daily burn against the true week's, mean absolute error as a share; and how often it had one. */
  paceError: number | null
  paceShown: number
  /** Idle hours scored (scoreIdle only), and the share where the bar as drawn was late. */
  idle: number
  idleLate: number
}

export const simulate = async (
  scenario: Scenario,
  seed: number,
  $: { command: { run: (e: never) => Promise<unknown> }; turn: { complete: (e: never) => Promise<unknown> } },
  on: On,
): Promise<Score> => {
  const next = random(scenario.seed + seed)
  const clock = mock.clock(on, { now: START })
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  let usd = 0
  let budget: Budget | null = null
  // Each session's own cost, start, seat and state: the kit holds one
  // session's state, so the test keeps one per session beneath the mod.
  let session = 'sim'
  const costs = new Map<string, number>([['sim', 0]])
  const started = new Map<string, number>([['sim', START]])
  const states = new Map<string, Map<string, unknown>>()
  const stateOf = (id: string) => states.get(id) ?? states.set(id, new Map()).get(id)!
  let versions = 0

  on('session.usage', () => ({
    value: {
      startedAt: started.get(session) ?? START,
      context: { window: 200_000 },
      rateLimits: session === 'personal' ? [{ kind: 'five_hour', percentUsed: 10 }] : [],
      cost: { usd: scenario.multi === true ? (costs.get(session) ?? 0) : usd },
    },
  }))
  on('session.id', () => ({ value: session }))
  // One call per step, priced at Sonnet 5.5's $10 per million output tokens.
  let stepUsd = 0
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'claude-sonnet-5-5',
        input_tokens: 0,
        output_tokens: Math.round(stepUsd * 100_000),
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    } as never
  })

  if (scenario.multi === true) {
    on('state.get' as never, ((_: unknown, e: { key: string }) => ({ value: { value: stateOf(session).get(e.key), version: versions } })) as never)
  }

  /** One working hour in a session: its calls priced step by step, then the turn. */
  const work = async (id: string, counted: number, $$: typeof $) => {
    if (!costs.has(id)) {
      costs.set(id, 0)
      // A new session starts as its first hour of work begins.
      started.set(id, clock.now() - HOUR)
      // What session.start decides for a session the mod sees from its first call.
      stateOf(id).set('basis', 'priced')
    }

    session = id
    const halves = id.startsWith('d') ? [counted / 2, counted / 2] : [counted]

    for (const [index, part] of halves.entries()) {
      stepUsd = part
      const stream = ($$ as never as { turn: { step: (e: unknown) => AsyncGenerator & { result: Promise<unknown> } } }).turn.step({
        turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, ...(index === 1 ? { agentId: 'sub' } : {}),
      })
      for await (const _ of stream) {
        // drain
      }
      await stream.result
    }

    costs.set(id, (costs.get(id) ?? 0) + counted)
    await $$.turn.complete(turn)
  }
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('turn.complete', () => ({ text: '' }))
  // Nothing beneath the mod draws: an empty band stands for the engine.
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/sim' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('state.set' as never, ((_: unknown, e: { key: string; value: unknown }, pass: (x: unknown) => unknown) => {
    if (scenario.multi === true) {
      stateOf(session).set(e.key, e.value)

      if (e.key === 'reading' && session !== 'personal') {
        budget = ((e.value as { budget?: Budget } | null)?.budget ?? null) as Budget | null
      }

      return { value: { isSet: true, version: ++versions } }
    }

    if (e.key === 'reading') {
      budget = ((e.value as { budget?: Budget } | null)?.budget ?? null) as Budget | null
    }

    return pass(e)
  }) as never)

  // The bill this month, and each hour's billed dollars for the true pace.
  let billed = 0
  const hourly: { at: number; usd: number }[] = []
  const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never
  const score = { turns: 0, inside: 0, late: 0, lateBy: 0, width: 0, miss: 0, resync: 0, paceErr: 0, paceN: 0, idle: 0, idleLate: 0 }
  let hasTurned = false
  // A fresh start: the person enters the month so far, which is nothing.
  await $.command.run({ command: 'hp', args: `0 ${LIMIT}` } as never)

  for (let day = 0; day < DAYS; day++) {
    const weekday = (day % 7) < 5
    const spike = scenario.spike !== undefined && scenario.spike[0] === day ? scenario.spike[1] : 1
    const code = weekday
      ? scenario.code * spike * Math.exp(scenario.sigma * normal(next) - (scenario.sigma ** 2) / 2)
      : 0
    const chat = (weekday || scenario.chatAnytime === true) && next() < scenario.chatOdds
      ? scenario.chat * (0.5 + next())
      : 0
    const isOut = scenario.outage !== undefined && day >= scenario.outage[0] && day <= scenario.outage[1]
    const syncs = scenario.stranger === true
      ? false
      : scenario.manualEvery === undefined
      ? !isOut && next() >= scenario.missOdds
      : day % scenario.manualEvery === 0

    for (let hour = 0; hour < 24; hour++) {
      const now = START + day * DAY + hour * HOUR

      if (monthOf(now) !== monthOf(now - HOUR)) {
        billed = 0
      }

      // The routine reads the dashboard at 13:43 UTC (early morning local time).
      if (syncs && hour === (scenario.syncHour ?? 13)) {
        const at = now + 43 * 60_000
        await clock.set(at)

        if (scenario.manualEvery === undefined) {
          files.set(SYNC, JSON.stringify({ spentUsd: round(billed), limitUsd: LIMIT, at }))
        } else {
          await $.command.run({ command: 'hp', args: `${round(billed)} ${LIMIT}` } as never)
        }
      }

      // Work runs 14:00 to 23:00 UTC; each working hour is one turn.
      const isWorking = hour >= 14 && hour < 23
      const counted = isWorking ? code / 9 : 0
      const unseen = scenario.chatAllHours === true ? chat / 24 : hour >= 14 && hour < 23 ? chat / 9 : 0
      await clock.set(now + HOUR)
      usd += counted
      billed += counted * scenario.factor + unseen
      hourly.push({ at: now + HOUR, usd: counted * scenario.factor + unseen })

      if (!isWorking || code === 0) {
        // Idle: what the bar shows as drawn now, from the store and the clock.
        if (scenario.scoreIdle === true && hasTurned && hour % 3 === 0) {
          const high = await drawnHigh($)

          if (high !== null) {
            score.idle += 1
            score.idleLate += billed > high + 0.005 ? 1 : 0
          }
        }

        continue
      }

      if (scenario.multi === true) {
        // Mornings the long session, afternoons the day's fresh one; some
        // evenings a subscription seat spends too, billed elsewhere.
        await work(hour < 18 ? 'a' : `d${day}`, counted, $)

        if (hour === 22 && next() < 0.5) {
          await work('personal', 3, $)
          session = `d${day}`
        }
      } else {
        await $.turn.complete(turn)
      }

      hasTurned = true
      const seen = budget as Budget | null

      if (seen === null) {
        continue
      }

      score.turns += 1
      const width = seen.highUsd - seen.lowUsd
      score.width += width
      score.miss += Math.abs(seen.spentUsd - billed)

      if (billed > seen.highUsd + 0.005) {
        if (DEBUG && score.late < 400 && seed === 0) console.log(`LATE ${scenario.name} d${day} h${hour} billed=${billed.toFixed(2)} low=${seen.lowUsd.toFixed(2)} c=${seen.spentUsd.toFixed(2)} high=${seen.highUsd.toFixed(2)} synced=${new Date(seen.syncedAt).toISOString()}`)
        score.late += 1
        score.lateBy += billed - seen.highUsd
      } else if (billed >= seen.lowUsd - 0.005) {
        score.inside += 1
      }

      // The mod's own rule: a week old, the range across a colour line (the
      // limit included), or wider than 5% of the limit.
      const most = ((LIMIT - seen.lowUsd) / LIMIT) * 100
      const least = ((LIMIT - seen.highUsd) / LIMIT) * 100
      const across = [50, 20, 0].some(line => least <= line && most > line)

      if (width > LIMIT * 0.05 || across || now + HOUR - seen.syncedAt > 7 * DAY) {
        score.resync += 1
      }

      if (seen.burnUsd != null) {
        const held = Math.min(7, (now + HOUR - START) / DAY)
        const week = hourly.filter(one => one.at > now + HOUR - 7 * DAY).reduce((sum, one) => sum + one.usd, 0) / held

        if (week > 0) {
          score.paceErr += Math.abs(seen.burnUsd - week) / week
          score.paceN += 1
        }
      }
    }
  }

  return {
    scenario: scenario.name,
    turns: score.turns,
    coverage: score.inside / score.turns,
    late: score.late / score.turns,
    lateBy: score.late === 0 ? 0 : score.lateBy / score.late,
    width: score.width / score.turns,
    miss: score.miss / score.turns,
    resync: score.resync / score.turns,
    paceError: score.paceN === 0 ? null : score.paceErr / score.paceN,
    paceShown: score.paceN / score.turns,
    idle: score.idle,
    idleLate: score.idle === 0 ? 0 : score.idleLate / score.idle,
  }
}

const round = (usd: number) => Math.round(usd * 100) / 100

/**
 * The high end of the SPEND row as drawn, from its text (`$a–b left of $300`,
 * or `$x.xx left of $300`): the drawn figure rounds outward, so this is at or above
 * the mod's own high end.
 */
const drawnHigh = async ($: unknown): Promise<number | null> => {
  const ui = await ($ as { ui: { mount: (e: unknown) => Promise<unknown> } }).ui.mount({
    plugin: 'usage-hp',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false },
  })
  const found = await (ui as { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }).findAll({ type: 'Text' })
  const text = found.map(one => one.text ?? '').join('')
  const range = /\$(\d+)–(\d+) left of \$300/.exec(text)
  const point = /\$(\d+\.\d\d) left of \$300/.exec(text)

  return range !== null ? LIMIT - Number(range[1]) : point !== null ? LIMIT - Number(point[1]) : null
}

for (const scenario of SCENARIOS) {
  for (const seed of SEEDS) {
    // Drawing the bar in idle hours takes a mount each: those runs get longer.
    test(`simulation: ${scenario.name} #${seed}`, { timeoutMs: scenario.scoreIdle === true ? 60_000 : 5_000 }, async ($, on) => {
      const result = await simulate(scenario, seed, $ as never, on)
      const fixed = Object.fromEntries(
        Object.entries(result).map(([key, value]) => [key, typeof value === 'number' ? Math.round(value * 1000) / 1000 : value]),
      )
      console.log(`SIM ${JSON.stringify({ ...fixed, seed })}`)
      expect(result.turns).toBeGreaterThan(100)
      expect(scenario.scoreIdle !== true || result.idle > 50).toBe(true)
      const floor = FLOORS[scenario.name]!
      expect(result.late).toBeLessThanOrEqual(floor.late)
      expect(result.miss).toBeLessThanOrEqual(floor.miss)
      expect(result.resync).toBeLessThanOrEqual(floor.resync)
      expect(result.coverage).toBeGreaterThanOrEqual(floor.coverage)
      // Width too: a lower late rate bought with a wider range shows here.
      expect(result.width).toBeLessThanOrEqual(floor.width)
      expect(result.idleLate).toBeLessThanOrEqual(floor.idleLate ?? 1)
      expect(result.paceError ?? 0).toBeLessThanOrEqual(floor.pace ?? 1)
    })
  }
}
