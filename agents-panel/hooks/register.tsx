import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, CodexLimits, EarlyStep, Panel, Session, Usage as VendorUsage } from '../types'
import { RECONCILE_MS, agentRowPrefix, applyComplete, applyReport, applyStep, ctxPercent, applyAnswer, applyCallDone, applyCheck, applyStepDetail, backendOf, finishRow, harvestRow, noteTurn, openRow, reconcileRows, reopenRow, statusWord, sumUsage, taskOf, toolLine, totals } from './agents'
import type { ListedAgent, Usage } from './agents'
import { BACKEND_NAME, BAND_H, PANE_SVG_BUDGET, STRIP_H, bandSvg, bandText, cardAlt, cardHeight, cardMeta, cardReadout, cardStats, cardSvg, cardsWithin, detailLines, hasDetail, finishedAlt, finishedGroups, finishedHeight, finishedRows, finishedSvg, groupLine, headerHeight, headerSvg, headerText, stripSvg } from './draw'
import { LAUNCH_GRACE_MS, doneExit, doneStatus, doneTokens, parseLaunches, parseNotifications } from './launches'
import { TAIL_BYTES, codexDayDir, codexHomeOf, dayStart, mergeUsage, newestWritten, parseCodexTail, parseLedger, pickRollout } from './usage'

const AGENTS = { plugin: 'agents-panel', key: 'agents' } as const
const PANEL = { plugin: 'agents-panel', key: 'panel' } as const
const NOW = { plugin: 'agents-panel', key: 'now' } as const
const SESSION = { plugin: 'agents-panel', key: 'session' } as const
const LAST_RECONCILE = { plugin: 'agents-panel', key: 'lastReconcileAt' } as const
const EARLY = { plugin: 'agents-panel', key: 'early' } as const
const USAGE = { plugin: 'agents-panel', key: 'usage' } as const
/** Ids whose steps can wait for their spawn card; the oldest falls off past this. */
const EARLY_CAP = 20
export const PANE = 'agents'
export const COMMAND = 'agents-panel'
const BLANK_PANEL: Panel = { isCompact: false, isDoneCollapsed: false, hasAutoOpened: false }

/** Every edit of the row list goes through one chain, so overlapping events apply one at a time. */
let chain: Promise<void> = Promise.resolve()

/** Read, apply, write with ifVersion; again on a miss, so two edits in flight both land. */
const edit = async ($: EngineInterface, fn: (list: AgentRun[]) => AgentRun[]): Promise<void> => {
  for (let tries = 0; tries < 8; tries += 1) {
    const { value: list = [], version } = await $.state.get(AGENTS)
    const next = fn(list)

    if (next === list) {
      return
    }

    const { isSet } = await $.state.set(AGENTS, next, { ifVersion: version })

    if (isSet) {
      return
    }
  }
}

export const queue = ($: EngineInterface, fn: (list: AgentRun[]) => AgentRun[]): Promise<void> => {
  const run = chain.then(() => edit($, fn))
  chain = run.catch(() => undefined)

  return run
}

/**
 * A subagent step, on the row chain: added to its row, or kept under its id when the row
 * is not there yet (the step beat the spawn hook's answer) for the spawn to fold in.
 */
const stepOrKeep = (
  $: EngineInterface,
  id: string,
  usage: Usage | null,
  model: string,
  effort: unknown,
  at: number,
  began: number,
  turnId: string,
  uses: readonly { name: string; input: unknown }[],
  stop: string | null,
): Promise<void> => {
  const run = chain.then(async () => {
    const { value: list = [] } = await $.state.get(AGENTS)

    // One edit for the step's detail and its figures, so nothing (a card replaced by a
    // spawn) can land between them.
    if (list.some(a => a.id === id)) {
      await edit($, l => {
        const noted = applyStepDetail(l, id, uses, stop)

        return usage === null ? noted : applyStep(noted, id, usage, model, effort, at, turnId, began)
      })

      return
    }

    const sum = usage === null ? null : sumUsage(usage)
    const tools = uses.map(toolLine)

    if (sum === null && tools.length === 0 && stop !== 'max_tokens') {
      return
    }

    const { value: early = {} } = await $.state.get(EARLY)
    const prev = early[id]
    const others = Object.keys(early).filter(k => k !== id).slice(-(EARLY_CAP - 1))
    const kept: Record<string, EarlyStep> = Object.fromEntries(others.map(k => [k, early[k]!]))
    kept[id] = {
      ...(prev?.ended === undefined ? {} : { ended: prev.ended }),
      ...(prev?.reported === undefined ? {} : { reported: prev.reported }),
      tokens: (prev?.tokens ?? 0) + (sum?.tokens ?? 0),
      context: sum?.context ?? prev?.context ?? 0,
      steps: (prev?.steps ?? 0) + (sum === null ? 0 : 1),
      model: usage?.model || model || prev?.model || '',
      turnId,
      ...(sum === null && prev?.turns === undefined
        ? {}
        : { turns: sum === null ? prev!.turns! : noteTurn(prev?.turns, turnId, (prev?.turns?.[turnId] ?? 0) + 1) }),
      ...(tools.length === 0 && prev?.tools === undefined ? {} : { tools: [...(prev?.tools ?? []), ...tools].slice(-3) }),
      ...(stop === 'max_tokens' || prev?.isCutOff === true ? { isCutOff: true as const } : {}),
      // Permission checks counted before the card opened survive a usage step.
      ...(prev?.checks === undefined ? {} : { checks: prev.checks }),
    }
    await $.state.set(EARLY, kept)
  })
  chain = run.catch(() => undefined)

  return run
}

/**
 * Opens a spawn's card in one step of the row chain, with whatever arrived for its id
 * before it (steps, a completion) folded in and forgotten, so nothing in between can
 * count them twice or overwrite newer figures with older ones.
 */
const openSpawn = ($: EngineInterface, run: AgentRun): Promise<void> => {
  const go = chain.then(async () => {
    const { value: early = {} } = await $.state.get(EARLY)
    const kept = early[run.id]

    await edit($, list => {
      const card: AgentRun = {
        ...run,
        variant: list.filter(a => a.variant !== undefined).length,
        ...(kept === undefined
          ? {}
          : {
              tokens: kept.tokens,
              contextTokens: kept.context,
              steps: kept.steps,
              model: kept.model || run.model,
              ...(kept.turnId === undefined ? {} : { turnId: kept.turnId }),
              ...(kept.turns === undefined ? {} : { turns: kept.turns }),
              detail: {
                ...run.detail,
                ...(kept.tools === undefined ? {} : { tools: kept.tools }),
                ...(kept.isCutOff === true ? { isCutOff: true as const } : {}),
              },
              ...(kept.checks === undefined ? {} : { checks: kept.checks }),
              ...(kept.pending === undefined || kept.pending.length === 0 ? {} : { pending: kept.pending }),
            }),
      }
      const opened = openRow(list, card)
      const end = kept?.ended
      const ended =
        end === undefined
          ? opened
          : applyAnswer(applyComplete(opened, run.id, end.reason, end.usage, end.at, end.turnId), run.id, end.answer ?? '')
      const report = kept?.reported

      return report === undefined ? ended : applyReport(ended, run.id, report.status, report.at)
    })

    if (kept !== undefined) {
      const { [run.id]: _folded, ...rest } = early
      await $.state.set(EARLY, rest)
    }

    // It opened already over: the reconcile that would read its final figures may have run first.
    if (kept?.ended !== undefined || kept?.reported !== undefined) {
      settleSoon($)
    }
  })
  chain = go.catch(() => undefined)

  return go
}

/** A permission check on the row chain: applied to its card, or held until the card opens. */
const checkOrKeep = ($: EngineInterface, id: string, decision: 'ask' | 'deny', call: string): Promise<void> => {
  const go = chain.then(async () => {
    const { value: list = [] } = await $.state.get(AGENTS)

    if (list.some(a => a.id === id)) {
      await edit($, l => applyCheck(l, id, decision, call))

      return
    }

    const { value: early = {} } = await $.state.get(EARLY)
    const prev = early[id] ?? { tokens: 0, context: 0, steps: 0, model: '' }
    const others = Object.keys(early).filter(k => k !== id).slice(-(EARLY_CAP - 1))
    const kept: Record<string, EarlyStep> = Object.fromEntries(others.map(k => [k, early[k]!]))
    const was = prev.checks ?? { asked: 0, denied: 0 }
    kept[id] = {
      ...prev,
      checks: decision === 'ask' ? { ...was, asked: was.asked + 1 } : { ...was, denied: was.denied + 1 },
      ...(decision === 'ask' ? { pending: [...(prev.pending ?? []), call].slice(-20) } : {}),
    }
    await $.state.set(EARLY, kept)
  })
  chain = go.catch(() => undefined)

  return go
}

/**
 * A subagent's completion, on the row chain: applied to its row, or kept with its early
 * steps when the row is not there yet, for the spawn to apply as it opens the card.
 */
const completeOrKeep = (
  $: EngineInterface,
  id: string,
  reason: string,
  usage: Usage | null,
  at: number,
  turnId: string,
  answer: string,
): Promise<void> => {
  const go = chain.then(async () => {
    const { value: list = [] } = await $.state.get(AGENTS)

    if (list.some(a => a.id === id)) {
      await edit($, l => applyAnswer(applyComplete(l, id, reason, usage, at, turnId), id, answer))

      return
    }

    const { value: early = {} } = await $.state.get(EARLY)
    const prev = early[id] ?? { tokens: 0, context: 0, steps: 0, model: '' }
    const others = Object.keys(early).filter(k => k !== id).slice(-(EARLY_CAP - 1))
    const kept: Record<string, EarlyStep> = Object.fromEntries(others.map(k => [k, early[k]!]))
    kept[id] = { ...prev, ended: { reason, at, turnId, usage, answer: taskOf(answer) } }
    await $.state.set(EARLY, kept)
  })
  chain = go.catch(() => undefined)

  return go
}

/**
 * How the engine reported a subagent's run ended, on the row chain: applied to its row,
 * or held with what else came early when the row is not there yet, for the spawn to apply.
 */
const reportOrKeep = ($: EngineInterface, id: string, status: 'completed' | 'failed' | 'stopped', at: number): Promise<void> => {
  const go = chain.then(async () => {
    const { value: list = [] } = await $.state.get(AGENTS)

    if (list.some(a => a.id === id)) {
      await edit($, l => applyReport(l, id, status, at))

      return
    }

    // A card /clear took away: its report is the earlier conversation's, not a card to come.
    if (clearedIds.has(id)) {
      return
    }

    const { value: early = {} } = await $.state.get(EARLY)
    const prev = early[id] ?? { tokens: 0, context: 0, steps: 0, model: '' }
    const others = Object.keys(early).filter(k => k !== id).slice(-(EARLY_CAP - 1))
    const kept: Record<string, EarlyStep> = Object.fromEntries(others.map(k => [k, early[k]!]))
    kept[id] = { ...prev, reported: { status, at } }
    await $.state.set(EARLY, kept)
  })
  chain = go.catch(() => undefined)

  return go
}

/** How long after a subagent ends the list is read once more, for its final figures (its cost). */
const SETTLE_MS = 3_000
/**
 * The ids /clear or /resume took finished cards away for. A report of one of them that
 * arrives afterwards belongs to the earlier conversation: it is dropped, not held for a
 * card, so a later run under the same id never opens closed by it. A card under such an id
 * takes its report directly, so only a report that beats its card is dropped.
 */
const clearedIds = new Set<string>()

/** One settle read pending at a time; an end while one waits asks for one more after it. */
let settleArmed = false
let settleAgain = false
let settleEpoch = 0

/**
 * After a subagent ends, one forced reconcile a moment later: the tick stops once nothing
 * runs, so the last agent of a turn that ends while the main loop is idle would otherwise
 * keep the figures of its last tick. Ends that land together share one read; an end while
 * a read waits gets a read of its own after it. /clear drops a pending read.
 */
const settleSoon = ($: EngineInterface): void => {
  if (settleArmed) {
    settleAgain = true

    return
  }

  settleArmed = true
  settleAgain = false
  const epoch = settleEpoch

  try {
    $.clock.after(SETTLE_MS, () => {
      if (epoch !== settleEpoch) {
        return
      }

      settleArmed = false
      void reconcile($, true).catch(() => undefined)

      if (settleAgain) {
        settleSoon($)
      }
    })
  } catch {
    // no timer: the next end tries again rather than finding a read that never comes
    settleArmed = false
  }
}

/** Panel edits (presses, toggles, resets) apply one at a time, so two presses never drop one. */
let panelChain: Promise<void> = Promise.resolve()

const editPanel = ($: EngineInterface, fn: (p: Panel) => Panel): Promise<void> => {
  const run = panelChain.then(async () => {
    const { value: p = BLANK_PANEL } = await $.state.get(PANEL)
    await $.state.set(PANEL, fn(p))
  })
  panelChain = run.catch(() => undefined)

  return run
}

/**
 * Codex's own defaults from ~/.codex/config.toml (top-level `model`, `model_reasoning_effort`),
 * for a Codex run whose command names neither; empty when the file is missing or unreadable.
 */
export const codexDefaults = async ($: EngineInterface, codexHome: string | null): Promise<{ model?: string; effort?: string }> => {
  try {
    const file = `${codexHome ?? ''}/config.toml`

    if (codexHome === null || !(await $.fs.exists(file))) {
      return {}
    }

    const text = await $.fs.read(file)
    // top level only: everything before the first [table] header
    const top = text.split(/^\s*\[/m)[0] ?? ''
    const key = (name: string): string | undefined => new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']+)["']`, 'm').exec(top)?.[1]
    const model = key('model')
    const effort = key('model_reasoning_effort')

    return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }
  } catch {
    return {}
  }
}

/** Cards open at once: their details stay well under the drawing's size limit. */
const OPEN_CAP = 3
/** Cells from a card's left edge to its details toggle: about the card's text column (56 px at 8 px a cell), less the button's own inset. */
const CARD_FOOT_LEFT = 6

/** The launcher's verdict from its done file, or null while the file has not landed. */
const landed = async ($: EngineInterface, doneFile: string | null): Promise<'done' | 'failed' | null> => {
  try {
    if (doneFile === null || !(await $.fs.exists(doneFile))) {
      return null
    }
  } catch {
    return null
  }

  try {
    return doneStatus(await $.fs.read(doneFile))
  } catch {
    return 'done'
  }
}

/** The last TAIL_BYTES of a file as text; null when it is missing or unreadable. */
const readTail = async ($: EngineInterface, file: string): Promise<string | null> => {
  try {
    if (!(await $.fs.exists(file))) {
      return null
    }

    const { size } = await $.fs.stat(file)

    return await $.fs.read(file, { as: 'text', offset: Math.max(0, size - TAIL_BYTES), length: TAIL_BYTES })
  } catch {
    return null
  }
}

/** The Codex session logs of the local day `at` falls in, oldest first, and the one written last; empty when the folder is missing. */
const rolloutsOf = async ($: EngineInterface, codexHome: string, at: number): Promise<{ dir: string; names: string[]; newest: string | null }> => {
  const dir = codexDayDir(codexHome, at)

  try {
    const files = (await $.fs.exists(dir)) ? (await $.fs.list(dir)).filter(f => f.kind === 'file') : []

    return { dir, names: files.map(f => f.name).sort(), newest: newestWritten(files) }
  } catch {
    return { dir, names: [], newest: null }
  }
}

/** The tail of the Codex session log written last, today's or (just past midnight, with none yet today) yesterday's. */
const newestTail = async ($: EngineInterface, codexHome: string, at: number): Promise<string | null> => {
  for (const day of [at, at - 86_400_000]) {
    const { dir, newest } = await rolloutsOf($, codexHome, day)

    if (newest !== null) {
      return readTail($, `${dir}/${newest}`)
    }
  }

  return null
}

/**
 * The usage strip's figures, read again: the consult ledger's Cursor and Antigravity tokens
 * for today, and Codex's rate-limit windows from `limits` or, without one, its newest session
 * log of the day. A source that cannot be read keeps the figure it had. Never throws.
 */
export const refreshUsage = async ($: EngineInterface, limits?: CodexLimits): Promise<void> => {
  try {
    const at = await $.clock.now()
    const home = await $.env.get('HOME')
    const next: Partial<VendorUsage> = {}

    if (home !== undefined) {
      const ledger = await readTail($, `${home}/.claude/metrics/consult-ledger.jsonl`)

      if (ledger !== null) {
        Object.assign(next, parseLedger(ledger, dayStart(at)))
      }

      let codex = limits

      if (codex === undefined) {
        const codexHome = codexHomeOf({ HOME: home, CODEX_HOME: await $.env.get('CODEX_HOME') })
        const tail = codexHome === null ? null : await newestTail($, codexHome, at)

        codex = tail === null ? undefined : parseCodexTail(tail).limits
      }

      if (codex !== undefined) {
        next.codex = codex
      }
    }

    const { value: prev = null } = await $.state.get(USAGE)
    await $.state.set(USAGE, mergeUsage(prev, next, at))
  } catch {
    // the strip keeps what it showed
  }
}

/**
 * What a finished external row left behind, read once: a buddy seat's exit code and tokens
 * from its done file; a Codex run's tokens from its own session log, whose rate-limit figures
 * go to the usage strip. Then the strip's ledger figures are read again. Never throws.
 */
const harvest = async ($: EngineInterface, id: string): Promise<void> => {
  let limits: CodexLimits | undefined

  try {
    const { value: list = [] } = await $.state.get(AGENTS)
    const a = list.find(r => r.id === id)
    const x = a?.external

    if (a === undefined || x === undefined || a.status === 'running' || x.tokens !== undefined) {
      return
    }

    const found: { tokens?: number; exit?: number; log?: string } = {}

    if (x.doneFile !== null) {
      if (await $.fs.exists(x.doneFile)) {
        const text = await $.fs.read(x.doneFile)
        const exit = doneExit(text)
        const tokens = doneTokens(text)
        Object.assign(found, exit === null ? {} : { exit }, tokens === null ? {} : { tokens })
      }
    } else if (a.type.startsWith('codex:') && x.noLog !== true) {
      // a run with no log of its own (`--ephemeral`, `resume`) reads none: the nearest log is another run's
      const home = x.codexHome ?? codexHomeOf({ HOME: await $.env.get('HOME'), CODEX_HOME: await $.env.get('CODEX_HOME') })

      if (home !== null) {
        const { dir, names } = await rolloutsOf($, home, a.startedAt)
        const taken = list.flatMap(r => (r.external?.log === undefined ? [] : [r.external.log]))
        const log = pickRollout(names, a.startedAt, a.endedAt ?? (await $.clock.now()), taken)
        const tail = log === null ? null : await readTail($, `${dir}/${log}`)

        if (log !== null && tail !== null) {
          const read = parseCodexTail(tail)
          limits = read.limits
          Object.assign(found, { log }, read.tokens === undefined ? {} : { tokens: read.tokens })
        }
      }
    }

    await queue($, l => harvestRow(l, id, found))
  } catch {
    // the card keeps its elapsed time and shows no tokens
  }

  await refreshUsage($, limits)
}

/** An external row's end: its status, then what it left behind. */
const endExternal = async ($: EngineInterface, id: string, status: 'done' | 'failed' | 'lost', at: number): Promise<void> => {
  await queue($, l => finishRow(l, id, status, at))
  await harvest($, id)
}

/** Every running external row: over when its done file has landed, lost past its deadline. */
const settleExternal = async ($: EngineInterface, at: number): Promise<void> => {
  const { value: list = [] } = await $.state.get(AGENTS)

  for (const a of list) {
    const x = a.external

    if (a.status !== 'running' || x === undefined) {
      continue
    }

    const status = await landed($, x.doneFile)

    if (status !== null) {
      await endExternal($, a.id, status, at)
    } else if (x.deadline !== null && at > x.deadline) {
      await endExternal($, a.id, 'lost', at)
    }
  }
}

/** $.agent.list() against every running row. Forced by the main turn's end; the tick is throttled. */
export const reconcile = async ($: EngineInterface, force: boolean): Promise<void> => {
  const at = await $.clock.now()
  const { value: last = 0, version } = await $.state.get(LAST_RECONCILE)

  if (!force && at - last < RECONCILE_MS) {
    return
  }

  // Claim the slot before the list is awaited (compare-and-set, so an overlapping caller misses);
  // a rejected list hands the old stamp back, so the next tick retries.
  const { isSet } = await $.state.set(LAST_RECONCILE, at, { ifVersion: version })

  if (!isSet && !force) {
    return
  }

  await settleExternal($, at)

  let infos: readonly ListedAgent[]

  try {
    infos = await $.agent.list()
  } catch {
    await $.state.set(LAST_RECONCILE, last)

    return
  }

  await queue($, list => reconcileRows(list, infos, at))
}

/** Opens the pane, or closes it when it is up; true when it ends up open. */
export const togglePane = async ($: EngineInterface): Promise<boolean> => {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)

  if (isOpen) {
    await $.ui.close({ id: PANE })

    return false
  }

  await $.ui.open({ id: PANE, title: 'Agents' })

  return true
}

const autoOpenOnce = async ($: EngineInterface): Promise<void> => {
  const { value: p = BLANK_PANEL, version } = await $.state.get(PANEL)

  if (p.hasAutoOpened) {
    return
  }

  // Compare-and-set: whoever lands the flag opens the pane; a concurrent caller misses and returns.
  const { isSet } = await $.state.set(PANEL, { ...p, hasAutoOpened: true }, { ifVersion: version })

  if (!isSet) {
    return
  }

  await $.ui.open({ id: PANE, title: 'Agents' })
}

/** Once per session, on the first subagent: serialized on the chain so two spawns in one tick open it once. */
export const autoOpen = ($: EngineInterface): Promise<void> => {
  const run = chain.then(() => autoOpenOnce($))
  chain = run.catch(() => undefined)

  return run
}

const tick = async ($: EngineInterface): Promise<void> => {
  const { value: list = [] } = await $.state.get(AGENTS)

  if (!list.some(a => a.status === 'running')) {
    return
  }

  await $.state.set(NOW, await $.clock.now())
  await reconcile($, false)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The clock first: a throw below must never stop elapsed time from moving (2026-10-12,
    // when the refused `/agents` name threw here and every running row sat at 0:00).
    $.clock.every(1000, () => {
      void tick($).catch(() => undefined)
    })

    try {
      // `/agents` is the engine's built-in and is refused, so the toggle has a name of its own.
      await $.command.register({
        name: COMMAND,
        description: "Show or hide the panel of this session's subagents: running, finished, model, context, tokens and time",
      })
    } catch {
      // No slash command; the band's ×n button still toggles the pane.
    }

    return started
  })

  // /clear, /resume and /branch end this conversation and start another with no session.start:
  // finished cards belong to the old one; a run still going keeps its card. The pane may open
  // itself again for the new conversation's first subagent.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      // A read armed for the old conversation is dropped; the new one arms its own.
      settleEpoch += 1
      settleArmed = false
      settleAgain = false
      const { value: before = [] } = await $.state.get(AGENTS)
      before.filter(a => a.status !== 'running').forEach(a => clearedIds.add(a.id))
      await queue($, list => (list.every(a => a.status === 'running') ? list : list.filter(a => a.status === 'running')))
      await editPanel($, p => ({ ...p, hasAutoOpened: false, open: [] }))
      await $.state.set(EARLY, {})
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)

    if (started.deny !== undefined || started.agentId === undefined) {
      return started
    }

    const at = await $.clock.now()
    const resumedId = e.resume?.agentId

    // A resumed subagent or a teammate brought back: the row it already has runs again,
    // its figures and costume kept, rather than a fresh card at zero.
    if (resumedId !== undefined) {
      const { value: list = [] } = await $.state.get(AGENTS)

      if (list.some(a => a.id === resumedId)) {
        // A new run of the same agent: its new task; the earlier run's tools and answer go.
        const task = e.prompt.trim() === '' ? {} : { detail: { task: taskOf(e.prompt) } }
        await queue($, l =>
          l.map(a => {
            if (a.id !== resumedId) {
              return a
            }

            const { detail: _earlier, pending: _asked, ...rest } = reopenRow(a, at)

            return { ...rest, ...task }
          }),
        )

        return started
      }
    }

    const run: AgentRun = {
      id: started.agentId,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      status: 'running',
      startedAt: at,
      contextTokens: 0,
      tokens: 0,
      steps: 0,
      ...(e.prompt.trim() === '' ? {} : { detail: { task: taskOf(e.prompt) } }),
    }
    // Numbered in spawn order, so agents of the same type take turns through the Clawd costumes.
    await openSpawn($, run)

    if (options.autoOpen !== false) {
      await autoOpen($)
    }

    return started
  }).catch(($, e, next) => next(e))

  // Permission checks on a subagent's calls reach its card: asks and denials counted,
  // an ask shown until the agent steps again. Observes only: the decision it returns is
  // the one beneath it, and a failure here replays the call.
  on('tool.check', async ($, e, next) => {
    const decided = await next(e)
    const id = e.agentId

    const call = e.tool_use_id

    if (id !== undefined && call !== undefined && (decided.decision === 'ask' || decided.decision === 'deny')) {
      try {
        await checkOrKeep($, id, decided.decision, call)
      } catch {
        // the card misses one count; the call is unaffected
      }
    }

    return decided
  }).catch(($, e, next) => next(e))

  // A subagent's call returned: an ask on it is answered. Observes only.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const id = e.agentId
    const call = e.tool_use_id

    if (id !== undefined && call !== undefined) {
      try {
        await queue($, list => applyCallDone(list, id, call))
      } catch {
        // a pending mark stays until the next step clears it
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  // A buddy seat or a Codex run started by Bash: a row per launch the command names. Errors
  // here never re-run the call: the rows open before it, and close after it, in guards of their own.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let ids: string[] = []
    let timeouts: number[] = []

    try {
      const env = { HOME: await $.env.get('HOME'), TMPDIR: await $.env.get('TMPDIR'), CODEX_HOME: await $.env.get('CODEX_HOME') }
      const parsed = parseLaunches(e.command, env)
      const isCodex = (l: { type: string }): boolean => l.type.startsWith('codex:')
      const defaults = parsed.some(isCodex) ? await codexDefaults($, parsed.find(isCodex)?.codexHome ?? codexHomeOf(env)) : {}
      // A Codex run's model and effort: its flags, else Codex's config defaults.
      const codexOf = (l: { model: string; effort?: string; ignoresConfig?: true }): { model: string; effort?: string } => {
        // `--ignore-user-config` runs without the config these defaults come from
        const d = l.ignoresConfig === true ? {} : defaults
        const model = l.model !== 'codex' ? l.model : (d.model ?? 'codex')
        const effort = l.effort ?? d.effort

        return { model, ...(effort === undefined ? {} : { effort }) }
      }
      const relayed = e.agentId === undefined ? undefined : parsed.find(isCodex)

      // In a subagent, a Codex run is that subagent's own work (codex-rescue), which has its
      // row: the row takes the Codex model and effort instead of opening a second one.
      if (relayed !== undefined) {
        const codex = codexOf(relayed)
        await queue($, list => list.map(a => (a.id === e.agentId ? { ...a, codex } : a)))
      }

      const launches = parsed.filter(l => e.agentId === undefined || !isCodex(l))
      const at = await $.clock.now()
      const base = e.tool_use_id ?? `bash-${at}`
      const rows: AgentRun[] = launches.map((launch, i) => {
        const codex = isCodex(launch) ? codexOf(launch) : null
        const effort = codex === null ? launch.effort : codex.effort

        return {
          id: `${base}:${i}`,
          type: launch.type,
          description: e.description || launch.type,
          model: codex === null ? launch.model : codex.model,
          ...(effort === undefined ? {} : { effort }),
          status: 'running',
          startedAt: at,
          contextTokens: 0,
          tokens: 0,
          steps: 0,
          external: {
            doneFile: launch.doneFile,
            deadline: null,
            ...(launch.capMs === undefined ? {} : { capMs: launch.capMs }),
            ...(launch.codexHome === undefined ? {} : { codexHome: launch.codexHome }),
            ...(launch.noLog === true ? { noLog: true as const } : {}),
          },
        }
      })

      if (rows.length > 0) {
        // The usage strip's figures as this launch finds them (two tail reads); it never throws.
        await refreshUsage($)
        await queue($, list => rows.reduce(openRow, list))
        ids = rows.map(r => r.id)
        timeouts = launches.map(l => l.timeoutMs)

        if (options.autoOpen !== false) {
          // The rows are open by now: a pane that fails to open must not cost
          // them their completion bookkeeping, or they stay running for good.
          try {
            await autoOpen($)
          } catch {
            // no pane: the band and /agents-panel still show the rows
          }
        }
      }
    } catch {
      ids = []
    }

    if (ids.length === 0) {
      return next(e)
    }

    const close = async (status: 'done' | 'failed'): Promise<void> => {
      try {
        const at = await $.clock.now()
        await queue($, list => ids.reduce((l, id) => finishRow(l, id, status, at), list))

        for (const id of ids) {
          await harvest($, id)
        }
      } catch {
        // The row stays running; the deadline, or the next session, ends it.
      }
    }
    let ran: Awaited<ReturnType<typeof next>>

    try {
      ran = await next(e)
    } catch (err) {
      await close('failed')
      throw err
    }

    // Backgrounded by the call, by ctrl+b, or by its timeout: its task notification ends it,
    // the turn's end ends it once its task is no longer in flight, and its timeout (the
    // launcher's, a wrapper's, or Codex's default) plus a grace bounds it whatever happens.
    const taskId = (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId ?? ''
    const isBackground = e.run_in_background === true || taskId !== ''

    // A call asked to background that errored without a task id never started: a
    // PreToolUse hook's deny (background-timeout-gate) comes back as an error result,
    // and no notification will ever end the row (ghost "Running" rows, 2026-10-12).
    if (ran.deny !== undefined || (ran.isError === true && taskId === '')) {
      await close('failed')
    } else if (!isBackground) {
      // An error never reaches here: without a task id the branch above failed it.
      await close('done')
    } else {
      try {
        const at = await $.clock.now()
        await queue($, list =>
          ids.reduce((l, id, i) => {
            const j = l.findIndex(a => a.id === id && a.status === 'running')
            const a = l[j]
            const ms = timeouts[i] ?? 0

            if (a === undefined || a.external === undefined || (ms <= 0 && taskId === '')) {
              return l
            }

            const external = {
              ...a.external,
              ...(ms > 0 ? { deadline: at + ms + LAUNCH_GRACE_MS } : {}),
              ...(taskId !== '' ? { taskId } : {}),
            }

            return l.map((b, k) => (k === j ? { ...a, external } : b))
          }, list),
        )
      } catch {
        // No deadline or task id: the notification still ends it.
      }
    }

    return ran
  })

  // A background task's notification ends the rows its call opened; a launcher's done file,
  // when it has landed, says done or failed better than the shell's own exit does.
  on('prompt.submit', async ($, e, next) => {
    try {
      const ends = e.text.includes('<task-notification>') ? parseNotifications(e.text) : []

      if (ends.length > 0) {
        const at = await $.clock.now()
        const { value: list = [] } = await $.state.get(AGENTS)

        for (const end of ends) {
          for (const a of list) {
            if (a.external === undefined || a.status !== 'running' || !a.id.startsWith(`${end.toolUseId}:`)) {
              continue
            }

            const status = (await landed($, a.external.doneFile)) ?? (end.status === 'completed' ? 'done' : 'failed')
            await endExternal($, a.id, status, at)
          }
        }
      }
    } catch {
      // A row left running here ends at its deadline or with the session.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The main turn's end lists the background work still in flight. A backgrounded row whose
  // task is not among it has ended, even when its notification never reached prompt.submit
  // (one delivered into a running turn): its done file decides, else done. Never blocks.
  on('classic.Stop', async ($, e, next) => {
    try {
      const live = e.background_tasks

      if (Array.isArray(live)) {
        const inFlight = new Set(live.map(t => t.id))
        const at = await $.clock.now()
        const { value: list = [] } = await $.state.get(AGENTS)

        for (const a of list) {
          const x = a.external

          if (x === undefined || a.status !== 'running' || x.taskId === undefined || inFlight.has(x.taskId)) {
            continue
          }

          const status = (await landed($, x.doneFile)) ?? 'done'
          await endExternal($, a.id, status, at)
        }
      }
    } catch {
      // A row left running here ends with its notification or at its deadline.
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    // When the request began: a step on a finished row that began before it ended is late, not a resume.
    const began = e.agentId === undefined ? 0 : await $.clock.now()
    const result = yield* next(e)

    const usage = result.usage ?? null

    // A subagent's step: what it asked for, whether it hit the output limit, and its
    // figures, kept whether or not it reported usage.
    if (e.agentId !== undefined) {
      const at = await $.clock.now()
      await stepOrKeep($, e.agentId, usage, e.model, e.effort, at, began, e.turnId, result.toolUses ?? [], result.stopReason ?? null)

      return result
    }

    if (usage === null) {
      return result
    }

    // The main loop: its model and context window, for the cards' context percent.
    let window: number | null = null

    try {
      window = (await $.session.usage()).context.window
    } catch {
      window = null
    }

    const session: Session = { model: usage.model || e.model, window }
    await $.state.set(SESSION, session)

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const at = await $.clock.now()
      const usage = e.usage ?? null
      await completeOrKeep($, id, e.reason, usage, at, e.turnId, e.answer)
      settleSoon($)
    } else {
      await reconcile($, true)
    }

    return next(e)
  })

  // How the engine says a subagent's run ended: a stopped run is shown as stopped, not
  // failed. Observes only: the report the parent reads is the one beneath, untouched.
  // Applied before the report goes on: the parent learns of the end only through it, so a
  // resume of the same agent cannot land first and be closed by this run's report.
  on('agent.report', async ($, e, next) => {
    try {
      const at = await $.clock.now()
      await reportOrKeep($, e.agentId, e.status, at)
      settleSoon($)
    } catch {
      // the card keeps what its completion said
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The engine's own agent rows (the terminal's list under the prompt, the desktop's
  // Background tasks, VS Code's subagents) get the agent's context fill and cost in
  // front of their words, so they show with the pane closed. Only `label` changes.
  on('ui.render', { component: 'AgentRow' }, async ($, e, next) => {
    if (options.agentRows === false) {
      return next(e)
    }

    const { value: list = [] } = await $.state.get(AGENTS)
    const prefix = agentRowPrefix(e.props, list.find(a => a.id === e.props.id))

    if (prefix === '') {
      return next(e)
    }

    // An empty label (no progress yet, no description) takes the figures alone, no dangling separator.
    const words = e.props.label.trim()
    const label = words === '' ? prefix.replace(/ · $/, '') : `${prefix}${e.props.label}`

    return next({ ...e, props: { ...e.props, label } })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => {
    try {
      const isOpen = await togglePane($)

      return { text: isOpen ? 'Agents panel opened.' : 'Agents panel closed.' }
    } catch {
      return { text: 'Agents panel: this surface could not open or close the pane.' }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value: list = [] } = await $.state.get(AGENTS)
    const { value: p = BLANK_PANEL } = await $.state.get(PANEL)
    const { value: session = null } = await $.state.get(SESSION)
    const { value: tickNow = 0 } = await $.state.get(NOW)
    const { value: usage = null } = await $.state.get(USAGE)
    const at = Math.max(tickNow, ...list.map(a => a.startedAt), 0)
    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const t = totals(list, at)
    const MAX_CARDS = 50
    // By default the finished runs are summarised, one row per vendor and model; a run that did not
    // end done keeps its card. `showsEachDone` lists every finished card, as before 0.8.0.
    const isEach = p.showsEachDone === true
    const summary = finishedGroups(finished, at)
    const listed = isEach ? finished : summary.attention
    const shownFinished = listed.slice(0, MAX_CARDS)
    const moreFinished = listed.length - shownFinished.length
    const isDesktop = e.surface === 'desktop'
    const compactPress = () => void editPanel($, prev => ({ ...prev, isCompact: !prev.isCompact }))
    const compactLabel = p.isCompact ? '▾ Expand' : '▴ Collapse'
    // a desktop draws its own secondary button, with the padding a bare text label lacked; the terminal keeps the plain label
    const toggleCompact = isDesktop ? (
      <Box key="compact-row" flexDirection="row" paddingY="sm">
        <Button key="compact" label={compactLabel} variant="secondary" onPress={compactPress} />
      </Box>
    ) : (
      <Button key="compact" label={compactLabel} plain onPress={compactPress} />
    )
    const hasDone = summary.groups.length > 0
    const toggleEach =
      p.isDoneCollapsed || !hasDone ? null : (
        <Button
          key="each"
          label={isEach ? 'Summary' : 'Each card'}
          plain
          dimColor
          onPress={() => void editPanel($, prev => ({ ...prev, showsEachDone: prev.showsEachDone !== true }))}
        />
      )
    const toggleDone = (
      // the toggle sits beside the label: spread across the row it landed past the drawings' right edge,
      // since the row spans the pane and every drawing stops at W
      <Box key="done-row" flexDirection="row" gap="md">
        <Button
          key="done"
          label={`${p.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
          plain
          onPress={() => void editPanel($, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
        />
        {toggleEach}
      </Box>
    )

    // A card opens to its task, newest tool uses, a cut-off, and the start of its answer.
    const opened = new Set(p.open ?? [])
    const detailToggle = (a: AgentRun) =>
      !hasDetail(a) ? null : (
        <Button
          key={`detail:${a.id}`}
          label={opened.has(a.id) ? '▾ Hide details' : '▸ Details'}
          plain
          dimColor
          onPress={() =>
            void editPanel($, prev => {
              // Only cards still listed stay open; the newest OPEN_CAP win.
              const live = (prev.open ?? []).filter(id => id !== a.id && list.some(r => r.id === id))
              const next = (prev.open ?? []).includes(a.id) ? live : [...live, a.id].slice(-OPEN_CAP)

              return { ...prev, open: next }
            })
          }
        />
      )
    const detailBlock = (a: AgentRun) =>
      !opened.has(a.id) || a.detail === undefined ? null : (
        <Box key={`detail-body:${a.id}`} flexDirection="column" paddingLeft={2}>
          {a.detail.task !== undefined && <Text dimColor wrap="wrap">{`Task: ${a.detail.task}`}</Text>}
          {(a.detail.tools ?? []).map((line, i) => (
            <Text key={`tool:${a.id}:${i}`} dimColor wrap="truncate-end">{`· ${line}`}</Text>
          ))}
          {a.detail.isCutOff === true && <Text color="yellow">Stopped at the output limit</Text>}
          {a.detail.answer !== undefined && <Text dimColor wrap="wrap">{`Answer: ${a.detail.answer}`}</Text>}
        </Box>
      )

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve({ ...e, surface: 'desktop' })
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))

      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1}>
            <Svg source={stripSvg(W, list, t)} alt={headerText(t)} width={W} height={STRIP_H} />
            {toggleCompact}
          </Box>
        )
      }

      // One render's markup is bounded (PANE_SVG_BUDGET): the header, then the running cards,
      // then the newest finished ones that still fit; the rest are counted, not drawn.
      const head = headerSvg(W, t, usage, at)
      const sum = p.isDoneCollapsed || isEach || !hasDone ? '' : finishedSvg(W, summary.groups)
      const drawn = (rows: AgentRun[], budget: number): { cards: { a: AgentRun; source: string }[]; used: number } => {
        const all = rows.map(a => ({ a, source: cardSvg(W, a, at, session, opened.has(a.id)) }))
        const cards = all.slice(0, cardsWithin(all.map(c => c.source.length), budget))

        return { cards, used: cards.reduce((n, c) => n + c.source.length, 0) }
      }
      const run = drawn(running, PANE_SVG_BUDGET - head.length)
      const fin = p.isDoneCollapsed ? { cards: [], used: 0 } : drawn(shownFinished, Math.max(0, PANE_SVG_BUDGET - head.length - run.used - sum.length))
      const moreRunning = running.length - run.cards.length
      const moreDone = listed.length - fin.cards.length
      // opened, a card's details are drawn inside it; its alt carries them too, for a reader that cannot see the drawing
      const altOf = (a: AgentRun): string =>
        opened.has(a.id) ? [cardAlt(a, at, session), ...detailLines(a, W).map(l => l.text)].join('. ') : cardAlt(a, at, session)
      const card = ({ a, source }: { a: AgentRun; source: string }) => (
        // the toggle is laid over the strip the card keeps along its bottom edge (CARD_FOOT_H), inside its outline:
        // the Box shrinks to the drawing, whose bottom edge is the outline's, so `bottom={0}` needs no pixel figure
        <Box key={`card:${a.id}`} flexDirection="column" position="relative" alignSelf="flex-start">
          <Svg source={source} alt={altOf(a)} width={W} height={cardHeight(a, at, session, W, opened.has(a.id))} />
          {hasDetail(a) && (
            <Box key={`foot:${a.id}`} position="absolute" bottom={0} left={CARD_FOOT_LEFT} flexDirection="row" paddingBottom="xs">
              {detailToggle(a)}
            </Box>
          )}
        </Box>
      )

      return (
        <Box flexDirection="column">
          <Svg source={head} alt={headerText(t, usage, at)} width={W} height={headerHeight(W, usage, at)} />
          {toggleCompact}
          {list.length === 0 && <Text dimColor>No subagents yet.</Text>}
          {running.length > 0 && <Text dimColor>{`Running · ${running.length}`}</Text>}
          {run.cards.map(card)}
          {moreRunning > 0 && <Text dimColor>{`+${moreRunning} more running`}</Text>}
          {finished.length > 0 && toggleDone}
          {fin.cards.map(card)}
          {!p.isDoneCollapsed && moreDone > 0 && <Text dimColor>{`+${moreDone} more`}</Text>}
          {sum !== '' && <Svg key="summary" source={sum} alt={finishedAlt(summary.groups)} width={W} height={finishedHeight(finishedRows(summary.groups))} />}
        </Box>
      )
    }

    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const GLYPH: Record<AgentRun['status'], string> = { running: '●', done: '✓', failed: '✗', stopped: '■', lost: '○' }
    const colorOf = (a: AgentRun): 'red' | 'green' | 'gray' | 'yellow' | 'magenta' =>
      a.status === 'failed'
        ? 'red'
        : a.status === 'done'
          ? 'green'
          : a.status === 'stopped'
            ? 'yellow'
            : a.status === 'lost'
              ? 'gray'
              : 'magenta'
    const row = (a: AgentRun) => {
      // A bar only while it measures something: a subagent's context, an external seat's timeout.
      const read = cardReadout(a, at, session)
      const filled = read.ratio === null ? 0 : Math.max(1, Math.round(barW * read.ratio))

      return (
        <Box key={`card:${a.id}`} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={colorOf(a)}>{GLYPH[a.status]}</Text>
            <Text bold={a.status !== 'lost'} dimColor={a.status === 'lost'} wrap="truncate-end">
              {a.description || a.type}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">{`  ${BACKEND_NAME[backendOf(a)]} · ${cardMeta(a)} · ${statusWord(a)}`}</Text>
          <Text wrap="truncate-end">
            {'  '}
            {read.ratio !== null && <Text color={read.isWarn ? 'yellow' : 'magenta'}>{'█'.repeat(filled)}</Text>}
            {read.ratio !== null && <Text dimColor>{`${'░'.repeat(Math.max(0, barW - filled))} `}</Text>}
            <Text dimColor>{cardStats(a, at, session)}</Text>
          </Text>
          {detailToggle(a)}
          {detailBlock(a)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{headerText(t, usage, at)}</Text>
          {toggleCompact}
        </Box>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={colorOf(a)}>
                {GLYPH[a.status]}{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {list.length === 0 && <Text dimColor>No subagents yet.</Text>}
            {running.length > 0 && <Text dimColor>{`Running · ${running.length}`}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && shownFinished.map(row)}
            {!p.isDoneCollapsed && moreFinished > 0 && <Text dimColor>{`+${moreFinished} more`}</Text>}
            {!p.isDoneCollapsed &&
              !isEach &&
              summary.groups.map(g => (
                <Text key={`group:${g.backend}:${g.meta}`} dimColor wrap="truncate-end">
                  {`  ${groupLine(g)}`}
                </Text>
              ))}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band asks each plugin for its own row (Claude Code 2.1.323+) and stacks
    // the rows itself (AbovePromptList), so this hook draws only this mod's row.
    const { value: list = [] } = await $.state.get(AGENTS)
    const running = list.filter(a => a.status === 'running')

    if (e.props.hasSurvey || running.length === 0) {
      return next(e)
    }

    const { value: tickNow = 0 } = await $.state.get(NOW)
    const at = Math.max(tickNow, ...running.map(a => a.startedAt))
    const text = bandText(running, at)
    const { Box, Text, Button } = $.ui.resolve(e)

    // Collapsed, nothing of the row is on screen: its words, and no drawing.
    if (e.props.isCollapsed) {
      return <Text dimColor>{text}</Text>
    }
    const button = <Button key="agents-open" label={`×${running.length}`} plain onPress={() => void togglePane($).catch(() => undefined)} />

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve({ ...e, surface: 'desktop' })
      const W = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))

      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={bandSvg(W, running, at)} alt={text} width={W} height={BAND_H} />
          {button}
        </Box>
      )
    }

    return (
      <Box>
        <Text color="magenta" bold>
          ●{' '}
        </Text>
        <Text>{text} </Text>
        {button}
      </Box>
    )
  })
}
