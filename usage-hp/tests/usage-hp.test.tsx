import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The test host runs under a real timer, but the mod's lib (no DOM, no Node) declares none.
declare const setTimeout: (callback: () => void, ms: number) => unknown

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)
const MINUTE = 60_000
const TURN = {
  answer: '',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
  reason: 'answer',
} as const
const SURFACES = ['desktop', 'terminal'] as const
// Nothing sits beneath the mod in a test: an empty band stands for the engine.
const EMPTY = { type: 'Box', props: {}, children: [] } as never

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * The engine beneath the mod, in memory: a clock, a store, and the usage
 * figures a test sets as it goes.
 */
const world = (on: On, now = T0) => {
  const clock = mock.clock(on, { now })
  const store = new Map<string, unknown>()
  const it = {
    clock,
    store,
    usd: 0 as number | null,
    limits: [] as Limit[],
    session: 's1',
    startedAt: now,
    usageCalls: 0,
    keyScans: 0,
    /** A slow engine read (ms), and the most reads in flight at once. */
    usageDelayMs: 0,
    usageActive: 0,
    usageMost: 0,
    /** Per-call delays (ms), used up in call order before usageDelayMs applies. */
    usageDelays: [] as number[],
    usageFailsOnce: false,
  }
  on('session.usage', async () => {
    it.usageCalls += 1
    it.usageActive += 1
    it.usageMost = Math.max(it.usageMost, it.usageActive)
    // What the engine knows when the read is asked, delivered after any delay.
    const limits = it.limits
    const usd = it.usd
    const delay = it.usageDelays.length > 0 ? it.usageDelays.shift()! : it.usageDelayMs

    if (delay > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, delay))
    }

    it.usageActive -= 1

    if (it.usageFailsOnce) {
      it.usageFailsOnce = false
      throw new Error('usage unavailable')
    }

    return {
      value: {
        startedAt: it.startedAt,
        context: { window: 200_000 },
        rateLimits: limits,
        ...(usd === null ? {} : { cost: { usd } }),
      },
    }
  })
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
  on('store.keys', () => (it.keyScans++, { value: [...store.keys()] }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', () => EMPTY)

  return it
}

// A test's body, not its options: the kit it is handed.
type Kit = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

/** `/hp <args>` as the person types it; the engine fills in where it came from. */
const hp = (args: string) => ({ command: 'hp', args }) as never

const drawn = async ($: Kit, surface: (typeof SURFACES)[number] = 'desktop') => {
  const ui = await $.ui.mount({
    plugin: 'usage-hp',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false },
  } as never)
  const found = await (
    ui as never as { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }
  ).findAll({ type: 'Text' })

  return found.map(one => one.text ?? '').join('')
}

const spendKeys = (store: Map<string, unknown>) =>
  [...store.keys()].filter(key => key.startsWith('spend:'))

for (const surface of SURFACES) {
  test(`${surface}: a draining bar says when it empties, and an old reading its age`, async ($, on) => {
    const it = world(on)
    it.usd = 1.5
    it.limits = [
      {
        kind: 'five_hour',
        percentUsed: 20,
        resetsAt: new Date(T0 + 4 * 60 * MINUTE).toISOString(),
      },
    ]

    await $.turn.complete(TURN)
    await it.clock.advance(10 * MINUTE)
    it.limits = [{ ...it.limits[0]!, percentUsed: 30 }]
    await $.turn.complete(TURN)

    const text = await drawn($, surface)
    expect(text).toContain('5H')
    expect(text).toContain('70% left')
    expect(text).toContain('resets in 3h 50m')
    // 10 points in 10 minutes with 70 left: 70 minutes, well before the reset.
    expect(text).toContain('empty in ~1h 10m at this pace')
    expect(text).toContain('$1.50 this session')
    expect(text).not.toContain('as of')

    await it.clock.advance(11 * MINUTE)
    expect(await drawn($, surface)).toContain('as of 11m ago')
  })
}

test('a slow drain outlasts the reset', async ($, on) => {
  const it = world(on)
  const resetsAt = new Date(T0 + 60 * MINUTE).toISOString()
  it.limits = [{ kind: 'five_hour', percentUsed: 20, resetsAt }]

  await $.turn.complete(TURN)
  await it.clock.advance(10 * MINUTE)
  it.limits = [{ kind: 'five_hour', percentUsed: 21, resetsAt }]
  await $.turn.complete(TURN)

  expect(await drawn($)).toContain('lasts past reset')
})

test('a window that reset while idle reads full, not its old figure', async ($, on) => {
  const it = world(on)
  it.limits = [
    {
      kind: 'five_hour',
      percentUsed: 88,
      resetsAt: new Date(T0 + 30 * MINUTE).toISOString(),
    },
  ]

  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('12% left')

  await it.clock.advance(31 * MINUTE)
  const text = await drawn($)
  expect(text).toContain('100% left')
  expect(text).toContain('window reset')
  expect(text).not.toContain('12% left')
  expect(text).not.toContain('resets in')
})

test('/hp draws a spend bar from the entered figures', async ($, on) => {
  const it = world(on)
  it.usd = 0.25

  const answer = await $.command.run(hp('12.21 300'))
  expect(answer.text).toContain('$12.21 of $300.00')

  const text = await drawn($)
  expect(text).toContain('SPEND')
  expect(text).toContain('96% left')
  // What the session cost before the entry is inside the entered figure.
  expect(text).toContain('$287.79 left of $300')
})

test('each turn adds the session cost to the entered spend, once', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 100'))

  it.usd = 2
  await $.turn.complete(TURN)
  // $88 left: the range is under a dollar wide, so the figure itself.
  expect(await drawn($)).toContain('$88.00 left of $100')

  it.usd = 5
  await $.turn.complete(TURN)
  // The same figure read again adds nothing.
  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('$84–86 left of $100')
  expect(it.store.get(spendKeys(it.store)[0]!)).toBe(5)
  expect(spendKeys(it.store)).toHaveLength(1)
})

test('sessions keep separate keys, so neither overwrites the other', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 100'))
  it.usd = 2
  await $.turn.complete(TURN)

  // Another session finished a turn at the same moment: its key, not ours.
  const [own] = spendKeys(it.store)
  const other = own!.replace(/s1$/, 's2')
  it.store.set(other, 7)

  it.usd = 3
  await it.clock.advance(3 * MINUTE)
  await $.turn.complete(TURN)

  expect(it.store.get(own!)).toBe(3)
  expect(it.store.get(other)).toBe(7)
  // 10 entered + 3 ours + 7 theirs = $80 left: a tenth of the count and a cold day ($2) of unseen spend below, a fifth above.
  expect(await drawn($)).toContain('$77–82 left of $100')
})

test('a turn at an unchanged cost leaves the session key as it stands', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0 100'))
  it.usd = 4
  await $.turn.complete(TURN)
  const [own] = spendKeys(it.store)
  expect(it.store.get(own!)).toBe(4)

  // A second turn at the same cost must not shrink or double what is stored.
  await $.turn.complete(TURN)
  expect(it.store.get(own!)).toBe(4)
  expect(await drawn($)).toContain('$95–97 left of $100')
})

test('a new month starts the spend over', async ($, on) => {
  const eve = Date.UTC(2026, 9, 31, 23, 50, 0)
  const it = world(on, eve)
  await $.command.run(hp('50 100'))
  it.usd = 4
  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('$45–47 left of $100')

  await it.clock.advance(20 * MINUTE)
  it.usd = 5
  await $.turn.complete(TURN)

  // November holds only what was spent after the last October reading.
  expect(await drawn($)).toContain('$96–100 left of $100')
  expect(spendKeys(it.store).every(key => key.includes(':2026-11:'))).toBe(true)
})

test('a session with its own limits never shows or spends the entered one', async ($, on) => {
  const it = world(on)
  it.store.set('budget', { limitUsd: 100, spentUsd: 10, month: '2026-10', epoch: T0 - 1 })
  it.usd = 6
  it.limits = [{ kind: 'five_hour', percentUsed: 10 }]
  await $.turn.complete(TURN)

  // The window dropped out of a later reading: still not the entered limit's.
  it.limits = []
  it.usd = 9
  await $.turn.complete(TURN)

  expect(spendKeys(it.store)).toHaveLength(0)
  expect(await drawn($)).not.toContain('SPEND')
})

test('before the first reply the entered limit is not drawn', async ($, on) => {
  const it = world(on)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => e as never)
  it.store.set('budget', { limitUsd: 100, spentUsd: 10, month: '2026-10', epoch: T0 - 1 })

  // The session starts and takes its first reading, with no reply yet.
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)

  const text = await drawn($)
  expect(text).toContain('waiting for the first reply')
  expect(text).not.toContain('SPEND')
  expect(spendKeys(it.store)).toHaveLength(0)
})

test('entering a higher spend is not read as a burn rate', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 100'))
  await it.clock.advance(10 * MINUTE)
  await $.command.run(hp('40 100'))
  await it.clock.advance(6 * MINUTE)

  const text = await drawn($)
  expect(text).toContain('$58–60 left of $100')
  expect(text).not.toContain('empty in')
})

test('/hp off forgets the limit and every session key', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 100'))
  it.usd = 2
  await $.turn.complete(TURN)

  await $.command.run(hp('off'))
  // The resync log is history and stays; nothing else does.
  expect([...it.store.keys()].filter(key => !key.startsWith('sync:'))).toHaveLength(0)
  expect(await drawn($)).not.toContain('SPEND')
})

test('/hp style used fills the bar as the limit is spent', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('17.98 300'))
  expect(await drawn($)).toContain('94% left')

  const answer = await $.command.run(hp('style used'))
  expect(answer.text).toContain('used')
  expect(it.store.get('style')).toBe('used')

  const text = await drawn($, 'terminal')
  expect(text).toContain('6% used')
  expect(text).toContain('$17.98 / $300')
  expect(text).not.toContain('% left')
  // 6% of twenty cells is one filled cell, where 94% left was nineteen.
  expect(text.split('█').length - 1).toBe(1)
})

test('/hp style hearts draws ten hearts that drain by quarters', async ($, on) => {
  const it = world(on)
  it.limits = [{ kind: 'five_hour', percentUsed: 45 }]
  await $.command.run(hp('style hearts'))
  await $.turn.complete(TURN)

  // 55% left is 22 quarters: five whole hearts, one part heart, four empty.
  const text = await drawn($, 'terminal')
  expect(text).toContain('55% left')
  expect(text.split('♡').length - 1).toBe(4)
  expect(text).not.toContain('█')
})

test('/hp style rejects a style it does not have', async ($, on) => {
  const it = world(on)
  const answer = await $.command.run(hp('style rainbow'))
  expect(answer.text).toContain('Usage: /hp style')
  expect(it.store.has('style')).toBe(false)
})

test('/hp hide draws nothing and keeps tracking; /hp show brings the row back', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 100'))
  expect(await drawn($)).toContain('SPEND')

  await $.command.run(hp('hide'))
  expect(await drawn($)).toBe('')

  it.usd = 5
  await $.turn.complete(TURN)
  expect(await drawn($)).toBe('')

  await $.command.run(hp('show'))
  // The turn taken while hidden was counted.
  expect(await drawn($)).toContain('$84–86 left of $100')
})

test('/hp style text keeps the figures and drops the bar', async ($, on) => {
  world(on)
  await $.command.run(hp('10 100'))
  await $.command.run(hp('style text'))

  const text = await drawn($)
  expect(text).toContain('90% left')
  expect(text).toContain('$90.00 left of $100')
  expect(text).not.toContain('█')
  expect(text).not.toContain('░')
})

test('a limit with cents keeps them in the row', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0.75 1.5'))
  await $.command.run(hp('style used'))

  const text = await drawn($)
  // $0.75 of $2 would read as 38%; the cents keep the dollars and the percent agreeing.
  expect(text).toContain('$0.75 / $1.50')
  expect(text).toContain('50% used')
  expect(it.store.get('budget')).toMatchObject({ limitUsd: 1.5, spentUsd: 0.75 })
})

test('the used style lights exactly the cells the bar style leaves dark', async ($, on) => {
  world(on)
  // 97.5% left is nineteen and a half cells: the bar rounds up to twenty lit...
  await $.command.run(hp('7.5 300'))
  const bar = await drawn($, 'terminal')
  expect(bar.split('█').length - 1).toBe(20)
  expect(bar.split('░').length - 1).toBe(0)

  // ...so used lights none, rather than rounding its own half cell up to one.
  await $.command.run(hp('style used'))
  const used = await drawn($, 'terminal')
  expect(used.split('█').length - 1).toBe(0)
  expect(used.split('░').length - 1).toBe(20)
  expect(used).toContain('3% used')
  expect(used).toContain('$7.50 / $300')
})

test('desktop draws the bar as one image, with shared figures said once beneath', async ($, on) => {
  const it = world(on)
  it.usd = 12.29
  const past = new Date(T0 - MINUTE).toISOString()
  it.limits = [
    { kind: 'five_hour', percentUsed: 40, resetsAt: past },
    { kind: 'seven_day', percentUsed: 40, resetsAt: past },
  ]
  await $.turn.complete(TURN)

  const ui = (await $.ui.mount({
    plugin: 'usage-hp',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false },
  } as never)) as never as { findAll: (q: { type: string }) => Promise<unknown[]> }
  // Two hearts and two bars, no glyph cells.
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(4)

  const text = await drawn($)
  expect(text).not.toContain('█')
  expect(text.split('window reset').length - 1).toBe(2)
  expect(text.split('next reply').length - 1).toBe(1)
  expect(text.split('this session').length - 1).toBe(1)
})

test('a spend range lights what it is sure of and half-lights the rest', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0 100'))
  await $.command.run(hp('style used'))
  it.usd = 20
  await $.turn.complete(TURN)

  // $20 counted, a fifth below and a tenth above: $16–22 spent, 16–22% used.
  const text = await drawn($, 'terminal')
  expect(text).toContain('$16–22 / $100')
  expect(text).toContain('16–22% used')
  // Three cells sure (15%), two across the range (to 25%), fifteen dark.
  expect(text.split('█').length - 1).toBe(3)
  expect(text.split('▒').length - 1).toBe(2)
  expect(text.split('░').length - 1).toBe(15)
})

test('a range colours by its pessimistic end', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0 100'))
  // $47 counted, a tenth above: the centre 53% left (green), the high end
  // $51.70, 48% left (yellow).
  it.usd = 47
  await $.turn.complete(TURN)

  const ui = (await $.ui.mount({
    plugin: 'usage-hp',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false },
  } as never)) as never as {
    findAll: (q: { type: 'Text' }) => Promise<{ text?: string; props?: { color?: string } }[]>
  }
  const label = (await ui.findAll({ type: 'Text' })).find(one => one.text?.includes('SPEND'))
  expect(label?.props?.color).toBe('yellow')
})

test('a re-entry learns how far the sessions ran from the dashboard', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0 300'))
  it.usd = 10
  await $.turn.complete(TURN)

  // A day on, the dashboard says $8 where the sessions counted $10.
  await it.clock.advance(24 * 60 * MINUTE)
  const answer = await $.command.run(hp('8 300'))
  expect(answer.text).toContain('$10.00 since the last entry against $8.00')
  expect([...it.store.keys()].filter(key => key.startsWith('calib:'))).toHaveLength(1)

  // One interval at 0.8, drawn a third of the way from 1: the next $30
  // counted reads as $28, so $8 + $28 = $36 spent, ± a quarter of $30.
  await it.clock.advance(5 * MINUTE)
  await $.command.run(hp('style used'))
  it.usd = 40
  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('$30–48 / $300')
})

test('a re-entry the sessions counted almost nothing for teaches nothing', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0 300'))
  it.usd = 0.5
  await $.turn.complete(TURN)
  await $.command.run(hp('5 300'))

  expect([...it.store.keys()].filter(key => key.startsWith('calib:'))).toHaveLength(0)
})

test('an old entry widens the range and asks for a fresh figure', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 300'))
  it.usd = 1
  await $.turn.complete(TURN)
  expect(await drawn($)).not.toContain('re-sync')

  await it.clock.advance(8 * 24 * 60 * MINUTE)
  await $.turn.complete(TURN)
  const text = await drawn($)
  expect(text).toContain('synced 8d 0h ago')
  expect(text).toContain('re-sync: /hp <spent> 300')
  // Eight days of sessions the mod cannot see: up to $2 more spent.
  await $.command.run(hp('style used'))
  expect(await drawn($)).toContain('$10–60 / $300')
})

test('the spend row keeps the money on top and the rest on the line beneath', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 300'))
  it.usd = 1
  await it.clock.advance(2 * 60 * MINUTE)
  await $.turn.complete(TURN)

  const ui = (await $.ui.mount({
    plugin: 'usage-hp',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false },
  } as never)) as never as {
    findAll: (q: { type: 'Text' }) => Promise<{ text?: string; props?: { bold?: boolean } }[]>
  }
  const texts = await ui.findAll({ type: 'Text' })
  const all = texts.map(one => one.text ?? '').join('')
  // The session's cost leads the second line, bold; reset and sync age close it.
  const lead = texts.find(one => one.text === '$1.00 this session')
  expect(lead?.props?.bold).toBe(true)
  expect(all.indexOf('this session')).toBeLessThan(all.indexOf('resets in'))
  expect(all.indexOf('resets in')).toBeLessThan(all.indexOf('synced 2h 0m ago'))
  expect(all.indexOf('/ $300')).toBeLessThan(all.indexOf('this session'))
})

test('once calibrated, the session cost carries its billed estimate', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0 300'))
  it.usd = 10
  await $.turn.complete(TURN)
  // Before any re-entry there is no ratio to bill by.
  expect(await drawn($)).not.toContain('billed')

  await it.clock.advance(24 * 60 * MINUTE)
  await $.command.run(hp('8 300'))
  await it.clock.advance(5 * MINUTE)
  await $.turn.complete(TURN)
  // One interval at 0.8, drawn a third of the way from 1: 0.93 of $10.
  expect(await drawn($)).toContain('$10.00 this session (~$9.33 billed)')
})

test('a figure left in the sync file is entered on the next turn, once', async ($, on) => {
  const it = world(on)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/x' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  const sync = '/home/x/.claude/state/usage-hp-sync.json'

  // No limit set with /hp: a sync file sets nothing up.
  files.set(sync, JSON.stringify({ spentUsd: 5, limitUsd: 300, at: T0 }))
  await $.turn.complete(TURN)
  expect(it.store.get('budget')).toBeUndefined()

  await $.command.run(hp('0 300'))
  it.usd = 10
  await it.clock.advance(24 * 60 * MINUTE)
  await $.turn.complete(TURN)

  // The dashboard, read just after that turn, says $8 where the sessions counted $10.
  const at = T0 + 24 * 60 * MINUTE
  files.set(sync, JSON.stringify({ spentUsd: 8, limitUsd: 300, at }))
  await it.clock.advance(MINUTE)
  await $.turn.complete(TURN)
  expect(it.store.get('budget')).toMatchObject({ spentUsd: 8, epoch: at })
  expect(it.store.get(`calib:${at}`)).toMatchObject({ est: 10, real: 8 })

  // The same file read again changes nothing.
  it.usd = 12
  await $.turn.complete(TURN)
  expect([...it.store.keys()].filter(key => key.startsWith('calib:'))).toHaveLength(1)
  expect(it.store.get('budget')).toMatchObject({ spentUsd: 8, epoch: at })
})

test('a synced figure read before this session spent more keeps what it spent since', async ($, on) => {
  const it = world(on)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/x' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  const sync = '/home/x/.claude/state/usage-hp-sync.json'

  await $.command.run(hp('10 300'))
  it.usd = 2
  await it.clock.advance(10 * MINUTE)
  await $.turn.complete(TURN)
  // The dashboard is read here, at $12 ...
  const at = T0 + 15 * MINUTE
  // ... and the session spends $3 more before the figure reaches it.
  it.usd = 5
  await it.clock.advance(10 * MINUTE)
  await $.turn.complete(TURN)

  files.set(sync, JSON.stringify({ spentUsd: 12, limitUsd: 300, at }))
  await it.clock.advance(5 * MINUTE)
  await $.turn.complete(TURN)

  // $12 on the dashboard plus the $3 spent after it was read ...
  expect(it.store.get('budget')).toMatchObject({ spentUsd: 12, epoch: at })
  const own = [...it.store.keys()].find(key => key.startsWith(`spend:${at}:`))
  expect(it.store.get(own!)).toBe(3)
  // ... and the calibration compares the $2 counted by then with the $2 billed.
  expect(it.store.get(`calib:${at}`)).toMatchObject({ est: 2, real: 2 })
})

/** The engine beneath `turn.step`: every call answers with `next.usage`. */
const steps = (on: On) => {
  const next = { usage: null as null | Record<string, unknown> }
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: next.usage,
    } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => e as never)

  return next
}

const step = async ($: Kit, agentId?: string) => {
  const stream = (
    $ as never as { turn: { step: (e: unknown) => AsyncGenerator & { result: Promise<unknown> } } }
  ).turn.step({ turnId: 't1', index: 0, model: 'x', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // drain
  }
  await stream.result
}

const usage = (model: string, read: number, write: number, output = 0, input = 0) => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
})

test('a fresh session prices each call by its model at the official rates', async ($, on) => {
  const it = world(on)
  const next = steps(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  await $.command.run(hp('0 300'))

  // One measured Sonnet 5.5 turn: Claude Code says $0.3988,
  // the official $0.10 cache reads make it $0.3858.
  next.usage = usage('claude-sonnet-5-5', 129_972, 92_694, 205, 6)
  await step($)
  it.usd = 0.3988
  await $.turn.complete(TURN)

  const key = [...it.store.keys()].find(one => one.startsWith('priced:s1:main'))
  expect(Math.round(((it.store.get(key!) as { usd: number }).usd) * 1e4) / 1e4).toBe(0.3858)
  // The session's own key counts the official figure ...
  const own = [...it.store.keys()].find(one => one.startsWith('spend:'))
  expect(Math.round((it.store.get(own!) as number) * 1e4) / 1e4).toBe(0.3858)
  // ... while the footer keeps Claude Code's figure beside it.
  expect(await drawn($)).toContain('$0.40 this session (~$0.39 billed)')
})

test('subagents are priced under their own keys and summed with the main thread', async ($, on) => {
  const it = world(on)
  const next = steps(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  await $.command.run(hp('0 300'))

  next.usage = usage('claude-opus-5-5', 0, 100_000) // $0.80
  await step($)
  next.usage = usage('claude-haiku-5-5', 50_000, 0) // $0.0005
  await step($, 'agent-1')
  // Over 100,000 prompt tokens Haiku 5.5 pays its second card: 0.05 a read.
  next.usage = usage('claude-haiku-5-5', 200_000, 0) // $0.01
  await step($, 'agent-1')
  // Claude Code counts the same calls the same way: nothing outside the turns.
  it.usd = 0.8105
  await $.turn.complete(TURN)

  expect(Math.round((it.store.get('priced:s1:agent-1') as { usd: number }).usd * 1e6) / 1e6).toBe(0.0105)
  const own = [...it.store.keys()].find(one => one.startsWith('spend:'))
  expect(Math.round((it.store.get(own!) as number) * 1e6) / 1e6).toBe(0.8105)
})

test('a model with no price is counted as unknown, not guessed', async ($, on) => {
  const it = world(on)
  const next = steps(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  next.usage = usage('claude-nova-9', 1000, 1000)
  await step($)
  expect(it.store.get('priced:s1:main')).toMatchObject({ usd: 0, unknown: 1 })
})

test('a session the mod joins after it has spent counts, as every key does, in official dollars', async ($, on) => {
  const it = world(on)
  const next = steps(on)
  it.usd = 5
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  await $.command.run(hp('0 300'))

  next.usage = usage('claude-sonnet-5-5', 1_000_000, 0) // $0.10 official
  await step($)
  it.usd = 5.2
  await $.turn.complete(TURN)

  // Claude Code counted $0.20 for the call; it is $0.10 at the official
  // rate, which is what every session's key holds for the calibration.
  const own = [...it.store.keys()].find(one => one.startsWith('spend:'))
  expect(Math.round((it.store.get(own!) as number) * 1e6) / 1e6).toBe(0.1)
})

test('what Claude Code counted outside the turns is added at its own price', async ($, on) => {
  const it = world(on)
  const next = steps(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  await $.command.run(hp('0 300'))

  // One Sonnet 5.5 call: 1M cache reads, $0.20 to Claude Code, $0.10 officially.
  next.usage = usage('claude-sonnet-5-5', 1_000_000, 0)
  await step($)
  // Claude Code's total also holds $0.05 of calls no turn showed (a title, a summary).
  it.usd = 0.25
  await $.turn.complete(TURN)

  const own = [...it.store.keys()].find(one => one.startsWith('spend:'))
  expect(Math.round((it.store.get(own!) as number) * 1e6) / 1e6).toBe(0.15)
})

test('a model with no price reaches the count through Claude Code\'s total', async ($, on) => {
  const it = world(on)
  const next = steps(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  await $.command.run(hp('0 300'))
  next.usage = usage('claude-nova-9', 1000, 1000)
  await step($)
  it.usd = 0.03
  await $.turn.complete(TURN)

  const own = [...it.store.keys()].find(one => one.startsWith('spend:'))
  expect(Math.round((it.store.get(own!) as number) * 1e6) / 1e6).toBe(0.03)
})

test('a session holding an earlier entry never sweeps a newer entry\'s keys', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 300'))
  const old = (it.store.get('budget') as { epoch: number }).epoch
  // Another session entered a newer figure a moment ago and has counted under it.
  it.store.set(`spend:${old + 1000}:2026-10:s2`, 4)
  it.store.set(`spend:${old - 1000}:2026-10:s3`, 9)
  it.usd = 1
  await it.clock.advance(3 * MINUTE)
  await $.turn.complete(TURN)

  expect(it.store.get(`spend:${old + 1000}:2026-10:s2`)).toBe(4)
  expect(it.store.has(`spend:${old - 1000}:2026-10:s3`)).toBe(false)
})

test('a reset more than two days off reads in days', async ($, on) => {
  world(on)
  await $.command.run(hp('10 300'))
  const text = await drawn($)
  expect(text).toMatch(/resets in \d+d(?! \d)/)
})

const labelColor = async ($: Kit) => {
  const ui = (await $.ui.mount({
    plugin: 'usage-hp',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false },
  } as never)) as never as {
    findAll: (q: { type: 'Text' }) => Promise<{ text?: string; props?: { color?: string } }[]>
  }

  return (await ui.findAll({ type: 'Text' })).find(one => /5H|SPEND/.test(one.text ?? ''))?.props?.color
}

test('a bar turns worse at the line but only better two points past it', async ($, on) => {
  const it = world(on)
  it.limits = [{ kind: 'five_hour', percentUsed: 51 }]
  await $.turn.complete(TURN)
  expect(await labelColor($)).toBe('yellow')

  // 51% left is back over the line, but not by two points: it stays yellow.
  it.limits = [{ kind: 'five_hour', percentUsed: 49 }]
  await $.turn.complete(TURN)
  expect(await labelColor($)).toBe('yellow')

  it.limits = [{ kind: 'five_hour', percentUsed: 47 }]
  await $.turn.complete(TURN)
  expect(await labelColor($)).toBe('green')

  // Worse again at once.
  it.limits = [{ kind: 'five_hour', percentUsed: 50.5 }]
  await $.turn.complete(TURN)
  expect(await labelColor($)).toBe('yellow')
})

test('a quiet session reads the other sessions\' counts again', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 100'))
  await $.command.run(hp('style used'))
  it.usd = 1
  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('$11.00 / $100')

  // Another session counts $20 while this one sits idle for five minutes.
  const [own] = spendKeys(it.store)
  it.store.set(own!.replace(/s1$/, 's2'), 20)
  await it.clock.advance(5 * MINUTE)

  // $10 + $21 counted, a fifth below it, a tenth and a cold day of unseen spend above.
  const text = await drawn($)
  expect(text).toContain('$26–36 / $100')
  expect(text).not.toContain('as of')
})

const measure = ($: Kit, it: ReturnType<typeof world>, changed: string[], limits: Limit[] = it.limits) =>
  $.session.measure({ context: { window: 200_000 }, rateLimits: limits, ...(it.usd === null ? {} : { cost: { usd: it.usd } }), changed } as never)

test('a limit that moves mid-turn moves the bar, with no turn end', async ($, on) => {
  const it = world(on)
  it.limits = [{ kind: 'five_hour', percentUsed: 20, resetsAt: new Date(T0 + 4 * 60 * MINUTE).toISOString() }]
  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('80%')
  it.limits = [{ ...it.limits[0]!, percentUsed: 35 }]
  await measure($, it, ['rateLimits'])
  expect(await drawn($)).toContain('65%')
})

test('a measure of cost or context alone reads nothing', async ($, on) => {
  const it = world(on)
  it.limits = [{ kind: 'five_hour', percentUsed: 20 }]
  await $.turn.complete(TURN)
  const before = it.usageCalls
  // Even with limits in the payload that differ from the last reading: only a measure
  // that names rateLimits re-reads.
  await measure($, it, ['cost'], [{ kind: 'five_hour', percentUsed: 35 }])
  await measure($, it, ['context'], [{ kind: 'five_hour', percentUsed: 35 }])
  expect(it.usageCalls).toBe(before)
})

test('a measure during a turn end waits for it: the two reads never overlap, and the spend counts once', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 100'))
  it.usd = 1
  await $.turn.complete(TURN)
  // A slow engine read, so overlapping refreshes would overlap here.
  it.usageDelayMs = 15
  it.usageMost = 0
  it.usd = 3
  it.limits = []
  const before = it.usageCalls
  // A limit window the last reading did not have, so the measure has something to read.
  await Promise.all([$.turn.complete(TURN), measure($, it, ['rateLimits', 'cost'], [{ kind: 'five_hour', percentUsed: 5 }])])
  expect(it.usageCalls - before).toBe(2)
  expect(it.usageMost).toBe(1)
  const [own] = spendKeys(it.store)
  expect(it.store.get(own!)).toBe(3)
})

test('a measure that reports the limits just read reads nothing again', async ($, on) => {
  const it = world(on)
  it.limits = [{ kind: 'five_hour', percentUsed: 20 }]
  await $.turn.complete(TURN)
  const before = it.usageCalls
  await measure($, it, ['rateLimits'])
  expect(it.usageCalls).toBe(before)
})

test('a refresh that fails does not stop the next one', async ($, on) => {
  const it = world(on)
  it.limits = [{ kind: 'five_hour', percentUsed: 20 }]
  it.usageFailsOnce = true
  await $.turn.complete(TURN).catch(() => undefined)
  it.limits = [{ kind: 'five_hour', percentUsed: 40 }]
  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('60%')
})

test('a subscription seat found mid-turn leaves no ledger key from a step in flight', async ($, on) => {
  const it = world(on)
  const next = steps(on)
  await $.command.run(hp('10 100'))
  await $.session.start({ cwd: '/t' } as never)
  next.usage = { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
  // The step's eligibility read is slow and sees no limits; the measure's read is quick and sees them.
  it.usageDelays = [30, 0]
  it.limits = []
  const stepping = (async () => {
    for await (const _ of $.turn.step({ turnId: 't9', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as never)) {
      // drain
    }
  })()
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  it.limits = [{ kind: 'five_hour', percentUsed: 10 }]
  await Promise.all([stepping, measure($, it, ['rateLimits'])])
  expect([...it.store.keys()].filter(key => key.startsWith('day:') && key.includes(':s1:'))).toEqual([])
})

test('the quiet re-read is redone at once when the budget changes', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 100'))
  await $.command.run(hp('style used'))
  it.usd = 1
  await $.turn.complete(TURN)
  await it.clock.advance(5 * MINUTE)
  expect(await drawn($)).toContain('/ $100')
  // Another session enters a new figure: the next redraw shows it, inside the two minutes.
  const stored = it.store.get('budget') as Record<string, unknown>
  it.store.set('budget', { ...stored, limitUsd: 300, spentUsd: 270, epoch: T0 + 5 * MINUTE })
  expect(await drawn($)).toContain('/ $300')
})

test('the quiet re-read is redone at once when the month turns', async ($, on) => {
  const END = Date.UTC(2026, 9, 31, 23, 56, 0)
  const it = world(on, END)
  await $.command.run(hp('10 100'))
  await $.command.run(hp('style used'))
  it.usd = 1
  await $.turn.complete(TURN)
  // Quiet past two minutes, still in October: the re-read is cached.
  await it.clock.advance(3 * MINUTE)
  const october = await drawn($)
  const scans = it.keyScans
  // A minute later it is November: inside the two minutes, but a different month.
  await it.clock.advance(MINUTE + 30_000)
  await drawn($)
  expect(it.keyScans).toBeGreaterThan(scans)
  expect(october).toContain('/ $100')
})

test('two redraws that find no quiet re-read share one', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 100'))
  it.usd = 1
  await $.turn.complete(TURN)
  await it.clock.advance(5 * MINUTE)
  const before = it.keyScans
  await Promise.all([drawn($), drawn($)])
  const both = it.keyScans - before
  const again = it.keyScans
  await it.clock.advance(3 * MINUTE)
  await drawn($)
  // One redraw's worth of scans for the pair, the same as one more redraw later.
  expect(both).toBe(it.keyScans - again)
})

test('idle redraws scan the store at most once per two minutes, and still pick up other sessions', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 100'))
  await $.command.run(hp('style used'))
  it.usd = 1
  await $.turn.complete(TURN)
  await it.clock.advance(5 * MINUTE)
  await drawn($)
  const afterFirst = it.keyScans
  for (let i = 0; i < 5; i++) {
    await drawn($)
  }
  expect(it.keyScans).toBe(afterFirst)
  // Another session counts $20; past two minutes the next redraw reads it.
  const [own] = spendKeys(it.store)
  it.store.set(own!.replace(/s1$/, 's2'), 20)
  await it.clock.advance(3 * MINUTE)
  expect(await drawn($)).toContain('$26–36 / $100')
  expect(it.keyScans).toBeGreaterThan(afterFirst)
})

test('the ledger keeps each session\'s calls per day, through a re-entry', async ($, on) => {
  const it = world(on)
  const next = steps(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  await $.command.run(hp('0 300'))

  // 100k Opus 5.5 output tokens: $2 a call, one call per session.
  next.usage = usage('claude-opus-5-5', 0, 0, 100_000)
  await step($)
  it.session = 's2'
  await step($)

  const days = [...it.store.keys()].filter(key => key.startsWith('day:'))
  expect(days).toHaveLength(2)
  expect(days.map(key => it.store.get(key))).toEqual([2, 2])

  // An entry from the dashboard starts the spend keys over, not the ledger.
  await $.command.run(hp('5 300'))
  expect([...it.store.keys()].filter(key => key.startsWith('day:'))).toHaveLength(2)
})

test('the ledger keeps a week and the resync log eight days, pruned when a session starts', async ($, on) => {
  const it = world(on)
  steps(on)
  it.store.set('day:2026-09-20:old', 3)
  it.store.set('day:2026-10-04:kept', 1)
  it.store.set(`sync:${T0 - 9 * 24 * 60 * MINUTE}`, { at: T0 - 9 * 24 * 60 * MINUTE })
  it.store.set(`sync:${T0 - 24 * 60 * MINUTE}`, { at: T0 - 24 * 60 * MINUTE })
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  expect([...it.store.keys()].sort()).toEqual(['day:2026-10-04:kept', `sync:${T0 - 24 * 60 * MINUTE}`])
})

test('there is no command to show the ledger: it is the mod\'s own', async ($, on) => {
  world(on)
  const text = ((await $.command.run(hp('ledger'))) as { text: string }).text
  expect(text).toStartWith('Usage:')
})

test('a week of the ledger paces the spend instead of the last hour', async ($, on) => {
  const it = world(on)
  steps(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  await $.command.run(hp('0 300'))
  // Yesterday the sessions spent $30: some 15 to 30 a day, whatever the time
  // zone, so $300 lasts ten to twenty days of the month's 26 left.
  const yesterday = new Date(T0 - 24 * 60 * MINUTE)
  const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
  it.store.set(`day:${day}:old`, 30)
  it.usd = 0.01
  await it.clock.advance(MINUTE)
  await $.turn.complete(TURN)
  expect(await drawn($)).toMatch(/empty in ~1\dd \d+h at this pace/)
})

test('one interval the sessions barely saw cannot set the range\'s width', async ($, on) => {
  const it = world(on)
  // Five re-entries where the count matched the bill, one where the bill ran
  // six times over it (spend from somewhere the mod does not run).
  for (let i = 0; i < 5; i++) {
    const at = T0 - (6 - i) * 60 * MINUTE
    it.store.set(`calib:${at}`, { est: 3, real: 3, at, basis: 'priced' })
  }
  it.store.set(`calib:${T0 - 30 * MINUTE}`, { est: 1, real: 6, at: T0 - 30 * MINUTE, basis: 'priced' })
  await $.command.run(hp('50 300'))
  it.usd = 5
  await it.clock.advance(2 * 60 * MINUTE)
  await $.turn.complete(TURN)
  const text = await drawn($)
  // The outlier still moves the centre (its dollars are real), but the range
  // stays a few dollars wide and asks for no re-sync.
  expect(text).not.toContain('re-sync')
  expect(text).toMatch(/\$23\d–24\d left of \$300/)
})

test('every entered figure is logged with when it was read, entered and by what', async ($, on) => {
  const it = world(on)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/x' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  const sync = '/home/x/.claude/state/usage-hp-sync.json'

  await $.command.run(hp('0 300'))
  expect(it.store.get(`sync:${T0}`)).toMatchObject({ at: T0, enteredAt: T0, source: 'command', spentUsd: 0 })

  it.usd = 10
  await it.clock.advance(24 * 60 * MINUTE)
  await $.turn.complete(TURN)
  const at = T0 + 24 * 60 * MINUTE
  files.set(sync, JSON.stringify({ spentUsd: 8, limitUsd: 300, at }))
  // The routine read the dashboard at `at`; the next turn picks it up an hour later.
  await it.clock.advance(60 * MINUTE)
  await $.turn.complete(TURN)
  expect(it.store.get(`sync:${at}`)).toMatchObject({
    at,
    enteredAt: at + 60 * MINUTE,
    source: 'file',
    spentUsd: 8,
    est: 10,
    real: 8,
  })

  // The footer says when the figure was read, beside how long ago.
  await it.clock.advance(60 * MINUTE)
  await $.turn.complete(TURN)
  expect(await drawn($)).toMatch(/synced 2h 0m ago \(\d\d:\d\d\)/)
})

test('a subscription seat\'s calls never reach the ledger, even those before its limits showed', async ($, on) => {
  const it = world(on)
  const next = steps(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  await $.command.run(hp('0 300'))
  next.usage = usage('claude-opus-5-5', 0, 0, 100_000)

  // The first call comes before the engine has reported any limit ...
  await step($)
  expect([...it.store.keys()].filter(key => key.startsWith('day:'))).toHaveLength(1)

  // ... and once it does, that call leaves the ledger and no later one enters.
  it.limits = [{ kind: 'five_hour', percentUsed: 10 }]
  it.usd = 2
  await $.turn.complete(TURN)
  await step($)
  expect([...it.store.keys()].filter(key => key.startsWith('day:'))).toHaveLength(0)
})

test('spend the sessions never saw widens the high end by a learned rate a day', async ($, on) => {
  const it = world(on)
  const DAYS = 24 * 60 * MINUTE
  // Three days the count matched the bill, one the bill ran $4.67 a day past it.
  for (let i = 0; i < 3; i++) {
    const at = T0 - (4 - i) * DAYS
    it.store.set(`calib:${at}`, { est: 3, real: 3, at, from: at - DAYS, basis: 'priced' })
  }
  it.store.set(`calib:${T0 - DAYS}`, { est: 1, real: 6, at: T0 - DAYS, from: T0 - 2 * DAYS, basis: 'priced' })
  await $.command.run(hp('50 300'))
  it.usd = 0.01
  await it.clock.advance(DAYS)
  await $.turn.complete(TURN)
  // A day on, the high end has grown by that rate, not the old $0.25.
  expect(await drawn($)).toContain('$244–250 left of $300')
})

test('the ratio may run past 1.5 when the bill keeps doing so', async ($, on) => {
  const it = world(on)
  for (let i = 0; i < 6; i++) {
    const at = T0 - (6 - i) * 60 * MINUTE
    it.store.set(`calib:${at}`, { est: 2, real: 5, at, basis: 'priced' })
  }
  await $.command.run(hp('0 300'))
  it.usd = 4
  await it.clock.advance(MINUTE)
  await $.turn.complete(TURN)
  // Ratio 2.125: $4 counted is $8.50 billed.
  expect(await drawn($)).toContain('(~$8.50 billed)')
})

test('two dashboard figures a day or more apart pace the month', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('20 300'))
  await it.clock.advance(2 * 24 * 60 * MINUTE)
  // $60 billed in two days, from wherever it came: $30 a day.
  await $.command.run(hp('80 300'))
  it.usd = 0.01
  await it.clock.advance(MINUTE)
  await $.turn.complete(TURN)
  expect(await drawn($)).toMatch(/empty in ~7d \d+h at this pace/)
})

test('a figure synced after a quiet weekend keeps what the next turn spent since it was read', async ($, on) => {
  const it = world(on)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/x' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  await $.command.run(hp('0 300'))
  it.usd = 5
  await $.turn.complete(TURN)

  // Three quiet days; the routine reads $40 off the dashboard, and the next
  // turn, an hour of work later, picks it up having spent $2 since.
  await it.clock.advance(3 * 24 * 60 * MINUTE)
  const at = T0 + 3 * 24 * 60 * MINUTE
  files.set('/home/x/.claude/state/usage-hp-sync.json', JSON.stringify({ spentUsd: 40, limitUsd: 300, at }))
  await it.clock.advance(60 * MINUTE)
  it.usd = 7
  await $.turn.complete(TURN)
  const [own] = spendKeys(it.store)
  expect(it.store.get(own!)).toBe(2)
})

test('a new month counts only what the session spent after its turn', async ($, on) => {
  // Entered 2026-10-28 at $100 spent; the session then spends on into November.
  const it = world(on, Date.UTC(2026, 9, 28, 12))
  it.usd = 100
  await $.command.run(hp('50 300'))
  it.usd = 105
  await it.clock.advance(60 * MINUTE)
  await $.turn.complete(TURN)
  it.usd = 110
  await it.clock.set(Date.UTC(2026, 9, 31, 23))
  await $.turn.complete(TURN)

  // The first November turn adds $1, not the $11 since the October entry.
  it.usd = 111
  await it.clock.set(Date.UTC(2026, 10, 2, 15))
  await $.turn.complete(TURN)
  const nov = [...it.store.keys()].find(key => key.startsWith('spend:') && key.includes(':2026-11:'))
  expect(it.store.get(nov!)).toBe(1)
  // And the footer still dates the figure from when it was read.
  expect(await drawn($)).toContain('(Oct 28')
})

test('a session found to be on a subscription seat takes its spend keys back out', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0 300'))
  it.usd = 4
  await $.turn.complete(TURN)
  expect(spendKeys(it.store)).toHaveLength(1)

  it.limits = [{ kind: 'five_hour', percentUsed: 10 }]
  it.usd = 5
  await $.turn.complete(TURN)
  expect([...it.store.keys()].filter(key => key.startsWith('spend:') || key.startsWith('trail:'))).toHaveLength(0)
})

test('/hp off in another session clears the row here once it reads the store again', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('10 300'))
  it.usd = 1
  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('SPEND')

  it.store.delete('budget')
  await it.clock.advance(5 * MINUTE)
  expect(await drawn($)).not.toContain('SPEND')
})

test('a decimal comma reads as cents, a thousands comma as thousands', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('47,53 300'))
  expect(it.store.get('budget')).toMatchObject({ spentUsd: 47.53 })
  await $.command.run(hp('1,234.50 2,000'))
  expect(it.store.get('budget')).toMatchObject({ spentUsd: 1234.5, limitUsd: 2000 })
})

test('past the limit, what is left reads as none, not a negative', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('298 300'))
  it.usd = 6
  await it.clock.advance(MINUTE)
  await $.turn.complete(TURN)
  const text = await drawn($)
  expect(text).not.toMatch(/\$-/)
  expect(text).toContain('$0')
})

test('a range clear of the colour lines asks for no re-sync; one across a line does', async ($, on) => {
  const it = world(on)
  // No calibration yet: a day on, the range is $6 or so wide, well clear of 50% and 20%.
  await $.command.run(hp('60 300'))
  it.usd = 0.01
  await it.clock.advance(24 * 60 * MINUTE)
  await $.turn.complete(TURN)
  expect(await drawn($)).not.toContain('re-sync')

  // Near half spent, the same width runs across the 50% line.
  await $.command.run(hp('147 300'))
  await it.clock.advance(24 * 60 * MINUTE)
  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('re-sync')
})

test('intervals too short to say a daily rate inform the ratio alone', async ($, on) => {
  const it = world(on)
  // Hourly re-entries where the bill ran 2.5 times the count: no unseen rate
  // can be read from an hour, so it all goes to the ratio.
  for (let i = 0; i < 6; i++) {
    const at = T0 - (6 - i) * 60 * MINUTE
    it.store.set(`calib:${at}`, { est: 2, real: 5, at, from: at - 60 * MINUTE, basis: 'priced' })
  }
  await $.command.run(hp('0 300'))
  it.usd = 4
  await it.clock.advance(MINUTE)
  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('(~$8.50 billed)')
})

test('a typical day is read from every interval, not the overnight gaps alone', async ($, on) => {
  const it = world(on)
  const HOUR = 60 * MINUTE
  // Two days of entries as a person re-syncing by hand leaves them: the only
  // intervals six hours or longer are the overnight gaps to the 7:00 routine,
  // which count little, while the working hours between the day's entries
  // are short and count most of the spend. Read from the long gaps alone, a
  // typical day looked like $2.40, and $6.50 counted in 80 minutes moved the
  // activity clock on 2.7 days: the high end ran $20 wide and asked for a
  // re-sync an hour after a fresh figure (2026-10-15).
  const chain: [number, number, number, number][] = [
    // [hours before T0 it ended, hours it lasted, counted, billed]
    [50, 17, 1.05, 5.93],
    [47.6, 2.4, 1.8, 2.41],
    [25, 22.6, 2.93, 2.96],
    [23, 2, 1.96, 1.34],
    [22, 1, 1.44, 1.45],
    [17, 5, 3.96, 3.96],
  ]
  for (const [ago, hours, est, real] of chain) {
    const at = T0 - ago * HOUR
    it.store.set(`calib:${at}`, { est, real, at, from: at - hours * HOUR, basis: 'priced' })
  }
  await $.command.run(hp('style used'))
  await $.command.run(hp('70.1 300'))
  it.usd = 6.5
  await it.clock.advance(80 * MINUTE)
  await $.turn.complete(TURN)
  const text = await drawn($)
  // Averaged over the whole two days the sessions count about $6.30 a day, so
  // the morning's work is a day's worth, and the range stays under $15 wide.
  expect(text).toMatch(/\$7\d–8\d \/ \$300/)
  expect(text).not.toContain('re-sync')
})

test('an API-key session with no limit entered draws no setup line', async ($, on) => {
  const it = world(on)
  steps(on)
  on('env.get', (_, e) => ({ value: e.name === 'ANTHROPIC_API_KEY' ? 'set' : undefined }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  it.usd = 1
  await $.turn.complete(TURN)
  expect(await drawn($)).not.toContain('Settings › Usage')
})

test('/hp <limit> alone says it assumed nothing spent yet', async ($, on) => {
  world(on)
  const reply = (await $.command.run(hp('300'))) as { text: string }
  expect(reply.text).toContain('assumes nothing is spent yet')
})

test('a re-sync stays asked for once the estimate alone has carried the bar past a line', async ($, on) => {
  const it = world(on)
  // $140 entered: the estimate a few days on runs wholly past the 50% line.
  await $.command.run(hp('140 300'))
  it.usd = 0.01
  await it.clock.advance(5 * 24 * 60 * MINUTE)
  await $.turn.complete(TURN)
  const text = await drawn($)
  expect(text).toMatch(/\$1[0-5]\d–1[0-6]\d left of \$300/)
  expect(text).toContain('re-sync')
})

test('a heavy session keeps its anchor reading through the trail\'s cap', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0 300'))
  it.usd = 1
  await $.turn.complete(TURN)
  await it.clock.advance(3 * 24 * 60 * MINUTE)
  // 150 turns in a day: more than the trail holds.
  for (let i = 0; i < 150; i++) {
    it.usd += 0.1
    await it.clock.advance(5 * MINUTE)
    await $.turn.complete(TURN)
  }
  const trail = [...it.store.entries()].find(([key]) => key.startsWith('trail:'))![1] as { at: number }[]
  expect(trail).toHaveLength(100)
  expect(trail[0]!.at).toBe(T0)
})

test('a sync file a few minutes ahead of this clock is still entered', async ($, on) => {
  const it = world(on)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/x' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  await $.command.run(hp('0 300'))
  await it.clock.advance(60 * MINUTE)
  files.set('/home/x/.claude/state/usage-hp-sync.json', JSON.stringify({ spentUsd: 9, limitUsd: 300, at: T0 + 63 * MINUTE }))
  it.usd = 1
  await $.turn.complete(TURN)
  expect(it.store.get('budget')).toMatchObject({ spentUsd: 9 })
})

test('a range across the limit itself asks for a re-sync', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('296 300'))
  it.usd = 0.01
  await it.clock.advance(60 * MINUTE)
  await $.turn.complete(TURN)
  expect(await drawn($)).toContain('re-sync')
})

test('a moment after a figure, the high end already allows a day of unseen spend', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('100 300'))
  it.usd = 0.01
  await it.clock.advance(MINUTE)
  await $.turn.complete(TURN)
  // Cold: 2% of $300 a day, whole from the first minute.
  expect(await drawn($)).toContain('$193–200 left of $300')
})

test('the unseen allowance grows smoothly across a day boundary', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0 300'))
  it.usd = 0.01
  await it.clock.advance(24 * 60 * MINUTE - MINUTE)
  await $.turn.complete(TURN)
  const before = await drawn($)
  await it.clock.advance(2 * MINUTE)
  await $.turn.complete(TURN)
  // Just past a day, a few minutes' worth more, not a second whole day.
  expect(before).toContain('$293–300 left of $300')
  expect(await drawn($)).toContain('$293–300 left of $300')
})

test('a session whose first turn ends after the routine\'s read keeps that turn', async ($, on) => {
  const it = world(on)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/x' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  // Another session entered the limit yesterday; this one opened before
  // today's read and finishes its first turn, $2, after it.
  it.store.set('budget', { limitUsd: 300, spentUsd: 10, month: '2026-10', epoch: T0 - 24 * 60 * MINUTE })
  it.startedAt = T0
  await it.clock.advance(20 * MINUTE)
  files.set('/home/x/.claude/state/usage-hp-sync.json', JSON.stringify({ spentUsd: 20, limitUsd: 300, at: T0 + 13 * MINUTE }))
  it.usd = 2
  await $.turn.complete(TURN)
  const [own] = spendKeys(it.store)
  expect(it.store.get(own!)).toBe(2)
})

test('a sync file waits for the first reply before it is entered', async ($, on) => {
  const it = world(on)
  steps(on)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/x' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  it.store.set('budget', { limitUsd: 300, spentUsd: 10, month: '2026-10', epoch: T0 - 60 * MINUTE })
  files.set('/home/x/.claude/state/usage-hp-sync.json', JSON.stringify({ spentUsd: 20, limitUsd: 300, at: T0 - 5 * MINUTE }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  expect(it.store.get('budget')).toMatchObject({ spentUsd: 10 })
  await $.turn.complete(TURN)
  expect(it.store.get('budget')).toMatchObject({ spentUsd: 20 })
})

test('the first /hp points to the sync file; later ones do not', async ($, on) => {
  world(on)
  const first = (await $.command.run(hp('10 300'))) as { text: string }
  expect(first.text).toContain('sync file')
  const again = (await $.command.run(hp('12 300'))) as { text: string }
  expect(again.text).not.toContain('sync file')
})

test('with nothing measured, the unseen allowance grows by the day', async ($, on) => {
  const it = world(on)
  await $.command.run(hp('0 300'))
  it.usd = 0.01
  await it.clock.advance(4 * 24 * 60 * MINUTE)
  await $.turn.complete(TURN)
  // Four days: 2% of $300 a day, $24: unseen spend adds up by days.
  expect(await drawn($)).toContain('$275–300 left of $300')
})

test('a sync file a few minutes ahead is entered once, not on every turn until the clock catches up', async ($, on) => {
  const it = world(on)
  const files = new Map<string, string>()
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/x' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  await $.command.run(hp('0 300'))
  await it.clock.advance(60 * MINUTE)
  files.set('/home/x/.claude/state/usage-hp-sync.json', JSON.stringify({ spentUsd: 9, limitUsd: 300, at: T0 + 65 * MINUTE }))
  it.usd = 1
  await $.turn.complete(TURN)
  // A turn a minute later, still before the file's time, spends $2 more.
  await it.clock.advance(MINUTE)
  it.usd = 3
  await $.turn.complete(TURN)
  const [own] = spendKeys(it.store)
  expect(it.store.get(own!)).toBe(2)
  expect([...it.store.keys()].filter(key => key.startsWith('sync:'))).toHaveLength(2)
})

test('an older figure entered after a newer one leaves the newer standing', async ($, on) => {
  // The engine beneath, with a store that lets a newer entry land while this
  // session is part way through entering an older one.
  const store = new Map<string, unknown>()
  let racing = false
  let usd = 1
  const files = new Map<string, string>()
  const clock = mock.clock(on, { now: T0 })
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 200_000 }, rateLimits: [], cost: { usd } } }))
  on('session.id', () => ({ value: 's1' }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    // The older entry's first write: another session enters $20, newer.
    if (racing && e.key.startsWith('spend:')) {
      racing = false
      store.set('budget', { limitUsd: 300, spentUsd: 20, month: '2026-10', epoch: T0 + 50 * MINUTE })
    }

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => EMPTY)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/x' : undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))

  await $.command.run(hp('5 300'))
  // The routine read $10 at T0 + 40 minutes; this session enters it at T0 + 60.
  files.set('/home/x/.claude/state/usage-hp-sync.json', JSON.stringify({ spentUsd: 10, limitUsd: 300, at: T0 + 40 * MINUTE }))
  await clock.set(T0 + 60 * MINUTE)
  usd = 3
  racing = true
  await $.turn.complete(TURN)
  // The race happened: the newer figure landed mid-entry ...
  expect(racing).toBe(false)
  // ... and stands.
  expect(store.get('budget')).toMatchObject({ spentUsd: 20 })
})

test('with no limit entered, calls do not reach the ledger', async ($, on) => {
  const it = world(on)
  const next = steps(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop' } as never)
  next.usage = usage('claude-opus-5-5', 0, 0, 100_000)
  await step($)
  expect([...it.store.keys()].filter(key => key.startsWith('day:'))).toHaveLength(0)
})

test('/hp in a session with limits of its own says which limit it shows', async ($, on) => {
  const it = world(on)
  it.limits = [{ kind: 'five_hour', percentUsed: 10 }]
  it.usd = 1
  await $.turn.complete(TURN)
  const reply = (await $.command.run(hp('10 300'))) as { text: string }
  expect(reply.text).toContain('limits of its own')
})
