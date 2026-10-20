import { expect, test } from 'claude-code/testing'

import { CODEX_DEFAULT_MS, doneStatus, parseLaunches, parseNotifications, wrapperTimeoutMs } from '../hooks/launches'

const RUN = '~/bin/buddy-run.sh'
const RELAY = 'node ~/bin/relay.mjs'
const ENV = { HOME: '/Users/x' }

test('launches: buddy-run names the model, its meta file and its timeout', async () => {
  expect(parseLaunches(`${RUN} kimi-k3-high /tmp/p/q 600`, ENV)).toEqual([
    { type: 'buddy:kimi-k3-high', model: 'kimi-k3-high', doneFile: '/tmp/p/q/meta-kimi-k3-high.txt', timeoutMs: 600_000 },
  ])
  // The launcher's default timeout; a trailing slash and quotes come off.
  expect(parseLaunches(`bash ${RUN} "grok-4.7-high" '/tmp/p/'`, ENV)[0]).toMatchObject({
    doneFile: '/tmp/p/meta-grok-4.7-high.txt',
    timeoutMs: 300_000,
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

test('launches: relay takes --model, else its kimi default, else cursor under a lane config; --out-dir names result.json', async () => {
  expect(parseLaunches(`${RELAY} --workspace /w --brief-file /w/b.md`, ENV)).toEqual([
    { type: 'buddy:kimi-k3-high', model: 'kimi-k3-high', doneFile: null, timeoutMs: 1_800_000 },
  ])
  expect(parseLaunches(`${RELAY} --workspace /w --model grok-4.7-high --out-dir /o --timeout 60000`, ENV)).toEqual([
    { type: 'buddy:grok-4.7-high', model: 'grok-4.7-high', doneFile: '/o/result.json', timeoutMs: 60_000 },
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
    { type: 'codex:exec', model: 'codex', doneFile: null, timeoutMs: 1_800_000 },
  ])
})
