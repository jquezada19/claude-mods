import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AgentRun } from '../types'

// The test host runs the module under a real timer, but the mod's lib (es2023, no DOM, no Node) declares none.
declare const setTimeout: (callback: () => void, ms: number) => unknown

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const SECOND = 1000
const SURFACES = ['terminal', 'desktop'] as const
const EMPTY = { type: 'Box', props: {}, children: [] } as never
// A subagent's steps and its completion share the turn id, as the engine sends them.
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
const STEP = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as const

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}
type Info = { id: string; status: string }

/** The engine beneath the mod: a clock, the agent list, the session usage, the panes, and the spawn answer. */
const world = (on: On, now = T0) => {
  const clock = mock.clock(on, { now })
  const it = {
    clock,
    usage: null as Usage | null,
    /** Awaited inside the engine's step, so a test can let time pass or events land mid-request. */
    duringStep: null as null | (() => Promise<void>),
    infos: [] as Info[],
    listFails: false,
    listCalls: 0,
    listDelayMs: 0,
    usageFails: false,
    window: 200_000,
    opens: [] as string[],
    panes: new Set<string>(),
    spawnAnswer: (e: { subagentType: string }) => ({ model: 'claude-opus-5-5', agentId: `id-${e.subagentType}` }) as Record<string, unknown>,
    spawnCalls: 0,
    state: new Map<string, unknown>(),
    sets: [] as string[],
    stateSetFailsOnce: false,
    /** The engine refuses `/agents` as a built-in name, as this build does (2026-10-10 debug log). */
    registerRefuses: false,
    /** What a lower plugin draws in the band, when a test wants something beneath. */
    beneath: '',
    /** The next step's tool uses and stop reason. */
    toolUses: [] as { name: string; input: unknown }[],
    stopReason: 'end_turn' as string | null,
  }
  // The test engine has no state noun: mirror every write the mod makes so a test can read it back.
  // `stateSetFailsOnce` stands for the mod's own bookkeeping throwing after a spawn's next().
  on('state.set', (_, e, next) => {
    if (it.stateSetFailsOnce && e.key === 'agents') {
      it.stateSetFailsOnce = false
      throw new Error('state hiccup')
    }

    it.state.set(e.key, e.value)
    it.sets.push(e.key)

    return next(e)
  })
  on('session.start', () => ({ cwd: '/t' }) as never)
  on('command.register', (_, e) => {
    if (it.registerRefuses) {
      throw new Error(`$.command.register: "/${e.name}" refused: it is the built-in /${e.name}`)
    }

    return { value: { command: e.name } } as never
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => {
    if (it.usageFails) {
      throw new Error('no usage')
    }

    return { value: { startedAt: now, context: { window: it.window }, rateLimits: [], cost: { usd: 0 } } } as never
  })
  on('agent.list', async () => {
    it.listCalls += 1

    if (it.listFails) {
      throw new Error('no list')
    }

    if (it.listDelayMs > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, it.listDelayMs))
    }

    return { value: it.infos.map(one => ({ ...one, description: '', type: 'x' })) } as never
  })
  on('agent.spawn', (_, e) => {
    it.spawnCalls += 1

    return it.spawnAnswer(e as never) as never
  })
  on('ui.open', (_, e) => {
    it.opens.push(e.id)
    it.panes.add(e.id)

    return { value: { isPlaced: true } } as never
  })
  on('ui.close', (_, e) => {
    it.panes.delete(e.id)

    return { value: undefined } as never
  })
  on('ui.panes', () => ({ value: [...it.panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('turn.step', async function* (_, e) {
    if (it.duringStep !== null) {
      await it.duringStep()
    }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: it.toolUses, stopReason: it.stopReason, usage: it.usage } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', (_, e) =>
    e.component === 'AbovePrompt' && it.beneath !== '' ? ({ type: 'Text', props: {}, children: [it.beneath] } as never) : EMPTY,
  )

  return it
}

type Kit = Engine
type World = ReturnType<typeof world>

const spawn = ($: Kit, type = 'general-purpose', description = `run ${type}`, id = `tu-${type}`) =>
  $.agent.spawn({
    tool_use_id: id,
    prompt: 'do the thing',
    description,
    subagentType: type,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as never)

const u = (i: number, o = 0, r = 0, w = 0, model = 'claude-opus-5-5'): Usage => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: w,
  model,
})

/** One model request, read to its end; `agentId` undefined is the main loop. */
const step = async ($: Kit, it: World, usage: Usage | null, agentId?: string, effort?: unknown) => {
  it.usage = usage
  const s = $.turn.step({ ...STEP, ...(agentId === undefined ? {} : { agentId }), ...(effort === undefined ? {} : { effort }) } as never)
  for await (const _ of s) {
    // drain
  }
}

const complete = ($: Kit, agentId?: string, reason = 'answer', usage?: Usage) =>
  $.turn.complete({ ...TURN, reason, ...(agentId === undefined ? {} : { agentId }), ...(usage === undefined ? {} : { usage }) } as never)

const rows = async (it: World): Promise<AgentRun[]> => (it.state.get('agents') as AgentRun[] | undefined) ?? []

test('spawn: a row opens, the answer is returned unchanged, the pane opens once', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  const answer = await spawn($, 'Explore', 'find the thing')
  expect(answer).toEqual({ model: 'claude-opus-5-5', agentId: 'id-Explore' })
  const [a] = await rows(it)
  expect(a).toMatchObject({ id: 'id-Explore', type: 'Explore', description: 'find the thing', model: 'claude-opus-5-5', status: 'running', startedAt: T0, steps: 0 })
  expect(it.opens).toEqual(['agents'])
  await spawn($, 'Plan')
  expect(it.opens).toEqual(['agents'])
  expect((await rows(it)).length).toBe(2)
})

test('spawn: autoOpen false never opens the pane', { options: { autoOpen: false } }, async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($)
  expect(it.opens).toEqual([])
  expect((await rows(it)).length).toBe(1)
})

test('spawn: deny, no agentId, an engine rejection, and a bookkeeping throw after next', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  it.spawnAnswer = () => ({ deny: 'nope' })
  expect(await spawn($, 'a')).toEqual({ deny: 'nope' })
  it.spawnAnswer = () => ({ model: 'm' })
  await spawn($, 'b')
  expect(await rows(it)).toEqual([])
  it.spawnAnswer = () => {
    throw new Error('engine says no')
  }
  // The kit reports a throwing bottom as a skipped hook with nothing beneath; either way the spawn rejects.
  await expect(spawn($, 'c')).rejects.toThrow(/engine says no|no implementation for agent\.spawn/)
  expect(await rows(it)).toEqual([])
  expect(it.spawnCalls).toBe(3)
  // The mod's own failure after next: the state bottom throws once, the spawn still answers, and runs once.
  it.spawnAnswer = e => ({ model: 'm', agentId: `id-${e.subagentType}` })
  it.stateSetFailsOnce = true
  const before = it.spawnCalls
  expect(await spawn($, 'd')).toEqual({ model: 'm', agentId: 'id-d' })
  expect(it.spawnCalls).toBe(before + 1)
})

test('spawn with resume keeps the row: tokens, costume and active time carry on', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  await step($, it, u(100, 10), 'id-a')
  await it.clock.advance(5 * SECOND)
  await complete($, 'id-a')
  const [first] = await rows(it)
  await it.clock.advance(60 * SECOND)
  await $.agent.spawn({
    tool_use_id: 'tu-resume',
    prompt: 'one more thing',
    description: 'run a',
    subagentType: 'a',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    resume: { agentId: 'id-a' },
  } as never)
  const list = await rows(it)
  expect(list.length).toBe(1)
  expect(list[0]).toMatchObject({ status: 'running', tokens: 110, steps: 1, variant: first!.variant })
  expect('endedAt' in list[0]!).toBe(false)
  // Elapsed carries on from the first run's 5 s, not from the 60 s it sat finished.
  expect(list[0]!.startedAt).toBe(T0 + 60 * SECOND)
})

test('a step from a new turn reopens a finished subagent (a SendMessage resume raises no spawn)', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  await step($, it, u(100, 10), 'id-a')
  await complete($, 'id-a')
  it.usage = u(40, 4)
  for await (const _ of $.turn.step({ ...STEP, turnId: 't2', agentId: 'id-a' } as never)) {
    // drain
  }
  const [a] = await rows(it)
  expect(a).toMatchObject({ status: 'running', tokens: 154, steps: 2 })
})

test('early steps land once: a step before its spawn card is kept and folded into the card', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  // The subagent's first request lands before the spawn hook has its agentId back.
  await step($, it, u(100, 10, 20, 5), 'id-a')
  expect((await rows(it)).length).toBe(0)
  await spawn($, 'a')
  const [a] = await rows(it)
  expect(a).toMatchObject({ id: 'id-a', status: 'running', tokens: 135, contextTokens: 125, steps: 1 })
  expect((it.state.get('early') as Record<string, unknown> | undefined)?.['id-a']).toBeUndefined()
  // Later steps add normally; the early step is not counted twice.
  await step($, it, u(10), 'id-a')
  expect((await rows(it))[0]).toMatchObject({ tokens: 145, steps: 2 })
})

test('clear and resume each drop finished rows, re-arm auto-open and forget held steps; other endings change nothing', async ($, on) => {
  const it = world(on)
  on('session.end', (_, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  await $.session.start({ cwd: '/t' } as never)
  const early = () => (it.state.get('early') as Record<string, unknown> | undefined) ?? {}
  const opened = () => (it.state.get('panel') as { hasAutoOpened: boolean }).hasAutoOpened
  await spawn($, 'a')
  await $.session.end({ reason: 'other', sessionId: 's1' } as never)
  let n = 0
  for (const reason of ['clear', 'resume']) {
    // Fresh for each reason: a finished card, an opened pane, a step held for an unknown id.
    n += 1
    await spawn($, `done${n}`)
    await complete($, `id-done${n}`)
    await step($, it, u(5), `id-held${n}`)
    expect(opened()).toBe(true)
    expect(Object.keys(early())).toContain(`id-held${n}`)
    expect((await rows(it)).some(a => a.status === 'done')).toBe(true)
    await $.session.end({ reason, sessionId: 's1' } as never)
    expect((await rows(it)).map(a => a.id)).toEqual(['id-a'])
    expect(opened()).toBe(false)
    expect(early()).toEqual({})
  }
  // The next subagent opens the pane again.
  const before = it.opens.length
  await spawn($, 'c')
  expect(it.opens.length).toBe(before + 1)
})

test('early steps and a completion that race the spawn are counted once, and the row ends', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await step($, it, u(100, 10), 'id-a')
  // The completion lands while the spawn hook is still waiting on its answer.
  // The completion lands while the spawn hook is still waiting on its answer.
  await Promise.all([spawn($, 'a'), complete($, 'id-a', 'answer', u(100, 10))])
  const [a] = await rows(it)
  expect(a).toMatchObject({ status: 'done', tokens: 110, steps: 1 })
  expect((it.state.get('early') as Record<string, unknown> | undefined)?.['id-a']).toBeUndefined()
})

test('a card keeps its task, its newest tool uses, a cut-off, and the start of its answer', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await $.agent.spawn({
    tool_use_id: 'tu-a',
    prompt: `Find every place the status colors are defined. ${'More context. '.repeat(60)}`,
    description: 'run a',
    subagentType: 'a',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as never)
  it.toolUses = [{ name: 'Read', input: { file_path: '/1' } }, { name: 'Read', input: { file_path: '/2' } }]
  await step($, it, u(10), 'id-a')
  it.toolUses = [{ name: 'Grep', input: { pattern: 'color' } }]
  // A step that reports no usage still says what it asked for.
  await step($, it, null, 'id-a')
  it.toolUses = [{ name: 'Bash', input: { command: 'git log --oneline' } }]
  it.stopReason = 'max_tokens'
  await step($, it, u(10), 'id-a')
  await $.turn.complete({ ...TURN, agentId: 'id-a', answer: `Found three. ${'Detail. '.repeat(80)}` } as never)
  const [a] = await rows(it)
  expect(a!.detail?.task?.startsWith('Find every place the status colors are defined.')).toBe(true)
  expect(a!.detail?.task?.length).toBe(400)
  expect(a!.detail?.tools).toEqual(['Read /2', 'Grep color', 'Bash git'])
  expect(a!.detail?.isCutOff).toBe(true)
  expect(a!.detail?.answer?.startsWith('Found three.')).toBe(true)
  expect(a!.detail?.answer?.length).toBe(400)
})

test('what arrives before the card (tools, a cut-off, a long answer) is held clipped and lands on it', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  it.toolUses = [{ name: 'Read', input: { file_path: '/early' } }]
  it.stopReason = 'max_tokens'
  // A step with no usage: its tools are kept all the same.
  await step($, it, null, 'id-a')
  await $.turn.complete({ ...TURN, agentId: 'id-a', reason: 'answer', answer: `Early. ${'x'.repeat(5_000)}` } as never)
  const held = (it.state.get('early') as Record<string, { tools?: string[]; isCutOff?: boolean; ended?: { answer?: string } }>)['id-a']!
  expect(held.tools).toEqual(['Read /early'])
  expect(held.isCutOff).toBe(true)
  expect(held.ended?.answer?.length).toBe(400)
  await spawn($, 'a')
  const [a] = await rows(it)
  expect(a!.status).toBe('done')
  expect(a!.detail?.tools).toEqual(['Read /early'])
  expect(a!.detail?.isCutOff).toBe(true)
  expect(a!.detail?.answer?.startsWith('Early.')).toBe(true)
})

test('a resumed spawn shows its new task; the earlier run\'s tools and answer go', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  it.toolUses = [{ name: 'Read', input: { file_path: '/first' } }]
  await step($, it, u(10), 'id-a')
  await $.turn.complete({ ...TURN, agentId: 'id-a', answer: 'First answer.' } as never)
  await $.agent.spawn({
    tool_use_id: 'tu-resume',
    prompt: 'One more thing.',
    description: 'run a',
    subagentType: 'a',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    resume: { agentId: 'id-a' },
  } as never)
  const [a] = await rows(it)
  expect(a!.detail).toEqual({ task: 'One more thing.' })
})

test('at most three cards stay open; a card that leaves is no longer listed open; /clear shuts them all', async ($, on) => {
  const it = world(on)
  on('session.end', (_, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  await $.session.start({ cwd: '/t' } as never)
  for (const t of ['a', 'b', 'c', 'd']) {
    await spawn($, t)
    await complete($, `id-${t}`)
  }
  for (const t of ['a', 'b', 'c', 'd']) {
    const p = await pane($, 'terminal')
    await p.press(`detail:id-${t}`)
    await p.done()
  }
  const open = () => (it.state.get('panel') as { open?: string[] }).open ?? []
  expect(open()).toEqual(['id-b', 'id-c', 'id-d'])
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  expect(open()).toEqual([])
})

test('two details presses at once both land', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  await spawn($, 'b')
  const p = await pane($, 'terminal')
  await Promise.all([p.press('detail:id-a'), p.press('detail:id-b')])
  await p.done()
  expect([...((it.state.get('panel') as { open?: string[] }).open ?? [])].sort()).toEqual(['id-a', 'id-b'])
})

test('an agent id that looks like a button key cannot collide with one', async ($, on) => {
  const it = world(on)
  it.spawnAnswer = (e: { subagentType: string }) => ({ model: 'claude-opus-5-5', agentId: e.subagentType === 'y' ? 'detail:id-x' : `id-${e.subagentType}` })
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'x')
  await spawn($, 'y')
  for (const surface of SURFACES) {
    const p = await pane($, surface)
    const keys = p.buttons.map(one => String(one.props.key))
    expect(new Set(keys).size).toBe(keys.length)
    await p.press('detail:id-x')
    await p.done()
    expect((it.state.get('panel') as { open?: string[] }).open).toContain('id-x')
    const q = await pane($, surface)
    await q.press('detail:id-x')
    await q.done()
  }
})

test('a subagent\'s permission checks reach its card; the engine\'s answer passes through whole; the main loop is not counted', async ($, on) => {
  const it = world(on)
  let decided: Record<string, unknown> = { decision: 'ask', reason: 'needs approval', rule: 'Bash(rm:*)' }
  on('tool.check', () => decided as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  const r1 = await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'c1', agentId: 'id-a' } as never)
  expect(r1).toEqual({ decision: 'ask', reason: 'needs approval', rule: 'Bash(rm:*)' })
  let [a] = await rows(it)
  expect(a).toMatchObject({ checks: { asked: 1, denied: 0 }, pending: ['c1'] })
  decided = { decision: 'deny', reason: 'blocked' }
  const r2 = await $.tool.check({ tool: 'Bash', input: { command: 'rm y' }, tool_use_id: 'c2', agentId: 'id-a' } as never)
  expect(r2).toEqual({ decision: 'deny', reason: 'blocked' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'c3' } as never)
  ;[a] = await rows(it)
  expect(a!.checks).toEqual({ asked: 1, denied: 1 })
  let p = await pane($, 'terminal')
  expect(p.texts).toContain('1 asked · 1 denied · awaiting approval')
  await p.done()
  // The asked call returns (approved and run): no longer awaiting, before any next step.
  await $.tool.call({ tool: 'Read', file_path: '/x', tool_use_id: 'c1', agentId: 'id-a' } as never)
  ;[a] = await rows(it)
  expect('pending' in a!).toBe(false)
  p = await pane($, 'terminal')
  expect(p.texts).not.toContain('awaiting approval')
  await p.done()
})

test('a check that comes before the card is held and lands on it', async ($, on) => {
  const it = world(on)
  on('tool.check', () => ({ decision: 'ask' }) as never)
  await $.session.start({ cwd: '/t' } as never)
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'c1', agentId: 'id-a' } as never)
  await spawn($, 'a')
  const [a] = await rows(it)
  expect(a).toMatchObject({ checks: { asked: 1, denied: 0 }, pending: ['c1'] })
})

test('a step that reports no usage still clears a pending ask', async ($, on) => {
  const it = world(on)
  on('tool.check', () => ({ decision: 'ask' }) as never)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'c1', agentId: 'id-a' } as never)
  await step($, it, null, 'id-a')
  const [a] = await rows(it)
  expect('pending' in a!).toBe(false)
})

test('spawn: the same agentId replaces the row', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'x', 'first', 'tu-1')
  await spawn($, 'x', 'second', 'tu-2')
  const list = await rows(it)
  expect(list.length).toBe(1)
  expect(list[0]!.description).toBe('second')
})

test('step: figures follow the subagent steps; the main loop records model and window together', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  await step($, it, u(100, 10), 'id-a', 'high')
  await step($, it, u(200, 20, 50), 'id-a')
  await step($, it, u(300, 30, 60, 10), 'id-a', 3)
  const [a] = await rows(it)
  expect(a).toMatchObject({ contextTokens: 370, tokens: 780, steps: 3, effort: 'high', status: 'running' })
  await step($, it, null, 'id-a')
  await step($, it, { ...u(1), input_tokens: Number.NaN }, 'id-a')
  await step($, it, u(5), 'id-unknown')
  expect((await rows(it))[0]!.tokens).toBe(780)
  expect((await rows(it)).length).toBe(1)
  await step($, it, u(9, 1, 0, 0, 'claude-opus-5-5[1m]'))
  expect(it.state.get('session')).toEqual({ model: 'claude-opus-5-5[1m]', window: 200_000 })
  it.usageFails = true
  await step($, it, u(9))
  expect(it.state.get('session')).toEqual({ model: 'claude-opus-5-5', window: null })
})

test('complete: status from the reason, endedAt from the event clock, the zero-step fallback, a late step', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  await spawn($, 'b')
  await spawn($, 'c')
  await step($, it, u(100, 10), 'id-a')
  // Half a second past the last tick: endedAt must be the event's clock, not the tick's stored now.
  await it.clock.advance(19 * SECOND + 500)
  await complete($, 'id-a')
  await complete($, 'id-b', 'aborted', u(100, 10, 20, 30, 'claude-sonnet-5-5'))
  await complete($, 'id-c', 'error')
  await complete($, 'id-unknown')
  const [a, b, c] = await rows(it)
  expect(a).toMatchObject({ status: 'done', endedAt: T0 + 19 * SECOND + 500, tokens: 110, steps: 1 })
  expect(b).toMatchObject({ status: 'failed', tokens: 160, contextTokens: 150, steps: 1, model: 'claude-sonnet-5-5' })
  expect(c).toMatchObject({ status: 'failed', tokens: 0, steps: 0 })
  await step($, it, u(50), 'id-a')
  const [late] = await rows(it)
  expect(late).toMatchObject({ status: 'done', endedAt: T0 + 19 * SECOND + 500, tokens: 160 })
  expect((await rows(it)).length).toBe(3)
})

test('two completions in the same tick both land', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  await spawn($, 'b')
  await Promise.all([complete($, 'id-a'), complete($, 'id-b', 'error')])
  expect((await rows(it)).map(r => r.status)).toEqual(['done', 'failed'])
  await it.clock.settle()
})

test('reconcile: the main turn forces it, the tick throttles it, absence times out by steps', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  await spawn($, 'b')
  await spawn($, 'c')
  await spawn($, 'd')
  await step($, it, u(10), 'id-d')
  it.infos = [
    { id: 'id-a', status: 'completed' },
    { id: 'id-b', status: 'killed' },
    { id: 'id-c', status: 'idle' },
  ]
  await complete($)
  let list = await rows(it)
  expect(list.map(r => r.status)).toEqual(['done', 'failed', 'running', 'running'])
  expect(list[3]!.missingSince).toBe(T0)
  // 1 s later another main-turn end still reconciles (forced), even inside the throttle window.
  it.infos = [{ id: 'id-c', status: 'running' }, { id: 'id-d', status: 'running' }]
  await it.clock.advance(SECOND)
  await complete($)
  list = await rows(it)
  expect('missingSince' in list[3]!).toBe(false)
  // The tick: at most one reconcile per 10 s while a row runs, counted from the forced one at T0 + 1 s.
  it.infos = []
  await it.clock.advance(9 * SECOND)
  list = await rows(it)
  expect('missingSince' in list[3]!).toBe(false)
  await it.clock.advance(SECOND)
  list = await rows(it)
  expect(list[3]!.missingSince).toBe(T0 + 11 * SECOND)
  expect(list[2]!.missingSince).toBe(T0 + 11 * SECOND)
  await it.clock.advance(59 * SECOND)
  list = await rows(it)
  expect(list[2]!.status).toBe('running')
  await it.clock.advance(SECOND)
  list = await rows(it)
  expect(list[2]!.status).toBe('lost')
  expect(list[3]!.status).toBe('failed')
  expect(list[3]!.endedAt).toBe(T0 + 71 * SECOND)
})

test('reconcile: a list that rejects changes nothing, and an idle session never ticks state', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  it.listFails = true
  await complete($)
  expect((await rows(it))[0]!.status).toBe('running')
  expect('missingSince' in (await rows(it))[0]!).toBe(false)
  it.listFails = false
  await complete($, 'id-a')
  const before = it.sets.filter(k => k === 'now').length
  await it.clock.advance(5 * SECOND)
  expect(it.sets.filter(k => k === 'now').length).toBe(before)
})

test('201 completed spawns keep 200; 201 running spawns keep 201', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  for (let i = 0; i < 201; i += 1) {
    await spawn($, `f${i}`)
    await complete($, `id-f${i}`)
  }
  let list = await rows(it)
  expect(list.length).toBe(200)
  expect(list[0]!.id).toBe('id-f1')
  expect(list[199]!.id).toBe('id-f200')
  for (let i = 0; i < 201; i += 1) {
    await spawn($, `r${i}`)
  }
  list = await rows(it)
  expect(list.filter(r => r.status === 'running').length).toBe(201)
  await it.clock.settle()
})

const band = async ($: Kit, surface: (typeof SURFACES)[number]) => {
  const ui = await $.ui.mount({
    plugin: 'agents-panel',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, bodyColumns: 120 },
  } as never)
  const h = ui as never as {
    findAll: (q: { type: string }) => Promise<{ type: string; text?: string; props: Record<string, unknown> }[]>
    press: (t: { key: string }) => Promise<unknown>
  }
  const texts = (await h.findAll({ type: 'Text' })).map(one => one.text ?? '').join('')
  const svgs = await h.findAll({ type: 'Svg' })
  const buttons = await h.findAll({ type: 'Button' })
  const press = async (key: string) => {
    await h.press({ key })
  }
  // One instance per site: a later call mounts afresh.
  const done = async () => (ui as never as { unmount: () => Promise<void> }).unmount()

  return { texts, svgs, buttons, press, done }
}

const pane = async ($: Kit, surface: (typeof SURFACES)[number], bodyColumns = 80) => {
  const ui = await $.ui.mount({
    plugin: 'agents-panel',
    surface,
    component: 'Pane',
    requestId: 'agents',
    props: { title: 'Agents', isFocused: false, bodyColumns, placement: 'dock' },
  } as never)
  const h = ui as never as {
    findAll: (q: { type: string }) => Promise<{ type: string; text?: string; props: Record<string, unknown> }[]>
    press: (t: { key: string }) => Promise<unknown>
  }
  const texts = (await h.findAll({ type: 'Text' })).map(one => one.text ?? '').join('\n')
  const svgs = await h.findAll({ type: 'Svg' })
  const alts = svgs.map(one => String(one.props.alt ?? ''))
  const buttons = await h.findAll({ type: 'Button' })
  const press = async (key: string) => {
    await h.press({ key })
  }
  const done = async () => (ui as never as { unmount: () => Promise<void> }).unmount()

  return { texts, svgs, alts, buttons, press, done, all: `${texts}\n${alts.join('\n')}` }
}

for (const surface of SURFACES) {
  test(`${surface}: a card's details open and close on its own button, one card at a time`, async ($, on) => {
    const it = world(on)
    await $.session.start({ cwd: '/t' } as never)
    await $.agent.spawn({
      tool_use_id: 'tu-a',
      prompt: 'Find every place the status colors are defined.',
      description: 'run a',
      subagentType: 'a',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    } as never)
    await spawn($, 'b')
    it.toolUses = [{ name: 'Read', input: { file_path: '/src/colors.ts' } }]
    it.stopReason = 'max_tokens'
    await step($, it, u(10), 'id-a')
    await $.turn.complete({ ...TURN, agentId: 'id-a', answer: 'Found three definitions.' } as never)
    let p = await pane($, surface)
    expect(p.all).not.toContain('Task:')
    // The cut-off shows on the card without opening it.
    expect(p.all).toContain('cut off')
    await p.press('detail:id-a')
    await p.done()
    p = await pane($, surface)
    expect(p.texts).toContain('Task: Find every place the status colors are defined.')
    expect(p.texts).toContain('Read /src/colors.ts')
    expect(p.texts).toContain('Answer: Found three definitions.')
    expect(p.texts).toContain('Stopped at the output limit')
    // The other card stays shut.
    expect(p.texts).not.toContain('do the thing')
    await p.press('detail:id-a')
    await p.done()
    p = await pane($, surface)
    expect(p.texts).not.toContain('Task:')
    await p.done()
  })

  test(`${surface}: the band is beneath alone with nothing running, and beneath plus the row while an agent runs`, async ($, on) => {
    const it = world(on)
    // Something beneath: one Text row from a lower plugin.
    it.beneath = 'BENEATH'
    await $.session.start({ cwd: '/t' } as never)
    let b = await band($, surface)
    expect(b.texts).toBe('BENEATH')
    expect(b.svgs.length).toBe(0)
    await b.done()
    await spawn($, 'Explore')
    await spawn($, 'Plan')
    // The engine lists both as running, or the 60 s absence rule would end them during the wait.
    it.infos = [
      { id: 'id-Explore', status: 'running' },
      { id: 'id-Plan', status: 'running' },
    ]
    await step($, it, u(400_000), 'id-Explore')
    await it.clock.advance(134 * SECOND)
    b = await band($, surface)
    expect(b.texts.startsWith('BENEATH')).toBe(true)
    const text = '2 running · 400k · 2:14'
    if (surface === 'desktop') {
      expect(b.svgs.length).toBe(1)
      expect(b.svgs[0]!.props.alt).toBe(text)
      expect(String(b.svgs[0]!.props.source)).toContain('class="c-pirate run"')
    } else {
      expect(b.texts).toContain(text)
    }
    expect(b.buttons.map(one => one.props.label)).toEqual(['×2'])
    await b.press('agents-open')
    expect(it.panes.has('agents')).toBe(false)
    await b.press('agents-open')
    expect(it.panes.has('agents')).toBe(true)
    await b.done()
    await complete($, 'id-Explore')
    await complete($, 'id-Plan', 'error')
    b = await band($, surface)
    expect(b.texts).toBe('BENEATH')
    expect(b.svgs.length).toBe(0)
    await b.done()
  })

  test(`${surface}: a survey hides the row; a lost row does not draw it`, async ($, on) => {
    const it = world(on)
    await $.session.start({ cwd: '/t' } as never)
    await spawn($, 'a')
    const ui = await $.ui.mount({
      plugin: 'agents-panel',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: true, isWorking: false, bodyColumns: 120 },
    } as never)
    const found = await (ui as never as { findAll: (q: { type: string }) => Promise<unknown[]> }).findAll({ type: 'Button' })
    expect(found.length).toBe(0)
    await (ui as never as { unmount: () => Promise<void> }).unmount()
    it.infos = []
    await complete($)
    await it.clock.advance(60 * SECOND)
    expect((await rows(it))[0]!.status).toBe('lost')
    const b = await band($, surface)
    expect(b.buttons.length).toBe(0)
    await b.done()
  })

  test(`${surface}: the pane lists rows with their figures, folds finished rows, collapses, and says when empty`, async ($, on) => {
    const it = world(on)
    await $.session.start({ cwd: '/t' } as never)
    let p = await pane($, surface)
    expect(p.all).toContain('No subagents yet.')
    await p.done()
    await spawn($, 'codex:codex-rescue', 'diagnose the leak')
    await spawn($, 'general-purpose', 'fix a<b && c')
    await step($, it, u(9))
    await step($, it, u(82_000, 1000, 0, 0), 'id-codex:codex-rescue', 'high')
    await it.clock.advance(19 * SECOND)
    await complete($, 'id-codex:codex-rescue')
    p = await pane($, surface)
    expect(p.all).toContain('diagnose the leak')
    expect(p.all).toContain('codex-rescue')
    expect(p.all).toContain('Opus 5.5')
    expect(p.all).toContain('ctx 41% · 82k · 83k · 0:19')
    expect(p.all).toContain('fix a<b && c')
    if (surface === 'desktop') {
      expect(p.svgs.some(one => String(one.props.source).includes('fix a&lt;b &amp;&amp; c'))).toBe(true)
      expect(p.svgs.every(one => String(one.props.alt ?? '') !== '')).toBe(true)
      expect(p.alts[0]).toBe('2 agents · 83k · 0:19')
    } else {
      expect(p.texts).toContain('2 agents · 83k · 0:19')
    }
    // The pane's own toggles, and one details button per card that has something to show.
    const keys = p.buttons.map(one => String(one.props.key))
    expect(keys.filter(k => !k.startsWith('detail:'))).toEqual(['compact', 'done'])
    expect(keys.filter(k => k.startsWith('detail:')).sort()).toEqual(['detail:id-codex:codex-rescue', 'detail:id-general-purpose'])
    await p.press('done')
    await p.done()
    p = await pane($, surface)
    expect(p.all).not.toContain('diagnose the leak')
    expect(p.all).toContain('fix a<b && c')
    await p.press('done')
    await p.press('compact')
    await p.done()
    p = await pane($, surface)
    expect(p.buttons.map(one => one.props.label)).toEqual(['Expand'])
    if (surface === 'desktop') {
      expect(p.alts.length).toBe(1)
      expect(String(p.svgs[0]!.props.source)).toContain('c-codex"')
    }
    await p.done()
  })
}

test('desktop: the pane draws at most 50 finished cards and a +n line; a lost row shows dashes', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  for (let i = 0; i < 60; i += 1) {
    await spawn($, `f${i}`)
    await complete($, `id-f${i}`)
  }
  await spawn($, 'ghost')
  it.infos = []
  await complete($)
  await it.clock.advance(60 * SECOND)
  const p = await pane($, 'desktop')
  // The header and 50 cards: the lost ghost is a finished row like the sixty done ones.
  expect(p.svgs.length).toBe(1 + 50)
  expect(p.texts).toContain('+11 more')
  expect(p.alts.some(a => a.includes('run ghost:') && a.includes('lost') && a.includes('— · —'))).toBe(true)
})

test('/agents toggles the pane', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  expect(await $.command.run({ command: 'agents-panel', args: '' } as never)).toEqual({ text: 'Agents panel opened.' })
  expect(it.panes.has('agents')).toBe(true)
  expect(await $.command.run({ command: 'agents-panel', args: '' } as never)).toEqual({ text: 'Agents panel closed.' })
  expect(it.panes.has('agents')).toBe(false)
})

test('review: two spawns in the same tick open the pane once; two ticks in flight list the agents once', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await Promise.all([spawn($, 'a'), spawn($, 'b')])
  expect(it.opens).toEqual(['agents'])
  // Reconcile: while a forced reconcile still waits on the list, ticks 9 s later stay throttled
  // because the slot was claimed before the wait; ticks past 10 s get through.
  it.listCalls = 0
  it.listDelayMs = 1500
  it.infos = [
    { id: 'id-a', status: 'running' },
    { id: 'id-b', status: 'running' },
  ]
  const forced = complete($)
  await it.clock.advance(9 * SECOND)
  await forced
  expect(it.listCalls).toBe(1)
  it.listDelayMs = 0
  await it.clock.advance(20 * SECOND)
  expect(it.listCalls).toBeGreaterThanOrEqual(2)
})

test('review: a rejected list leaves lastReconcileAt alone, so the next tick retries', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  it.infos = [{ id: 'id-a', status: 'running' }]
  await complete($)
  const stamped = it.state.get('lastReconcileAt')
  expect(stamped).toBe(T0)
  it.listFails = true
  await it.clock.advance(11 * SECOND)
  expect(it.state.get('lastReconcileAt')).toBe(stamped)
  it.listFails = false
  it.listCalls = 0
  await it.clock.advance(SECOND)
  expect(it.listCalls).toBe(1)
})

/** The Bash tool and the disk beneath the mod, for launches: `files` is what has landed. */
const shell = (on: On) => {
  const it = { files: new Map<string, string>(), calls: 0, isError: false, bgId: '' }
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/x' : undefined }) as never)
  on('fs.exists', (_, e) => ({ value: it.files.has(e.path) }) as never)
  on('fs.read', (_, e) => {
    const text = it.files.get(e.path)

    if (text === undefined) {
      throw new Error('ENOENT')
    }

    return { value: text } as never
  })
  on('tool.call', () => {
    it.calls += 1

    return { result: { stdout: '', ...(it.bgId === '' ? {} : { backgroundTaskId: it.bgId }) }, text: '', ...(it.isError ? { isError: true } : {}) } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)

  return it
}

const bash = ($: Kit, command: string, over: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Bash', tool_use_id: 'tu-bash', command, description: 'ask the panel', ...over } as never)

const RUN = '~/.claude/skills/buddy-panel/scripts/buddy-run.sh'

const notify = ($: Kit, toolUseId: string, status = 'completed') =>
  $.prompt.submit({
    text: `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Background command done</summary>\n</task-notification>`,
    wait: false,
    origin: { kind: 'task-notification' },
  } as never)

test('launch: a foreground buddy call is a row for its length; an error fails it; the call runs once', async ($, on) => {
  const it = world(on)
  const sh = shell(on)
  await $.session.start({ cwd: '/t' } as never)
  await bash($, `${RUN} kimi-k3-high /tmp/p 300`)
  let [a] = await rows(it)
  expect(a).toMatchObject({ id: 'tu-bash:0', type: 'buddy:kimi-k3-high', description: 'ask the panel', status: 'done', endedAt: T0 })
  expect(a!.external).toEqual({ doneFile: '/tmp/p/meta-kimi-k3-high.txt', deadline: null })
  expect(it.opens).toEqual(['agents'])
  sh.isError = true
  await bash($, `codex exec "explain"`, { tool_use_id: 'tu-2' })
  a = (await rows(it))[1]
  expect(a).toMatchObject({ type: 'codex:exec', status: 'failed' })
  expect(sh.calls).toBe(2)
  // Not a launch: no row, the call still runs.
  await bash($, 'git status', { tool_use_id: 'tu-3' })
  expect((await rows(it)).length).toBe(2)
  expect(sh.calls).toBe(3)
})

test('launch: a backgrounded seat runs until its meta file lands, or is lost past its deadline', async ($, on) => {
  const it = world(on)
  const sh = shell(on)
  await $.session.start({ cwd: '/t' } as never)
  const cmd = `P=/tmp/p; ${RUN} kimi-k3-high $P 60 & ${RUN} grok-4.7-high $P 60 & ${RUN} gemini-3.1-pro $P 60`
  await bash($, cmd, { run_in_background: true })
  let list = await rows(it)
  expect(list.map(r => [r.type, r.status])).toEqual([
    ['buddy:kimi-k3-high', 'running'],
    ['buddy:grok-4.7-high', 'running'],
    ['buddy:gemini-3.1-pro', 'running'],
  ])
  expect(list[0]!.external).toEqual({ doneFile: '/tmp/p/meta-kimi-k3-high.txt', deadline: T0 + 120 * SECOND })
  sh.files.set('/tmp/p/meta-kimi-k3-high.txt', 'EXIT:0\n')
  sh.files.set('/tmp/p/meta-gemini-3.1-pro.txt', 'EXIT:124\n')
  await complete($)
  list = await rows(it)
  expect(list.map(r => r.status)).toEqual(['done', 'running', 'failed'])
  // Reconcile never ends an external row by absence from the engine's list.
  await it.clock.advance(119 * SECOND)
  expect((await rows(it))[1]!.status).toBe('running')
  await it.clock.advance(11 * SECOND)
  list = await rows(it)
  expect(list[1]).toMatchObject({ status: 'lost', endedAt: T0 + 130 * SECOND })
})

test('launch: a background run with no done file ends on its notification; the meta file beats the shell status', async ($, on) => {
  const it = world(on)
  const sh = shell(on)
  await $.session.start({ cwd: '/t' } as never)
  await bash($, `cd $C && timeout 1800 codex exec --json "$(cat prompt.txt)" < /dev/null > codex.jsonl`, { run_in_background: true, tool_use_id: 'tu-cx' })
  await bash($, `${RUN} kimi-k3-high "$UNSET" 900`, { run_in_background: true, tool_use_id: 'tu-k' })
  await bash($, `${RUN} grok-4.7-high /tmp/p 900; echo "REAL_EXIT=$?"`, { run_in_background: true, tool_use_id: 'tu-g' })
  let list = await rows(it)
  expect(list.map(r => [r.id, r.type, r.status])).toEqual([
    ['tu-cx:0', 'codex:exec', 'running'],
    ['tu-k:0', 'buddy:kimi-k3-high', 'running'],
    ['tu-g:0', 'buddy:grok-4.7-high', 'running'],
  ])
  // Codex names no timeout of its own; the timeout wrapper's 1800 s bounds it.
  expect(list[0]!.external).toEqual({ doneFile: null, deadline: T0 + 1860 * SECOND })
  expect(list[1]!.external).toEqual({ doneFile: null, deadline: T0 + 960 * SECOND })
  await it.clock.advance(5 * SECOND)
  await notify($, 'tu-cx')
  await notify($, 'tu-k', 'killed')
  // The shell exited 0 (the trailing echo), but the seat's meta says it timed out.
  sh.files.set('/tmp/p/meta-grok-4.7-high.txt', 'EXIT:124')
  await notify($, 'tu-g')
  list = await rows(it)
  expect(list.map(r => [r.status, r.endedAt])).toEqual([
    ['done', T0 + 5 * SECOND],
    ['failed', T0 + 5 * SECOND],
    ['failed', T0 + 5 * SECOND],
  ])
  // A notification for another call, or a typed prompt, ends nothing.
  await notify($, 'tu-nope')
  expect(sh.calls).toBe(3)
})

test('launch: a call the engine backgrounds keeps its row running; Codex inside a subagent gets none', async ($, on) => {
  const it = world(on)
  const sh = shell(on)
  await $.session.start({ cwd: '/t' } as never)
  sh.bgId = 'b9'
  await bash($, `${RUN} kimi-k3-high /tmp/p 300`, { tool_use_id: 'tu-auto' })
  expect((await rows(it))[0]).toMatchObject({ status: 'running', external: { doneFile: '/tmp/p/meta-kimi-k3-high.txt', deadline: T0 + 360 * SECOND } })
  sh.bgId = ''
  await bash($, 'node /p/codex-companion.mjs review', { agentId: 'id-codex-rescue', tool_use_id: 'tu-sub' })
  expect((await rows(it)).length).toBe(1)
  expect(sh.calls).toBe(2)
})

test('launch: a backgrounded call a hook denies (an error with no task id) fails its row at once, never a ghost', async ($, on) => {
  const it = world(on)
  const sh = shell(on)
  await $.session.start({ cwd: '/t' } as never)
  // background-timeout-gate's deny reaches the mod as an error result with no backgroundTaskId
  sh.isError = true
  await bash($, `${RUN} kimi-k3-high /tmp/p 600`, { run_in_background: true, tool_use_id: 'tu-denied' })
  expect((await rows(it))[0]).toMatchObject({ id: 'tu-denied:0', status: 'failed', endedAt: T0 })
  // the re-issued, wrapped call is its own row and runs
  sh.isError = false
  sh.bgId = 'b7'
  await bash($, `timeout -k 10 660 ${RUN} kimi-k3-high /tmp/p 600`, { run_in_background: true, tool_use_id: 'tu-ok' })
  const list = await rows(it)
  expect(list.map(r => [r.id, r.status])).toEqual([
    ['tu-denied:0', 'failed'],
    ['tu-ok:0', 'running'],
  ])
  // an error that did start a background task (a wrapper's non-zero exit arrives later) still waits on its notification
  sh.isError = true
  sh.bgId = 'b8'
  await bash($, `${RUN} grok-4.7-high /tmp/p 600`, { run_in_background: true, tool_use_id: 'tu-bg-err' })
  expect((await rows(it))[2]).toMatchObject({ id: 'tu-bg-err:0', status: 'running' })
  expect(sh.calls).toBe(3)
})

test('spawn: agents number in spawn order, so six general-purpose cards wear five Clawd costumes', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  it.spawnAnswer = (e: { subagentType: string }) => ({ model: 'claude-opus-5-5', agentId: `id-${it.spawnCalls}` })
  for (let i = 0; i < 6; i += 1) {
    await spawn($, 'general-purpose', `seat ${i}`, `tu-${i}`)
  }
  expect((await rows(it)).map(r => r.variant)).toEqual([0, 1, 2, 3, 4, 5])
  const p = await pane($, 'desktop')
  const costumes = p.svgs.map(s => /class="c-(\w+)/.exec(String(s.props.source))?.[1]).filter(Boolean)
  expect(new Set(costumes)).toEqual(new Set(['plain', 'pirate', 'detective', 'engineer', 'chef']))
})

test('launch: the main turn\'s end closes a backgrounded run whose task is no longer in flight, its notification lost', async ($, on) => {
  const it = world(on)
  const sh = shell(on)
  on('classic.Stop', () => ({}) as never)
  await $.session.start({ cwd: '/t' } as never)
  sh.bgId = 'bcx1'
  await bash($, 'timeout -k 10 900 codex exec --json "go" < /dev/null > e.jsonl; echo "REAL_EXIT=$?"', { run_in_background: true, tool_use_id: 'tu-cx' })
  sh.bgId = 'bk1'
  await bash($, `${RUN} kimi-k3-high /tmp/p 600`, { run_in_background: true, tool_use_id: 'tu-k' })
  sh.bgId = 'bg1'
  await bash($, `${RUN} grok-4.7-high /tmp/q 600`, { run_in_background: true, tool_use_id: 'tu-g' })
  let list = await rows(it)
  expect(list[0]!.external).toEqual({ doneFile: null, deadline: T0 + 960 * SECOND, taskId: 'bcx1' })
  // a turn ends while all three are in flight: nothing changes
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [
    { id: 'bcx1', type: 'shell', status: 'running', description: 'codex' },
    { id: 'bk1', type: 'shell', status: 'running', description: 'kimi' },
    { id: 'bg1', type: 'shell', status: 'running', description: 'grok' },
  ] } as never)
  expect((await rows(it)).map(r => r.status)).toEqual(['running', 'running', 'running'])
  // the codex and grok tasks ended without a notification arriving; grok's meta says it timed out
  await it.clock.advance(7 * SECOND)
  sh.files.set('/tmp/q/meta-grok-4.7-high.txt', 'EXIT:124\n')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bk1', type: 'shell', status: 'running', description: 'kimi' }] } as never)
  list = await rows(it)
  expect(list.map(r => [r.id, r.status])).toEqual([
    ['tu-cx:0', 'done'],
    ['tu-k:0', 'running'],
    ['tu-g:0', 'failed'],
  ])
  expect(list[0]!.endedAt).toBe(T0 + 7 * SECOND)
  // an engine that sends no list ends nothing
  await $.classic.Stop({ stop_hook_active: false } as never)
  expect((await rows(it))[1]!.status).toBe('running')
})

test('launch: a backgrounded Codex run whose notification never comes is lost past its wrapper timeout', async ($, on) => {
  const it = world(on)
  shell(on)
  await $.session.start({ cwd: '/t' } as never)
  await bash($, 'timeout -k 10 300 codex exec --json "go" < /dev/null > e.jsonl', { run_in_background: true, tool_use_id: 'tu-cx' })
  await it.clock.advance(355 * SECOND)
  await complete($)
  expect((await rows(it))[0]!.status).toBe('running')
  await it.clock.advance(10 * SECOND)
  await complete($)
  expect((await rows(it))[0]).toMatchObject({ status: 'lost' })
})

for (const surface of SURFACES) {
  test(`review (${surface}): a refused /agents still starts the clock, so a background Codex run's time ticks and its tokens read —`, async ($, on) => {
    // 2026-10-12: session.start threw at command.register before clock.every, so `now` never moved
    // and a background `codex exec` read `— · — · 0:00` and `1 running · 0 · 0:00` for minutes.
    const it = world(on)
    it.registerRefuses = true
    shell(on)

    try {
      await $.session.start({ cwd: '/t' } as never)
    } catch {
      // the refusal may surface; the tick must start regardless
    }

    await bash($, 'timeout -k 10 1800 codex exec --cd /s -o /s/o.md "go" < /dev/null > /s/log 2>&1', { run_in_background: true, tool_use_id: 'tu-cx' })
    await it.clock.advance(125 * SECOND)
    expect(it.state.get('now')).toBe(T0 + 125 * SECOND)
    const b = await band($, surface)
    const text = surface === 'desktop' ? String(b.svgs[0]?.props.alt ?? '') : b.texts
    expect(text).toContain('1 running · — · 2:05')
    await b.done()
    const p = await pane($, surface)
    expect(p.all).toContain('— · — · 2:05')
    await p.done()
    await it.clock.settle()
  })
}

test('held steps are counted per turn: a later turn with no usage step still takes its completion usage', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  // t1's usage step and a tool-only step of t2 both land before the card.
  await step($, it, u(100), 'id-a')
  it.usage = null
  it.toolUses = [{ name: 'Read', input: { file_path: '/x' } }]
  for await (const _ of $.turn.step({ ...STEP, turnId: 't2', agentId: 'id-a' } as never)) {
    // drain
  }
  await spawn($, 'a')
  await $.turn.complete({ ...TURN, turnId: 't2', agentId: 'id-a', usage: u(7) } as never)
  expect((await rows(it))[0]).toMatchObject({ status: 'done', tokens: 107, steps: 2 })
})

test('a step in flight when its run ended lands late: the row stays finished', async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  await spawn($, 'a')
  await step($, it, u(10), 'id-a')
  let release = () => {}
  const held = new Promise<void>(r => {
    release = r
  })
  it.duringStep = () => held
  it.usage = u(4)
  const inFlight = (async () => {
    for await (const _ of $.turn.step({ ...STEP, turnId: 't2', agentId: 'id-a' } as never)) {
      // drain
    }
  })()
  await it.clock.advance(SECOND)
  await complete($, 'id-a')
  it.duringStep = null
  release()
  await inFlight
  const [a] = await rows(it)
  expect(a).toMatchObject({ status: 'done', tokens: 14, steps: 2 })
  // A step that starts after the end is a resume.
  await it.clock.advance(SECOND)
  for await (const _ of $.turn.step({ ...STEP, turnId: 't3', agentId: 'id-a' } as never)) {
    // drain
  }
  expect((await rows(it))[0]!.status).toBe('running')
})
