export type AgentStatus = 'running' | 'done' | 'failed' | 'lost'

/** One subagent of the session, keyed by the agentId the engine answered the spawn with. */
export type AgentRun = {
  id: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  /** The latest step's input side: input + cache read + cache write. */
  contextTokens: number
  /** Every step's four counts, summed. */
  tokens: number
  steps: number
  /** What $.agent.list() says of a running row that is not working: parked on a prompt, a message, or not started. */
  engineStatus?: 'pending' | 'waiting' | 'idle'
  /** First reconcile that found no list row for it while running. */
  missingSince?: number
  /** The turn the row last finished in: a later step from another turn is a resume, one from this turn is late. */
  turnId?: string
  /**
   * Usage steps seen per turn (the newest few turns): a completion of a turn with none seen
   * takes its figures from its own usage, and the turn is then marked FELL_BACK (-1) so a
   * repeated completion or a late step of it adds nothing.
   */
  turns?: Record<string, number>
  /** Permission checks on the run's calls that asked or denied (an allow is not counted). */
  checks?: { asked: number; denied: number }
  /** The calls a check asked about that have not returned (and the run has not stepped or ended since). */
  pending?: string[]
  /** What the card opens to: the task, the newest tool uses, the answer's start, and whether it was cut off. */
  detail?: AgentDetail
  /** A subagent's spawn order, which picks its Clawd costume when its type has none of its own. */
  variant?: number
  /**
   * Set on an agent a Bash call started outside the engine (a buddy seat, a Codex run):
   * the engine never lists it and reports no tokens. A foreground one ends with its call;
   * a backgrounded one when `doneFile` lands, on its task notification, at the main turn's
   * end once `taskId` is no longer in flight, or as lost past `deadline`.
   */
  external?: { doneFile: string | null; deadline: number | null; taskId?: string }
}

/** A card's drill-down, clipped: the task (400), up to three tool lines (80 each), the answer's start (400). */
export type AgentDetail = {
  task?: string
  tools?: string[]
  answer?: string
  /** A step stopped at the output limit (stop reason max_tokens). */
  isCutOff?: true
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  hasAutoOpened: boolean
  /** The cards opened to their details, by agent id. */
  open?: string[]
}

/** A model request's four token counts and model, as a step or completion reports them. */
export type EarlyUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  model?: string
}

/** What arrived for a subagent before its spawn card opened: folded into the card when it does. */
export type EarlyStep = {
  tokens: number
  context: number
  steps: number
  model: string
  /** The turn the held steps ran in (the newest). */
  turnId?: string
  /** Held usage steps per turn, folded into the card's own per-turn counts. */
  turns?: Record<string, number>
  /** Permission checks that came before the card: counted, and asks still pending. */
  checks?: { asked: number; denied: number }
  pending?: string[]
  /** The held steps' newest tool lines (three at most), and whether one stopped at the output limit. */
  tools?: string[]
  isCutOff?: true
  /** A completion that also came first, applied right after the card opens. */
  ended?: { reason: string; at: number; turnId: string; usage: EarlyUsage | null; answer?: string }
}

/** The main loop's model and its context window, written together. */
export type Session = {
  model: string
  window: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'agents-panel': {
      agents: AgentRun[]
      panel: Panel
      now: number
      session: Session | null
      lastReconcileAt: number
      early: Record<string, EarlyStep>
    }
  }
}
