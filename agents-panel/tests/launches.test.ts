import { expect, test } from 'claude-code/testing'

import { CODEX_DEFAULT_MS, doneExit, doneStatus, doneTokens, parseLaunches, parseNotifications, wrapperTimeoutMs } from '../hooks/launches'

const RUN = '~/bin/buddy-run.sh'
const RELAY = 'node ~/bin/relay.mjs'
const ENV = { HOME: '/Users/x' }

test('launches: buddy-run names the model, its meta file and its timeout', async () => {
  expect(parseLaunches(`${RUN} kimi-k3-high /tmp/p/q 600`, ENV)).toEqual([
    { type: 'buddy:kimi-k3-high', model: 'kimi-k3-high', doneFile: '/tmp/p/q/meta-kimi-k3-high.txt', timeoutMs: 600_000, capMs: 600_000 },
  ])
  // The launcher's default timeout; a trailing slash and quotes come off.
  expect(parseLaunches(`bash ${RUN} "grok-4.7-high" '/tmp/p/'`, ENV)[0]).toMatchObject({
    doneFile: '/tmp/p/meta-grok-4.7-high.txt',
    timeoutMs: 600_000,
  })
})

test('launches: the dir resolves from assignments earlier in the command, env and ~; anything else gives no done file', async () => {
  expect(parseLaunches(`P=/tmp/panel; ${RUN} kimi-k3-high "$P" 300`, ENV)[0]!.doneFile).toBe('/tmp/panel/meta-kimi-k3-high.txt')
  expect(parseLaunches(`T="$HOME/s"; ${RUN} kimi-k3-high \${T}/one`, ENV)[0]!.doneFile).toBe('/Users/x/s/one/meta-kimi-k3-high.txt')
  expect(parseLaunches(`${RUN} kimi-k3-high ~/p`, ENV)[0]!.doneFile).toBe('/Users/x/p/meta-kimi-k3-high.txt')
  expect(parseLaunches(`${RUN} kimi-k3-high "$UNSET"`, ENV)[0]!.doneFile).toBeNull()
  expect(parseLaunches(`${RUN} kimi-k3-high relative/dir`, ENV)[0]!.doneFile).toBeNull()
  expect(parseLaunches(`${RUN} kimi-k3-high "$(mktemp -d)"`, ENV)[0]!.doneFile).toBeNull()
})

test('launches: relay takes --model, else its grok default, else cursor under a lane config; --out-dir names result.json', async () => {
  expect(parseLaunches(`${RELAY} --workspace /w --brief-file /w/b.md`, ENV)).toEqual([
    { type: 'buddy:grok-4.7-high', model: 'grok-4.7-high', doneFile: null, timeoutMs: 1_800_000, capMs: 1_800_000 },
  ])
  expect(parseLaunches(`${RELAY} --workspace /w --model grok-4.7-high --out-dir /o --timeout 60000`, ENV)).toEqual([
    { type: 'buddy:grok-4.7-high', model: 'grok-4.7-high', doneFile: '/o/result.json', timeoutMs: 60_000, capMs: 60_000 },
  ])
  expect(parseLaunches(`${RELAY} --workspace /w --repo /r`, ENV)[0]!.model).toBe('cursor')
})

test('launches: Codex runs by companion verb or codex exec; a mention of codex is not a run', async () => {
  expect(parseLaunches('node "/p/codex/1.0.6/scripts/codex-companion.mjs" review "--base main"', ENV)).toEqual([
    // no timeout of its own and no wrapper: Codex's default bounds it
    { type: 'codex:review', model: 'codex', doneFile: null, timeoutMs: CODEX_DEFAULT_MS },
  ])
  expect(parseLaunches('codex exec --cd /r "explain" </dev/null', ENV)[0]!.type).toBe('codex:exec')
  expect(parseLaunches('grep -rn codex ~/bin; echo codex', ENV)).toEqual([])
  // the model and effort the command names, outside quotes; a prompt's words are not flags
  expect(parseLaunches('node /p/codex-companion.mjs task --effort high --model gpt-6.2-astra "use --effort low"', ENV)[0]).toMatchObject({
    model: 'gpt-6.2-astra',
    effort: 'high',
  })
  expect(parseLaunches(`codex exec -c model_reasoning_effort="medium" -m o9 "go" </dev/null`, ENV)[0]).toMatchObject({ model: 'o9', effort: 'medium' })
  expect(parseLaunches('codex exec "go --model x"; echo --effort low', ENV)[0]).toEqual({ type: 'codex:exec', model: 'codex', doneFile: null, timeoutMs: CODEX_DEFAULT_MS })
  expect(parseLaunches('git status', ENV)).toEqual([])
})

test('launches: several seats in one command come back in order', async () => {
  const cmd = `P=/tmp/p; ${RUN} grok-4.7-high $P & ${RUN} kimi-k3-high $P & ${RUN} gemini-3.1-pro $P & wait`
  expect(parseLaunches(cmd, ENV).map(l => l.model)).toEqual(['grok-4.7-high', 'kimi-k3-high', 'gemini-3.1-pro'])
})

test('launches: the done file decides done or failed by EXIT', async () => {
  expect(doneStatus('EXIT:0\nUSAGE:12k')).toBe('done')
  expect(doneStatus('EXIT:124')).toBe('failed')
  expect(doneStatus('{"ok":true}')).toBe('done')
})

test('notifications: each block gives its call and status; a block missing either, or plain text, gives nothing', async () => {
  const one = (id: string, status: string) =>
    `<task-notification>\n<task-id>b</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>/t/b.output</output-file>\n<status>${status}</status>\n<summary>x</summary>\n</task-notification>`
  expect(parseNotifications(`${one('toolu_1', 'completed')}\n${one('toolu_2', 'failed')}`)).toEqual([
    { toolUseId: 'toolu_1', status: 'completed' },
    { toolUseId: 'toolu_2', status: 'failed' },
  ])
  expect(parseNotifications('<task-notification><task-id>b</task-id><status>completed</status></task-notification>')).toEqual([])
  expect(parseNotifications('a <task-notification> arrives when the workflow completes')).toEqual([])
})

test('launches: a timeout wrapper bounds the launch it wraps, and only that one', async () => {
  // coreutils timeout with -k, before codex exec (the shape that got stuck on 2026-10-10)
  expect(parseLaunches('timeout -k 10 900 codex exec -c x --json "go" < /dev/null > e.jsonl', ENV)[0]!.timeoutMs).toBe(900_000)
  // units, gtimeout, other flags
  expect(parseLaunches('gtimeout --preserve-status 5m codex exec "go"', ENV)[0]!.timeoutMs).toBe(300_000)
  expect(parseLaunches("timeout -s KILL 1.5h codex exec go", ENV)[0]!.timeoutMs).toBe(5_400_000)
  // perl's alarm wrapper
  expect(parseLaunches("perl -e 'alarm shift; exec @ARGV' 120 codex exec go", ENV)[0]!.timeoutMs).toBe(120_000)
  // a wrapper through env, before a buddy seat: the shorter of the two
  expect(parseLaunches(`timeout -k 10 650 env BUDDY_SKILL=x ${RUN} kimi-k3-high /tmp/p 600`, ENV)[0]!.timeoutMs).toBe(600_000)
  expect(parseLaunches(`timeout 120 env X=1 ${RUN} kimi-k3-high /tmp/p 600`, ENV)[0]!.timeoutMs).toBe(120_000)
  // a wrapper on the command before is not this launch's
  expect(parseLaunches('timeout 30 git fetch; codex exec go', ENV)[0]!.timeoutMs).toBe(CODEX_DEFAULT_MS)
  expect(parseLaunches('timeout 30 git fetch && codex exec go', ENV)[0]!.timeoutMs).toBe(CODEX_DEFAULT_MS)
  expect(wrapperTimeoutMs('sleep 1 | codex exec', 10)).toBeNull()
})

test('launches: a codex invocation that only reads the CLI (help, version, inside a pipeline) is not a run', async () => {
  // 2026-10-12: `codex exec --help 2>&1 | grep ...` showed as a finished agent
  expect(parseLaunches('codex exec --help 2>&1 | grep -E "effort|sandbox"', ENV)).toEqual([])
  expect(parseLaunches('codex exec -h', ENV)).toEqual([])
  expect(parseLaunches('codex --version && codex exec --version', ENV)).toEqual([])
  expect(parseLaunches('codex review --help | head -40', ENV)).toEqual([])
  expect(parseLaunches('codex exec help', ENV)).toEqual([])
  expect(parseLaunches('node /p/codex-companion.mjs review --help', ENV)).toEqual([])
  // naming the command to another program is a mention, not a run
  expect(parseLaunches('echo codex exec go; which codex exec; man codex exec', ENV)).toEqual([])
  // a real run stays one, even when its quoted prompt says --help, and beside a help lookup
  expect(parseLaunches('codex exec "document the --help output" < /dev/null', ENV).map(l => l.type)).toEqual(['codex:exec'])
  expect(parseLaunches('codex exec --help >/dev/null; timeout -k 10 1800 codex exec --cd /s -o /s/o.md "go" < /dev/null > /s/log 2>&1', ENV)).toEqual([
    { type: 'codex:exec', model: 'codex', doneFile: null, timeoutMs: 1_800_000, capMs: 1_800_000 },
  ])
})

test('launches: a launch named inside quoted text or a heredoc body is data, not a run', async () => {
  // 2026-11-24: six of eight live cards were status checks and notes that only mentioned a run
  expect(parseLaunches('pgrep -fl "buddy-run.sh grok-4.7-medium-fast|codex exec -c" | cut -c1-160', ENV)).toEqual([])
  expect(parseLaunches('pgrep -fl "timeout -k 10 600 codex exec" | cut -c1-80', ENV)).toEqual([])
  expect(parseLaunches("pgrep -fl 'buddy-run.sh grok-4.7-high /tmp/p 600'", ENV)).toEqual([])
  expect(parseLaunches('pgrep -f "node /p/codex-companion.mjs task"; pgrep -f "relay.mjs --model kimi"', ENV)).toEqual([])
  expect(parseLaunches("cat >> notes.md <<'EOF'\nran it as codex exec with both pins\n~/bin/buddy-run.sh grok-4.7-high /tmp/p 600\nEOF\necho ok", ENV)).toEqual([])
  expect(parseLaunches('cat > probe.ts <<EOF\nconst c = `codex exec go`\nEOF\nnode probe.ts', ENV)).toEqual([])
  expect(parseLaunches('record.py append --text "launched codex exec with it\'s pins; codex review next"', ENV)).toEqual([])
  // a real run stays one: a quoted script path, a shell's -c string, a $(...) capture, a shell's heredoc, a run after a heredoc
  expect(parseLaunches('"/Users/x/bin/buddy-run.sh" grok-4.7-high /tmp/p 300', ENV).map(l => l.type)).toEqual(['buddy:grok-4.7-high'])
  expect(parseLaunches('node "/p/codex-companion.mjs" task "go"', ENV).map(l => l.type)).toEqual(['codex:task'])
  expect(parseLaunches('bash -lc "codex exec go"', ENV).map(l => l.type)).toEqual(['codex:exec'])
  expect(parseLaunches('OUT="$(codex exec "go" </dev/null)"', ENV).map(l => l.type)).toEqual(['codex:exec'])
  expect(parseLaunches("bash <<'EOF'\ncodex exec go\nEOF", ENV).map(l => l.type)).toEqual(['codex:exec'])
  expect(parseLaunches("cat > q.md <<'EOF'\nabout codex exec\nEOF\ncodex exec - < q.md", ENV).map(l => l.type)).toEqual(['codex:exec'])
})

test('launches: a Codex run pinned with -c model= reads that model, not the config default', async () => {
  const cmd = `codex exec --json -c 'model="gpt-6.2-sol"' -c 'model_reasoning_effort="low"' "go" < /dev/null`
  expect(parseLaunches(cmd, ENV)[0]).toMatchObject({ type: 'codex:exec', model: 'gpt-6.2-sol', effort: 'low' })
  expect(parseLaunches('codex exec -c model="gpt-6.2-astra" "go"', ENV)[0]!.model).toBe('gpt-6.2-astra')
  // the effort key is not a model, and a model named inside the prompt is not a flag
  expect(parseLaunches(`codex exec -c 'model_reasoning_effort="high"' "use -c model=x"`, ENV)[0]).toMatchObject({ model: 'codex', effort: 'high' })
  // only a launcher's or a wrapper's own timeout is a cap the card can run a bar against
  expect(parseLaunches('codex exec "go"', ENV)[0]!.capMs).toBeUndefined()
  expect(parseLaunches('timeout 600 codex exec "go"', ENV)[0]!.capMs).toBe(600_000)
})

test('launches: a continued line is one command; exec-server is not exec; a prompt that quotes an effort flag sets none', async () => {
  // 2026-11-24 doc review: the vendor's own examples continue `codex exec` over lines with a backslash
  expect(parseLaunches('timeout -k 10 900 \\\n  codex exec \\\n  -c \'model="gpt-6.2-astra"\' \\\n  -c model_reasoning_effort="high" "go" </dev/null', ENV)).toEqual([
    { type: 'codex:exec', model: 'gpt-6.2-astra', effort: 'high', doneFile: null, timeoutMs: 900_000, capMs: 900_000 },
  ])
  expect(parseLaunches('codex exec \\\n  --help', ENV)).toEqual([])
  expect(parseLaunches(`${RUN} \\\n  kimi-k3-high /tmp/p \\\n  300`, ENV)).toMatchObject([{ type: 'buddy:kimi-k3-high', timeoutMs: 300_000 }])
  // `codex exec-server` is another program's verb, not a run of `exec`
  expect(parseLaunches('codex exec-server --remote', ENV)).toEqual([])
  expect(parseLaunches('codex review-queue', ENV)).toEqual([])
  // an effort named inside the prompt is prose
  expect(parseLaunches('codex exec "investigate why -c model_reasoning_effort=low is slow" </dev/null', ENV)[0]!.effort).toBeUndefined()
  expect(parseLaunches(`codex exec -c 'model_reasoning_effort="high"' "say -c model_reasoning_effort=low"`, ENV)[0]!.effort).toBe('high')
})

test('launches: a run with no session log of its own says so, and a CODEX_HOME names where its log is', async () => {
  // `--ephemeral` writes no log and `resume` appends to an older one: matching by start time would read a neighbour's
  expect(parseLaunches('codex exec --ephemeral "go" </dev/null', ENV)[0]).toMatchObject({ type: 'codex:exec', noLog: true })
  expect(parseLaunches('codex exec resume --last "next step" </dev/null', ENV)[0]).toMatchObject({ type: 'codex:exec', noLog: true })
  expect(parseLaunches('codex exec resume 01a210b4-2075-7640-818d-35320e872e8d "go"', ENV)[0]!.noLog).toBe(true)
  expect(parseLaunches('codex exec "resume the --ephemeral work" </dev/null', ENV)[0]!.noLog).toBeUndefined()
  expect(parseLaunches('codex exec "go" </dev/null', ENV)[0]!.noLog).toBeUndefined()
  // where the run keeps its state: the command's own assignment, else the environment's, else unsaid
  expect(parseLaunches('CODEX_HOME=/tmp/cx codex exec "go"', ENV)[0]!.codexHome).toBe('/tmp/cx')
  expect(parseLaunches('codex exec "go"', { ...ENV, CODEX_HOME: '/opt/cx' })[0]!.codexHome).toBe('/opt/cx')
  expect(parseLaunches('codex exec "go"', ENV)[0]!.codexHome).toBeUndefined()
})

test('launches: a Codex run that skips the user config says so, so the card does not borrow its defaults', async () => {
  expect(parseLaunches('codex exec --ignore-user-config "go" </dev/null', ENV)[0]).toMatchObject({ type: 'codex:exec', model: 'codex', ignoresConfig: true })
  // a prompt that mentions the flag does not set it
  expect(parseLaunches('codex exec "explain --ignore-user-config" </dev/null', ENV)[0]!.ignoresConfig).toBeUndefined()
  expect(parseLaunches('codex exec "go" </dev/null', ENV)[0]!.ignoresConfig).toBeUndefined()
})

test('launches: a command that only reads or tests a launcher script starts no seat', async () => {
  // 2026-11-24: each of these drew a buddy seat in the pane
  expect(parseLaunches(`sed -n 40,80p ${RUN}; grep -n -i -E 'effort|model' ${RELAY} | head -30`, ENV)).toEqual([])
  expect(parseLaunches(`bash skills/buddy-panel/scripts/test-buddy-run.sh > /tmp/out.txt 2>&1; echo "RC=$?"`, ENV)).toEqual([])
  expect(parseLaunches(`cat ${RUN} | head -5`, ENV)).toEqual([])
  // a reader handed the script and two more words: the run pattern matches, the reader is what stops it
  expect(parseLaunches(`wc -l ${RUN} grok-4.7-high /tmp/p`, ENV)).toEqual([])
  expect(parseLaunches(`grep -n TIMEOUT_S ${RUN} test-buddy-run.sh relay.mjs`, ENV)).toEqual([])
  expect(parseLaunches(`chmod +x ${RELAY} && git diff -- ${RUN}`, ENV)).toEqual([])
  // what follows the name is not a model id: a redirect, an unset variable
  expect(parseLaunches(`${RUN} > /tmp/log 2>&1`, ENV)).toEqual([])
  expect(parseLaunches(`${RUN} "$m" "$d" 170`, ENV)).toEqual([])
  // a real launch on the same line as a read is still one
  expect(parseLaunches(`cat ${RUN} >/dev/null; ${RUN} kimi-k3-high /tmp/p 600`, ENV).map(l => l.model)).toEqual(['kimi-k3-high'])
})

test('launches: a launch written once inside a for loop is one seat per word, each with its own done file', async () => {
  const cmd = `B=/tmp/s; for m in grok-4.7-medium-fast agy-gemini-4-neon-medium; do d="$B/bd-$m"; mkdir -p "$d"; timeout -k 10 200 ${RUN} "$m" "$d" 170 > "$d/out.txt"; done`
  expect(parseLaunches(cmd, ENV)).toEqual([
    { type: 'buddy:grok-4.7-medium-fast', model: 'grok-4.7-medium-fast', doneFile: '/tmp/s/bd-grok-4.7-medium-fast/meta-grok-4.7-medium-fast.txt', timeoutMs: 170_000, capMs: 170_000 },
    { type: 'buddy:agy-gemini-4-neon-medium', model: 'agy-gemini-4-neon-medium', doneFile: '/tmp/s/bd-agy-gemini-4-neon-medium/meta-agy-gemini-4-neon-medium.txt', timeoutMs: 170_000, capMs: 170_000 },
  ])
})

test('launches: the done file gives the exit code and the tokens the seat used', async () => {
  const meta = 'EXIT:0\nUSAGE:{"tokens_in": 27250, "tokens_out": 5148, "cache_read": 13504, "cache_write": 0, "duration_ms": 35841, "is_error": false}\n'
  expect(doneExit(meta)).toBe(0)
  expect(doneTokens(meta)).toBe(32_398)
  expect(doneExit('EXIT:124\nPROGRESS:{"events":3}\n')).toBe(124)
  expect(doneTokens('EXIT:124\n')).toBeNull()
  expect(doneExit('{"ok":true}')).toBeNull()
  expect(doneTokens('EXIT:0\nUSAGE:{not json}\n')).toBeNull()
  expect(doneTokens('EXIT:0\nUSAGE:{"tokens_in": 0, "tokens_out": 0}\n')).toBeNull()
})
