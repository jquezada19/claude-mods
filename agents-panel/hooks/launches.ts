/**
 * Agents that run outside the engine, started by a Bash call: a Cursor buddy seat
 * (buddy-run.sh, relay.mjs) or a Codex run (codex-companion.mjs, `codex exec`).
 * The engine never lists them, so their rows open on the call and close on its
 * result, or, for a backgrounded call, on its task notification or when the
 * launcher's own done file lands, whichever comes first.
 */
export type Launch = {
  /** `buddy:<model>` or `codex:<verb>`; the costume reads it. */
  type: string
  /** The model as the command names it; `codex` when the command names none. */
  model: string
  /** The file the launcher writes when it ends, absolute, or null when the command does not say. */
  doneFile: string | null
  /** How long the launcher may run before it kills its seat, from its own default when unnamed. */
  timeoutMs: number
}

/** Past its timeout plus this, a backgrounded row whose done file never landed is lost. */
export const LAUNCH_GRACE_MS = 60_000
const RUN_DEFAULT_S = 300
const RELAY_DEFAULT_MS = 1_800_000
const RELAY_DEFAULT_MODEL = 'kimi-k3-high'
/**
 * A Codex run names no timeout of its own; without a wrapper's, its row is lost
 * past this rather than running forever when its notification never comes.
 */
export const CODEX_DEFAULT_MS = 3_600_000
const UNIT_S: Record<string, number> = { '': 1, s: 1, m: 60, h: 3_600, d: 86_400 }

const unquote = (s: string): string => s.replace(/^(['"])(.*)\1$/, '$2')

/**
 * `NAME=value` assignments earlier in the command, then `$NAME`, `${NAME}` and a
 * leading `~` expanded from them and from env; null when anything is left unresolved.
 */
const resolver = (command: string, env: Record<string, string | undefined>) => {
  const vars: Record<string, string> = {}
  const assign = /(?:^|[\s;&(])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g

  for (let m = assign.exec(command); m !== null; m = assign.exec(command)) {
    vars[m[1]!] = unquote(m[2]!)
  }

  const lookup = (name: string): string | undefined => vars[name] ?? env[name]

  return (raw: string): string | null => {
    let s = unquote(raw)

    if (s === '~' || s.startsWith('~/')) {
      const home = lookup('HOME')

      if (home === undefined) {
        return null
      }

      s = home + s.slice(1)
    }

    for (let i = 0; i < 4 && s.includes('$'); i += 1) {
      s = s.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (whole, a?: string, b?: string) => lookup(a ?? b ?? '') ?? whole)
    }

    return s.includes('$') || s.includes('`') || !s.startsWith('/') ? null : s
  }
}

const ARG = `("[^"]*"|'[^']*'|[^\\s;&|]+)`

/**
 * The timeout a wrapper puts on the launch at `at`: coreutils `timeout [-k N]
 * [-s SIG] DURATION` (or `gtimeout`), or `perl -e 'alarm shift; exec @ARGV' S`,
 * in the same command segment before it; null when none does.
 */
export const wrapperTimeoutMs = (command: string, at: number): number | null => {
  const before = command.slice(0, at)
  // separators count outside quotes only (perl's 'alarm shift; exec @ARGV' holds a ;)
  const masked = maskQuotes(before)
  const cut = Math.max(...[';', '&', '|', '\n', '('].map(c => masked.lastIndexOf(c)))
  const segment = before.slice(cut + 1)
  const coreutils = /(?:^|\s)g?timeout\s+(?:(?:-[ks]\s+\S+|--(?:kill-after|signal)=\S+|--[a-z-]+)\s+)*(\d+(?:\.\d+)?)([smhd]?)(?=\s)/.exec(segment)

  if (coreutils !== null) {
    return Math.round(Number(coreutils[1]) * UNIT_S[coreutils[2] ?? '']! * 1000)
  }

  const perl = /alarm shift[^'"]*['"]\s+(\d+)(?=\s)/.exec(segment)

  return perl === null ? null : Number(perl[1]) * 1000
}

/**
 * The launch's timeout: the shorter of its own and a wrapper's when both are
 * known, else whichever is, else CODEX_DEFAULT_MS for a Codex run (0, no
 * deadline, for a buddy seat with neither, which its own default always covers).
 */
const withWrapper = (command: string, at: number, launch: Launch): Launch => {
  const wrap = wrapperTimeoutMs(command, at)
  const own = launch.timeoutMs
  const timeoutMs =
    own > 0 && wrap !== null ? Math.min(own, wrap) : own > 0 ? own : wrap !== null ? wrap : launch.type.startsWith('codex:') ? CODEX_DEFAULT_MS : 0

  return { ...launch, timeoutMs }
}

/** Quoted text blanked to underscores, length kept, so separators and flags count outside quotes only. */
const maskQuotes = (s: string): string => s.replace(/'[^']*'|"[^"]*"/g, q => '_'.repeat(q.length))

/** A flag or first argument that makes a Codex invocation print and exit: no agent runs. */
const READS_CLI = /^\s*help(?=\s|$)|(?:^|\s)(?:--help|-h|--version|-V)(?=[\s=]|$)/
/** A program that only names the Codex command it is handed (prints, finds, documents it). */
const NAMES_IT = /^\s*(?:echo|printf|which|type|man|whatis|apropos|command\s+-[vV]|grep|egrep|rg)(?:\s|$)/

/**
 * Whether the Codex invocation between `at` and `end` (its verb's end) is only a look at
 * the CLI: `--help`, `-h`, `--version`, `-V` or a `help` argument before its command ends,
 * or a program like `echo` or `which` at the head of its command (2026-10-12, when
 * `codex exec --help | grep ...` showed as a finished agent).
 */
const isInspection = (command: string, at: number, end: number): boolean => {
  const masked = maskQuotes(command)
  const tail = masked.slice(end)
  const stop = tail.search(/[;&|\n)]/)
  const args = stop < 0 ? tail : tail.slice(0, stop)
  const before = masked.slice(0, at)
  const head = before.slice(Math.max(...[';', '&', '|', '\n', '('].map(c => before.lastIndexOf(c))) + 1)

  return READS_CLI.test(args) || NAMES_IT.test(head)
}

/** Every external agent the command starts, in the order it names them. */
export const parseLaunches = (command: string, env: Record<string, string | undefined> = {}): Launch[] => {
  const resolve = resolver(command, env)
  const found: { at: number; launch: Launch }[] = []
  const run = new RegExp(`buddy-run\\.sh['"]?\\s+${ARG}\\s+${ARG}(?:\\s+(\\d+))?`, 'g')

  for (let m = run.exec(command); m !== null; m = run.exec(command)) {
    const model = unquote(m[1]!)
    const dir = resolve(m[2]!)
    found.push({
      at: m.index,
      launch: {
        type: `buddy:${model}`,
        model,
        doneFile: dir === null ? null : `${dir.replace(/\/$/, '')}/meta-${model}.txt`,
        timeoutMs: Number(m[3] ?? RUN_DEFAULT_S) * 1000,
      },
    })
  }

  const relay = /relay\.mjs['"]?((?:\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+))*)/g

  for (let m = relay.exec(command); m !== null; m = relay.exec(command)) {
    const args = m[1] ?? ''
    const flag = (name: string): string | undefined => new RegExp(`--${name}(?:=|\\s+)${ARG}`).exec(args)?.[1]
    const named = flag('model')
    // With --repo, an approved lane config may pick the model; the command alone cannot say which.
    const model = named !== undefined ? unquote(named) : /--repo\b/.test(args) ? 'cursor' : RELAY_DEFAULT_MODEL
    const out = flag('out-dir')
    const dir = out === undefined ? null : resolve(out)
    found.push({
      at: m.index,
      launch: {
        type: `buddy:${model}`,
        model,
        doneFile: dir === null ? null : `${dir.replace(/\/$/, '')}/result.json`,
        timeoutMs: Number(flag('timeout') ?? RELAY_DEFAULT_MS),
      },
    })
  }

  const codex = /codex-companion\.mjs['"]?\s+([a-z][a-z-]*)|(?:^|[\s;&|(])codex\s+(exec|review)\b/g

  for (let m = codex.exec(command); m !== null; m = codex.exec(command)) {
    // past a leading separator the match took, so a wrapper is looked for in this command, not the one before
    const at = m.index + (m[1] === undefined && /^[\s;&|(]/.test(m[0]) ? 1 : 0)

    if (isInspection(command, at, m.index + m[0].length)) {
      continue
    }

    found.push({ at, launch: { type: `codex:${m[1] ?? m[2]}`, model: 'codex', doneFile: null, timeoutMs: 0 } })
  }

  return found.sort((a, b) => a.at - b.at).map(f => withWrapper(command, f.at, f.launch))
}

/** The launcher's verdict from its done file: buddy-run writes `EXIT:<code>`; anything else that landed is a finish. */
export const doneStatus = (text: string): 'done' | 'failed' => {
  const code = /^EXIT:(\d+)/m.exec(text)?.[1]

  return code === undefined || code === '0' ? 'done' : 'failed'
}

/**
 * Every background task a notification reports over: the call that started it and how it
 * ended (`completed`, `failed`, `killed`). The text is the notification as it entered.
 */
export const parseNotifications = (text: string): { toolUseId: string; status: string }[] => {
  const out: { toolUseId: string; status: string }[] = []
  const block = /<task-notification>([\s\S]*?)<\/task-notification>/g

  for (let m = block.exec(text); m !== null; m = block.exec(text)) {
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(m[1]!)?.[1]?.trim()
    const status = /<status>([^<]+)<\/status>/.exec(m[1]!)?.[1]?.trim()

    if (id !== undefined && status !== undefined) {
      out.push({ toolUseId: id, status })
    }
  }

  return out
}
