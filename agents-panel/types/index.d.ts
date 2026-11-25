/** `stopped`: the person or the engine stopped the run (agent.report `stopped`, or `killed` in $.agent.list()). */
export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped' | 'lost'

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
  /**
   * Set while contextTokens came from a completion's usage (a turn's requests summed),
   * not from one request: no context percent is drawn from it. A real step clears it.
   */
  contextIsSum?: true
  /**
   * Set when the run's end came from the engine's report (agent.report), the engine's
   * own word on it: the agent list's `killed` does not override it. Cleared when the row
   * runs again.
   */
  isReported?: true
  /** The context window of the model it runs on, as $.agent.list() reports it (Claude Code 2.1.326+). */
  window?: number
  /** What /cost credited for its requests, an estimate, as $.agent.list() reports it. */
  usd?: number
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
  external?: {
    doneFile: string | null
    deadline: number | null
    taskId?: string
    /** The launch's own timeout (the launcher's or a wrapper's), which the card's bar runs against; absent when none is known. */
    capMs?: number
    /** What it used once it ended: a buddy seat's from its done file, a Codex run's from its session log. Absent until read. */
    tokens?: number
    /** The exit code its done file named (124 is the launcher's timeout). */
    exit?: number
    /** The Codex session log its tokens were read from, so two runs never read the same one. */
    log?: string
    /** Where this Codex run keeps its state when the command or the environment names it (`CODEX_HOME`); absent, `~/.codex`. */
    codexHome?: string
    /** A Codex run with no session log of its own to read (`--ephemeral` writes none, `resume` appends to an older one). */
    noLog?: true
  }
  /**
   * Set on a subagent that hands its work to Codex (codex-rescue): the model and effort its
   * Codex call runs at, from the call's flags, else ~/.codex/config.toml. The card shows these
   * in place of the subagent's own Claude model, which only relays.
   */
  codex?: { model: string; effort?: string }
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
  /** Every finished card listed; absent or false, finished runs are summarised one row per vendor and model (0.8.0). */
  showsEachDone?: boolean
}

/**
 * Codex's rate-limit windows (two, or one on some plans) as percent used when last read, each with the time (ms) its
 * window resets when the log names one (past that time the figure read is no longer true)
 * and the window's length in minutes when the log names it (300 is the 5h window, 10080 the 7d).
 */
export type CodexLimits = {
  primary: number
  /** Absent on a plan with one window; a lone window is always `primary` here, whichever slot the log had it in. */
  secondary?: number
  primaryResetsAt?: number
  secondaryResetsAt?: number
  primaryMinutes?: number
  secondaryMinutes?: number
}

/**
 * What the vendors behind the external seats have used, as of the last read. `codex` is the
 * account's own rate-limit windows, percent used; `cursor` and `antigravity` are this machine's
 * consult-ledger tokens for the local day `day` starts, not a vendor quota.
 */
export type Usage = {
  day: number
  codex?: CodexLimits
  cursor?: number
  antigravity?: number
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
  /** How the engine reported the run ended, when that came before the card too. */
  reported?: { status: 'completed' | 'failed' | 'stopped'; at: number }
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
      usage: Usage | null
    }
  }
}
