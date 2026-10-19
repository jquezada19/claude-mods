import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0)
const MINUTE = 60_000
const SURFACES = ['terminal', 'desktop'] as const
// Nothing sits beneath the mod in a test: an empty band stands for the engine.
const EMPTY = { type: 'Box', props: {}, children: [] } as never
const STEP = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 } as const
const GUARD_ON = { options: { coldSendGuard: true, bigTokens: 150_000 } }

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number }
}

/** What the session is configured with: process env beyond HOME, and merged settings. */
type Setup = { env?: Record<string, string>; settings?: Record<string, unknown> }

/**
 * The engine beneath the mod, in memory: a clock, a store, the next
 * response's usage, and a record of what the mod asked, ran, and sent.
 */
const world = (on: On, now = T0, setup: Setup = {}) => {
  const clock = mock.clock(on, { now })
  const store = new Map<string, unknown>()
  const it = {
    clock,
    store,
    /** What another mod draws in the band beneath this one. */
    beneath: EMPTY as unknown,
    usage: null as Usage | null,
    answer: 'Send anyway' as string | null,
    asked: [] as string[],
    ran: [] as string[][],
    compacted: 0,
    filled: [] as string[],
    submitted: [] as string[],
    isFillOk: true,
    tokensAfter: 20_000,
    toasts: [] as string[],
  }
  on('ui.toast', (_, e) => {
    it.toasts.push(e.text)

    return { value: undefined } as never
  })
  on('session.id', () => ({ value: 's1' }))
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
  mock.env(on, { HOME: '/home/t', ...(setup.env ?? {}) })
  on('settings.read', () => ({ value: setup.settings ?? {} }) as never)
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: it.usage } as never
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => it.beneath as never)
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const input = e as never as { questions: { question: string }[] }
    const q = input.questions[0]!.question
    it.asked.push(q)

    if (it.answer === null) {
      throw new Error('dismissed')
    }

    return { result: { questions: input.questions, answers: { [q]: it.answer } } } as never
  })
  on('session.messages', () => ({ value: [{ role: 'user', text: 'long', toolUses: [] }] }) as never)
  on('session.compact', (_, e) => {
    if (e.trigger === 'precompute') {
      return { messages: [{ role: 'user', text: 'kept', toolUses: [] }] } as never
    }
    it.compacted += 1

    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensAfter: it.tokensAfter } as never
  })
  on('prompt.fill', (_, e) => {
    it.filled.push(e.text)

    return { isFilled: it.isFillOk, draft: it.isFillOk ? e.text : '' } as never
  })
  on('prompt.submit', (_, e) => {
    it.submitted.push(e.text)

    return { text: e.text }
  })
  on('process.run', (_, e) => {
    it.ran.push([...e.argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', () => ({}) as never)
  on('classic.PostModelSwitch', () => ({}) as never)

  return it
}

type Kit = Parameters<Parameters<typeof test>[1]>[0]

const drawn = async ($: Kit, surface: (typeof SURFACES)[number] = 'desktop') => {
  const ui = await $.ui.mount({
    plugin: 'cache-status',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false },
  } as never)
  const found = await (
    ui as never as { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }
  ).findAll({ type: 'Text' })

  return found.map(one => one.text ?? '').join('')
}

/** One main-thread model request with the given usage, read to its end. */
const step = async ($: Kit, it: ReturnType<typeof world>, usage: Usage, index = 0) => {
  it.usage = usage
  const s = $.turn.step({ ...STEP, index })
  for await (const _ of s) {
    // drain
  }

  return s.result
}

const warm = (prompt: number, model = 'claude-opus-5-5'): Usage => ({
  input_tokens: 500,
  output_tokens: 200,
  cache_read_input_tokens: prompt - 500,
  cache_creation_input_tokens: 0,
  model,
})
const rewritten = (prompt: number, model = 'claude-opus-5-5'): Usage => ({
  input_tokens: 500,
  output_tokens: 200,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: prompt - 500,
  model,
})

for (const surface of SURFACES) {
  test(`${surface}: nothing sent yet draws the waiting row`, async ($, on) => {
    world(on)
    expect(await drawn($, surface)).toContain('waiting for first response')
  })

  test(`${surface}: a cached step draws warm with the time left`, async ($, on) => {
    const it = world(on)
    await step($, it, warm(80_000))
    const text = await drawn($, surface)
    expect(text).toContain('● CACHE WARM')
    expect(text).toContain('1h left of 1h')
    expect(text).toContain('last hit 99%')
    await it.clock.advance(MINUTE)
    expect(await drawn($, surface)).toContain('59m left of 1h')
  })

  test(`${surface}: /clear resets the row to waiting`, async ($, on) => {
    const it = world(on)
    await step($, it, warm(80_000))
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    expect(await drawn($, surface)).toContain('waiting for first response')
  })

  test(`${surface}: /resume and /branch reset the row to waiting too`, async ($, on) => {
    const it = world(on)
    await step($, it, warm(80_000))
    expect(await drawn($, surface)).not.toContain('waiting for first response')
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's2' } } as never)
    expect(await drawn($, surface)).toContain('waiting for first response')
  })

  test(`${surface}: a resume seeds the row from the idle time`, async ($, on) => {
    world(on)
    await $.classic.SessionStart({
      source: 'resume',
      seconds_since_last_response: 600,
      prompt_cache_likely_expired: false,
      context_tokens: 120_000,
    } as never)
    const text = await drawn($, surface)
    expect(text).toContain('● CACHE WARM')
    expect(text).toContain('50m left of 1h')
  })

  test(`${surface}: a resume past the lifetime reads lapsed`, async ($, on) => {
    world(on)
    await $.classic.SessionStart({
      source: 'resume',
      seconds_since_last_response: 7200,
      prompt_cache_likely_expired: true,
      context_tokens: 120_000,
    } as never)
    const text = await drawn($, surface)
    expect(text).toContain('○ CACHE COLD')
    expect(text).toContain('lapsed 1h ago')
  })

  test(`${surface}: a fork that sits idle ages into lapsed`, async ($, on) => {
    const it = world(on)
    await $.classic.SessionStart({
      source: 'fork',
      seconds_since_last_response: 60,
      prompt_cache_likely_expired: false,
      context_tokens: 50_000,
    } as never)
    expect(await drawn($, surface)).toContain('● CACHE WARM')
    await it.clock.advance(61 * MINUTE)
    expect(await drawn($, surface)).toContain('○ CACHE COLD')
  })

  test(`${surface}: a big re-cache after the lifetime counts as a cold restart and is logged`, async ($, on) => {
    const it = world(on)
    await step($, it, warm(120_000))
    await it.clock.advance(61 * MINUTE)
    await step($, it, rewritten(120_000), 1)
    const text = await drawn($, surface)
    expect(text).toContain('1 cold restart')
    expect(text).toContain('120k re-cached')
    expect(it.ran).toHaveLength(1)
    expect(it.ran[0]![0]).toBe('sh')
    expect(it.ran[0]![4]).toContain('"tokens":119500')
    expect(it.ran[0]![5]).toBe('/home/t/.claude/metrics/cache-restarts.jsonl')
  })

  test(`${surface}: a cache hit after a long gap is not a cold restart`, async ($, on) => {
    const it = world(on)
    await step($, it, warm(120_000))
    await it.clock.advance(61 * MINUTE)
    // The cache outlived the assumed lifetime: the request read it, wrote nothing.
    await step($, it, warm(120_000), 1)
    expect(await drawn($, surface)).not.toContain('cold restart')
    expect(it.ran).toHaveLength(0)
  })

  test(`${surface}: a re-cache inside the lifetime is a rewrite, not a cold restart`, async ($, on) => {
    const it = world(on)
    await step($, it, warm(120_000))
    await it.clock.advance(2 * MINUTE)
    await step($, it, rewritten(120_000), 1)
    expect(await drawn($, surface)).not.toContain('cold restart')
    expect(it.ran).toHaveLength(0)
  })

  test(`${surface}: the first step after a compaction is not a cold restart`, async ($, on) => {
    const it = world(on)
    await step($, it, warm(120_000))
    await it.clock.advance(61 * MINUTE)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'long', toolUses: [] }] } as never)
    await step($, it, rewritten(40_000), 1)
    expect(await drawn($, surface)).not.toContain('cold restart')
    // The flag is one-shot: a later lapse counts again.
    await it.clock.advance(61 * MINUTE)
    await step($, it, rewritten(40_000), 2)
    expect(await drawn($, surface)).toContain('1 cold restart')
  })

  test(`${surface}: a precompute exempts nothing, so a later lapse still counts`, async ($, on) => {
    const it = world(on)
    await step($, it, warm(120_000))
    await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'long', toolUses: [] }] } as never)
    await it.clock.advance(61 * MINUTE)
    await step($, it, rewritten(120_000), 1)
    expect(await drawn($, surface)).toContain('1 cold restart')
  })

  test(`${surface}: a model switch is not a cold restart`, async ($, on) => {
    const it = world(on)
    await step($, it, warm(120_000))
    await it.clock.advance(61 * MINUTE)
    await step($, it, rewritten(120_000, 'claude-sonnet-5-5'), 1)
    expect(await drawn($, surface)).not.toContain('cold restart')
  })

  test(`${surface}: a small context re-cache is below the restart floor`, async ($, on) => {
    const it = world(on)
    await step($, it, warm(20_000))
    await it.clock.advance(61 * MINUTE)
    await step($, it, rewritten(20_000), 1)
    expect(await drawn($, surface)).not.toContain('cold restart')
  })
}

// ---------- where the lifetime comes from ----------

const ORDER: [string, Setup, string][] = [
  ['nothing configured: 1h, drawn as assumed', {}, 'left of 1h (assumed)'],
  ['the promptCacheTtl setting', { settings: { promptCacheTtl: '5m' } }, 'left of 5m'],
  ['CLAUDE_CODE_PROMPT_CACHE_TTL over the setting', { settings: { promptCacheTtl: '5m' }, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } }, 'left of 1h ·'],
  ['FORCE_PROMPT_CACHING_5M over everything', { settings: { promptCacheTtl: '1h' }, env: { FORCE_PROMPT_CACHING_5M: '1' } }, 'left of 5m'],
  ['ENABLE_PROMPT_CACHING_1H when nothing else is set', { env: { ENABLE_PROMPT_CACHING_1H: '1' } }, 'left of 1h ·'],
  ['the setting under ENABLE_PROMPT_CACHING_1H', { settings: { promptCacheTtl: '5m' }, env: { ENABLE_PROMPT_CACHING_1H: '1' } }, 'left of 5m'],
  ['a value that is neither 5m nor 1h is ignored', { settings: { promptCacheTtl: '2h' } }, 'left of 1h (assumed)'],
]

for (const [name, setup, want] of ORDER) {
  test(`configured lifetime, documented order: ${name}`, async ($, on) => {
    const it = world(on, T0, setup)
    await step($, it, warm(120_000))
    expect(await drawn($)).toContain(want)
  })
}

test('a resume the engine calls likely expired reads cold, without inventing a 5m lifetime', async ($, on) => {
  world(on)
  await $.classic.SessionStart({
    source: 'resume',
    seconds_since_last_response: 600,
    prompt_cache_likely_expired: true,
    context_tokens: 120_000,
  } as never)
  const text = await drawn($)
  expect(text).toContain('○ CACHE COLD')
  expect(text).toContain('expired while away')
  expect(text).not.toContain('lapsed 5m')
})

test('a cache write that says 5m sets 5m, ahead of any setting', async ($, on) => {
  const it = world(on, T0, { settings: { promptCacheTtl: '1h' } })
  await step($, it, { ...rewritten(120_000), cache_creation: { ephemeral_5m_input_tokens: 119_500, ephemeral_1h_input_tokens: 0 } })
  expect(await drawn($)).toContain('left of 5m')
})

test('a cache write that says 1h confirms 1h: no longer drawn as assumed', async ($, on) => {
  const it = world(on)
  await step($, it, { ...rewritten(120_000), cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 119_500 } })
  const text = await drawn($)
  expect(text).toContain('left of 1h ·')
  expect(text).not.toContain('assumed')
})

const SWITCH = { from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5', requested_model: 'opus', source: 'command', context_tokens: 120_000, prompt_cache_warm: false, estimated_cache_write_usd: 0, pricing: 'catalog' }

test('the engine\'s cache_ttl at a model switch sets the lifetime for the model it switched to', async ($, on) => {
  const it = world(on, T0, { settings: { promptCacheTtl: '1h' } })
  await $.classic.PostModelSwitch({ ...SWITCH, cache_ttl: '5m' } as never)
  await step($, it, warm(120_000))
  expect(await drawn($)).toContain('left of 5m')
  // A response from another model is not covered by that report: configuration again.
  await step($, it, warm(120_000, 'claude-sonnet-5-5'), 1)
  expect(await drawn($)).toContain('left of 1h ·')
})

test('a subagent\'s model switch says nothing about the main conversation', async ($, on) => {
  const it = world(on, T0, { settings: { promptCacheTtl: '1h' } })
  await $.classic.PostModelSwitch({ ...SWITCH, cache_ttl: '5m', agent_id: 'sub-1' } as never)
  await step($, it, warm(120_000))
  expect(await drawn($)).toContain('left of 1h ·')
})

test('/clear and /resume forget the engine\'s report', async ($, on) => {
  const it = world(on, T0, { settings: { promptCacheTtl: '1h' } })
  await $.classic.PostModelSwitch({ ...SWITCH, cache_ttl: '5m' } as never)
  await $.session.end({ reason: 'resume', sessionId: 's1', resume: { id: 's2' } } as never)
  await step($, it, warm(120_000))
  expect(await drawn($)).toContain('left of 1h ·')
})

test('an observed lifetime carries to later responses that say nothing', async ($, on) => {
  const it = world(on)
  await step($, it, { ...rewritten(120_000), cache_creation: { ephemeral_5m_input_tokens: 119_500, ephemeral_1h_input_tokens: 0 } })
  await step($, it, warm(120_000), 1)
  expect(await drawn($)).toContain('left of 5m')
})

test('a re-write logged after an observed write records that the split was seen', async ($, on) => {
  const it = world(on)
  const split = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 119_500 }
  await step($, it, { ...rewritten(120_000), cache_creation: split })
  await it.clock.advance(61 * MINUTE)
  await step($, it, { ...rewritten(120_000), cache_creation: split }, 1)
  expect(it.ran[0]![4]).toContain('"split_seen":true')
  expect(it.ran[0]![4]).toContain('"ttl_basis":"observed"')
})

test('a lapse is judged by the lifetime the earlier cache had, not the one the new request reports', async ($, on) => {
  const it = world(on)
  // The earlier cache was 5m; ten minutes later a 1h write re-caches everything: a lapse.
  await step($, it, { ...rewritten(120_000), cache_creation: { ephemeral_5m_input_tokens: 119_500, ephemeral_1h_input_tokens: 0 } })
  await it.clock.advance(10 * MINUTE)
  await step($, it, { ...rewritten(120_000), cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 119_500 } }, 1)
  expect(await drawn($)).toContain('1 cold restart')
  expect(it.ran[0]![4]).toContain('"kind":"lapse"')
})

test('a re-write exactly at the lifetime is a lapse', async ($, on) => {
  const it = world(on, T0, { settings: { promptCacheTtl: '1h' } })
  await step($, it, warm(120_000))
  await it.clock.advance(60 * MINUTE)
  await step($, it, rewritten(120_000), 1)
  expect(await drawn($)).toContain('1 cold restart')
})

test('after a resume the engine called expired, the re-write is a lapse, and compaction clears the flag', async ($, on) => {
  const it = world(on, T0, { settings: { promptCacheTtl: '1h' } })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, prompt_cache_likely_expired: true, context_tokens: 120_000 } as never)
  await step($, it, rewritten(120_000))
  expect(await drawn($)).toContain('1 cold restart')
  expect(it.ran[0]![4]).toContain('"kind":"lapse"')
  // A compaction after an expired resume: the new context is cached, the row is warm.
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, prompt_cache_likely_expired: true, context_tokens: 200_000 } as never)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, prompt_cache_likely_expired: true, context_tokens: 200_000 } as never)
  it.tokensAfter = 180_000
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'long', toolUses: [] }] } as never)
  expect(await drawn($)).toContain('● CACHE WARM')
})

test('a big re-write inside a known lifetime is a miss, logged as one, not a cold restart', async ($, on) => {
  const it = world(on, T0, { settings: { promptCacheTtl: '1h' } })
  await step($, it, warm(120_000))
  await it.clock.advance(8 * MINUTE)
  await step($, it, rewritten(120_000), 1)
  const text = await drawn($)
  expect(text).toContain('1 miss')
  expect(text).not.toContain('cold restart')
  expect(it.ran).toHaveLength(1)
  expect(it.ran[0]![4]).toContain('"kind":"miss"')
  expect(it.ran[0]![4]).toContain('"ttl_basis":"setting"')
  expect(it.ran[0]![4]).toContain('"split_seen":false')
})

test('a lapse past a known lifetime is a cold restart, logged with its basis', async ($, on) => {
  const it = world(on, T0, { settings: { promptCacheTtl: '1h' } })
  await step($, it, warm(120_000))
  await it.clock.advance(61 * MINUTE)
  await step($, it, rewritten(120_000), 1)
  expect(await drawn($)).toContain('1 cold restart')
  expect(it.ran[0]![4]).toContain('"kind":"lapse"')
  expect(it.ran[0]![4]).toContain('"ttl_basis":"setting"')
  expect(it.ran[0]![4]).toContain('"split_seen":false')
})

test('a cold-looking hit rate no longer shortens the lifetime', async ($, on) => {
  const it = world(on)
  await step($, it, warm(120_000))
  await it.clock.advance(10 * MINUTE)
  await step($, it, rewritten(120_000), 1)
  const text = await drawn($)
  expect(text).toContain('left of 1h (assumed)')
  // Under an assumed lifetime a re-write inside it is not counted either way.
  expect(text).not.toContain('miss')
  expect(it.ran).toHaveLength(0)
})

// ---------- the offer to turn the guard on ----------

test('with the guard off, the first big lapse offers the guard once, naming /config and the size', async ($, on) => {
  const it = world(on)
  await step($, it, warm(160_000))
  await it.clock.advance(61 * MINUTE)
  await step($, it, rewritten(160_000), 1)
  expect(it.toasts).toHaveLength(1)
  expect(it.toasts[0]).toContain('/config')
  expect(it.toasts[0]).toContain('160k')
  // A second lapse in the same session: no second offer.
  await it.clock.advance(61 * MINUTE)
  await step($, it, rewritten(160_000), 2)
  expect(it.toasts).toHaveLength(1)
})

test('no offer for a lapse under the size the guard asks at', async ($, on) => {
  const it = world(on)
  await step($, it, warm(40_000))
  await it.clock.advance(61 * MINUTE)
  await step($, it, rewritten(40_000), 1)
  expect(it.toasts).toHaveLength(0)
})

test('the offer follows the configured size, not a fixed one', { options: { bigTokens: 100_000 } }, async ($, on) => {
  const it = world(on)
  await step($, it, warm(120_000))
  await it.clock.advance(61 * MINUTE)
  await step($, it, rewritten(120_000), 1)
  expect(it.toasts).toHaveLength(1)
})

test('a failing offer never stops the lapse being counted', async ($, on) => {
  const it = world(on)
  on('state.set', (_, e, next) => {
    if ((e as { key: string }).key === 'offered') {
      throw new Error('state refused')
    }

    return next(e)
  })
  await step($, it, warm(160_000))
  await it.clock.advance(61 * MINUTE)
  await step($, it, rewritten(160_000), 1)
  expect(await drawn($)).toContain('1 cold restart')
  expect(it.ran).toHaveLength(1)
})

test('no offer while the guard is already on', GUARD_ON, async ($, on) => {
  const it = world(on)
  await step($, it, warm(160_000))
  await it.clock.advance(61 * MINUTE)
  await step($, it, rewritten(160_000), 1)
  expect(it.toasts).toHaveLength(0)
})

test('/clear lets the next conversation be offered again', async ($, on) => {
  const it = world(on)
  await step($, it, warm(160_000))
  await it.clock.advance(61 * MINUTE)
  await step($, it, rewritten(160_000), 1)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await step($, it, warm(160_000), 2)
  await it.clock.advance(61 * MINUTE)
  await step($, it, rewritten(160_000), 3)
  expect(it.toasts).toHaveLength(2)
})

// ---------- the cold-send guard (draws nothing, so one surface suffices) ----------

const GUARD = { options: { coldSendGuard: true, bigTokens: 150_000 } }
const lapse = async ($: Kit, it: ReturnType<typeof world>, prompt = 160_000) => {
  await step($, it, warm(prompt))
  await it.clock.advance(61 * MINUTE)
}
const submit = ($: Kit, text = 'next please') =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

test('guard off by default: a cold big send passes without a question', async ($, on) => {
  const it = world(on)
  await lapse($, it)
  const r = await submit($)
  expect(r.drop).toBeUndefined()
  expect(it.asked).toHaveLength(0)
})

test('guard on: a cold big send asks, and Send anyway passes it', GUARD, async ($, on) => {
  const it = world(on)
  await lapse($, it)
  it.answer = 'Send anyway'
  const r = await submit($)
  expect(r.drop).toBeUndefined()
  expect(it.asked).toHaveLength(1)
  expect(it.asked[0]).toContain('lapsed 1m ago')
  expect(it.asked[0]).toContain('160k')
})

test('guard on: Cancel drops the prompt and puts the text back in the box', GUARD, async ($, on) => {
  const it = world(on)
  await lapse($, it)
  it.answer = 'Cancel'
  const r = await submit($, 'keep this text')
  expect(r.drop).toContain('cold-send guard')
  expect(it.filled).toEqual(['keep this text'])
  expect(it.submitted).toHaveLength(0)
})

test('guard on: Compact now holds the prompt in the box and compacts off the hook', GUARD, async ($, on) => {
  const it = world(on)
  await lapse($, it)
  it.answer = 'Compact now, then send'
  const r = await submit($, 'after compaction')
  expect(r.drop).toContain('compacting now')
  expect(it.filled).toEqual(['after compaction'])
  expect(it.submitted).toHaveLength(0)
  // The compaction is scheduled past the hook: it runs once the clock settles.
  await it.clock.settle()
  expect(it.compacted).toBe(1)
  // The compacted context is small and freshly cached: the resend passes without a second ask.
  const again = await submit($, 'after compaction')
  expect(again.drop).toBeUndefined()
  expect(it.asked).toHaveLength(1)
  expect(it.submitted).toEqual(['after compaction'])
  // And the reading now carries the compacted size: a later lapse is under the threshold.
  await it.clock.advance(61 * MINUTE)
  const later = await submit($, 'much later')
  expect(later.drop).toBeUndefined()
  expect(it.asked).toHaveLength(1)
})

test('guard on: Cancel keeps the text in the reason when the box refuses it', GUARD, async ($, on) => {
  const it = world(on)
  it.isFillOk = false
  await lapse($, it)
  it.answer = 'Cancel'
  const r = await submit($, 'do not lose me')
  expect(r.drop).toContain('do not lose me')
  expect(r.drop).toContain('could not take it back')
})

test('guard on: a slash command passes without a question', GUARD, async ($, on) => {
  const it = world(on)
  await lapse($, it)
  const r = await $.prompt.submit({ text: '/compact', wait: false, origin: { kind: 'composer' }, command: { name: 'compact', args: '' } } as never)
  expect(r.drop).toBeUndefined()
  expect(it.asked).toHaveLength(0)
})

test('guard on: a long prompt is never dropped when the box refuses it back', GUARD, async ($, on) => {
  const it = world(on)
  it.isFillOk = false
  await lapse($, it)
  it.answer = 'Cancel'
  const long = 'x'.repeat(5_000)
  const r = await submit($, long)
  // Too long to carry in a drop reason (cut at 4,096): it goes as typed instead.
  expect(r.drop).toBeUndefined()
  expect(it.submitted).toEqual([long])
  expect(it.asked).toHaveLength(1)
})

test('guard on: a resume the engine calls expired asks before a big send', GUARD, async ($, on) => {
  const it = world(on)
  await $.classic.SessionStart({
    source: 'resume',
    seconds_since_last_response: 600,
    prompt_cache_likely_expired: true,
    context_tokens: 160_000,
  } as never)
  it.answer = 'Send anyway'
  await submit($)
  expect(it.asked).toHaveLength(1)
})

test('guard on: silent while the cache is warm', GUARD, async ($, on) => {
  const it = world(on)
  await step($, it, warm(160_000))
  await submit($)
  expect(it.asked).toHaveLength(0)
})

test('guard on: silent below the size threshold', GUARD, async ($, on) => {
  const it = world(on)
  await lapse($, it, 60_000)
  await submit($)
  expect(it.asked).toHaveLength(0)
})

test('guard on: the new text counts toward the size', GUARD, async ($, on) => {
  const it = world(on)
  await lapse($, it, 140_000)
  await submit($, 'x'.repeat(60_000))
  expect(it.asked).toHaveLength(1)
})

test('guard on: silent for an SDK origin and inside a running turn', GUARD, async ($, on) => {
  const it = world(on)
  await lapse($, it)
  await $.prompt.submit({ text: 'a', wait: false, origin: { kind: 'sdk' } } as never)
  await $.prompt.submit({ text: 'b', wait: false, turnId: 't9', origin: { kind: 'composer' } } as never)
  expect(it.asked).toHaveLength(0)
})

test('guard on: a dismissed dialog sends the prompt', GUARD, async ($, on) => {
  const it = world(on)
  it.answer = null
  await lapse($, it)
  const r = await submit($)
  expect(it.asked).toHaveLength(1)
  expect(r.drop).toBeUndefined()
})

test('the cache row sits below whatever another mod draws in the band, so plugin-dirs order sets the stack', async ($, on) => {
  const it = world(on)
  it.beneath = { type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['♥ SPEND'] }] }

  const text = await drawn($)
  expect(text).toContain('♥ SPEND')
  expect(text.indexOf('cache')).toBeGreaterThan(text.indexOf('♥ SPEND'))
})
