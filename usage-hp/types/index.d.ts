export type UsageHpWindow = {
  /** Which window: five_hour, seven_day, or a gateway's spend_limit. */
  kind: string
  /** How much of the window is used, 0 to 100 (past 100 when exceeded). */
  percentUsed: number
  /** When the window resets, ISO 8601; absent when the engine has none. */
  resetsAt?: string
}

/** A monthly spend limit the person entered with /hp, tracked locally. */
export type UsageHpBudget = {
  limitUsd: number
  /** The exact figure the range builds on: the one entered, or 0 in a month after it. */
  baseUsd?: number
  /** Spend so far this month: the figure entered plus what sessions added, calibrated. */
  spentUsd: number
  /** The range the spend is likely in; equal to spentUsd right after an entry. */
  lowUsd: number
  highUsd: number
  /** When the figure was last entered from the dashboard, ms. */
  syncedAt: number
  /** How many earlier re-entries the calibration learned from. */
  syncs: number
  /** What the dashboard bills per dollar Claude Code counts, as calibrated; 1 before any re-entry. */
  ratio: number
  /** When the month ends, ms since the epoch (months turn over in UTC). */
  resetsAt: number
  /** Dollars billed a day: from the resync log's week, else the ledger's scaled by `ratio`; null without either. */
  burnUsd?: number | null
}

export type UsageHpReading = {
  windows: UsageHpWindow[]
  /** What the session has cost in US dollars; null where no ledger is kept. */
  usd: number | null
  /** The same at the official per-model prices, where the session is priced so; else null. */
  pricedUsd?: number | null
  budget: UsageHpBudget | null
  /** When a finished turn last gave fresh figures, ms; null before the first. */
  at: number | null
}

/**
 * One interval between two /hp entries: what the sessions counted, and what
 * the dashboard says was really spent. Kept in $.store under `calib:<at>`.
 */
export type UsageHpCalibration = {
  est: number
  real: number
  at: number
  /** When the entry it measures from was made, ms; absent on intervals kept before 0.20. */
  from?: number
  /** `priced` when counted at official prices; earlier intervals counted Claude Code's own cost. */
  basis?: UsageHpBasis
}

/** What the session had cost at a reading: where its count starts for a figure read then. */
export type UsageHpCost = { at: number; usd: number }

/**
 * What one agent of a session (main, or a subagent) has cost at the official
 * per-model prices, kept in $.store under `priced:<session>:<agent>`.
 */
export type UsageHpPriced = {
  usd: number
  /** The same calls at Claude Code's own prices: its total beyond this is calls no turn shows. */
  engine?: number
  /** Calls whose model has no price here: counted through Claude Code's total instead. */
  unknown: number
  /** When it was last written, ms: stale keys of ended sessions are pruned. */
  at: number
}

/**
 * Where a session's dollars come from: each call priced at the official
 * per-model rates (`priced`), or Claude Code's own session cost (`engine`) for
 * a session the mod joined after it had already spent.
 */
export type UsageHpBasis = 'priced' | 'engine'

/**
 * One dashboard figure entered, by /hp or the sync file, kept in $.store under
 * `sync:<at>`: the resync log. `est` and `real` are the interval it measured,
 * where it was a same-month re-entry.
 */
export type UsageHpSync = {
  /** When the dashboard figure was read, ms. */
  at: number
  /** When the mod entered it, ms: later than `at` for a sync file picked up on a later turn. */
  enteredAt: number
  spentUsd: number
  limitUsd: number
  /** `command` for /hp, `file` for the sync file the scheduled routine writes. */
  source: 'command' | 'file'
  est?: number
  real?: number
}

/** One past reading of a bar: how much was left, and when. */
export type UsageHpSample = { at: number; left: number }

/** Where this session's cost starts counting toward the entered limit. */
export type UsageHpLedger = {
  /** The limit's entry and month this base belongs to; a new one starts over. */
  tag: string
  /** The session's cost that the entered figure, or an earlier month, holds. */
  baseUsd: number
}

/** What the other sessions have added, read from the store now and then. */
export type UsageHpOthers = { tag: string; usd: number; at: number }

/**
 * How a bar is drawn: `bar` drains from full, `used` fills as the limit is
 * spent, `hearts` is a row of ten hearts losing a quarter at a time, `text`
 * is the figures alone.
 */
export type UsageHpStyle = 'bar' | 'used' | 'hearts' | 'text'

declare module 'claude-code' {
  interface PluginState {
    'usage-hp': {
      reading: UsageHpReading | null
      /** The session's cost at the last reading. */
      counted: number
      /** The session's cost at recent readings, oldest first, two days of them. */
      costs: UsageHpCost[]
      /** Where this session's dollars come from, settled when it starts. */
      basis: UsageHpBasis
      /** Each bar's colour at the last reading, by kind: what the hysteresis holds to. */
      colors: Record<string, 'green' | 'yellow' | 'red'>
      /** Recent readings of each bar by kind, oldest first: the pace's basis. */
      samples: Record<string, UsageHpSample[]>
      /** True once the engine reported a limit: such a session has its own bars. */
      seen: boolean
      ledger: UsageHpLedger | null
      others: UsageHpOthers | null
      style: UsageHpStyle
      /** True while /hp hide stands: nothing is drawn, the figures still kept. */
      hidden: boolean
      /** True when the session bills an API key or a cloud provider: no setup line is drawn. */
      metered: boolean
    }
  }
}
