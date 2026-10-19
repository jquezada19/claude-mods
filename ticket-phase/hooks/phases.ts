import type { PhaseInfo, PhaseRow, PhaseStats, TicketPhases } from '../types'

const isEvent = (value: unknown): value is PhaseRow['event'] =>
  value === 'enter' || value === 'exit'

/**
 * Reads the sink's lines into rows: the stamp becomes epoch ms, the phase a
 * number 1–8. A line that fails any of that is skipped and counted. Rows come
 * back in time order; equal stamps keep the file's order.
 */
export const parseRows = (text: string): { rows: PhaseRow[]; skipped: number } => {
  const rows: PhaseRow[] = []
  let skipped = 0
  // A row's order is its place among the rows with the same stamp, not in the whole file:
  // when only the newest part of the sink is read, rows before it drop out, and an order
  // counted from the start of the text would shift (and with it a tally's identity).
  const ties = new Map<number, number>()

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') {
      continue
    }

    let one: unknown
    try {
      one = JSON.parse(raw)
    } catch {
      skipped += 1
      continue
    }

    if (typeof one !== 'object' || one === null) {
      skipped += 1
      continue
    }

    const { ts, session, ticket, phase, event } = one as Record<string, unknown>
    const at = typeof ts === 'string' ? Date.parse(ts) : Number.NaN
    const n =
      typeof phase === 'number' ? phase : typeof phase === 'string' ? Number(phase) : Number.NaN

    if (
      !Number.isFinite(at) ||
      typeof session !== 'string' ||
      session === '' ||
      (typeof ticket !== 'string' && typeof ticket !== 'number') ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > 8 ||
      !isEvent(event)
    ) {
      skipped += 1
      continue
    }

    const order = (ties.get(at) ?? 0) + 1
    ties.set(at, order)
    rows.push({ at, session, ticket: String(ticket), phase: n, event, order })
  }

  rows.sort((a, b) => a.at - b.at || a.order - b.order)

  return { rows, skipped }
}

export const LAST_PHASE = 8
/** Canonical phase names, index 1–8 (index 0 unused). */
export const PHASES: readonly string[] = [
  '',
  'Recall',
  'Research',
  'Plan',
  'Test',
  'Implement',
  'Review',
  'Ship',
  'Compound',
]

const blank = (): PhaseInfo => ({
  enters: 0,
  exits: 0,
  closed: 0,
  left: 0,
  rounds: 1,
  open: [],
  openedAt: null,
  openedOrder: null,
})

/**
 * Walks one ticket's rows into its phase state. A ticket is in one phase at a
 * time: an enter opens its phase and leaves every other open phase (a skipped
 * exit, whoever's it was); an enter on a phase already open is a resume that
 * keeps the phase's start; an exit closes the phase for everyone; an exit with
 * nothing open is an orphan that changes no state.
 */
export const walk = (rows: readonly PhaseRow[]): TicketPhases => {
  const phases: Record<number, PhaseInfo> = {}
  const sessions = new Set<string>()
  let firstEnterAt: number | null = null
  let lastExitAt: number | null = null
  let lastPhase: number | null = null
  let lastEvent: PhaseRow['event'] | null = null

  for (let p = 1; p <= LAST_PHASE; p += 1) {
    phases[p] = blank()
  }

  for (const row of rows) {
    const info = phases[row.phase]!
    sessions.add(row.session)
    lastPhase = row.phase
    lastEvent = row.event

    if (row.event === 'enter') {
      info.enters += 1
      firstEnterAt ??= row.at

      if (info.open.length > 0) {
        if (!info.open.includes(row.session)) {
          info.open.push(row.session)
        }

        continue
      }

      for (let q = 1; q <= LAST_PHASE; q += 1) {
        const other = phases[q]!

        if (q !== row.phase && other.open.length > 0) {
          other.open = []
          other.openedAt = null
          other.openedOrder = null
          other.left += 1
        }
      }

      if (info.left > 0) {
        info.rounds += 1
      }

      info.open.push(row.session)
      info.openedAt = row.at
      info.openedOrder = row.order
      continue
    }

    info.exits += 1

    if (info.open.length === 0) {
      continue
    }

    info.open = []
    info.openedAt = null
    info.openedOrder = null
    info.closed += 1
    info.left += 1
    lastExitAt = row.at
  }

  let current: number | null = null
  let enteredAt: number | null = null
  let enteredOrder: number | null = null

  for (let p = 1; p <= LAST_PHASE; p += 1) {
    const { openedAt, openedOrder } = phases[p]!

    if (
      openedAt !== null &&
      (enteredAt === null ||
        openedAt > enteredAt ||
        (openedAt === enteredAt && (openedOrder ?? 0) > (enteredOrder ?? 0)))
    ) {
      current = p
      enteredAt = openedAt
      enteredOrder = openedOrder
    }
  }

  const last = phases[LAST_PHASE]!
  const isDone =
    current === null && lastPhase === LAST_PHASE && lastEvent === 'exit' && last.closed > 0

  return {
    ticket: rows[0]?.ticket ?? '',
    phases,
    current,
    enteredAt,
    enteredOrder,
    lastPhase,
    lastEvent,
    isDone,
    firstEnterAt,
    lastExitAt,
    sessions: [...sessions],
  }
}

/** The middle value; null under two values, since one sample is no pace. */
export const median = (values: readonly number[]): number | null => {
  if (values.length < 2) {
    return null
  }

  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Own pace per phase over every ticket: each exit pairs with its own session's
 * most recent still-unpaired enter, else the most recent of any session, so a
 * resumed phase yields one sample, interleaved sessions measure their own
 * stretches, and an orphan exit yields none.
 */
export const statsOf = (rows: readonly PhaseRow[]): Record<number, PhaseStats> => {
  const open = new Map<string, { at: number; session: string }[]>()
  const durations: Record<number, { ms: number; ticket: string }[]> = {}

  for (const row of rows) {
    const key = `${row.ticket}:${row.phase}`
    const stack = open.get(key) ?? []

    if (row.event === 'enter') {
      stack.push({ at: row.at, session: row.session })
      open.set(key, stack)
      continue
    }

    let index = stack.length - 1

    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i]!.session === row.session) {
        index = i
        break
      }
    }

    const [entered] = index >= 0 ? stack.splice(index, 1) : []

    if (entered === undefined) {
      continue
    }

    ;(durations[row.phase] ??= []).push({ ms: row.at - entered.at, ticket: row.ticket })
  }

  const stats: Record<number, PhaseStats> = {}

  for (let p = 1; p <= LAST_PHASE; p += 1) {
    const pairs = durations[p] ?? []
    stats[p] = {
      median: median(pairs.map(one => one.ms)),
      pairs: pairs.length,
      tickets: new Set(pairs.map(one => one.ticket)).size,
    }
  }

  return stats
}

/** The canonical phases still ahead: above the current one, or above the latest row's. */
export const aheadOf = (state: TicketPhases): number[] => {
  const from = state.current ?? state.lastPhase ?? 0
  const ahead: number[] = []

  for (let p = from + 1; p <= LAST_PHASE; p += 1) {
    ahead.push(p)
  }

  return ahead
}

/**
 * Time left at own pace: the medians of the phases ahead, plus what the current
 * phase's median still allows. Null until every summed phase has pairs from two
 * distinct tickets.
 */
export const etaOf = (
  state: TicketPhases,
  stats: Record<number, PhaseStats>,
  now: number,
): number | null => {
  const summed = [...aheadOf(state), ...(state.current === null ? [] : [state.current])]
  let ms = 0

  for (const p of summed) {
    const one = stats[p]

    if (one === undefined || one.median === null || one.tickets < 2) {
      return null
    }

    ms +=
      p === state.current && state.enteredAt !== null
        ? Math.max(0, one.median - (now - state.enteredAt))
        : one.median
  }

  return ms
}

/** A duration for the row: minutes under an hour, then h+m, then d+h. */
export const until = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  if (days > 0) {
    return `${days}d${hours}h`
  }

  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`
}

/** A token count for the row: thousands as k, millions to one decimal, each carrying up. */
export const tokensShort = (n: number): string => {
  if (n < 1000) {
    return `${n}`
  }

  const k = Math.round(n / 1000)

  if (k < 1000) {
    return `${k}k`
  }

  const m = Math.round(n / 100_000) / 10

  return m >= 1000 ? `${Math.round(n / 1_000_000)}M` : `${m.toFixed(1)}M`
}

/**
 * The eight cells: below the current phase ◆ where the phase was entered, ◈
 * the current, ◇ everything above it whatever its history. With no current
 * phase, ◆ wherever a phase was entered.
 */
export const cellsOf = (state: TicketPhases): string => {
  let out = ''

  for (let p = 1; p <= LAST_PHASE; p += 1) {
    const entered = state.phases[p]!.enters > 0

    if (state.current === null) {
      out += entered ? '◆' : '◇'
    } else if (p === state.current) {
      out += '◈'
    } else if (p < state.current) {
      out += entered ? '◆' : '◇'
    } else {
      out += '◇'
    }
  }

  return out
}

/** The `tier:` value inside the leading frontmatter block, or null. */
export const tierOf = (text: string): string | null => {
  if (!text.startsWith('---')) {
    return null
  }

  const end = text.indexOf('\n---', 3)

  if (end === -1) {
    return null
  }

  const match = /^tier:\s*([A-Za-z]+)\s*$/m.exec(text.slice(0, end))

  return match === null ? null : match[1]!.toLowerCase()
}
