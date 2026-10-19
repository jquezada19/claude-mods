import type { EngineInterface, Register } from 'claude-code'

import type { CacheStatusLast, CacheStatusRestarts } from '../types'

const MINUTE = 60_000
const SHORT_TTL = 5 * MINUTE
const LONG_TTL = 60 * MINUTE
const TICK = 15_000
// Under this much left the band turns yellow: a prompt now still hits.
const CLOSE = 5 * MINUTE
// A request this big whose cache-written share passes this, after a gap past
// the lifetime, is a cold restart: the whole context written again.
const RESTART_MIN_TOKENS = 30_000
const RESTART_WRITTEN_SHARE = 0.5
// The guard sizes the outgoing prompt as the last one plus the new text.
const CHARS_PER_TOKEN = 4
/** The longest prompt a drop reason can carry whole: the engine cuts a reason at 4,096 characters, the wording takes the rest. */
const DROP_CAP = 3_500
const SEND = 'Send anyway'
const COMPACT = 'Compact now, then send'
const CANCEL = 'Cancel'

/** Where the lifetime on the row comes from, strongest first. */
type TtlBasis = NonNullable<CacheStatusLast['ttlBasis']>

const ttlOf = (v: unknown): number | null => (v === '5m' ? SHORT_TTL : v === '1h' ? LONG_TTL : null)

/**
 * The main conversation's lifetime as configured, in Anthropic's documented order:
 * FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, the promptCacheTtl setting,
 * ENABLE_PROMPT_CACHING_1H. null when nothing sets it: the default then depends on
 * billing (1h on a subscription within plan usage, else 5m), which no field exposes.
 */
const configuredTtl = async ($: EngineInterface): Promise<{ ttlMs: number; basis: TtlBasis } | null> => {
  if ((await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1') {
    return { ttlMs: SHORT_TTL, basis: 'env' }
  }

  const fromEnv = ttlOf(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))

  if (fromEnv !== null) {
    return { ttlMs: fromEnv, basis: 'env' }
  }

  let fromSetting: number | null = null

  try {
    fromSetting = ttlOf((await $.settings.read()).promptCacheTtl)
  } catch {
    fromSetting = null
  }

  if (fromSetting !== null) {
    return { ttlMs: fromSetting, basis: 'setting' }
  }

  if ((await $.env.get('ENABLE_PROMPT_CACHING_1H')) === '1') {
    return { ttlMs: LONG_TTL, basis: 'env' }
  }

  return null
}

/** The 1h/5m split of a request's cache writes, when the usage carries it (the API's cache_creation). */
const splitOf = (usage: unknown): { fiveMin: number; oneHour: number } | null => {
  const cc = (usage as { cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown } } | null)
    ?.cache_creation

  if (cc === undefined || cc === null) {
    return null
  }

  const fiveMin = typeof cc.ephemeral_5m_input_tokens === 'number' ? cc.ephemeral_5m_input_tokens : 0
  const oneHour = typeof cc.ephemeral_1h_input_tokens === 'number' ? cc.ephemeral_1h_input_tokens : 0

  return { fiveMin, oneHour }
}

const LAST = { plugin: 'cache-status', key: 'last' } as const
const RESTARTS = { plugin: 'cache-status', key: 'restarts' } as const
/** The lifetime the engine reported at the last model switch, and the model it switched to. */
const ENGINE = { plugin: 'cache-status', key: 'engine' } as const
/** Whether this conversation was already offered the cold-send guard. */
const OFFERED = { plugin: 'cache-status', key: 'offered' } as const

const span = (ms: number): string => {
  const minutes = Math.floor(ms / MINUTE)

  if (minutes >= 60) {
    const rest = minutes % 60

    return `${Math.floor(minutes / 60)}h${rest === 0 ? '' : ` ${rest}m`}`
  }

  if (minutes >= 1) {
    return `${minutes}m`
  }

  return `${Math.max(0, Math.floor(ms / 1000))}s`
}

const tokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)

/** One JSONL row appended on the host; a failure to write never reaches the band. */
const logRestart = async ($: EngineInterface, row: Record<string, unknown>): Promise<void> => {
  const home = (await $.env.get('HOME')) ?? ''
  const path = `${home}/.claude/metrics/cache-restarts.jsonl`

  try {
    await $.process.run(
      ['sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s\\n" "$1" >> "$2"', '_', JSON.stringify(row), path],
      { timeoutMs: 5_000 },
    )
  } catch {
    // the row is a measurement, never a blocker
  }
}

/**
 * A resumed or forked transcript: the engine says how long ago its last
 * response was. Stored as an absolute time, so an idle session ages into
 * lapsed on the clock alone.
 */
const seedFromIdle = async (
  $: EngineInterface,
  idleSeconds: number,
  isLikelyExpired: boolean,
  contextTokens: number,
): Promise<void> => {
  const now = await $.clock.now()
  const idleMs = idleSeconds * 1000
  // The lifetime is whatever is configured, else assumed; the engine's own verdict on
  // whether the cache outlived the break is taken as given, never turned into a 5m guess.
  const configured = await configuredTtl($)
  const seeded: CacheStatusLast = {
    at: now - idleMs,
    hitPercent: 0,
    ttlMs: configured?.ttlMs ?? LONG_TTL,
    ttlBasis: configured?.basis ?? 'assumed',
    isCached: true,
    ...(isLikelyExpired ? { isExpired: true } : {}),
    promptTokens: contextTokens,
    model: '',
  }
  await $.state.set(LAST, seeded)
}

/**
 * After a compaction that replaced the main transcript: the compaction request
 * itself wrote the new, smaller context into the cache, so the reading moves to
 * now and to that size. That is also what keeps the next step from reading as a
 * cold restart, and the cold-send guard from asking again before any step runs.
 */
const afterCompaction = async ($: EngineInterface, tokensAfter: number | undefined): Promise<void> => {
  const { value: seen } = await $.state.get(LAST)

  if (seen !== null && seen !== undefined) {
    // The compaction wrote the new context: whatever expired while away is cached again.
    const { isExpired: _wasExpired, ...rest } = seen
    const after: CacheStatusLast = {
      ...rest,
      at: await $.clock.now(),
      isCached: true,
      promptTokens: tokensAfter ?? 0,
    }
    await $.state.set(LAST, after)
  }
}

export const register: Register = (on, options) => {
  const isGuardOn = options.coldSendGuard === true
  const bigTokens =
    typeof options.bigTokens === 'number' && options.bigTokens > 0 ? options.bigTokens : 150_000

  on('session.start', async ($, e, next) => {
    // The countdown moves with the clock, not with any state write.
    $.clock.every(TICK, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  // Opt-in: before a big prompt enters a lapsed cache, ask. Compaction re-reads
  // the cold context once and shrinks later turns; it pays off only if the
  // session goes on.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind

    // A slash command is not a prompt into the cache: /compact, /clear and the mods' own
    // commands pass, and a skill command pays its own way like any send.
    if (!isGuardOn || e.turnId !== undefined || e.command !== undefined || (kind !== 'composer' && kind !== 'bridge')) {
      return next(e)
    }

    const { value: seen } = await $.state.get(LAST)

    if (seen === null || seen === undefined || seen.isCached === false) {
      return next(e)
    }

    const left = seen.ttlMs - ((await $.clock.now()) - seen.at)
    const outgoing = seen.promptTokens + Math.ceil(e.text.length / CHARS_PER_TOKEN)

    const isLapsed = left <= 0 || seen.isExpired === true

    if (!isLapsed || outgoing < bigTokens) {
      return next(e)
    }

    let answer: string

    try {
      answer = await $.ui.ask(
        `${left <= 0 ? `Cache lapsed ${span(-left)} ago` : 'Cache expired while away'}. Sending now re-caches about ${tokens(outgoing)} tokens. What should happen?`,
        { options: [SEND, COMPACT, CANCEL], header: 'Cache cold' },
      )
    } catch {
      // dismissed, or nobody to ask: send as typed
      return next(e)
    }

    if (answer !== COMPACT && answer !== CANCEL) {
      return next(e)
    }

    let isFilled = false

    try {
      isFilled = (await $.prompt.fill({ text: e.text })).isFilled
    } catch {
      isFilled = false
    }

    // The text is never lost: when no box took it back, the drop reason carries it, and a
    // prompt too long for a reason (the engine cuts one at 4,096 characters) is sent as typed.
    if (!isFilled && e.text.length > DROP_CAP) {
      try {
        await $.ui.toast('cache-status: the box could not take a prompt this long back, so it was sent as typed')
      } catch {
        // no toast here: it is sent all the same
      }

      return next(e)
    }

    const where = isFilled ? 'The prompt is back in the box' : `The box could not take it back, so here it is:\n\n${e.text}\n\n`

    if (answer === COMPACT) {
      // The engine refuses a compaction from inside this hook (it would compact
      // under the turn the hook holds), so it runs a tick later, off the hook.
      // A plugin's own call does not pass through its own session.compact hook,
      // so the reading is refreshed here from the result.
      $.clock.after(0, async () => {
        try {
          const done = await $.session.compact()

          if (done.skip === undefined) {
            await afterCompaction($, done.tokensAfter)
          }
        } catch {
          // refused or failed: the row keeps saying the cache is cold
        }
      })

      return { drop: `Not sent: compacting now. ${where}${isFilled ? '; press Enter once the cache row shows the new context.' : 'Send it again once the cache row shows the new context.'}` }
    }

    return { drop: `Not sent: cache-status cold-send guard (Cancel). ${where}${isFilled ? '.' : ''}` }
  })

  // The idle time of a resumed or forked transcript rides the classic event,
  // not session.start (whose input has no such field).
  on('classic.SessionStart', async ($, e, next) => {
    const idle = e.seconds_since_last_response
    const { value: seen } = await $.state.get(LAST)

    if (
      (e.source === 'resume' || e.source === 'fork') &&
      (seen === null || seen === undefined) &&
      idle !== undefined
    ) {
      await seedFromIdle($, idle, e.prompt_cache_likely_expired === true, e.context_tokens ?? 0)
    }

    return next(e)
  })

  // /clear ends the conversation under this id and no session.start follows:
  // start the row over.
  // The engine names the main conversation's lifetime after every model switch (a
  // command, the picker, the SDK, an automatic fallback, a resume): kept with the model
  // it switched to, in session state so a reload keeps it. A subagent's switch is its own.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const reported = ttlOf(e.cache_ttl)

    if (reported !== null && e.agent_id === undefined) {
      await $.state.set(ENGINE, { ttlMs: reported, model: e.to_model })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // /resume and /branch end this conversation too (reported as resume); no session.start follows.
    if (e.reason === 'clear' || e.reason === 'resume') {
      await $.state.set(LAST, null)
      await $.state.set(RESTARTS, null)
      await $.state.set(ENGINE, null)
      await $.state.set(OFFERED, null)
    }

    return next(e)
  })

  // Compaction rewrites a shorter context on purpose. A precompute installs
  // nothing, so it changes nothing here.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId !== undefined || e.trigger === 'precompute' || done.skip !== undefined) {
      return done
    }

    await afterCompaction($, done.tokensAfter)

    return done
  })

  on('turn.step', async function* ($, e, next) {
    // The lifetime runs from the start of the request, not the end of the response.
    const startedAt = await $.clock.now()
    const response = yield* next(e)
    const usage = response.usage

    // A subagent's requests keep a prefix of their own warm, not the session's.
    if (e.agentId !== undefined || usage === null) {
      return response
    }

    const cached =
      usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    const prompt = usage.input_tokens + cached
    const hit = prompt === 0 ? 0 : usage.cache_read_input_tokens / prompt

    const { value: seen } = await $.state.get(LAST)
    const gap = seen === null || seen === undefined ? 0 : startedAt - seen.at
    // The lifetime: what this request's own cache writes say, else what the engine said
    // at a model switch, else what is configured, else what an earlier write showed,
    // else 1h assumed (observed main-conversation writes were 1h, 2026-10-16).
    // A hit rate says nothing about the lifetime: a changed prefix misses inside it.
    const split = splitOf(usage)
    const configured = await configuredTtl($)
    const observed = split === null ? null : split.fiveMin > 0 ? SHORT_TTL : split.oneHour > 0 ? LONG_TTL : null
    const known = seen?.ttlBasis === 'observed' ? { ttlMs: seen.ttlMs, basis: 'observed' as const } : null
    // The engine's report covers the model it switched to, nothing else.
    const { value: engine } = await $.state.get(ENGINE)
    const reported = engine !== null && engine !== undefined && engine.model === usage.model ? engine.ttlMs : null
    const { ttlMs, basis }: { ttlMs: number; basis: TtlBasis } =
      observed !== null
        ? { ttlMs: observed, basis: 'observed' }
        : reported !== null
          ? { ttlMs: reported, basis: 'engine' }
          : (configured ?? known ?? { ttlMs: LONG_TTL, basis: 'assumed' })

    const written = usage.cache_creation_input_tokens
    const isSameModel =
      seen === null || seen === undefined || seen.model === '' || seen.model === usage.model
    const isRewrite =
      seen !== null &&
      seen !== undefined &&
      isSameModel &&
      prompt > RESTART_MIN_TOKENS &&
      written / prompt > RESTART_WRITTEN_SHARE
    // Judged by the lifetime the earlier cache had (the new request's says nothing about
    // it). Past it, or after a resume the engine called expired, it is a lapse (a cold
    // restart). Inside a lifetime that was known, not assumed, it is a miss: something
    // changed the prefix. Inside an assumed one it says nothing either way.
    const prevTtl = seen?.ttlMs ?? ttlMs
    const prevBasis: TtlBasis = seen?.ttlBasis ?? 'assumed'
    const kind = !isRewrite
      ? null
      : seen?.isExpired === true || gap >= prevTtl
        ? 'lapse'
        : prevBasis === 'assumed'
          ? null
          : 'miss'

    if (kind !== null) {
      const { value: before } = await $.state.get(RESTARTS)
      const restarts: CacheStatusRestarts =
        kind === 'lapse'
          ? {
              ...(before ?? { misses: 0, missTokens: 0 }),
              count: (before?.count ?? 0) + 1,
              tokens: (before?.tokens ?? 0) + written,
              lastAt: startedAt,
            }
          : {
              count: before?.count ?? 0,
              tokens: before?.tokens ?? 0,
              lastAt: startedAt,
              misses: (before?.misses ?? 0) + 1,
              missTokens: (before?.missTokens ?? 0) + written,
            }
      await $.state.set(RESTARTS, restarts)
      await logRestart($, {
        ts: new Date(startedAt).toISOString(),
        session: await $.session.id(),
        kind,
        tokens: written,
        gap_min: Math.round(gap / MINUTE),
        ttl_min: prevTtl / MINUTE,
        ttl_basis: prevBasis,
        split_seen: split !== null,
      })
    }

    // The guard is opt-in. After the first lapse big enough for the guard to have asked
    // about, say once that it exists; never turn it on unasked. Recorded after the lapse
    // is counted, and nothing here can stop that accounting.
    if (kind === 'lapse' && !isGuardOn && prompt >= bigTokens) {
      try {
        const { value: wasOffered = false } = await $.state.get(OFFERED)

        if (!wasOffered) {
          await $.state.set(OFFERED, true)
          await $.ui.toast(
            `cache-status: that lapse re-cached ${tokens(written)} tokens. The cold-send guard can ask before the next big send: turn it on in /config under cache-status.`,
            { timeoutMs: 12_000 },
          )
        }
      } catch {
        // the offer is a courtesy: a failure here skips it
      }
    }

    const fresh: CacheStatusLast = {
      at: startedAt,
      hitPercent: Math.round(hit * 100),
      ttlMs,
      ttlBasis: basis,
      isCached: cached > 0,
      promptTokens: prompt,
      model: usage.model,
    }
    await $.state.set(LAST, fresh)

    return response
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Like every other band mod, this row goes after whatever is drawn beneath:
    // the rows then stack in CLAUDE_CODE_PLUGIN_DIRS order, last listed on top
    // (until 2026-10-13 this row pinned itself above the rest).
    const beneath = await next(e)

    if (e.props.hasSurvey) {
      return beneath
    }

    const { Box, Text } = $.ui.resolve(e)
    const { value: seen } = await $.state.get(LAST)

    if (seen === null || seen === undefined) {
      return (
        <Box flexDirection="column">
          {beneath}
          <Text dimColor>○ cache · waiting for first response</Text>
        </Box>
      )
    }

    const left = seen.ttlMs - ((await $.clock.now()) - seen.at)
    const ttl = `${seen.ttlMs === LONG_TTL ? '1h' : '5m'}${seen.ttlBasis === 'assumed' ? ' (assumed)' : ''}`
    // Nothing read or written: there is no cached prefix to be warm.
    const isCold = seen.isCached === false || seen.isExpired === true || left <= 0
    const detail = !isCold
      ? ` · ${span(left)} left of ${ttl} · last hit ${seen.hitPercent}%`
      : seen.isCached === false
        ? ' · last response used no cache'
        : seen.isExpired === true && left > 0
          ? ' · expired while away · next message re-caches'
          : ` · lapsed ${span(-left)} ago · next message re-caches`
    const { value: restarts } = await $.state.get(RESTARTS)
    const misses = restarts?.misses ?? 0
    const reCached = (restarts?.tokens ?? 0) + (restarts?.missTokens ?? 0)
    const tally =
      restarts === null || restarts === undefined
        ? ''
        : `${restarts.count > 0 ? ` · ${restarts.count} cold restart${restarts.count === 1 ? '' : 's'}` : ''}${
            misses > 0 ? ` · ${misses} miss${misses === 1 ? '' : 'es'}` : ''
          } · ${tokens(reCached)} re-cached`

    return (
      <Box flexDirection="column">
        {beneath}
        <Box>
          <Text color={isCold ? 'red' : left < CLOSE ? 'yellow' : 'green'} bold>
            {isCold ? '○ CACHE COLD' : '● CACHE WARM'}
          </Text>
          <Text dimColor>{`${detail}${tally}`}</Text>
        </Box>
      </Box>
    )
  })
}
