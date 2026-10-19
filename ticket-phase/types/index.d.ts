/** One sink row after parsing: the stamp as epoch ms, the file position as `order`. */
export type PhaseRow = {
  at: number
  session: string
  ticket: string
  phase: number
  event: 'enter' | 'exit'
  order: number
}

/** What one phase of a ticket has seen across every session. */
export type PhaseInfo = {
  enters: number
  exits: number
  /** Exits that closed an open enter; the rest of `exits` were orphans. */
  closed: number
  /** Times the phase was left: closed by an exit, or by an enter of another phase. */
  left: number
  /** 1 + enters after the phase was left; a resume or a second session is not a round. */
  rounds: number
  /** Sessions with an unanswered enter, oldest first. */
  open: string[]
  /** The enter that opened the phase for the ticket, ms; null when not open. */
  openedAt: number | null
  /** That enter's row order: tells a same-second re-entry from the one before. */
  openedOrder: number | null
}

/** The phase state of one ticket, walked from its rows in time order. */
export type TicketPhases = {
  ticket: string
  phases: Record<number, PhaseInfo>
  /** The open phase whose enter is the latest; null between phases or when done. */
  current: number | null
  enteredAt: number | null
  enteredOrder: number | null
  /** The phase and event of the ticket's latest row; null with no rows. */
  lastPhase: number | null
  lastEvent: 'enter' | 'exit' | null
  isDone: boolean
  firstEnterAt: number | null
  lastExitAt: number | null
  /** Every session that wrote a row for the ticket. */
  sessions: string[]
}

/** Own pace for one phase over every ticket's paired enter/exit. */
export type PhaseStats = {
  /** Median duration in ms; null under two pairs. */
  median: number | null
  pairs: number
  /** Distinct tickets among the pairs: the ETA's gate. */
  tickets: number
}

export type TicketPhaseReading = {
  ticket: string
  /** `small`, `medium`, `full`, or `?`. */
  tier: string
  state: TicketPhases
  stats: Record<number, PhaseStats>
  skipped: number
  sinkMtimeMs: number
  noteMtimeMs: number | null
  /** When the reading was taken, ms. */
  at: number
  /** Set when the sink was past the read limit and only its newest part was read. */
  isPartial?: true
}

/** Tokens this session has spent in the current phase, kept in $.store across restarts. */
export type TicketPhaseTally = {
  ticket: string
  phase: number
  enteredAt: number
  enteredOrder: number
  /** Every step's four counts, cached context included. */
  tokens: number
  /** What the steps added: uncached input, output and cache writes; absent on a tally stored before 0.3.0. */
  fresh?: number
  /** When a step last added to it: pruning goes by this, not by when the phase began. */
  at?: number
}

declare module 'claude-code' {
  interface PluginState {
    'ticket-phase': {
      reading: TicketPhaseReading | null
      /** The sink's mtime at the last read, whether or not it held a row of ours; null after a failed read. */
      sinkMtimeMs: number | null
      /** The Work Item note found for the ticket, cached between refreshes. */
      notePath: string | null
      hidden: boolean
    }
  }
}
