/**
 * What the vendors behind the external seats have used, read from files those tools already
 * write: Codex's own session log (its tokens for a run, and the account's rate-limit windows)
 * and the house consult ledger (the Cursor and Antigravity seats' tokens today). Parsers only:
 * the hooks module does the reading. Nothing here is a vendor quota for Cursor or Antigravity;
 * neither CLI reports one locally (checked 2026-11-24).
 */
import type { CodexLimits, Usage } from '../types'

/** The tail of a session log read for its newest figures; a long run's log is megabytes. */
export const TAIL_BYTES = 262_144

/** Where Codex keeps its state: `CODEX_HOME` when set (its docs name `$CODEX_HOME/config.toml`), else `~/.codex`; null with neither. */
export const codexHomeOf = (env: { HOME?: string | undefined; CODEX_HOME?: string | undefined }): string | null => {
  const named = (env.CODEX_HOME ?? '').replace(/\/+$/, '')

  return named !== '' ? named : env.HOME === undefined ? null : `${env.HOME}/.codex`
}

/** `…/sessions/2026/11/24`: the folder under Codex's home a run started at `at` writes into (local date). */
export const codexDayDir = (codexHome: string, at: number): string => {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')

  return `${codexHome}/sessions/${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`
}

/**
 * The session log written last: a long run started earlier can hold a newer reading of the
 * account than a short one started after it. By name (start time) when no entry carries a time.
 */
export const newestWritten = (entries: readonly { name: string; mtimeMs?: number }[]): string | null => {
  const logs = entries.filter(e => rolloutStart(e.name) !== null)
  const [first] = [...logs].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || (a.name < b.name ? 1 : -1))

  return first?.name ?? null
}

/** When a session log named `rollout-2026-11-24T20-38-26-<id>.jsonl` began (local time), or null. */
export const rolloutStart = (name: string): number | null => {
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-.*\.jsonl$/.exec(name)

  if (m === null) {
    return null
  }

  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]

  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

/**
 * The session log of the run that started at `startedAt`: the first one begun at or after it
 * (a second of slack before) and before it ended, not already taken by another row.
 */
export const pickRollout = (names: readonly string[], startedAt: number, endedAt: number, taken: readonly string[] = []): string | null => {
  const fits = names
    .filter(n => !taken.includes(n))
    .map(n => ({ n, at: rolloutStart(n) }))
    .filter((r): r is { n: string; at: number } => r.at !== null && r.at >= startedAt - 1_500 && r.at <= endedAt)
    .sort((a, b) => a.at - b.at)

  return fits[0]?.n ?? null
}

/** The newest `"key":<number>` in the text, or null. */
const lastNumber = (text: string, key: string): number | null => {
  const re = new RegExp(`"${key}"\\s*:\\s*(\\d+(?:\\.\\d+)?)`, 'g')
  let out: number | null = null

  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out = Number(m[1])
  }

  return out
}

/** One window of a rate-limit snapshot: null when the log has `null` there or names no percent. */
const windowOf = (block: string, name: string): { used: number; resetsAt?: number; minutes?: number } | null => {
  const at = block.indexOf(`"${name}"`)

  if (at < 0) {
    return null
  }

  // `"primary":null,"secondary":{…}`: a null window has no figures, and must not read its neighbour's
  const rest = block.slice(at + name.length + 2).replace(/^\s*:\s*/, '')

  if (!rest.startsWith('{')) {
    return null
  }

  const body = rest.slice(0, 160).split('}')[0] ?? ''
  const used = lastNumber(body, 'used_percent')
  // `resets_at` is epoch seconds (2026-11-24: a 5h window read at 23% was shown for minutes after it reset)
  const resets = lastNumber(body, 'resets_at')
  const minutes = lastNumber(body, 'window_minutes')

  return used === null ? null : { used, ...(resets === null ? {} : { resetsAt: resets * 1000 }), ...(minutes === null ? {} : { minutes }) }
}

/**
 * The account's rate-limit windows from the newest snapshot that has one. A snapshot for
 * another quota can follow with both windows null (third-party reports of `limit_id: "premium"`),
 * so the search walks back past those. A plan with one window gives one, in either slot.
 */
const limitsOf = (text: string): { limits?: CodexLimits } => {
  for (let at = text.lastIndexOf('"rate_limits"'); at >= 0; at = at === 0 ? -1 : text.lastIndexOf('"rate_limits"', at - 1)) {
    const block = text.slice(at, at + 600)
    const [first, second] = [windowOf(block, 'primary'), windowOf(block, 'secondary')].filter(w => w !== null)

    if (first !== undefined) {
      return {
        limits: {
          primary: first.used,
          ...(second === undefined ? {} : { secondary: second.used }),
          ...(first.resetsAt === undefined ? {} : { primaryResetsAt: first.resetsAt }),
          ...(second?.resetsAt === undefined ? {} : { secondaryResetsAt: second.resetsAt }),
          ...(first.minutes === undefined ? {} : { primaryMinutes: first.minutes }),
          ...(second?.minutes === undefined ? {} : { secondaryMinutes: second.minutes }),
        },
      }
    }
  }

  return {}
}

/**
 * A Codex session log's newest figures: the run's total tokens (`total_token_usage.total_tokens`)
 * and the account's two rate-limit windows as percent used. Either may be absent.
 */
export const parseCodexTail = (text: string): { tokens?: number; limits?: CodexLimits } => {
  const totalAt = text.lastIndexOf('"total_token_usage"')
  const tokens = totalAt < 0 ? null : lastNumber(text.slice(totalAt, totalAt + 400).split('"last_token_usage"')[0] ?? '', 'total_tokens')
  return { ...(tokens === null ? {} : { tokens }), ...limitsOf(text) }
}

/**
 * The consult ledger's seat runs since `since` (the local day's start), summed by where they
 * ran: Antigravity (pool `agy`) or Cursor (every other buddy pool). A cut first line is skipped.
 */
export const parseLedger = (text: string, since: number): { cursor: number; antigravity: number } => {
  const out = { cursor: 0, antigravity: 0 }

  for (const line of text.split('\n')) {
    if (!line.includes('"consult_call"')) {
      continue
    }

    try {
      const r = JSON.parse(line) as { kind?: string; ts?: string; pool?: string; tokens_total?: unknown }

      if (r.kind !== 'consult_call' || typeof r.ts !== 'string' || typeof r.tokens_total !== 'number' || !(Date.parse(r.ts) >= since)) {
        continue
      }

      if (r.pool === 'agy') {
        out.antigravity += r.tokens_total
      } else if (typeof r.pool === 'string' && r.pool.startsWith('cursor')) {
        out.cursor += r.tokens_total
      }
    } catch {
      // a line cut by the tail read, or not a row
    }
  }

  return out
}

/**
 * A window's reading at `at`: the percent read, or `reset` once its reset time has passed. Past
 * the reset the figure read is no longer true and none has been read since, so no number is shown:
 * the account may already have used some of the new window from another machine.
 */
export const windowReading = (used: number, resetsAt: number | undefined, at: number): string =>
  resetsAt !== undefined && at >= resetsAt ? 'reset' : `${Math.round(used)}%`

/** A window's name from its length: `5h`, `7d`, `90m`; `fallback` when the log named no length. */
export const windowName = (minutes: number | undefined, fallback: string): string =>
  minutes === undefined || minutes <= 0 ? fallback : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`

/** The start of the local day `at` falls in. */
export const dayStart = (at: number): number => {
  const d = new Date(at)

  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Whether a Codex reading still describes a window that has not reset by `at`. */
export const hasLiveWindow = (c: CodexLimits | undefined, at: number): boolean =>
  c !== undefined && [c.primaryResetsAt, c.secondaryResetsAt].some(r => r !== undefined && r > at)

/**
 * `prev` with what was just read laid over it; a source that could not be read keeps its last
 * figure for the same day. Across midnight the ledger's day figures start clean, but Codex's
 * windows roll on: a reading with a reset still ahead is kept.
 */
export const mergeUsage = (prev: Usage | null, next: Partial<Usage>, at: number): Usage => {
  const day = dayStart(at)
  const kept = prev !== null && prev.day === day ? prev : { day, ...(prev !== null && hasLiveWindow(prev.codex, at) ? { codex: prev.codex! } : {}) }

  return { ...kept, ...next, day }
}
