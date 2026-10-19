import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, EarlyStep, Panel, Session } from '../types'
import { RECONCILE_MS, applyComplete, applyStep, ctxPercent, applyAnswer, applyCallDone, applyCheck, applyStepDetail, finishRow, noteTurn, openRow, reconcileRows, reopenRow, sumUsage, taskOf, toolLine, totals } from './agents'
import type { Usage } from './agents'
import { BAND_H, CARD_H, STRIP_H, bandSvg, bandText, cardAlt, cardMeta, cardStats, cardSvg, headerSvg, headerText, stripSvg } from './draw'
import { LAUNCH_GRACE_MS, doneStatus, parseLaunches, parseNotifications } from './launches'

const AGENTS = { plugin: 'agents-panel', key: 'agents' } as const
const PANEL = { plugin: 'agents-panel', key: 'panel' } as const
const NOW = { plugin: 'agents-panel', key: 'now' } as const
const SESSION = { plugin: 'agents-panel', key: 'session' } as const
const LAST_RECONCILE = { plugin: 'agents-panel', key: 'lastReconcileAt' } as const
const EARLY = { plugin: 'agents-panel', key: 'early' } as const
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

      return end === undefined
        ? opened
        : applyAnswer(applyComplete(opened, run.id, end.reason, end.usage, end.at, end.turnId), run.id, end.answer ?? '')
    })

    if (kept !== undefined) {
      const { [run.id]: _folded, ...rest } = early
      await $.state.set(EARLY, rest)
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

/** Cards open at once: their details stay well under the drawing's size limit. */
const OPEN_CAP = 3

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
      await queue($, l => finishRow(l, a.id, status, at))
    } else if (x.deadline !== null && at > x.deadline) {
      await queue($, l => finishRow(l, a.id, 'lost', at))
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

  let infos: readonly { id: string; status: string }[]

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
      const env = { HOME: await $.env.get('HOME'), TMPDIR: await $.env.get('TMPDIR') }
      // In a subagent, a Codex run is that subagent's own work (codex-rescue), which has its row.
      const launches = parseLaunches(e.command, env).filter(l => e.agentId === undefined || !l.type.startsWith('codex:'))
      const at = await $.clock.now()
      const base = e.tool_use_id ?? `bash-${at}`
      const rows: AgentRun[] = launches.map((launch, i) => ({
        id: `${base}:${i}`,
        type: launch.type,
        description: e.description || launch.type,
        model: launch.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        tokens: 0,
        steps: 0,
        external: { doneFile: launch.doneFile, deadline: null },
      }))

      if (rows.length > 0) {
        await queue($, list => rows.reduce(openRow, list))
        ids = rows.map(r => r.id)
        timeouts = launches.map(l => l.timeoutMs)

        if (options.autoOpen !== false) {
          await autoOpen($)
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
            await queue($, l => finishRow(l, a.id, status, at))
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
          await queue($, l => finishRow(l, a.id, status, at))
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
    } else {
      await reconcile($, true)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const isOpen = await togglePane($)

    return { text: isOpen ? 'Agents panel opened.' : 'Agents panel closed.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value: list = [] } = await $.state.get(AGENTS)
    const { value: p = BLANK_PANEL } = await $.state.get(PANEL)
    const { value: session = null } = await $.state.get(SESSION)
    const { value: tickNow = 0 } = await $.state.get(NOW)
    const at = Math.max(tickNow, ...list.map(a => a.startedAt), 0)
    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const t = totals(list, at)
    const MAX_CARDS = 50
    const shownFinished = finished.slice(0, MAX_CARDS)
    const moreFinished = finished.length - shownFinished.length
    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? 'Expand' : 'Collapse'}
        plain
        onPress={() => void editPanel($, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
        plain
        onPress={() => void editPanel($, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )

    // A card opens to its task, newest tool uses, a cut-off, and the start of its answer.
    const opened = new Set(p.open ?? [])
    const hasDetail = (a: AgentRun): boolean =>
      a.detail !== undefined &&
      (a.detail.task !== undefined || (a.detail.tools ?? []).length > 0 || a.detail.answer !== undefined || a.detail.isCutOff === true)
    const detailToggle = (a: AgentRun) =>
      !hasDetail(a) ? null : (
        <Button
          key={`detail:${a.id}`}
          label={opened.has(a.id) ? '▾ details' : '▸ details'}
          plain
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

      return (
        <Box flexDirection="column">
          <Svg source={headerSvg(W, t)} alt={headerText(t)} width={W} height={44} />
          {toggleCompact}
          {list.length === 0 && <Text dimColor>No subagents yet.</Text>}
          {running.length > 0 && <Text dimColor>{`Running · ${running.length}`}</Text>}
          {running.map(a => (
            <Box key={`card:${a.id}`} flexDirection="column">
              <Svg source={cardSvg(W, a, at, session)} alt={cardAlt(a, at, session)} width={W} height={CARD_H} />
              {detailToggle(a)}
              {detailBlock(a)}
            </Box>
          ))}
          {finished.length > 0 && toggleDone}
          {!p.isDoneCollapsed &&
            shownFinished.map(a => (
              <Box key={`card:${a.id}`} flexDirection="column">
                <Svg source={cardSvg(W, a, at, session)} alt={cardAlt(a, at, session)} width={W} height={CARD_H} />
                {detailToggle(a)}
                {detailBlock(a)}
              </Box>
            ))}
          {!p.isDoneCollapsed && moreFinished > 0 && <Text dimColor>{`+${moreFinished} more`}</Text>}
        </Box>
      )
    }

    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const GLYPH: Record<AgentRun['status'], string> = { running: '●', done: '✓', failed: '✗', lost: '○' }
    const colorOf = (a: AgentRun): 'red' | 'green' | 'gray' | 'magenta' =>
      a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : a.status === 'lost' ? 'gray' : 'magenta'
    const row = (a: AgentRun) => {
      const pct = a.status === 'lost' ? null : ctxPercent(a, session)
      const fillPct = a.status === 'done' ? 100 : (pct ?? 0)
      const filled = Math.round((barW * fillPct) / 100)

      return (
        <Box key={`card:${a.id}`} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={colorOf(a)}>{GLYPH[a.status]}</Text>
            <Text bold={a.status !== 'lost'} dimColor={a.status === 'lost'} wrap="truncate-end">
              {a.description || a.type}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">{`  ${cardMeta(a)}`}</Text>
          <Text wrap="truncate-end">
            {'  '}
            <Text color={a.status === 'done' ? 'green' : 'magenta'}>{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(Math.max(0, barW - filled))}</Text>
            <Text dimColor>{` ${cardStats(a, at, session)}`}</Text>
          </Text>
          {detailToggle(a)}
          {detailBlock(a)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{headerText(t)}</Text>
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
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever another mod draws in the band stays; this row goes after it.
    const beneath = await next(e)
    const { value: list = [] } = await $.state.get(AGENTS)
    const running = list.filter(a => a.status === 'running')

    if (e.props.hasSurvey || running.length === 0) {
      return beneath
    }

    const { value: tickNow = 0 } = await $.state.get(NOW)
    const at = Math.max(tickNow, ...running.map(a => a.startedAt))
    const text = bandText(running, at)
    const { Box, Text, Button } = $.ui.resolve(e)
    const button = <Button key="agents-open" label={`×${running.length}`} plain onPress={() => void togglePane($)} />

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve({ ...e, surface: 'desktop' })
      const W = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))

      return (
        <Box flexDirection="column">
          {beneath}
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={bandSvg(W, running, at)} alt={text} width={W} height={BAND_H} />
            {button}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {beneath}
        <Box>
          <Text color="magenta" bold>
            ●{' '}
          </Text>
          <Text>{text} </Text>
          {button}
        </Box>
      </Box>
    )
  })
}
