/**
 * Agents that run outside the engine, started by a Bash call: an external-model seat
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
  /** The reasoning effort the command names (a Codex `--effort` or `-c model_reasoning_effort=`), when it names one. */
  effort?: string
  /** The file the launcher writes when it ends, absolute, or null when the command does not say. */
  doneFile: string | null
  /** How long the launcher may run before it kills its seat, from its own default when unnamed. */
  timeoutMs: number
  /** A Codex run with no session log of its own: `--ephemeral` writes none, `resume` appends to an older one. */
  noLog?: true
  /** Where a Codex run keeps its state when the command assigns `CODEX_HOME` or the environment has it, absolute. */
  codexHome?: string
  /** A Codex run told to skip the user's config (`--ignore-user-config`): its defaults are not this run's. */
  ignoresConfig?: true
  /** That timeout when the launcher or a wrapper really enforces one; absent when it is only this mod's own bound on a Codex run. */
  capMs?: number
}

/** Past its timeout plus this, a backgrounded row whose done file never landed is lost. */
export const LAUNCH_GRACE_MS = 60_000
// buddy-run.sh's own default (`TIMEOUT_S="${3:-600}"`, read 2026-11-24)
const RUN_DEFAULT_S = 600
const RELAY_DEFAULT_MS = 1_800_000
const RELAY_DEFAULT_MODEL = 'grok-4.7-high'
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

  return { ...launch, timeoutMs, ...(own > 0 || wrap !== null ? { capMs: timeoutMs } : {}) }
}

/** Quoted text blanked to underscores, length kept, so separators and flags count outside quotes only. */
const maskQuotes = (s: string): string => s.replace(/'[^']*'|"[^"]*"/g, q => '_'.repeat(q.length))

/** A shell named at the head of a segment, optionally under a wrapper: what it is handed runs. */
const SHELL_HEAD = /(?:^|[\s;&|(])(?:ba|z|da)?sh(?:\s+-[A-Za-z]+)*\s*$/
const SHELL_C = /(?:^|[\s;&|(])(?:ba|z|da)?sh(?:\s+-[A-Za-z]+)*\s+-[A-Za-z]*c\s+$/

/**
 * Which characters of the command are data rather than shell words: a heredoc body, and
 * quoted text (2026-11-24, when a `pgrep -fl "… codex exec"`, a note appended through a
 * heredoc and a test file's strings each drew a finished Codex card). Left live, because
 * the shell does run them: a heredoc fed to a shell, a shell's `-c` string, and a
 * `$(...)` inside double quotes.
 */
const dataMask = (command: string): boolean[] => {
  const data = new Array<boolean>(command.length).fill(false)
  const heredoc = /(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n/g

  for (let m = heredoc.exec(command); m !== null; m = heredoc.exec(command)) {
    const from = m.index + m[0].length
    const close = new RegExp(`^[ \\t]*${m[2]}[ \\t]*$`, 'm').exec(command.slice(from))
    const to = close === null ? command.length : from + close.index
    const line = command.slice(command.lastIndexOf('\n', m.index) + 1, m.index)

    if (!SHELL_HEAD.test(line.replace(/\s+-s?\s*$/, ''))) {
      data.fill(true, from, to)
    }

    heredoc.lastIndex = to
  }

  const quoted = /'[^']*'|"[^"]*"/g

  for (let m = quoted.exec(command); m !== null; m = quoted.exec(command)) {
    if (data[m.index]) {
      // a quote character inside a heredoc body opens nothing
      quoted.lastIndex = m.index + 1
      continue
    }

    if (SHELL_C.test(command.slice(0, m.index))) {
      continue
    }

    const from = m.index + 1
    const to = m.index + m[0].length - 1
    const sub = m[0][0] === '"' ? /\$\(/.exec(command.slice(from, to)) : null

    // from a `$(` on, the string is a command again (its own inner quotes end this match early)
    data.fill(true, from, sub === null ? to : from + sub.index)
  }

  return data
}

/** A flag or first argument that makes a Codex invocation print and exit: no agent runs. */
const READS_CLI = /^\s*help(?=\s|$)|(?:^|\s)(?:--help|-h|--version|-V)(?=[\s=]|$)/
/** A program that only names the Codex command it is handed (prints, finds, documents it). */
const NAMES_IT = /^\s*(?:echo|printf|which|type|man|whatis|apropos|command\s+-[vV]|grep|egrep|rg)(?:\s|$)/
/**
 * A program that reads, lists or edits a launcher script it is handed rather than running it
 * (2026-11-24, when `sed -n 40,80p .../buddy-run.sh; grep ... relay.mjs | head` drew a buddy seat).
 */
const READS_SCRIPT =
  /^\s*(?:echo|printf|which|type|man|command\s+-[vV]|grep|egrep|rg|sed|awk|cat|head|tail|wc|ls|less|bat|cp|mv|chmod|diff|git|stat|file|touch|shellcheck|open|code|vim?|nano)(?:\s|$)/
/** The ids buddy-run.sh itself accepts: anything else after its name is not a model (a redirect, an unset variable). */
const MODEL_ID = /^[a-z0-9][a-z0-9.+-]*$/

/** The command segment the text at `at` stands in: from the last separator outside quotes. */
const headOf = (command: string, at: number): string => {
  const before = maskQuotes(command).slice(0, at)

  return before.slice(Math.max(...[';', '&', '|', '\n', '('].map(c => before.lastIndexOf(c))) + 1)
}

/** `for NAME in a b c`: the words each loop variable takes, so a launch written once inside a loop is one row per word. */
const loopWords = (command: string): Record<string, string[]> => {
  const out: Record<string, string[]> = {}
  const loop = /(?:^|[\s;&(])for\s+([A-Za-z_]\w*)\s+in\s+([^;\n]+)[;\n]/g

  for (let m = loop.exec(command); m !== null; m = loop.exec(command)) {
    out[m[1]!] = (m[2]!.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote)
  }

  return out
}

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

/**
 * The model and effort a Codex invocation names, read from its arguments up to its
 * command's end (outside quotes): `--model m`, `-m m`, `-c model=m`, `--effort e`, or
 * `-c model_reasoning_effort=e` (bare `codex exec` rejects `--effort`). Either may be absent.
 */
export const codexFlags = (command: string, end: number): { model?: string; effort?: string; ignoresConfig?: true; noLog?: true } => {
  const masked = maskQuotes(command)
  const tail = masked.slice(end)
  const stop = tail.search(/[;&|\n)]/)
  const args = command.slice(end, end + (stop < 0 ? tail.length : stop))
  const live = stop < 0 ? tail : tail.slice(0, stop)
  // a flag counts only where it stands outside quotes; its value may be quoted
  const at = (re: RegExp): string | undefined => {
    const m = re.exec(live)

    return m === null ? undefined : unquote(new RegExp(`^${ARG}`).exec(args.slice(m.index + m[0].length))?.[1] ?? '') || undefined
  }
  // `-c model="m"` is how bare `codex exec` pins one (2026-11-24: a sol run read as the config's astra)
  // found where a `-c` stands outside quotes (a prompt that says `-c model=x` names no model)
  const pinned = (): string | undefined => {
    const flag = /(?:^|\s)-c\s+/g

    for (let m = flag.exec(live); m !== null; m = flag.exec(live)) {
      const value = /^['"]?model\s*=\s*\\?["']?([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(args.slice(m.index + m[0].length))?.[1]

      if (value !== undefined) {
        return value
      }
    }

    return undefined
  }
  const model = at(/(?:^|\s)(?:--model(?:=|\s+)|-m\s+)/) ?? pinned()
  // as for the model: only where its `-c` stands outside quotes (a prompt that says `-c model_reasoning_effort=low` sets none)
  const pinnedEffort = (): string | undefined => {
    const flag = /(?:^|\s)-c\s+/g

    for (let m = flag.exec(live); m !== null; m = flag.exec(live)) {
      const value = /^['"]?model_reasoning_effort\s*=\s*\\?["']?([a-z]+)/.exec(args.slice(m.index + m[0].length))?.[1]

      if (value !== undefined) {
        return value
      }
    }

    return undefined
  }
  const effort = at(/(?:^|\s)--effort(?:=|\s+)/) ?? pinnedEffort()

  // outside quotes only: a prompt that mentions the flag does not set it
  const ignoresConfig = /(?:^|\s)--ignore-user-config(?=\s|$)/.test(live)

  // `--ephemeral` persists no session log; `resume` (the first word after `exec`'s options) continues an older one
  const noLog = /(?:^|\s)--ephemeral(?=\s|$)/.test(live) || /^\s+(?:-\S+\s+)*resume(?=\s|$)/.test(live)

  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(ignoresConfig ? { ignoresConfig: true as const } : {}),
    ...(noLog ? { noLog: true as const } : {}),
  }
}

/** Every external agent the command starts, in the order it names them. */
export const parseLaunches = (raw: string, env: Record<string, string | undefined> = {}): Launch[] => {
  // A backslash at a line's end continues the command: the vendor's own examples write
  // `codex exec \` then its flags, and a newline otherwise ends a command here. Same length, so every index holds.
  const command = raw.replace(/\\\n/g, '  ')
  const resolve = resolver(command, env)
  const found: { at: number; launch: Launch }[] = []
  // not `test-buddy-run.sh`, and not a script something only reads
  const run = new RegExp(`(?<![\\w-])buddy-run\\.sh['"]?\\s+${ARG}\\s+${ARG}(?:\\s+(\\d+))?`, 'g')
  const loops = loopWords(command)
  const data = dataMask(command)
  // a script may stand in a quoted path; what follows its name is a shell word only outside data
  const afterName = (m: RegExpExecArray, name: string): number => m.index + name.length + (/['"]/.test(m[0][name.length] ?? '') ? 1 : 0)

  for (let m = run.exec(command); m !== null; m = run.exec(command)) {
    if (data[afterName(m, 'buddy-run.sh')] || READS_SCRIPT.test(headOf(command, m.index))) {
      continue
    }

    const named = unquote(m[1]!)
    const loopVar = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(named)?.[1]
    const words = loopVar === undefined ? undefined : loops[loopVar]
    // one row per word of a loop the launch stands in; else the one model it names
    const seats =
      words === undefined || loopVar === undefined
        ? [{ model: named, dirOf: resolve }]
        : words.map(w => ({ model: w, dirOf: resolver(command, { ...env, [loopVar]: w }) }))

    for (const seat of seats) {
      if (!MODEL_ID.test(seat.model)) {
        continue
      }

      const dir = seat.dirOf(m[2]!)
      found.push({
        at: m.index,
        launch: {
          type: `buddy:${seat.model}`,
          model: seat.model,
          doneFile: dir === null ? null : `${dir.replace(/\/$/, '')}/meta-${seat.model}.txt`,
          timeoutMs: Number(m[3] ?? RUN_DEFAULT_S) * 1000,
        },
      })
    }
  }

  const relay = /relay\.mjs['"]?((?:\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+))*)/g

  for (let m = relay.exec(command); m !== null; m = relay.exec(command)) {
    if (data[afterName(m, 'relay.mjs')] || READS_SCRIPT.test(headOf(command, m.index))) {
      continue
    }

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

  // the command's own `CODEX_HOME=…`, else the environment's; unsaid when neither names an absolute path
  const codexHome = resolve('$CODEX_HOME')?.replace(/\/+$/, '') ?? null
  const codex = /codex-companion\.mjs['"]?\s+([a-z][a-z-]*)|(?:^|[\s;&|('"])codex\s+(exec|review)(?![\w-])/g

  for (let m = codex.exec(command); m !== null; m = codex.exec(command)) {
    // past a leading separator the match took, so a wrapper is looked for in this command, not the one before
    const at = m.index + (m[1] === undefined && /^[\s;&|('"]/.test(m[0]) ? 1 : 0)

    if (data[m[1] === undefined ? at : afterName(m, 'codex-companion.mjs')] || isInspection(command, at, m.index + m[0].length)) {
      continue
    }

    const flags = codexFlags(command, m.index + m[0].length)
    found.push({
      at,
      launch: {
        type: `codex:${m[1] ?? m[2]}`,
        model: flags.model ?? 'codex',
        ...(flags.effort === undefined ? {} : { effort: flags.effort }),
        ...(flags.ignoresConfig === true ? { ignoresConfig: true as const } : {}),
        ...(flags.noLog === true ? { noLog: true as const } : {}),
        ...(codexHome === null ? {} : { codexHome }),
        doneFile: null,
        timeoutMs: 0,
      },
    })
  }

  return found.sort((a, b) => a.at - b.at).map(f => withWrapper(command, f.at, f.launch))
}

/** The exit code buddy-run wrote to its done file (`EXIT:<code>`; 124 is its timeout), or null when the file names none. */
export const doneExit = (text: string): number | null => {
  const code = /^EXIT:(\d+)/m.exec(text)?.[1]

  return code === undefined ? null : Number(code)
}

/**
 * The tokens a finished seat used, from the `USAGE:{...}` line buddy-run writes under its
 * exit code: input plus output; null when the file carries no such line or no counts.
 */
export const doneTokens = (text: string): number | null => {
  const raw = /^USAGE:(\{.*\})\s*$/m.exec(text)?.[1]

  if (raw === undefined) {
    return null
  }

  try {
    const u = JSON.parse(raw) as { tokens_in?: unknown; tokens_out?: unknown }
    const n = (typeof u.tokens_in === 'number' ? u.tokens_in : 0) + (typeof u.tokens_out === 'number' ? u.tokens_out : 0)

    return n > 0 ? n : null
  } catch {
    return null
  }
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
