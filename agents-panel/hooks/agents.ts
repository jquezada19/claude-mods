import type { AgentRun, Session } from '../types'
import type { Costume } from './sprite'

export const ROW_CAP = 200
/** A running row absent from $.agent.list() for this long is over. */
export const MISSING_MS = 60_000
/** The tick's reconcile runs at most this often; the main turn's end forces one. */
export const RECONCILE_MS = 10_000

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  model?: string
}

const count = (v: unknown): number => (typeof v === 'number' ? v : 0)

/** The four counts summed, and the input side alone; null when either is not finite. */
export const sumUsage = (u: Usage): { tokens: number; context: number } | null => {
  const i = count(u.input_tokens)
  const o = count(u.output_tokens)
  const r = count(u.cache_read_input_tokens)
  const w = count(u.cache_creation_input_tokens)
  const tokens = i + o + r + w
  const context = i + r + w

  return Number.isFinite(tokens) && Number.isFinite(context) ? { tokens, context } : null
}

/** Appends a run, replacing one of the same id; keeps the newest ROW_CAP, dropping finished rows first. */
export const openRow = (list: AgentRun[], run: AgentRun): AgentRun[] => {
  const out = [...list.filter(a => a.id !== run.id), run]

  while (out.length > ROW_CAP) {
    const i = out.findIndex(a => a.status !== 'running')

    if (i < 0) {
      break
    }

    out.splice(i, 1)
  }

  return out
}

const replaceAt = (list: AgentRun[], i: number, next: AgentRun): AgentRun[] => list.map((a, j) => (j === i ? next : a))

const withoutMissing = (a: AgentRun): AgentRun => {
  const { missingSince: _dropped, ...rest } = a

  return rest
}

const withoutEngineStatus = (a: AgentRun): AgentRun => {
  const { engineStatus: _dropped, ...rest } = a

  return rest
}

/** A run that is working again or over: neither parked by the engine nor waiting on an approval. */
const settled = (a: AgentRun): AgentRun => {
  const { engineStatus: _parked, pending: _pending, ...rest } = a

  return rest
}

/** The engine's own states for a run that is neither working nor over: shown, never counted as finished. */
const PARKED = new Set(['pending', 'waiting', 'idle'])

/**
 * A finished row running again (a SendMessage resume, a teammate woken): running, with
 * startedAt moved so elapsed carries on from what the earlier run took, not the idle gap.
 */
export const reopenRow = (a: AgentRun, at: number): AgentRun => {
  if (a.status === 'running' || a.endedAt === undefined) {
    return a
  }

  const { endedAt, missingSince: _dropped, ...rest } = a

  return { ...rest, status: 'running', startedAt: at - (endedAt - a.startedAt) }
}

/** How many turns a row remembers its per-turn step counts for. */
export const TURNS_KEPT = 8
/** A turn whose figures came from its completion's usage. */
export const FELL_BACK = -1

/** The per-turn counts with one turn set (moved to newest), trimmed to the newest TURNS_KEPT. */
export const noteTurn = (turns: Record<string, number> | undefined, turnId: string, value: number): Record<string, number> => {
  const { [turnId]: _old, ...rest } = turns ?? {}
  const keys = Object.keys(rest).slice(-(TURNS_KEPT - 1))

  return { ...Object.fromEntries(keys.map(k => [k, rest[k]!])), [turnId]: value }
}

/**
 * A row's per-turn counts, carrying a card from 0.4.0 across a reload: its one turn's step
 * count (turnSteps) and the turn its completion counted (fellBack) become entries. The
 * legacy fields are dropped from any row an event rewrites.
 */
export const turnsOf = (a: AgentRun): Record<string, number> | undefined => {
  const { turnSteps, fellBack } = a as AgentRun & { turnSteps?: unknown; fellBack?: unknown }

  if (a.turns !== undefined || (turnSteps === undefined && fellBack === undefined)) {
    return a.turns
  }

  const out: Record<string, number> = {}

  if (typeof a.turnId === 'string' && typeof turnSteps === 'number' && turnSteps > 0) {
    out[a.turnId] = turnSteps
  }

  if (typeof fellBack === 'string') {
    out[fellBack] = FELL_BACK
  }

  return out
}

const withoutLegacy = (a: AgentRun): AgentRun => {
  const { turnSteps: _s, fellBack: _f, ...rest } = a as AgentRun & { turnSteps?: unknown; fellBack?: unknown }

  return rest
}

/**
 * One model request of the subagent: figures move. A step on a done or failed row is a
 * resume (no agent.spawn fires for a SendMessage resume) only when it belongs to a turn the
 * row has not seen and began after the row ended; any other step on a finished row is late
 * and only adds figures. A turn counted by its completion's usage takes no step figures.
 * An external row has no steps; a lost row keeps its status.
 */
export const applyStep = (
  list: AgentRun[],
  id: string,
  usage: Usage,
  model: string,
  effort: unknown,
  at: number,
  turnId?: string,
  began?: number,
): AgentRun[] => {
  const i = list.findIndex(a => a.id === id)

  if (i < 0) {
    return list
  }

  const sum = sumUsage(usage)

  if (sum === null) {
    return list
  }

  const was = list[i]!
  const found: AgentRun = { ...withoutLegacy(was), ...(turnsOf(was) === undefined ? {} : { turns: turnsOf(was) }) }
  const seen = turnId === undefined ? undefined : found.turns?.[turnId]

  // This turn's usage already came from its completion: a late step would count it twice.
  if (seen === FELL_BACK) {
    return list
  }

  const isNewTurn = turnId !== undefined && seen === undefined && turnId !== found.turnId
  const isFinished = found.status === 'done' || found.status === 'failed'
  const isResumed =
    found.external === undefined &&
    isFinished &&
    isNewTurn &&
    (began === undefined || found.endedAt === undefined || began >= found.endedAt)
  const a = isResumed ? reopenRow(found, at) : found
  const next: AgentRun = {
    ...settled(withoutMissing(a)),
    model: usage.model || model || a.model,
    effort: typeof effort === 'string' ? effort : a.effort,
    contextTokens: sum.context,
    tokens: a.tokens + sum.tokens,
    steps: a.steps + 1,
    ...(turnId === undefined
      ? {}
      : {
          ...(isNewTurn || turnId === a.turnId ? { turnId } : {}),
          turns: noteTurn(a.turns, turnId, (seen ?? 0) + 1),
        }),
  }

  return replaceAt(list, i, next)
}

/**
 * The run's end: done on an answer, failed otherwise. A turn none of whose steps was seen
 * (one that ran before the card, or a resumed run's whose steps went unreported) takes its
 * figures from the completion's usage, added to what earlier runs counted, and is marked so
 * a repeated completion or a late step of it adds nothing.
 */
export const applyComplete = (
  list: AgentRun[],
  id: string,
  reason: string,
  usage: Usage | null,
  at: number,
  turnId?: string,
): AgentRun[] => {
  const i = list.findIndex(a => a.id === id)

  if (i < 0) {
    return list
  }

  const was = list[i]!
  const a: AgentRun = { ...withoutLegacy(was), ...(turnsOf(was) === undefined ? {} : { turns: turnsOf(was) }) }
  const seen = turnId === undefined ? a.steps : (a.turns?.[turnId] ?? 0)
  const sum = seen === 0 && usage !== null ? sumUsage(usage) : null
  const isOlderTurn = turnId !== undefined && turnId !== a.turnId && a.turns?.[turnId] !== undefined
  const next: AgentRun = {
    ...settled(a),
    status: reason === 'answer' ? 'done' : 'failed',
    endedAt: at,
    ...(turnId === undefined || isOlderTurn ? {} : { turnId }),
    ...(sum === null
      ? {}
      : {
          tokens: a.tokens + sum.tokens,
          contextTokens: sum.context,
          steps: a.steps + 1,
          model: usage?.model || a.model,
          ...(turnId === undefined ? {} : { turns: noteTurn(a.turns, turnId, FELL_BACK) }),
        }),
  }

  return replaceAt(list, i, next)
}

/** What $.agent.list() says about every running row; absence is timed and ends in failed (had steps) or lost (had none). */
export const reconcileRows = (list: AgentRun[], infos: readonly { id: string; status: string }[], at: number): AgentRun[] => {
  const status = new Map(infos.map(one => [one.id, one.status]))
  let changed = false
  const out = list.map(a => {
    if (a.status !== 'running' || a.external !== undefined) {
      return a
    }

    const s = status.get(a.id)

    if (s === 'completed') {
      changed = true

      return { ...settled(withoutMissing(a)), status: 'done' as const, endedAt: at }
    }

    if (s === 'failed' || s === 'killed') {
      changed = true

      return { ...settled(withoutMissing(a)), status: 'failed' as const, endedAt: at }
    }

    if (s !== undefined) {
      const parked = PARKED.has(s) ? (s as NonNullable<AgentRun['engineStatus']>) : undefined

      if (a.missingSince === undefined && a.engineStatus === parked) {
        return a
      }

      changed = true
      const seen = withoutEngineStatus(withoutMissing(a))

      return parked === undefined ? seen : { ...seen, engineStatus: parked }
    }

    if (a.missingSince === undefined) {
      changed = true

      return { ...a, missingSince: at }
    }

    if (at - a.missingSince >= MISSING_MS) {
      changed = true

      return { ...settled(withoutMissing(a)), status: a.steps > 0 ? ('failed' as const) : ('lost' as const), endedAt: at }
    }

    return a
  })

  return changed ? out : list
}

/** Thousands as k, millions to one decimal. */
export const fmtTokens = (n: number): string => {
  if (n < 1000) {
    return `${Math.round(n)}`
  }

  const k = Math.round(n / 1000)

  if (k < 1000) {
    return `${k}k`
  }

  return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`
}

/** m:ss under an hour, h:mm:ss above; never negative. */
export const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')

  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** The id without its vendor prefix and any `[...]` suffix, lower-cased: what two ids are compared on. */
export const modelKey = (id: string): string => id.toLowerCase().replace(/^claude-/, '').replace(/\[[^\]]*\]$/, '')

/** `Opus 5.5` from `claude-opus-5-5[1m]`; an unknown id with the prefix stripped; `—` for nothing. */
export const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(id)

  if (m === null) {
    return modelKey(id) || '—'
  }

  const [, family = '', major = '', minor] = m

  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor === undefined ? '' : `.${minor}`}`
}

/** The row's context against the session window, only when it runs the session's model. */
export const ctxPercent = (row: AgentRun, session: Session | null): number | null => {
  if (session === null || session.window === null || session.window <= 0) {
    return null
  }

  if (modelKey(row.model) !== modelKey(session.model)) {
    return null
  }

  // Multiply first: 29 / 200 * 100 is 14.499999… in floating point, 2900 / 200 is exactly 14.5.
  return Math.min(100, Math.round((row.contextTokens * 100) / session.window))
}

/** The Clawd costumes a subagent of no type of its own rotates through. */
export const CLAWDS: readonly Costume[] = ['plain', 'pirate', 'detective', 'engineer', 'chef']

/**
 * The costume for an agent type, any `<plugin>:` prefix removed: every agent of the
 * codex plugin is the Codex bot, a Kimi buddy seat (`buddy:kimi-…`) the panda, a
 * Gemini one the rainbow droplet, a Grok one the ball, a Composer one the cube. Any
 * other subagent takes the Clawd costume its spawn order (`variant`) points at, so a
 * session's agents show every one; with no variant it is the plain Clawd.
 */
export const costumeOf = (type: string, variant?: number): Costume => {
  const bare = type.replace(/^[^:]*:/, '')

  if (type.startsWith('codex:') || bare === 'codex-rescue') return 'codex'
  if (type.startsWith('buddy:') && bare.startsWith('kimi')) return 'panda'
  if (type.startsWith('buddy:') && bare.startsWith('gemini')) return 'gemini'
  if (type.startsWith('buddy:') && /^(cursor-)?grok/.test(bare)) return 'grok'
  if (type.startsWith('buddy:') && bare.startsWith('composer')) return 'composer'

  if (bare === 'Explore') return 'pirate'
  if (bare === 'Plan') return 'engineer'
  if (bare === 'claude-code-guide') return 'chef'

  return variant === undefined ? 'plain' : CLAWDS[variant % CLAWDS.length]!
}

/** An external row's end, as its call's result or its done file said; a row already over keeps its status. */
export const finishRow = (list: AgentRun[], id: string, status: 'done' | 'failed' | 'lost', at: number): AgentRun[] => {
  const i = list.findIndex(a => a.id === id)

  if (i < 0 || list[i]!.status !== 'running') {
    return list
  }

  return replaceAt(list, i, { ...settled(list[i]!), status, endedAt: at })
}

export const elapsed = (row: AgentRun, at: number): number => (row.endedAt ?? Math.max(at, row.startedAt)) - row.startedAt

/** Whether the row's token figures mean anything: an external or lost row never reports a request. */
export const reportsTokens = (row: AgentRun): boolean => row.external === undefined && row.status !== 'lost'

/** Agents, their summed tokens (null when no row reports any: unknown, not 0) and the span they cover. */
export type Totals = { agents: number; tokens: number | null; time: number }

export const totals = (list: AgentRun[], at: number): Totals => {
  if (list.length === 0) {
    return { agents: 0, tokens: 0, time: 0 }
  }

  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  const known = list.filter(reportsTokens)

  return { agents: list.length, tokens: known.length === 0 ? null : known.reduce((s, a) => s + a.tokens, 0), time: end - start }
}

/** Whitespace runs folded, then cut to `n` characters with an ellipsis when it had to cut. */
export const clip = (text: string, n: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`
}

/** The argument that says most about a tool call, first found in this order. */
const HINTS = ['file_path', 'path', 'notebook_path', 'pattern', 'url', 'command', 'query', 'description'] as const
const TOOL_LINE = 80

/**
 * The program a shell command runs: its first word after any VAR=value prefixes, the
 * directory dropped. Only that reaches a card: a command's arguments can carry anything
 * (headers, tokens, bodies), and no pattern list is a safe filter for a pane that may be
 * on a shared screen.
 */
const programOf = (command: string): string => {
  const word = command
    .trim()
    .split(/\s+/)
    .find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))

  return (word ?? '').replace(/^["']|["']$/g, '').replace(/^.*\//, '')
}

/** A URL as host and path: userinfo, query and fragment dropped. */
const urlShape = (url: string): string => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]*)([^?#]*)/i.exec(url.trim())

  return m === null ? url.replace(/[?#].*$/, '') : `${m[1]}${m[2]}`
}

/** One tool use as a card line: its name and its most telling argument, clipped. */
export const toolLine = (use: { name: string; input: unknown }): string => {
  const input = typeof use.input === 'object' && use.input !== null ? (use.input as Record<string, unknown>) : {}
  const key = HINTS.find(k => typeof input[k] === 'string' && (input[k] as string).trim() !== '')
  const value = key === undefined ? '' : (input[key] as string)
  const shown = key === 'command' ? programOf(value) : key === 'url' ? urlShape(value) : value

  return clip(shown === '' ? use.name : `${use.name} ${shown}`, TOOL_LINE)
}

const TOOLS_KEPT = 3
const TEXT_KEPT = 400

/** A step's tool uses (the newest three kept, newest last) and whether it stopped at the output limit. */
export const applyStepDetail = (
  list: AgentRun[],
  id: string,
  uses: readonly { name: string; input: unknown }[],
  stopReason: string | null,
): AgentRun[] => {
  const i = list.findIndex(a => a.id === id)

  if (i < 0) {
    return list
  }

  // A step means the agent is working: whatever it waited on was answered.
  const a = settled(list[i]!)
  const tools = [...(a.detail?.tools ?? []), ...uses.map(toolLine)].slice(-TOOLS_KEPT)
  const detail = { ...a.detail, tools, ...(stopReason === 'max_tokens' ? { isCutOff: true } : {}) }

  return replaceAt(list, i, { ...a, detail })
}

/** The start of the run's answer, kept for the card; an empty answer leaves none. */
export const applyAnswer = (list: AgentRun[], id: string, answer: string): AgentRun[] => {
  const i = list.findIndex(a => a.id === id)

  if (i < 0 || answer.trim() === '') {
    return list
  }

  const a = list[i]!

  return replaceAt(list, i, { ...a, detail: { ...a.detail, answer: clip(answer, TEXT_KEPT) } })
}

/** The task a subagent was given, as the card keeps it. */
export const taskOf = (prompt: string): string => clip(prompt, TEXT_KEPT)

/**
 * A permission check on one of the subagent's calls: an ask or a denial is counted, and
 * an ask stays pending on its call until that call returns, the agent steps again, or the
 * run ends. Who answered an ask (the person, the classifier) is not something the engine
 * says, so "asked" counts asks, not people asked.
 */
export const applyCheck = (list: AgentRun[], id: string, decision: 'allow' | 'ask' | 'deny', toolUseId: string): AgentRun[] => {
  const i = list.findIndex(a => a.id === id)

  if (i < 0 || decision === 'allow') {
    return list
  }

  const a = list[i]!
  const was = a.checks ?? { asked: 0, denied: 0 }
  const checks = decision === 'ask' ? { ...was, asked: was.asked + 1 } : { ...was, denied: was.denied + 1 }
  const pending = decision === 'ask' ? [...(a.pending ?? []).filter(one => one !== toolUseId), toolUseId] : a.pending

  return replaceAt(list, i, { ...a, checks, ...(pending === undefined ? {} : { pending }) })
}

/** A call of the subagent's returned: an ask on it is no longer pending. */
export const applyCallDone = (list: AgentRun[], id: string, toolUseId: string): AgentRun[] => {
  const i = list.findIndex(a => a.id === id)
  const a = list[i]

  if (a === undefined || !(a.pending ?? []).includes(toolUseId)) {
    return list
  }

  const left = a.pending!.filter(one => one !== toolUseId)
  const { pending: _all, ...rest } = a

  return replaceAt(list, i, left.length === 0 ? rest : { ...rest, pending: left })
}
