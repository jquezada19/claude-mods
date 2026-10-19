import { expect, test } from 'claude-code/testing'

import type { AgentRun } from '../types'
import {
  MISSING_MS,
  ROW_CAP,
  TURNS_KEPT,
  applyComplete,
  applyStep,
  costumeOf,
  ctxPercent,
  elapsed,
  finishRow,
  fmtTime,
  fmtTokens,
  modelKey,
  modelName,
  openRow,
  reopenRow,
  applyAnswer,
  applyCallDone,
  applyCheck,
  applyStepDetail,
  clip,
  toolLine,
  reconcileRows,
  sumUsage,
  totals,
} from '../hooks/agents'

const T0 = 1_000_000
const row = (id: string, over: Partial<AgentRun> = {}): AgentRun => ({
  id,
  type: 'general-purpose',
  description: `task ${id}`,
  model: 'claude-opus-5-5',
  status: 'running',
  startedAt: T0,
  contextTokens: 0,
  tokens: 0,
  steps: 0,
  ...over,
})
const usage = (i: number, o: number, r: number, w: number, model = 'claude-opus-5-5') => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: w,
  model,
})

test('sumUsage: four counts, missing ones are 0, a non-finite sum is null', async () => {
  expect(sumUsage(usage(1, 2, 3, 4))).toEqual({ tokens: 10, context: 8 })
  expect(sumUsage({ input_tokens: 5 })).toEqual({ tokens: 5, context: 5 })
  expect(sumUsage({ input_tokens: Number.NaN })).toBe(null)
  expect(sumUsage({ output_tokens: Number.POSITIVE_INFINITY })).toBe(null)
})

test('openRow: replaces a row of the same id, caps at 200 dropping the oldest finished row, never a running one', async () => {
  const a = row('a')
  let list = openRow([], a)
  list = openRow(list, { ...a, description: 'again' })
  expect(list.length).toBe(1)
  expect(list[0]!.description).toBe('again')
  const finished = Array.from({ length: ROW_CAP }, (_, i) => row(`f${i}`, { status: 'done', startedAt: T0 + i }))
  const capped = openRow(finished, row('new'))
  expect(capped.length).toBe(ROW_CAP)
  expect(capped[0]!.id).toBe('f1')
  expect(capped[ROW_CAP - 1]!.id).toBe('new')
  const running = Array.from({ length: ROW_CAP }, (_, i) => row(`r${i}`))
  expect(openRow(running, row('new')).length).toBe(ROW_CAP + 1)
})

test('applyStep: context is the latest input side, tokens accumulate, model and effort follow the step, status untouched', async () => {
  let list = [row('a')]
  list = applyStep(list, 'a', usage(100, 10, 0, 0), 'claude-opus-5-5', 'high', T0)
  list = applyStep(list, 'a', usage(200, 20, 50, 0), 'claude-opus-5-5', 'high', T0)
  list = applyStep(list, 'a', usage(300, 30, 60, 10, 'claude-sonnet-5-5'), 'claude-opus-5-5', 7, T0)
  const a = list[0]!
  expect(a.contextTokens).toBe(370)
  expect(a.tokens).toBe(780)
  expect(a.steps).toBe(3)
  expect(a.model).toBe('claude-sonnet-5-5')
  expect(a.effort).toBe('high')
  expect(a.status).toBe('running')
  // An empty usage.model keeps the request's model.
  const m = applyStep([row('b')], 'b', usage(1, 1, 1, 1, ''), 'claude-haiku-5-5', undefined, T0)
  expect(m[0]!.model).toBe('claude-haiku-5-5')
})

test('applyStep: unknown id and non-finite usage keep the list; a step on a finished row reopens it', async () => {
  const list = [row('a', { status: 'done', endedAt: T0 + 5, tokens: 10, turnId: 't1' })]
  expect(applyStep(list, 'zzz', usage(1, 1, 1, 1), 'm', undefined, T0 + 9, 't2')).toBe(list)
  expect(applyStep(list, 'a', { input_tokens: Number.NaN }, 'm', undefined, T0 + 9, 't2')).toBe(list)
  // A late step of the turn the row finished in adds figures and keeps it done.
  const late = applyStep(list, 'a', usage(1, 1, 1, 1), 'm', undefined, T0 + 9, 't1')
  expect(late[0]!.status).toBe('done')
  expect(late[0]!.endedAt).toBe(T0 + 5)
  expect(late[0]!.tokens).toBe(14)
  // A step from another turn is a resume: the row runs again.
  const after = applyStep(list, 'a', usage(1, 1, 1, 1), 'm', undefined, T0 + 9, 't2')
  expect(after[0]!.status).toBe('running')
  expect('endedAt' in after[0]!).toBe(false)
  expect(after[0]!.tokens).toBe(14)
  // No turn id says nothing about a resume.
  expect(applyStep(list, 'a', usage(1, 0, 0, 0), 'm', undefined, T0 + 9)[0]!.status).toBe('done')
  // A failed row reopens too; an external row never takes a step's status change.
  const failed = applyStep([row('f', { status: 'failed', endedAt: T0 + 5, turnId: 't1' })], 'f', usage(1, 0, 0, 0), 'm', undefined, T0 + 9, 't2')
  expect(failed[0]!.status).toBe('running')
  const ext = row('x', { status: 'done', endedAt: T0 + 5, turnId: 't1', external: { doneFile: null, deadline: null } })
  expect(applyStep([ext], 'x', usage(1, 0, 0, 0), 'm', undefined, T0 + 9, 't2')[0]!.status).toBe('done')
  // A step clears missingSince and a parked mark: the agent is working.
  const seen = applyStep([row('c', { missingSince: T0, engineStatus: 'waiting' })], 'c', usage(1, 0, 0, 0), 'm', undefined, T0 + 9)
  expect('missingSince' in seen[0]!).toBe(false)
  expect('engineStatus' in seen[0]!).toBe(false)
})

test('reopen keeps active time: elapsed resumes from what the first run took', async () => {
  const done = row('a', { status: 'done', startedAt: T0, endedAt: T0 + 5_000, tokens: 10 })
  const reopened = reopenRow(done, T0 + 60_000)
  expect(reopened.status).toBe('running')
  expect('endedAt' in reopened).toBe(false)
  expect(elapsed(reopened, T0 + 61_000)).toBe(6_000)
  expect(reopened.tokens).toBe(10)
  // A running row is left as it is.
  const live = row('b')
  expect(reopenRow(live, T0 + 9)).toBe(live)
})

test('applyComplete: reason maps to status, endedAt is the given clock, the zero-step fallback fills figures once', async () => {
  const done = applyComplete([row('a', { steps: 2, tokens: 50, contextTokens: 40 })], 'a', 'answer', usage(9, 9, 9, 9), T0 + 7)
  expect(done[0]!.status).toBe('done')
  expect(done[0]!.endedAt).toBe(T0 + 7)
  expect(done[0]!.tokens).toBe(50)
  for (const reason of ['aborted', 'error', 'refusal']) {
    expect(applyComplete([row('a')], 'a', reason, null, T0)[0]!.status).toBe('failed')
  }
  const fb = applyComplete([row('b')], 'b', 'answer', usage(100, 10, 20, 30, 'claude-sonnet-5-5'), T0)
  expect(fb[0]!.tokens).toBe(160)
  expect(fb[0]!.contextTokens).toBe(150)
  expect(fb[0]!.steps).toBe(1)
  expect(fb[0]!.model).toBe('claude-sonnet-5-5')
  const none = applyComplete([row('c')], 'c', 'answer', null, T0)
  expect(none[0]!.tokens).toBe(0)
  const bad = applyComplete([row('d')], 'd', 'answer', { input_tokens: Number.NaN }, T0)
  expect(bad[0]!.tokens).toBe(0)
  expect(bad[0]!.status).toBe('done')
  expect(applyComplete([row('a')], 'nope', 'answer', null, T0).length).toBe(1)
})

test('reconcileRows: list statuses map, absence times out to failed with steps and lost without', async () => {
  const list = [row('a'), row('b'), row('c'), row('d', { steps: 3 }), row('e'), row('f', { status: 'done' })]
  const r1 = reconcileRows(
    list,
    [
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'killed' },
      { id: 'c', status: 'idle' },
    ],
    T0 + 1,
  )
  expect(r1.map(a => a.status)).toEqual(['done', 'failed', 'running', 'running', 'running', 'done'])
  expect(r1[0]!.endedAt).toBe(T0 + 1)
  expect(r1[3]!.missingSince).toBe(T0 + 1)
  expect(r1[4]!.missingSince).toBe(T0 + 1)
  const r2 = reconcileRows(r1, [{ id: 'c', status: 'waiting' }], T0 + 1 + MISSING_MS - 1)
  expect(r2[3]!.status).toBe('running')
  const r3 = reconcileRows(r2, [{ id: 'c', status: 'pending' }], T0 + 1 + MISSING_MS)
  expect(r3[3]!.status).toBe('failed')
  expect(r3[4]!.status).toBe('lost')
  expect(r3[2]!.status).toBe('running')
  // Seen again clears the timer; a failed list entry fails the row.
  const r4 = reconcileRows([row('g', { missingSince: T0 })], [{ id: 'g', status: 'running' }], T0 + 5)
  expect('missingSince' in r4[0]!).toBe(false)
  expect(reconcileRows([row('h')], [{ id: 'h', status: 'failed' }], T0)[0]!.status).toBe('failed')
  // Nothing to change returns the same list.
  const same = [row('i', { status: 'done' })]
  expect(reconcileRows(same, [], T0)).toBe(same)
})

test('formatting: tokens, time, model key and name', async () => {
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(1000)).toBe('1k')
  expect(fmtTokens(412_400)).toBe('412k')
  expect(fmtTokens(1_250_000)).toBe('1.3M')
  expect(fmtTime(19_000)).toBe('0:19')
  expect(fmtTime(134_000)).toBe('2:14')
  expect(fmtTime(3_600_000 + 61_000)).toBe('1:01:01')
  expect(fmtTime(-5)).toBe('0:00')
  expect(modelKey('claude-opus-5-5[1m]')).toBe('opus-5-5')
  expect(modelKey('Claude-Opus-5-5')).toBe('opus-5-5')
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelName('claude-haiku-5-5')).toBe('Haiku 5.5')
  expect(modelName('claude-custom-x')).toBe('custom-x')
  expect(modelName('')).toBe('—')
})

test('ctxPercent: only against the session window of the same model, capped at 100', async () => {
  const a = row('a', { contextTokens: 82_000, model: 'claude-opus-5-5' })
  expect(ctxPercent(a, { model: 'claude-opus-5-5[1m]', window: 200_000 })).toBe(41)
  expect(ctxPercent(a, { model: 'claude-sonnet-5-5', window: 200_000 })).toBe(null)
  expect(ctxPercent(a, { model: 'claude-opus-5-5', window: 0 })).toBe(null)
  expect(ctxPercent(a, { model: 'claude-opus-5-5', window: null })).toBe(null)
  expect(ctxPercent(a, null)).toBe(null)
  expect(ctxPercent(row('b', { contextTokens: 500_000 }), { model: 'claude-opus-5-5', window: 200_000 })).toBe(100)
})

test('costumeOf strips a plugin prefix and maps the known types', async () => {
  expect(costumeOf('Explore')).toBe('pirate')
  expect(costumeOf('codex:codex-rescue')).toBe('codex')
  expect(costumeOf('codex-rescue')).toBe('codex')
  expect(costumeOf('codex:some-later-agent')).toBe('codex')
  expect(costumeOf('codex:review')).toBe('codex')
  expect(costumeOf('buddy:kimi-k3-high')).toBe('panda')
  expect(costumeOf('buddy:grok-4.7-high')).toBe('grok')
  expect(costumeOf('buddy:cursor-grok-4.6-fast')).toBe('grok')
  expect(costumeOf('buddy:composer-2')).toBe('composer')
  expect(costumeOf('buddy:cursor')).toBe('plain')
  expect(costumeOf('buddy:gemini-3.8-flash-high')).toBe('gemini')
  expect(costumeOf('gemini-something')).toBe('plain')
  expect(costumeOf('kimi-something')).toBe('plain')
  expect(costumeOf('Plan')).toBe('engineer')
  expect(costumeOf('claude-code-guide')).toBe('chef')
  expect(costumeOf('general-purpose')).toBe('plain')
  expect(costumeOf('some-plugin:Explore')).toBe('pirate')
})

test('elapsed and totals', async () => {
  const a = row('a', { startedAt: T0, endedAt: T0 + 10_000, tokens: 100, status: 'done' })
  const b = row('b', { startedAt: T0 + 2_000, tokens: 50 })
  expect(elapsed(a, T0 + 99_000)).toBe(10_000)
  expect(elapsed(b, T0 + 5_000)).toBe(3_000)
  expect(elapsed(b, T0)).toBe(0)
  // The span ends at the latest end: a's endedAt (T0 + 10 s) is later than the clock (T0 + 5 s).
  expect(totals([a, b], T0 + 5_000)).toEqual({ agents: 2, tokens: 150, time: 10_000 })
  expect(totals([a], T0 + 99_000)).toEqual({ agents: 1, tokens: 100, time: 10_000 })
  expect(totals([], T0)).toEqual({ agents: 0, tokens: 0, time: 0 })
  // no row that reports tokens: the sum is unknown, not 0
  const ext = { ...a, tokens: 0, endedAt: undefined, external: { doneFile: null, deadline: null } }
  expect(totals([ext], T0 + 5_000).tokens).toBeNull()
  expect(totals([{ ...a, status: 'lost' as const, tokens: 0 }], T0).tokens).toBeNull()
  expect(totals([ext, a], T0 + 5_000).tokens).toBe(100)
})

test('review: percent rounds half up, model key strips only the trailing bracket, boundaries of the formatters', async () => {
  // 29 / 200 × 100 is 14.499999… in floating point; the percent is computed as 2900 / 200.
  expect(ctxPercent(row('a', { contextTokens: 29 }), { model: 'claude-opus-5-5', window: 200 })).toBe(15)
  expect(ctxPercent(row('a', { contextTokens: 1 }), { model: 'claude-opus-5-5', window: 300 })).toBe(0)
  expect(modelKey('claude-opus[foo]bar[1m]')).toBe('opus[foo]bar')
  expect(fmtTokens(999_499)).toBe('999k')
  expect(fmtTokens(999_500)).toBe('1.0M')
  expect(fmtTokens(1_000_000)).toBe('1.0M')
  expect(fmtTime(3_599_000)).toBe('59:59')
  expect(fmtTime(3_600_000)).toBe('1:00:00')
})

test('review: idle, waiting and pending clear the missing timer; a completion over steps keeps every figure', async () => {
  for (const status of ['idle', 'waiting', 'pending']) {
    expect('missingSince' in reconcileRows([row('a', { missingSince: T0 })], [{ id: 'a', status }], T0 + 5)[0]!).toBe(false)
  }
  const kept = applyComplete([row('a', { steps: 2, tokens: 50, contextTokens: 40, model: 'm1' })], 'a', 'answer', usage(10, 10, 10, 10, 'm2'), T0)
  expect(kept[0]).toMatchObject({ tokens: 50, contextTokens: 40, steps: 2, model: 'm1' })
})

test('review: the cap evicts the oldest finished row even when older running rows sit before it', async () => {
  const mixed = [row('old-running', { startedAt: T0 }), ...Array.from({ length: ROW_CAP - 1 }, (_, i) => row(`f${i}`, { status: 'done', startedAt: T0 + 1 + i }))]
  const after = openRow(mixed, row('new'))
  expect(after.length).toBe(ROW_CAP)
  expect(after[0]!.id).toBe('old-running')
  expect(after.some(a => a.id === 'f0')).toBe(false)
})

test('external rows: reconcile never touches them; finishRow ends a running one once', async () => {
  const ext = row('x', { type: 'buddy:kimi-k3-high', external: { doneFile: '/p/meta-kimi-k3-high.txt', deadline: T0 + 5 } })
  const kept = reconcileRows([ext], [], T0 + 10 * MISSING_MS)
  expect(kept[0]).toEqual(ext)
  const ended = finishRow([ext, row('y')], 'x', 'failed', T0 + 7)
  expect(ended[0]).toMatchObject({ status: 'failed', endedAt: T0 + 7 })
  expect(ended[1]).toEqual(row('y'))
  expect(finishRow(ended, 'x', 'done', T0 + 9)).toBe(ended)
  expect(finishRow(ended, 'nope', 'done', T0 + 9)).toBe(ended)
})

test('costumeOf: an agent of no type of its own rotates through the Clawd costumes by spawn order', async () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(v => costumeOf('general-purpose', v))).toEqual([
    'plain',
    'pirate',
    'detective',
    'engineer',
    'chef',
    'plain',
    'pirate',
  ])
  // A type with its own costume, and a mascot, keep it whatever the order.
  expect(costumeOf('Plan', 1)).toBe('engineer')
  expect(costumeOf('codex:codex-rescue', 4)).toBe('codex')
  expect(costumeOf('buddy:kimi-k3-high', 2)).toBe('panda')
  // A row from before the rotation is the plain Clawd.
  expect(costumeOf('general-purpose')).toBe('plain')
})

test('reconcile keeps the engine\'s waiting, idle and pending states on a running row, and clears them', async () => {
  const list = [row('a'), row('b'), row('c')]
  const waiting = reconcileRows(list, [{ id: 'a', status: 'waiting' }, { id: 'b', status: 'idle' }, { id: 'c', status: 'pending' }], T0 + 1)
  expect(waiting.map(a => a.status)).toEqual(['running', 'running', 'running'])
  expect(waiting.map(a => a.engineStatus)).toEqual(['waiting', 'idle', 'pending'])
  // The same state again changes nothing.
  expect(reconcileRows(waiting, [{ id: 'a', status: 'waiting' }, { id: 'b', status: 'idle' }, { id: 'c', status: 'pending' }], T0 + 2)).toBe(waiting)
  // Running again clears the mark; completing clears it with the finish.
  const back = reconcileRows(waiting, [{ id: 'a', status: 'running' }, { id: 'b', status: 'completed' }, { id: 'c', status: 'pending' }], T0 + 3)
  expect('engineStatus' in back[0]!).toBe(false)
  expect(back[1]!.status).toBe('done')
  expect('engineStatus' in back[1]!).toBe(false)
  expect(back[2]!.engineStatus).toBe('pending')
})

test('a row finished by reconcile keeps the turn its steps ran in: a late step of that turn does not reopen it', async () => {
  let list = [row('a')]
  list = applyStep(list, 'a', usage(10, 0, 0, 0), 'm', undefined, T0 + 1, 't1')
  expect(list[0]!.turnId).toBe('t1')
  list = reconcileRows(list, [{ id: 'a', status: 'completed' }], T0 + 2)
  expect(list[0]!.status).toBe('done')
  expect(applyStep(list, 'a', usage(1, 0, 0, 0), 'm', undefined, T0 + 3, 't1')[0]!.status).toBe('done')
  expect(applyStep(list, 'a', usage(1, 0, 0, 0), 'm', undefined, T0 + 3, 't2')[0]!.status).toBe('running')
})

test('every way a row ends drops its parked mark', async () => {
  const parked = (id: string) => row(id, { engineStatus: 'waiting', steps: 1 })
  expect('engineStatus' in applyComplete([parked('a')], 'a', 'aborted', null, T0 + 1)[0]!).toBe(false)
  expect('engineStatus' in finishRow([parked('b')], 'b', 'failed', T0 + 1)[0]!).toBe(false)
  const gone = reconcileRows([{ ...parked('c'), missingSince: T0 }], [], T0 + MISSING_MS)
  expect(gone[0]!.status).toBe('failed')
  expect('engineStatus' in gone[0]!).toBe(false)
})

test('clip: short text as it is, long text cut with an ellipsis, whitespace runs folded', async () => {
  expect(clip('a  b\n\nc', 10)).toBe('a b c')
  expect(clip('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`)
})

test('toolLine: the tool and its most telling argument; a command shows only its program, a URL only host and path', async () => {
  expect(toolLine({ name: 'Read', input: { file_path: '/src/a.ts', limit: 10 } })).toBe('Read /src/a.ts')
  expect(toolLine({ name: 'Grep', input: { pattern: 'foo', path: '/src' } })).toBe('Grep /src')
  expect(toolLine({ name: 'Grep', input: { pattern: 'foo' } })).toBe('Grep foo')
  // A command can carry anything: only the program it runs reaches the card.
  const leaks = [
    'curl -H "Authorization: Bearer demoCredential" https://x?token=demoCredential',
    'curl -H "Cookie: session=demoCredential" -H "X-Auth: demoCredential" https://x',
    'curl -u user:demoCredential https://user:demoCredential@host -d \'{"password":"demoCredential"}\'',
    'FOO_TOKEN=demoCredential PASSWORD="demoCredential" /usr/local/bin/curl --password demoCredential',
  ]
  for (const command of leaks) {
    const line = toolLine({ name: 'Bash', input: { command } })
    expect(line).toBe('Bash curl')
    expect(line).not.toContain('demoCredential')
  }
  expect(toolLine({ name: 'Bash', input: { command: 'echo Bearer migration plan' } })).toBe('Bash echo')
  expect(toolLine({ name: 'WebFetch', input: { url: 'https://user:demoCredential@example.com/docs/a?token=demoCredential#x' } })).toBe(
    'WebFetch example.com/docs/a',
  )
  expect(toolLine({ name: 'mcp__x__y', input: null })).toBe('mcp__x__y')
  expect(toolLine({ name: 'Read', input: { file_path: `/${'z'.repeat(200)}` } }).length).toBe(80)
})

test('applyStepDetail: the newest three tool uses, newest last; a max_tokens stop marks the run cut off', async () => {
  let list = [row('a')]
  list = applyStepDetail(list, 'a', [{ name: 'Read', input: { file_path: '/1' } }, { name: 'Read', input: { file_path: '/2' } }], 'tool_use')
  list = applyStepDetail(list, 'a', [{ name: 'Grep', input: { pattern: 'p' } }, { name: 'Read', input: { file_path: '/4' } }], 'end_turn')
  expect(list[0]!.detail?.tools).toEqual(['Read /2', 'Grep p', 'Read /4'])
  expect(list[0]!.detail?.isCutOff).toBeUndefined()
  list = applyStepDetail(list, 'a', [], 'max_tokens')
  expect(list[0]!.detail?.isCutOff).toBe(true)
  expect(list[0]!.detail?.tools).toEqual(['Read /2', 'Grep p', 'Read /4'])
  // Unknown id: the list as it was.
  expect(applyStepDetail(list, 'zz', [], 'max_tokens')).toBe(list)
})

test('applyAnswer: the answer head, clipped to 400; an empty answer leaves none', async () => {
  const list = applyAnswer([row('a', { detail: { task: 't' } })], 'a', 'y'.repeat(500))
  expect(list[0]!.detail?.answer?.length).toBe(400)
  expect(list[0]!.detail?.task).toBe('t')
  expect(applyAnswer([row('b')], 'b', '')[0]!.detail?.answer).toBeUndefined()
})

test('applyCheck: asks and denials counted; an ask is pending on its call; an allow changes nothing', async () => {
  let list = [row('a')]
  expect(applyCheck(list, 'a', 'allow', 'c0')).toBe(list)
  list = applyCheck(list, 'a', 'ask', 'c1')
  expect(list[0]!.checks).toEqual({ asked: 1, denied: 0 })
  expect(list[0]!.pending).toEqual(['c1'])
  list = applyCheck(list, 'a', 'ask', 'c2')
  list = applyCheck(list, 'a', 'deny', 'c3')
  expect(list[0]!.checks).toEqual({ asked: 2, denied: 1 })
  expect(list[0]!.pending).toEqual(['c1', 'c2'])
  // A call that returns is no longer pending; the other stays.
  list = applyCallDone(list, 'a', 'c1')
  expect(list[0]!.pending).toEqual(['c2'])
  list = applyCallDone(list, 'a', 'c2')
  expect('pending' in list[0]!).toBe(false)
  expect(applyCheck(list, 'zz', 'ask', 'c9')).toBe(list)
})

test('a pending ask clears on the next step (with or without usage) and on every ending', async () => {
  const waiting = () => applyCheck([row('a', { steps: 1 })], 'a', 'ask', 'c1')
  const gone = (l: AgentRun[]) => expect('pending' in l[0]!).toBe(false)
  gone(applyStep(waiting(), 'a', usage(1, 0, 0, 0), 'm', undefined, T0 + 1, 't1'))
  gone(applyStepDetail(waiting(), 'a', [], 'end_turn'))
  gone(applyComplete(waiting(), 'a', 'answer', null, T0 + 1))
  gone(finishRow(waiting(), 'a', 'failed', T0 + 1))
  gone(reconcileRows(waiting(), [{ id: 'a', status: 'completed' }], T0 + 1))
  gone(reconcileRows(waiting(), [{ id: 'a', status: 'failed' }], T0 + 1))
  gone(reconcileRows(waiting(), [{ id: 'a', status: 'killed' }], T0 + 1))
  gone(reconcileRows([{ ...waiting()[0]!, missingSince: T0 }], [], T0 + MISSING_MS))
  // A reconcile that still lists it as running keeps the ask pending.
  expect(reconcileRows(waiting(), [{ id: 'a', status: 'running' }], T0 + 1)[0]!.pending).toEqual(['c1'])
  // The counts stay: they are the run's history.
  expect(applyComplete(waiting(), 'a', 'answer', null, T0 + 1)[0]!.checks).toEqual({ asked: 1, denied: 0 })
})

test('the completion fallback is per turn: a resumed run with no steps seen adds its usage once; a late step of it adds nothing', async () => {
  // A first run: two steps seen in t1, then its completion (no fallback).
  let list = [row('a')]
  list = applyStep(list, 'a', usage(40, 10, 0, 0), 'm', undefined, T0 + 1, 't1')
  list = applyStep(list, 'a', usage(40, 10, 0, 0), 'm', undefined, T0 + 2, 't1')
  list = applyComplete(list, 'a', 'answer', usage(999, 999, 0, 0), T0 + 3, 't1')
  expect(list[0]).toMatchObject({ tokens: 100, steps: 2, status: 'done' })
  // Resumed in t2 with no step seen: the completion's usage is added, not swapped in.
  list = applyComplete(list, 'a', 'answer', usage(20, 5, 0, 0), T0 + 9, 't2')
  expect(list[0]).toMatchObject({ tokens: 125, contextTokens: 20, steps: 3 })
  // A late step of t2 arrives: already counted by the completion.
  list = applyStep(list, 'a', usage(20, 5, 0, 0), 'm', undefined, T0 + 10, 't2')
  expect(list[0]).toMatchObject({ tokens: 125, steps: 3 })
  // A step of a new turn still counts.
  list = applyStep(list, 'a', usage(1, 1, 0, 0), 'm', undefined, T0 + 11, 't3')
  expect(list[0]).toMatchObject({ tokens: 127, steps: 4 })
})

test('a turn whose steps were seen does not also take its completion usage', async () => {
  let list = [row('a', { status: 'done', endedAt: T0, tokens: 100, steps: 2, turnId: 't1' })]
  list = applyStep(list, 'a', usage(20, 5, 0, 0), 'm', undefined, T0 + 5, 't2')
  list = applyComplete(list, 'a', 'answer', usage(20, 5, 0, 0), T0 + 6, 't2')
  expect(list[0]).toMatchObject({ tokens: 125, steps: 3 })
})


test('a repeated completion of a fallback turn adds its usage once', async () => {
  let list = [row('a', { status: 'done', endedAt: T0, tokens: 100, steps: 2, turnId: 't1' })]
  list = applyComplete(list, 'a', 'answer', usage(20, 5, 0, 0), T0 + 5, 't2')
  list = applyComplete(list, 'a', 'answer', usage(20, 5, 0, 0), T0 + 6, 't2')
  expect(list[0]).toMatchObject({ tokens: 125, steps: 3 })
})

test('fallbacks are remembered per turn: a delayed step of an older fallback turn neither counts nor reopens', async () => {
  let list = [row('a', { status: 'done', endedAt: T0, tokens: 100, steps: 2, turnId: 't1' })]
  list = applyComplete(list, 'a', 'answer', usage(20, 5, 0, 0), T0 + 5, 't2')
  list = applyComplete(list, 'a', 'answer', usage(10, 0, 0, 0), T0 + 9, 't3')
  expect(list[0]).toMatchObject({ tokens: 135, steps: 4, status: 'done' })
  // t2's own step turns up after t3 finished: t2 was counted by its completion.
  list = applyStep(list, 'a', usage(20, 5, 0, 0), 'm', undefined, T0 + 10, 't2')
  expect(list[0]).toMatchObject({ tokens: 135, steps: 4, status: 'done', endedAt: T0 + 9 })
})

test('a delayed step of an older seen turn adds figures but does not reopen the row', async () => {
  let list = [row('a')]
  list = applyStep(list, 'a', usage(10, 0, 0, 0), 'm', undefined, T0 + 1, 't1')
  list = applyComplete(list, 'a', 'answer', null, T0 + 2, 't1')
  list = applyStep(list, 'a', usage(10, 0, 0, 0), 'm', undefined, T0 + 3, 't2')
  list = applyComplete(list, 'a', 'answer', null, T0 + 4, 't2')
  list = applyStep(list, 'a', usage(5, 0, 0, 0), 'm', undefined, T0 + 5, 't1')
  expect(list[0]).toMatchObject({ status: 'done', endedAt: T0 + 4, tokens: 25, turnId: 't2' })
})

test('the steps seen are counted per turn: a completion of a turn with none seen falls back even after other turns stepped', async () => {
  let list = [row('a')]
  list = applyStep(list, 'a', usage(10, 0, 0, 0), 'm', undefined, T0 + 1, 't1')
  // t1's completion never came; t2 completes with no step of its own seen.
  list = applyComplete(list, 'a', 'answer', usage(7, 0, 0, 0), T0 + 2, 't2')
  expect(list[0]).toMatchObject({ tokens: 17, steps: 2 })
  // A completion arriving after a turn change does not carry the old turn's count.
  list = applyComplete(list, 'a', 'answer', usage(3, 0, 0, 0), T0 + 3, 't3')
  expect(list[0]).toMatchObject({ tokens: 20, steps: 3 })
})

test('a first step that began before the row ended is late, not a resume', async () => {
  // Reconcile ended the run while the row still named t1; t2's first step was already in flight.
  let list = [row('a', { status: 'failed', endedAt: T0 + 5, tokens: 10, steps: 1, turnId: 't1' })]
  list = applyStep(list, 'a', usage(4, 0, 0, 0), 'm', undefined, T0 + 6, 't2', T0 + 4)
  expect(list[0]).toMatchObject({ status: 'failed', endedAt: T0 + 5, tokens: 14 })
  // Its completion then sees the step and does not fall back.
  list = applyComplete(list, 'a', 'answer', usage(99, 0, 0, 0), T0 + 7, 't2')
  expect(list[0]).toMatchObject({ tokens: 14, steps: 2 })
  // A step that began after the end is a real resume.
  list = applyStep(list, 'a', usage(1, 0, 0, 0), 'm', undefined, T0 + 9, 't3', T0 + 8)
  expect(list[0]!.status).toBe('running')
})

test('the per-turn memory stays bounded', async () => {
  let list = [row('a')]
  for (let n = 0; n < 40; n += 1) {
    list = applyStep(list, 'a', usage(1, 0, 0, 0), 'm', undefined, T0 + n, `t${n}`)
  }
  expect(Object.keys(list[0]!.turns ?? {}).length).toBeLessThanOrEqual(TURNS_KEPT)
})

test('a card from 0.4.0 keeps its accounting across a reload', async () => {
  // fell back in t1: a late t1 step adds nothing
  const legacyFell = { ...row('a', { status: 'done', endedAt: T0, tokens: 25, steps: 1, turnId: 't1' }), fellBack: 't1' } as AgentRun
  expect(applyStep([legacyFell], 'a', usage(20, 5, 0, 0), 'm', undefined, T0 + 1, 't1')[0]).toMatchObject({ tokens: 25, steps: 1 })
  // one step counted in t1: its completion does not fall back over it
  const legacySeen = { ...row('a', { tokens: 25, steps: 1, turnId: 't1' }), turnSteps: 1 } as AgentRun
  const done = applyComplete([legacySeen], 'a', 'answer', usage(20, 5, 0, 0), T0 + 2, 't1')[0]!
  expect(done).toMatchObject({ tokens: 25, steps: 1, status: 'done' })
  // the legacy fields are gone from the rewritten row
  expect('turnSteps' in done || 'fellBack' in done).toBe(false)
  expect(done.turns).toEqual({ t1: 1 })
})
