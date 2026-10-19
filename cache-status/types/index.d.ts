export type CacheStatusLast = {
  /** When the last main-thread request started, ms since the epoch. */
  at: number
  /** Share of that request's prompt the cache served, 0 to 100. */
  hitPercent: number
  /** The cache lifetime in force, in ms. */
  ttlMs: number
  /** Where ttlMs came from: the request's own cache writes, the engine at a model switch, env or settings, or assumed. */
  ttlBasis?: 'observed' | 'engine' | 'env' | 'setting' | 'assumed'
  /** Whether that response read or wrote any cache tokens. */
  isCached: boolean
  /** Set on a resume the engine reported as likely expired, until the next response. */
  isExpired?: boolean
  /** That request's whole prompt (uncached + cache read + cache written), tokens. */
  promptTokens: number
  /** The model that answered, as the API names it; '' when seeded from a resume. */
  model: string
}

export type CacheStatusRestarts = {
  /** Requests this session that re-cached a big context after the cache lapsed. */
  count: number
  /** Cache-written tokens across those requests. */
  tokens: number
  /** When the last one (lapse or miss) started, ms since the epoch. */
  lastAt: number
  /** Big re-writes inside a known lifetime: the prefix changed, the cache had not lapsed. */
  misses?: number
  /** Cache-written tokens across those misses. */
  missTokens?: number
}

/** The lifetime the engine reported at the last main-conversation model switch, and the model it switched to. */
export type CacheStatusEngine = {
  ttlMs: number
  model: string
}

declare module 'claude-code' {
  interface PluginState {
    'cache-status': {
      last: CacheStatusLast | null
      restarts: CacheStatusRestarts | null
      engine: CacheStatusEngine | null
      offered: boolean | null
    }
  }
}
