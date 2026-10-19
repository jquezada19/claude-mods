import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { aheadOf, cellsOf, etaOf, median, parseRows, statsOf, tierOf, tokensShort, until, walk } from '../hooks/phases'
import { expandHome } from '../hooks/register'

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const TICK = 60_000
const SINK = '/t/sink.jsonl'
const VAULT = '/t/vault'
const OPTIONS = { options: { sink: SINK, vault: VAULT } }
const EMPTY = { type: 'Box', props: {}, children: [] } as never

/** One sink line as ticket-phase.sh writes it, stamped from epoch ms. */
const line = (
  session: string,
  ticket: string,
  phase: number | string,
  event: string,
  at: number,
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    ts: new Date(at).toISOString(),
    session,
    ticket,
    phase,
    event,
    model: 'claude-opus-5-5',
    ...extra,
  })

type File = { text: string; mtimeMs: number }
type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

/**
 * The engine beneath the mod, in memory: a clock, a store, a file tree of
 * fixtures, and the usage figures a test sets as it goes.
 */
const world = (on: On, now = T0) => {
  const clock = mock.clock(on, { now })
  const store = new Map<string, unknown>()
  const files = new Map<string, File>()
  const it = {
    clock,
    store,
    files,
    session: 's1',
    usage: null as Usage | null,
    bash: [] as string[],
    reads: 0,
    lists: 0,
    afterRead: null as null | (() => void),
    statFails: new Set<string>(),
    write(path: string, text: string, mtimeMs = now) {
      files.set(path, { text, mtimeMs })
    },
    sink(lines: string[], mtimeMs = now) {
      files.set(SINK, { text: lines.join('\n') + '\n', mtimeMs })
    },
  }
  mock.env(on, { HOME: '/home/t' })
  on('session.start', () => ({ cwd: '/t' }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('session.id', () => ({ value: it.session }))
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
  on('fs.read', (_, e) => {
    const f = files.get(e.path)

    if (f === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }

    it.reads += 1
    const text = f.text
    it.afterRead?.()

    return { value: text } as never
  })
  on('fs.stat', (_, e) => {
    if (it.statFails.has(e.path)) {
      throw new Error(`EIO: ${e.path}`)
    }

    const f = files.get(e.path)

    if (f === undefined) {
      const dir = [...files.keys()].some(k => k.startsWith(`${e.path}/`))

      if (!dir) {
        throw new Error(`ENOENT: ${e.path}`)
      }

      return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } } as never
    }

    return {
      value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false },
    } as never
  })
  on('fs.list', (_, e) => {
    it.lists += 1
    const prefix = `${e.path}/`
    const names = new Set<string>()
    const out: { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }[] = []

    for (const [k, f] of files) {
      if (!k.startsWith(prefix)) {
        continue
      }

      const rest = k.slice(prefix.length)
      const name = rest.split('/')[0]!

      if (names.has(name)) {
        continue
      }

      names.add(name)
      out.push(
        rest.includes('/')
          ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
          : { name, kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false },
      )
    }

    if (out.length === 0) {
      throw new Error(`ENOENT: ${e.path}`)
    }

    return { value: out } as never
  })
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: it.usage,
    } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    it.bash.push((e as never as { command: string }).command)

    return { result: { stdout: '', stderr: '' } } as never
  })
  on('ui.render', () => EMPTY)

  return it
}

type Kit = Parameters<NonNullable<Parameters<typeof test>[2]>>[0]

/** /phase as the person runs it: the engine's call carries the origin and the presentation whole. */
const phase = ($: Kit, args: string) =>
  $.command.run({ command: 'phase', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const drawn = async ($: Kit, surface: 'desktop' | 'terminal' = 'terminal') => {
  const ui = await $.ui.mount({
    plugin: 'ticket-phase',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, bodyColumns: 120 },
  } as never)
  const h = ui as never as {
    findAll: (q: { type: string }) => Promise<{ text?: string; props: Record<string, unknown> }[]>
    unmount: () => Promise<void>
  }
  const texts = (await h.findAll({ type: 'Text' })).map(one => one.text ?? '').join('')

  if (surface === 'terminal') {
    await h.unmount()

    return texts
  }

  // The desktop row is one Svg whose alt is the terminal text.
  const svgs = await h.findAll({ type: 'Svg' })
  await h.unmount()

  return svgs.map(one => String(one.props.alt ?? '')).join('') + texts
}

/** The desktop Svg's source, for structural assertions. */
const source = async ($: Kit) => {
  const ui = await $.ui.mount({
    plugin: 'ticket-phase',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, bodyColumns: 120 },
  } as never)
  const h = ui as never as { findAll: (q: { type: string }) => Promise<{ props: Record<string, unknown> }[]>; unmount: () => Promise<void> }
  const svgs = await h.findAll({ type: 'Svg' })
  await h.unmount()

  return svgs.map(one => String(one.props.source ?? '')).join('')
}

test('parseRows turns stamps into epoch ms and orders by time', OPTIONS, async () => {
  const text = [line('a', '1', 2, 'enter', T0 + HOUR), line('a', '1', 1, 'enter', T0)].join('\n')
  const { rows, skipped } = parseRows(text)
  expect(skipped).toBe(0)
  expect(rows.map(r => r.phase)).toEqual([1, 2])
  expect(rows[0]!.at).toBe(T0)
})

test('parseRows skips malformed, short and unparsable rows and counts them', OPTIONS, async () => {
  const text = [
    'not json',
    '{"session":"a"}',
    line('a', '1', 9, 'enter', T0),
    line('a', '1', 1, 'nope', T0),
    JSON.stringify({ ts: 'yesterday', session: 'a', ticket: '1', phase: 1, event: 'enter' }),
    line('a', '1', 1, 'enter', T0),
  ].join('\n')
  const { rows, skipped } = parseRows(text)
  expect(rows.length).toBe(1)
  expect(skipped).toBe(5)
})

test('parseRows accepts a numeric string phase', OPTIONS, async () => {
  const { rows } = parseRows(line('a', '1', '5', 'enter', T0))
  expect(rows[0]!.phase).toBe(5)
})

test('equal stamps keep file order', OPTIONS, async () => {
  const text = [line('a', '1', 1, 'exit', T0), line('a', '1', 2, 'enter', T0)].join('\n')
  const { rows } = parseRows(text)
  expect(rows.map(r => `${r.phase}${r.event}`)).toEqual(['1exit', '2enter'])
})

test('a DST fall-back hour orders by epoch, not by string', OPTIONS, async () => {
  const early = JSON.stringify({ ts: '2026-11-01T01:59:00-04:00', session: 'a', ticket: '1', phase: 1, event: 'enter' })
  const late = JSON.stringify({ ts: '2026-11-01T01:30:00-05:00', session: 'a', ticket: '1', phase: 1, event: 'exit' })
  const { rows } = parseRows([late, early].join('\n'))
  expect(rows.map(r => r.event)).toEqual(['enter', 'exit'])
})

const rowsOf = (lines: string[]) => parseRows(lines.join('\n')).rows

test('walk: an open enter is the current phase', OPTIONS, async () => {
  const s = walk(rowsOf([line('a', '1', 1, 'enter', T0), line('a', '1', 1, 'exit', T0 + 5 * MINUTE), line('a', '1', 2, 'enter', T0 + 6 * MINUTE)]))
  expect(s.current).toBe(2)
  expect(s.enteredAt).toBe(T0 + 6 * MINUTE)
  expect(s.phases[1]!.exits).toBe(1)
  expect(s.isDone).toBe(false)
})

test('walk: a resume is not a round, keeps the first enter as the start, and the exit closes the phase', OPTIONS, async () => {
  const open = walk(rowsOf([line('a', '1', 5, 'enter', T0), line('b', '1', 5, 'enter', T0 + HOUR)]))
  expect(open.phases[5]!.rounds).toBe(1)
  expect(open.phases[5]!.enters).toBe(2)
  expect(open.current).toBe(5)
  // The phase began with a's enter; b resumed it.
  expect(open.enteredAt).toBe(T0)
  expect(open.phases[5]!.open).toEqual(['a', 'b'])
  const s = walk(rowsOf([line('a', '1', 5, 'enter', T0), line('b', '1', 5, 'enter', T0 + HOUR), line('b', '1', 5, 'exit', T0 + HOUR + 30 * MINUTE)]))
  // A ticket is in one phase at a time: b's exit ends phase 5 for the ticket, a's dead enter included.
  expect(s.current).toBe(null)
  expect(s.phases[5]!.open).toEqual([])
})

test('walk: any exit closes the phase for the ticket, and a later enter is a new round', OPTIONS, async () => {
  const s = walk(rowsOf([line('a', '1', 5, 'enter', T0), line('b', '1', 5, 'enter', T0 + MINUTE), line('a', '1', 5, 'exit', T0 + 2 * MINUTE)]))
  expect(s.current).toBe(null)
  expect(s.phases[5]!.open).toEqual([])
  expect(s.phases[5]!.rounds).toBe(1)
  const t = walk(rowsOf([line('a', '1', 5, 'enter', T0), line('b', '1', 5, 'enter', T0 + MINUTE), line('a', '1', 5, 'exit', T0 + 2 * MINUTE), line('c', '1', 5, 'enter', T0 + 3 * MINUTE)]))
  expect(t.current).toBe(5)
  expect(t.enteredAt).toBe(T0 + 3 * MINUTE)
  expect(t.phases[5]!.rounds).toBe(2)
})

test('walk: another session entering a later phase closes a dead session\'s open earlier phase', OPTIONS, async () => {
  // A ticket where session A never exited 5 and session B shipped.
  const s = walk(rowsOf([line('a', '1', 5, 'enter', T0), line('b', '1', 7, 'enter', T0 + HOUR), line('b', '1', 7, 'exit', T0 + 2 * HOUR)]))
  expect(s.current).toBe(null)
  expect(s.phases[5]!.open).toEqual([])
  expect(cellsOf(s)).toBe('◇◇◇◇◆◇◆◇')
  const done = walk(rowsOf([line('a', '1', 5, 'enter', T0), line('b', '1', 7, 'enter', T0 + HOUR), line('b', '1', 7, 'exit', T0 + 2 * HOUR), line('b', '1', 8, 'enter', T0 + 2 * HOUR), line('b', '1', 8, 'exit', T0 + 3 * HOUR)]))
  expect(done.isDone).toBe(true)
})

test('walk: re-entry after an exit is a round and elapsed counts from the latest enter', OPTIONS, async () => {
  const s = walk(rowsOf([line('a', '1', 6, 'enter', T0), line('a', '1', 6, 'exit', T0 + HOUR), line('a', '1', 5, 'enter', T0 + HOUR + MINUTE), line('a', '1', 5, 'exit', T0 + 2 * HOUR), line('a', '1', 6, 'enter', T0 + 2 * HOUR + MINUTE)]))
  expect(s.current).toBe(6)
  expect(s.enteredAt).toBe(T0 + 2 * HOUR + MINUTE)
  expect(s.phases[6]!.rounds).toBe(2)
  expect(s.phases[5]!.rounds).toBe(1)
})

test('walk: between phases, an orphan exit 8 is not done; enter 8 + exit 8 is', OPTIONS, async () => {
  const between = walk(rowsOf([line('a', '1', 2, 'enter', T0), line('a', '1', 2, 'exit', T0 + HOUR), line('a', '1', 8, 'exit', T0 + HOUR + MINUTE)]))
  expect(between.current).toBe(null)
  expect(between.isDone).toBe(false)
  expect(between.phases[8]!.exits).toBe(1)
  const done = walk(rowsOf([line('a', '1', 1, 'enter', T0), line('a', '1', 8, 'enter', T0 + HOUR), line('a', '1', 8, 'exit', T0 + 2 * HOUR)]))
  expect(done.isDone).toBe(true)
  expect(done.firstEnterAt).toBe(T0)
  expect(done.lastExitAt).toBe(T0 + 2 * HOUR)
})

test('walk: a session entering a higher phase closes its own open lower phase (a skipped exit)', OPTIONS, async () => {
  const s = walk(rowsOf([line('a', '1', 1, 'enter', T0), line('a', '1', 2, 'enter', T0 + MINUTE)]))
  expect(s.current).toBe(2)
  // The skipped exit is not counted as one, but it no longer holds the phase open.
  expect(s.phases[1]!.open).toEqual([])
  expect(s.phases[1]!.exits).toBe(0)
  expect(s.phases[1]!.enters).toBe(1)
  expect(s.sessions).toEqual(['a'])
  // Another session's open enter on the lower phase is closed the same way.
  const t = walk(rowsOf([line('b', '1', 1, 'enter', T0), line('a', '1', 2, 'enter', T0 + MINUTE)]))
  expect(t.phases[1]!.open).toEqual([])
  expect(t.current).toBe(2)
})

test('median is the middle value, not the mean', OPTIONS, async () => {
  expect(median([10, 100, 1000])).toBe(100)
  expect(median([10, 20, 30, 1000])).toBe(25)
  expect(median([7])).toBe(null)
  expect(median([])).toBe(null)
})

test('statsOf pairs each exit with the most recent unpaired enter, one pair per exit', OPTIONS, async () => {
  const rows = rowsOf([
    line('a', '1', 5, 'enter', T0),
    line('b', '1', 5, 'enter', T0 + HOUR), // resume
    line('b', '1', 5, 'exit', T0 + HOUR + 30 * MINUTE),
    line('c', '2', 5, 'enter', T0),
    line('c', '2', 5, 'exit', T0 + 10 * MINUTE),
    line('d', '3', 5, 'enter', T0),
    line('d', '3', 5, 'exit', T0 + 50 * MINUTE),
    line('e', '4', 7, 'exit', T0), // orphan: no pair
  ])
  const stats = statsOf(rows)
  expect(stats[5]!.pairs).toBe(3)
  expect(stats[5]!.tickets).toBe(3)
  // Durations 30m (the resume's exit pairs with b's enter, never a's), 10m, 50m → median 30m.
  expect(stats[5]!.median).toBe(30 * MINUTE)
  expect(stats[7]!.pairs).toBe(0)
  expect(stats[7]!.median).toBe(null)
})

test('statsOf pairs an exit with its own session\'s enter first', OPTIONS, async () => {
  const rows = rowsOf([
    line('s1', '1', 5, 'enter', T0), line('s2', '1', 5, 'enter', T0 + 50 * MINUTE), line('s3', '1', 5, 'enter', T0 + 51 * MINUTE),
    line('s1', '1', 5, 'exit', T0 + 52 * MINUTE), line('s2', '1', 5, 'exit', T0 + 53 * MINUTE), line('s3', '1', 5, 'exit', T0 + 200 * MINUTE),
  ])
  // Per-session durations 52m, 3m, 149m → median 52m (latest-unpaired pairing would say 3m).
  expect(statsOf(rows)[5]!.median).toBe(52 * MINUTE)
})

const pairsOf = (phase: number, ...durations: number[]) =>
  durations.flatMap((d, i) => [
    line(`s${phase}${i}`, `t${i}`, phase, 'enter', T0 - 2 * HOUR),
    line(`s${phase}${i}`, `t${i}`, phase, 'exit', T0 - 2 * HOUR + d),
  ])

test('etaOf sums the medians ahead plus what is left of the current one', OPTIONS, async () => {
  const rows = rowsOf([...pairsOf(6, 40 * MINUTE, 50 * MINUTE), ...pairsOf(7, 20 * MINUTE, 30 * MINUTE), ...pairsOf(8, 2 * MINUTE, 4 * MINUTE), ...pairsOf(5, 30 * MINUTE, 60 * MINUTE)])
  const stats = statsOf(rows)
  const state = walk(rowsOf([line('me', '9', 5, 'enter', T0)]))
  // current 5: median 45m, elapsed 10m → 35m left; ahead 6+7+8 = 45m + 25m + 3m.
  expect(etaOf(state, stats, T0 + 10 * MINUTE)).toBe((35 + 45 + 25 + 3) * MINUTE)
  // Past the median the current term clamps to zero.
  expect(etaOf(state, stats, T0 + 2 * HOUR)).toBe((45 + 25 + 3) * MINUTE)
  // Between phases there is no current term.
  const between = walk(rowsOf([line('me', '9', 5, 'enter', T0), line('me', '9', 5, 'exit', T0 + MINUTE)]))
  expect(aheadOf(between)).toEqual([6, 7, 8])
  expect(etaOf(between, stats, T0 + HOUR)).toBe((45 + 25 + 3) * MINUTE)
})

test('etaOf needs pairs from two distinct tickets for every phase it sums', OPTIONS, async () => {
  const rows = rowsOf([
    line('a', '1', 7, 'enter', T0), line('a', '1', 7, 'exit', T0 + HOUR),
    line('a', '1', 7, 'enter', T0 + HOUR), line('a', '1', 7, 'exit', T0 + 2 * HOUR), // two pairs, one ticket
    line('b', '2', 8, 'enter', T0), line('b', '2', 8, 'exit', T0 + MINUTE),
    line('c', '3', 8, 'enter', T0), line('c', '3', 8, 'exit', T0 + MINUTE),
  ])
  const stats = statsOf(rows)
  expect(stats[7]!.pairs).toBe(2)
  expect(stats[7]!.tickets).toBe(1)
  const state = walk(rowsOf([line('me', '9', 6, 'enter', T0), line('me', '9', 6, 'exit', T0 + MINUTE)]))
  expect(etaOf(state, stats, T0 + HOUR)).toBe(null)
})

test('until and tokensShort are compact', OPTIONS, async () => {
  expect(until(23 * MINUTE)).toBe('23m')
  expect(until(130 * MINUTE)).toBe('2h10m')
  expect(until(2 * HOUR)).toBe('2h0m')
  expect(until(76 * HOUR)).toBe('3d4h')
  expect(until(20 * 1000)).toBe('0m')
  expect(tokensShort(184_321)).toBe('184k')
  expect(tokensShort(1_234_567)).toBe('1.2M')
  expect(tokensShort(999)).toBe('999')
  expect(tokensShort(999_500)).toBe('1.0M')
  expect(tokensShort(999_950_000)).toBe('1000M')
})

test('cellsOf draws worked phases below the current as done and everything above as ahead', OPTIONS, async () => {
  const skipped = walk(rowsOf([line('a', '1', 1, 'enter', T0), line('a', '1', 2, 'enter', T0 + MINUTE)]))
  expect(cellsOf(skipped)).toBe('◆◈◇◇◇◇◇◇')
  const back = walk(rowsOf([line('a', '1', 6, 'enter', T0), line('a', '1', 6, 'exit', T0 + MINUTE), line('a', '1', 5, 'enter', T0 + 2 * MINUTE)]))
  expect(cellsOf(back)).toBe('◇◇◇◇◈◇◇◇')
  const between = walk(rowsOf([line('a', '1', 1, 'enter', T0), line('a', '1', 1, 'exit', T0 + MINUTE), line('a', '1', 2, 'enter', T0 + MINUTE), line('a', '1', 2, 'exit', T0 + 2 * MINUTE)]))
  expect(cellsOf(between)).toBe('◆◆◇◇◇◇◇◇')
})

const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
const STEP = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as const

/** One model request with the given token usage, read to its end. */
const step = async ($: Kit, it: ReturnType<typeof world>, tokens: number, agentId?: string) => {
  it.usage = { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
  const s = $.turn.step({ ...STEP, ...(agentId === undefined ? {} : { agentId }) } as never)
  for await (const _ of s) {
    // drain
  }
}

test('nothing is drawn when the sink has no row for this session', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('other', '1002', 1, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toBe('')
})

test('nothing is drawn when the sink is missing', OPTIONS, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toBe('')
})

test('an own enter row draws the ticket, tier ?, the current cell and elapsed', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  const text = await drawn($)
  expect(text.startsWith('#1002 ? ◇◇◇◇◈◇◇◇ 5 Implement 0m/—')).toBe(true)
  expect(text).toContain(' · ETA —')
  await it.clock.advance(23 * MINUTE)
  expect(await drawn($)).toContain('23m/—')
})

test('medians and the ETA come from every ticket in the sink', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([
    ...pairsOf(5, 30 * MINUTE, 41 * MINUTE, 60 * MINUTE),
    ...pairsOf(6, 40 * MINUTE, 50 * MINUTE),
    ...pairsOf(7, 20 * MINUTE, 30 * MINUTE),
    ...pairsOf(8, 2 * MINUTE, 4 * MINUTE),
    line('s1', '1002', 5, 'enter', T0),
  ])
  await $.session.start({ cwd: '/t' } as never)
  await it.clock.advance(23 * MINUTE)
  const text = await drawn($)
  expect(text).toContain('23m/41m')
  // 18m left of 41m, then 45m + 25m + 3m ahead = 91m.
  expect(text).toContain('~1h31m left')
  expect(text).not.toContain('ETA —')
})

test('between phases and done have their own labels', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 2, 'enter', T0 - HOUR), line('s1', '1002', 2, 'exit', T0)])
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toBe('#1002 ? ◇◆◇◇◇◇◇◇ between phases · ETA —')
  it.sink([line('s1', '1002', 1, 'enter', T0 - 3 * HOUR), line('s1', '1002', 8, 'enter', T0 - HOUR), line('s1', '1002', 8, 'exit', T0)])
  await $.turn.complete(TURN as never)
  const text = await drawn($)
  expect(text).toContain('done 3h0m')
  expect(text).toContain('◆◇◇◇◇◇◇◆')
})

test('rounds show for a re-entered phase', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 6, 'enter', T0 - 2 * HOUR), line('s1', '1002', 6, 'exit', T0 - HOUR), line('s1', '1002', 6, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toContain('R6×2')
})

test('the full row fits 80 columns', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([
    ...pairsOf(5, 41 * MINUTE, 41 * MINUTE),
    ...pairsOf(6, 50 * MINUTE, 50 * MINUTE),
    ...pairsOf(7, 30 * MINUTE, 30 * MINUTE),
    ...pairsOf(8, 4 * MINUTE, 4 * MINUTE),
    // Review ran twice before this Implement round: rounds[6] = 2.
    line('s1', '1002', 6, 'enter', T0 - 4 * HOUR),
    line('s1', '1002', 6, 'exit', T0 - 3 * HOUR),
    line('s1', '1002', 6, 'enter', T0 - 3 * HOUR + MINUTE),
    line('s1', '1002', 6, 'exit', T0 - 2 * HOUR),
    line('s1', '1002', 5, 'enter', T0),
  ])
  it.write(`${VAULT}/Work Items/In Flight/1002 - Dark mode toggle.md`, '---\ntier: medium\n---\n')
  await $.session.start({ cwd: '/t' } as never)
  await step($, it, 184_000)
  await it.clock.advance(23 * MINUTE)
  const text = await drawn($)
  expect(text).toContain(' · 184k')
  expect(text).toContain('R6×2')
  expect(text.length).toBeLessThanOrEqual(80)
})

test('the fallback row with two rounds, a long elapsed and a big tally fits 80 columns', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([
    ...pairsOf(5, 38 * MINUTE, 38 * MINUTE),
    line('s1', '1005', 5, 'enter', T0 - 6 * HOUR), line('s1', '1005', 5, 'exit', T0 - 5 * HOUR),
    line('s1', '1005', 6, 'enter', T0 - 5 * HOUR), line('s1', '1005', 6, 'exit', T0 - 4 * HOUR),
    line('s1', '1005', 5, 'enter', T0 - 4 * HOUR), line('s1', '1005', 5, 'exit', T0 - 3 * HOUR),
    line('s1', '1005', 6, 'enter', T0 - 3 * HOUR), line('s1', '1005', 6, 'exit', T0 - 2 * HOUR),
    line('s1', '1005', 5, 'enter', T0),
  ])
  it.write(`${VAULT}/Work Items/In Flight/1005 - Something.md`, '---\ntier: medium\n---\n')
  await $.session.start({ cwd: '/t' } as never)
  await step($, it, 1_400_000)
  await it.clock.advance(72 * MINUTE)
  const text = await drawn($)
  // The ticket's own two one-hour Implement rounds pull the median up from 38m.
  expect(text).toContain('1h12m/49m')
  expect(text).toContain(' · ETA —')
  expect(text).toContain('R5×3 R6×2')
  expect(text.length).toBeLessThanOrEqual(80)
})

test('tierOf reads tier only from the frontmatter block', OPTIONS, async () => {
  expect(tierOf('---\ntype: work-item\ntier: full\n---\nbody')).toBe('full')
  expect(tierOf('---\ntype: work-item\n---\n\ntier: full in the body')).toBe(null)
  expect(tierOf('no frontmatter\ntier: small')).toBe(null)
})

test('the tier comes from the Work Item note, In Flight before Done', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  it.write(`${VAULT}/Work Items/Done/Sprint 1/1002 - Old copy.md`, '---\ntier: small\n---\n')
  it.write(`${VAULT}/Work Items/In Flight/1002 - Dark mode toggle.md`, '---\ntier: full\n---\n')
  it.write(`${VAULT}/Work Items/In Flight/2501 - Not this one.md`, '---\ntier: medium\n---\n')
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toContain('#1002 full')
})

test('a prefix id does not match', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '2501', 5, 'enter', T0)])
  it.write(`${VAULT}/Work Items/In Flight/1002 - Dark mode toggle.md`, '---\ntier: full\n---\n')
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toContain('#2501 ?')
})

test('a note under Done alone is found, and a moved note is rescanned', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1001', 7, 'enter', T0)])
  it.write(`${VAULT}/Work Items/Done/Sprint 1/1001 - Shipped.md`, '---\ntier: medium\n---\n')
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toContain('#1001 medium')
  it.files.delete(`${VAULT}/Work Items/Done/Sprint 1/1001 - Shipped.md`)
  it.write(`${VAULT}/Work Items/In Testing/1001 - Shipped.md`, '---\ntier: full\n---\n')
  await $.turn.complete(TURN as never)
  expect(await drawn($)).toContain('#1001 full')
})

test('tokens tally main-loop and subagent steps since the phase enter', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  await step($, it, 100_000)
  await step($, it, 84_000, 'sub-1')
  expect(await drawn($)).toContain(' · 184k')
  expect(it.store.get('tokens:s1')).toMatchObject({ ticket: '1002', phase: 5, enteredAt: T0, tokens: 184_000 })
})

test('a new enter zeroes the tally, a resume keeps it, a restart keeps it', OPTIONS, async ($, on) => {
  const it = world(on)
  it.store.set('tokens:s1', { ticket: '1002', phase: 5, enteredAt: T0, enteredOrder: 1, tokens: 50_000, fresh: 50_000 })
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never) // a restart: fresh $.state, the store carries on
  await step($, it, 1000)
  expect(await drawn($)).toContain(' · 51k')
  it.sink([line('s1', '1002', 5, 'enter', T0), line('s1', '1002', 5, 'exit', T0 + MINUTE), line('s1', '1002', 6, 'enter', T0 + 2 * MINUTE)])
  await $.turn.complete(TURN as never)
  await step($, it, 2000)
  expect(await drawn($)).toContain(' · 2k')
})

test('the band shows new tokens, not cache re-reads; /phase shows both', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  // A warm step: most of it is the cached context read back.
  it.usage = { input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 3_000, model: 'm' }
  for await (const _ of $.turn.step({ ...STEP } as never)) {
    // drain
  }
  const band = await drawn($)
  expect(band).toContain(' · 6k')
  expect(band).not.toContain('206k')
  expect(it.store.get('tokens:s1')).toMatchObject({ tokens: 206_000, fresh: 6_000 })
  const report = (await $.command.run({ command: 'phase', args: '' } as never)) as { text: string }
  expect(report.text).toContain('6k new')
  expect(report.text).toContain('206k processed')
  // A tally stored before the split counts its new tokens from here.
  it.store.set('tokens:s1', { ticket: '1002', phase: 5, enteredAt: T0, enteredOrder: 1, tokens: 90_000 })
  await step($, it, 1_000)
  expect(await drawn($)).toContain(' · 1k')
})

test('a new ticket zeroes the tally', OPTIONS, async ($, on) => {
  const it = world(on)
  it.store.set('tokens:s1', { ticket: '1001', phase: 5, enteredAt: T0, enteredOrder: 1, tokens: 50_000, fresh: 50_000 })
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  await step($, it, 1000)
  expect(await drawn($)).toContain(' · 1k')
})

test('no tokens are shown between phases', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0), line('s1', '1002', 5, 'exit', T0 + MINUTE)])
  await $.session.start({ cwd: '/t' } as never)
  await step($, it, 1000)
  expect(await drawn($)).toBe('#1002 ? ◇◇◇◇◆◇◇◇ between phases · ETA —')
})

test('a Bash call to ticket-phase.sh refreshes in the same turn', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toContain('5 Implement')
  it.sink([line('s1', '1002', 5, 'enter', T0), line('s1', '1002', 5, 'exit', T0 + MINUTE), line('s1', '1002', 6, 'enter', T0 + MINUTE)])
  await $.tool.call({ tool: 'Bash', command: '~/.claude/scripts/ticket-phase.sh 1002 6 enter --session s1' } as never)
  expect(await drawn($)).toContain('6 Review')
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(it.bash.length).toBe(2)
})

test('the tick re-reads only when the sink mtime moved', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)], T0)
  await $.session.start({ cwd: '/t' } as never)
  // Another session advances the ticket but the mtime is unchanged (a stat lie): nothing moves.
  it.sink([line('s1', '1002', 5, 'enter', T0), line('s2', '1002', 5, 'exit', T0 + MINUTE), line('s2', '1002', 6, 'enter', T0 + MINUTE)], T0)
  await it.clock.advance(TICK)
  expect(await drawn($)).toContain('5 Implement')
  // Now the mtime moves: the band follows within a tick.
  it.sink([line('s1', '1002', 5, 'enter', T0), line('s2', '1002', 5, 'exit', T0 + MINUTE), line('s2', '1002', 6, 'enter', T0 + MINUTE)], T0 + 2 * MINUTE)
  await it.clock.advance(TICK)
  expect(await drawn($)).toContain('6 Review')
})

test('expandHome expands the defaults', OPTIONS, async () => {
  expect(expandHome('~/.claude/metrics/x.jsonl', '/home/t')).toBe('/home/t/.claude/metrics/x.jsonl')
  expect(expandHome('/abs/path', '/home/t')).toBe('/abs/path')
  expect(expandHome('~', '/home/t')).toBe('/home/t')
})

test('the default sink path is read under HOME', { options: {} }, async ($, on) => {
  const it = world(on)
  it.write('/home/t/.claude/metrics/ticket-phase-tokens.jsonl', line('s1', '1002', 5, 'enter', T0) + '\n')
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($).then(t => t.startsWith('#1002'))).toBe(true)
})

test('/phase prints the summary and says when there is no ticket', OPTIONS, async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  const none = await phase($, '')
  expect(none.text).toContain('No phase row for this session')
  it.sink(['garbage', line('s1', '1002', 5, 'enter', T0 - 10 * MINUTE), line('x', 't', 5, 'enter', T0 - HOUR), line('x', 't', 5, 'exit', T0 - 20 * MINUTE)])
  const some = await phase($, '')
  expect(some.text).toContain('#1002')
  expect(some.text).toContain('5 Implement · open 10m')
  expect(some.text).toContain('1 pair · 1 ticket')
  expect(some.text).toContain('1 row skipped')
  expect(some.text).toContain("this session's steps, subagents included")
})

test('/phase hide draws nothing and keeps tracking; /phase show brings it back', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  await phase($, 'hide')
  expect(await drawn($)).toBe('')
  expect(it.store.get('hidden')).toBe(true)
  await phase($, 'show')
  expect(await drawn($)).toContain('#1002')
})

test('walk: rounds count re-entries after the phase was left, never orphans', OPTIONS, async () => {
  // An orphan exit then an enter is the first round, not the second.
  const orphan = walk(rowsOf([line('a', '1', 6, 'exit', T0), line('a', '1', 6, 'enter', T0 + MINUTE)]))
  expect(orphan.phases[6]!.rounds).toBe(1)
  expect(orphan.phases[6]!.exits).toBe(1)
  // Leaving 6 by entering 5 (a skipped exit) still makes the next enter 6 a second round.
  const skipped = walk(rowsOf([line('a', '1', 5, 'enter', T0), line('a', '1', 5, 'exit', T0 + 1 * MINUTE), line('a', '1', 6, 'enter', T0 + 2 * MINUTE), line('a', '1', 5, 'enter', T0 + 3 * MINUTE), line('a', '1', 5, 'exit', T0 + 4 * MINUTE), line('a', '1', 6, 'enter', T0 + 5 * MINUTE)]))
  expect(skipped.phases[6]!.rounds).toBe(2)
  expect(skipped.phases[5]!.rounds).toBe(2)
})

test('walk: an orphan re-exit does not move the done total', OPTIONS, async () => {
  const s = walk(rowsOf([line('a', '1', 1, 'enter', T0), line('a', '1', 8, 'enter', T0 + HOUR), line('a', '1', 8, 'exit', T0 + 2 * HOUR), line('a', '1', 8, 'exit', T0 + 3 * HOUR)]))
  expect(s.isDone).toBe(true)
  expect(s.lastExitAt).toBe(T0 + 2 * HOUR)
})

test('walk: a reopened ticket is no longer done and the phases ahead follow the latest row', OPTIONS, async () => {
  const s = walk(rowsOf([line('a', '1', 1, 'enter', T0), line('a', '1', 8, 'enter', T0 + HOUR), line('a', '1', 8, 'exit', T0 + 2 * HOUR), line('b', '1', 2, 'enter', T0 + 3 * HOUR), line('b', '1', 2, 'exit', T0 + 4 * HOUR)]))
  expect(s.isDone).toBe(false)
  expect(s.current).toBe(null)
  expect(aheadOf(s)).toEqual([3, 4, 5, 6, 7, 8])
})

test('walk: a same-session resume neither reopens nor rounds the phase', OPTIONS, async () => {
  const s = walk(rowsOf([line('a', '1', 5, 'enter', T0), line('a', '1', 5, 'enter', T0 + HOUR), line('a', '1', 5, 'exit', T0 + HOUR + MINUTE)]))
  expect(s.phases[5]!.enters).toBe(2)
  expect(s.phases[5]!.rounds).toBe(1)
  expect(s.phases[5]!.open).toEqual([])
  expect(s.current).toBe(null)
})

test('a re-entry of the same phase zeroes the tally', OPTIONS, async ($, on) => {
  const it = world(on)
  it.store.set('tokens:s1', { ticket: '1002', phase: 6, enteredAt: T0 - 2 * HOUR, enteredOrder: 1, tokens: 50_000, fresh: 50_000 })
  it.sink([line('s1', '1002', 6, 'enter', T0 - 2 * HOUR), line('s1', '1002', 6, 'exit', T0 - HOUR), line('s1', '1002', 6, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  await step($, it, 1000)
  expect(await drawn($)).toContain(' · 1k')
})

test('refresh stats before it reads, so a write between the two is caught by the next tick', OPTIONS, async ($, on) => {
  const it = world(on)
  const v1 = [line('s1', '1002', 5, 'enter', T0)]
  const v2 = [...v1, line('s1', '1002', 5, 'exit', T0 + MINUTE), line('s1', '1002', 6, 'enter', T0 + MINUTE)]
  it.sink(v1, T0)
  it.afterRead = () => {
    it.afterRead = null
    it.sink(v2, T0 + 2 * MINUTE)
  }
  await $.session.start({ cwd: '/t' } as never)
  await it.clock.advance(TICK)
  expect(await drawn($)).toContain('6 Review')
})

test('a sink that appears after a failed read is picked up by the tick, and an unchanged sink is not re-read', OPTIONS, async ($, on) => {
  const it = world(on)
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toBe('')
  it.sink([line('s1', '1002', 5, 'enter', T0)], T0)
  await it.clock.advance(TICK)
  expect(await drawn($)).toContain('5 Implement')
  const reads = it.reads
  await it.clock.advance(3 * TICK)
  expect(it.reads).toBe(reads)
  // A sink with no row of ours is read once per change, not once per tick.
  it.sink([line('other', '1', 5, 'enter', T0)], T0 + MINUTE)
  await it.clock.advance(TICK)
  expect(await drawn($)).toBe('')
  const again = it.reads
  await it.clock.advance(3 * TICK)
  expect(it.reads).toBe(again)
})

test('a note created after the first reading is noticed by the tick', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)], T0)
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toContain('#1002 ?')
  it.write(`${VAULT}/Work Items/In Flight/1002 - New.md`, '---\ntier: full\n---\n')
  // A missing note is looked for again every ten minutes, not every tick.
  await it.clock.advance(10 * 60_000)
  expect(await drawn($)).toContain('#1002 full')
})

test('a ticket with no note is not looked for on every tick', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)], T0)
  await $.session.start({ cwd: '/t' } as never)
  const after = it.lists
  // Five quiet minutes: no search at all; past ten, one.
  await it.clock.advance(5 * 60_000)
  expect(it.lists).toBe(after)
  await it.clock.advance(6 * 60_000)
  expect(it.lists).toBeGreaterThan(after)
})

test('a sink past the read limit still gives a row, from its newest part', OPTIONS, async ($, on) => {
  const it = world(on)
  const tail = [line('s1', '1002', 5, 'enter', T0)].join('\n')
  // An old row cut in half by the tail, then the rows that matter.
  it.write(SINK, `${'{"old":"row"}\n'.repeat(260_000)}${tail}\n`)
  on('process.run', (_, e) =>
    ({
      value:
        e.argv[0] === 'tail'
          ? { exitCode: 0, stdout: `ld":"row"}\n${tail}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
          : { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }) as never,
  )
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toContain('#1002')
  const report = (await $.command.run({ command: 'phase', args: '' } as never)) as { text: string }
  expect(report.text).toContain('newest 3 MiB')
  // the row the tail cut in half is dropped, not counted as a bad row
  expect(report.text).toContain('0 rows skipped')
})

test('a row keeps its order when rows before it drop out of the read window', OPTIONS, async () => {
  const rows = [
    line('s1', '1002', 4, 'exit', T0 - MINUTE),
    line('s1', '1002', 5, 'enter', T0),
    line('s1', '1002', 5, 'exit', T0),
    line('s1', '1002', 5, 'enter', T0),
  ]
  const whole = parseRows(rows.join('\n')).rows
  const cut = parseRows(rows.slice(1).join('\n')).rows
  expect(cut.map(r => r.order)).toEqual(whole.slice(1).map(r => r.order))
})

test('the tail keeps a first row that starts exactly at the cut', OPTIONS, async ($, on) => {
  const it = world(on)
  it.write(SINK, `${'{"old":"row"}\n'.repeat(260_000)}${line('s1', '1002', 5, 'enter', T0)}\n`)
  // The window opens exactly on a whole row: asked for one byte more, tail shows the
  // newline before it; asked for exactly the window, the row comes first.
  const row = `${line('s1', '1002', 5, 'enter', T0)}\n`
  on('process.run', (_, e) =>
    ({
      value:
        e.argv[0] === 'tail'
          ? { exitCode: 0, stdout: Number(e.argv[2]) > 3 * 1024 * 1024 ? `\n${row}` : row, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
          : { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }) as never,
  )
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toContain('#1002')
})

test('a tail whose output was cut short is not taken as the history', OPTIONS, async ($, on) => {
  const it = world(on)
  it.write(SINK, `${'{"old":"row"}\n'.repeat(260_000)}${line('s1', '1002', 5, 'enter', T0)}\n`)
  on('process.run', () =>
    ({ value: { exitCode: 0, stdout: `x\n${line('s1', '1002', 5, 'enter', T0)}\n`, stderr: '', isStdoutTruncated: true, isStderrTruncated: false } }) as never,
  )
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toBe('')
})

test('a tally still in use is kept however long ago its phase began', OPTIONS, async ($, on) => {
  const it = world(on)
  const DAY = 86_400_000
  it.store.set('tokens:busy', { ticket: '1', phase: 5, enteredAt: T0 - 40 * DAY, enteredOrder: 0, tokens: 5, at: T0 - DAY })
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  expect(it.store.has('tokens:busy')).toBe(true)
})

test('two refreshes at once walk the folders for a missing note once', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)], T0)
  const before = it.lists
  await $.session.start({ cwd: '/t' } as never)
  const one = it.lists - before
  expect(one).toBeGreaterThan(0)
  // the session moves to another ticket with no note: nothing has looked for it yet
  it.sink([line('s1', '1002', 5, 'enter', T0), line('s1', '1003', 2, 'enter', T0 + MINUTE)], T0 + MINUTE)
  const start = it.lists
  await Promise.all([$.turn.complete(TURN as never), $.turn.complete(TURN as never)])
  expect(it.lists - start).toBe(one)
})

test('a step stamps its tally with when it ran, so a long phase still in use survives the prune', OPTIONS, async ($, on) => {
  const it = world(on)
  const DAY = 86_400_000
  it.sink([line('s1', '1002', 5, 'enter', T0 - 40 * DAY)])
  await $.session.start({ cwd: '/t' } as never)
  await step($, it, 1000)
  const tally = it.store.get('tokens:s1') as { at?: number; enteredAt: number }
  expect(tally.at).toBeGreaterThan(tally.enteredAt + 30 * DAY)
  // the next session's prune keeps it
  await $.session.start({ cwd: '/t' } as never)
  expect(it.store.has('tokens:s1')).toBe(true)
})

test('repeated refreshes do not look for a missing note more than once in ten minutes', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)], T0)
  await $.session.start({ cwd: '/t' } as never)
  const after = it.lists
  await $.turn.complete(TURN as never)
  await $.turn.complete(TURN as never)
  expect(it.lists).toBe(after)
})

test('tallies of phases entered more than 30 days ago leave the store at session start', OPTIONS, async ($, on) => {
  const it = world(on)
  const DAY = 86_400_000
  it.store.set('tokens:old', { ticket: '1', phase: 5, enteredAt: T0 - 31 * DAY, enteredOrder: 1, tokens: 5 })
  it.store.set('tokens:recent', { ticket: '2', phase: 5, enteredAt: T0 - 2 * DAY, enteredOrder: 1, tokens: 5 })
  it.store.set('other:key', 1)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  expect(it.store.has('tokens:old')).toBe(false)
  expect(it.store.has('tokens:recent')).toBe(true)
  expect(it.store.has('other:key')).toBe(true)
})

test('two steps in flight at once both land in the tally', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  it.usage = { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
  const a = $.turn.step({ ...STEP } as never)
  const b = $.turn.step({ ...STEP, agentId: 'sub-1' } as never)
  for await (const _ of a) { /* drain */ }
  for await (const _ of b) { /* drain */ }
  expect(await drawn($)).toContain(' · 2k')
})

test('a same-second exit and re-enter starts the tally over', OPTIONS, async ($, on) => {
  const it = world(on)
  it.store.set('tokens:s1', { ticket: '1002', phase: 5, enteredAt: T0, enteredOrder: 1, tokens: 52_000, fresh: 52_000 })
  it.sink([line('s1', '1002', 5, 'enter', T0), line('s1', '1002', 5, 'exit', T0), line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  await step($, it, 1000)
  expect(await drawn($)).toContain(' · 1k')
})

test('a step with a missing usage field does not poison the tally', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  it.usage = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' } as never
  const s = $.turn.step({ ...STEP } as never)
  for await (const _ of s) { /* drain */ }
  expect(await drawn($)).toContain(' · 1k')
})

test('the cached note path is matched on its file name, not on a folder above it', { options: { sink: SINK, vault: '/t/2 - vault' } }, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1', 5, 'enter', T0)])
  it.write('/t/2 - vault/Work Items/In Flight/1 - one.md', '---\ntier: full\n---\n')
  it.write('/t/2 - vault/Work Items/In Flight/2 - two.md', '---\ntier: small\n---\n')
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toContain('#1 full')
  it.sink([line('s1', '1', 5, 'enter', T0), line('s1', '2', 5, 'enter', T0 + MINUTE)])
  await $.turn.complete(TURN as never)
  expect(await drawn($)).toContain('#2 small')
})

test('moving to a ticket with no note drops the old note path', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  it.write(`${VAULT}/Work Items/In Flight/1002 - Dark mode toggle.md`, '---\ntier: full\n---\n')
  await $.session.start({ cwd: '/t' } as never)
  it.sink([line('s1', '1002', 5, 'enter', T0), line('s1', '1001', 1, 'enter', T0 + MINUTE)])
  await $.turn.complete(TURN as never)
  const text = (await phase($, '')).text
  expect(text).toContain('#1001 · tier ?')
  expect(text).not.toContain('1002 - Dark mode')
})

test('a note that reads but cannot be stat-ed still gives its tier', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  const note = `${VAULT}/Work Items/In Flight/1002 - Dark mode toggle.md`
  it.write(note, '---\ntier: full\n---\n')
  it.statFails.add(note)
  await $.session.start({ cwd: '/t' } as never)
  expect(await drawn($)).toContain('#1002 full')
})

test('a refresh that fails inside the Bash hook does not fail the Bash call', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  it.statFails.add(SINK)
  const out = await $.tool.call({ tool: 'Bash', command: 'ticket-phase.sh 1002 5 exit --session s1' } as never)
  expect(out).toBeDefined()
  expect(it.bash.length).toBe(1)
})

test('desktop: the Svg alt equals the terminal row in every state', OPTIONS, async ($, on) => {
  const it = world(on)
  // Open phase with a median, then overrun (red), then without a median, between phases, and done.
  it.sink([
    ...pairsOf(5, 30 * MINUTE, 41 * MINUTE, 60 * MINUTE),
    ...pairsOf(6, 40 * MINUTE, 50 * MINUTE),
    ...pairsOf(7, 20 * MINUTE, 30 * MINUTE),
    ...pairsOf(8, 2 * MINUTE, 4 * MINUTE),
    line('s1', '1002', 5, 'enter', T0),
  ])
  await $.session.start({ cwd: '/t' } as never)
  await it.clock.advance(23 * MINUTE)
  expect(await drawn($, 'desktop')).toBe(await drawn($, 'terminal'))
  expect(await drawn($, 'desktop')).toContain('23m/41m')
  await it.clock.advance(80 * MINUTE)
  expect(await drawn($, 'desktop')).toBe(await drawn($, 'terminal'))
  it.sink([line('s1', '1002', 3, 'enter', T0)])
  await $.turn.complete(TURN as never)
  expect(await drawn($, 'desktop')).toBe(await drawn($, 'terminal'))
  expect(await drawn($, 'desktop')).toContain('/—')
  it.sink([line('s1', '1002', 2, 'enter', T0 - HOUR), line('s1', '1002', 2, 'exit', T0)])
  await $.turn.complete(TURN as never)
  expect(await drawn($, 'desktop')).toBe('#1002 ? ◇◆◇◇◇◇◇◇ between phases · ETA —')
  it.sink([line('s1', '1002', 1, 'enter', T0 - 3 * HOUR), line('s1', '1002', 8, 'enter', T0 - HOUR), line('s1', '1002', 8, 'exit', T0)])
  await $.turn.complete(TURN as never)
  expect(await drawn($, 'desktop')).toBe(await drawn($, 'terminal'))
  expect(await drawn($, 'desktop')).toContain('done 3h0m')
})

test('desktop: the drawing carries the pill, the phase mascot, and the red color on an overrun', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([...pairsOf(5, 30 * MINUTE, 41 * MINUTE, 60 * MINUTE), line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  await it.clock.advance(23 * MINUTE)
  let s = await source($)
  expect(s).toContain('>5 Implement<')
  expect(s).toContain('data-mascot="hammer"')
  expect(s).toContain('#3B9C5F')
  // 23m of a 41m median: the ghost of phase 6 is at 0.05 + 0.5 × 23/41; the enter is too old to slide.
  expect(s).toContain(`class="ghost" opacity="${(0.05 + 0.5 * (23 / 41)).toFixed(3)}"`)
  expect(s).not.toContain('class="slide"')
  await it.clock.advance(80 * MINUTE)
  s = await source($)
  expect(s).toContain('#D0453F')
  it.sink([line('s1', '1002', 2, 'enter', T0 - HOUR), line('s1', '1002', 2, 'exit', T0)])
  await $.turn.complete(TURN as never)
  s = await source($)
  expect(s).not.toContain('class="pill"')
  expect(s).toContain('data-mascot="thinking-dots"')
})

test('desktop: a hidden row and a survey draw nothing; the terminal row is unchanged', OPTIONS, async ($, on) => {
  const it = world(on)
  it.sink([line('s1', '1002', 5, 'enter', T0)])
  await $.session.start({ cwd: '/t' } as never)
  expect((await drawn($, 'terminal')).startsWith('#1002 ? ◇◇◇◇◈◇◇◇ 5 Implement 0m/—')).toBe(true)
  await phase($, 'hide')
  expect(await drawn($, 'desktop')).toBe('')
  await phase($, 'show')
  expect(await drawn($, 'desktop')).not.toBe('')
})
