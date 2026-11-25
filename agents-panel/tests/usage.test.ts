import { expect, test } from 'claude-code/testing'

import { codexDayDir, codexHomeOf, dayStart, mergeUsage, newestWritten, parseCodexTail, parseLedger, pickRollout, rolloutStart } from '../hooks/usage'

const at = (h: number, m: number, s: number): number => new Date(2026, 10, 24, h, m, s).getTime()

test('usage: a Codex session log is found by the local day and the time in its name', async () => {
  expect(codexDayDir('/Users/x/.codex', at(20, 38, 26))).toBe('/Users/x/.codex/sessions/2026/11/24')
  expect(codexDayDir('/Users/x/.codex', new Date(2026, 0, 5, 1, 0, 0).getTime())).toBe('/Users/x/.codex/sessions/2026/01/05')
  // Codex keeps its state under CODEX_HOME when that is set, else ~/.codex
  expect(codexHomeOf({ HOME: '/Users/x' })).toBe('/Users/x/.codex')
  expect(codexHomeOf({ HOME: '/Users/x', CODEX_HOME: '/tmp/cx/' })).toBe('/tmp/cx')
  expect(codexHomeOf({ HOME: '/Users/x', CODEX_HOME: '' })).toBe('/Users/x/.codex')
  expect(codexHomeOf({})).toBeNull()
  // the log to read the account's limits from is the one written last, not the one started last
  expect(newestWritten([{ name: 'rollout-2026-11-24T20-00-00-a.jsonl', mtimeMs: 900 }, { name: 'rollout-2026-11-24T21-00-00-b.jsonl', mtimeMs: 500 }, { name: 'notes.txt', mtimeMs: 999 }])).toBe('rollout-2026-11-24T20-00-00-a.jsonl')
  expect(newestWritten([{ name: 'rollout-2026-11-24T20-00-00-a.jsonl' }, { name: 'rollout-2026-11-24T21-00-00-b.jsonl' }])).toBe('rollout-2026-11-24T21-00-00-b.jsonl')
  expect(newestWritten([])).toBeNull()
  expect(rolloutStart('rollout-2026-11-24T20-38-26-01a21091-9245.jsonl')).toBe(at(20, 38, 26))
  expect(rolloutStart('notes.txt')).toBeNull()
  const names = ['rollout-2026-11-24T20-30-00-a.jsonl', 'rollout-2026-11-24T20-38-26-b.jsonl', 'rollout-2026-11-24T20-38-40-c.jsonl', 'x.txt']
  // the first log begun at or after the run started, and before it ended
  expect(pickRollout(names, at(20, 38, 25), at(20, 45, 0))).toBe('rollout-2026-11-24T20-38-26-b.jsonl')
  // a log another row already read is not read twice
  expect(pickRollout(names, at(20, 38, 25), at(20, 45, 0), ['rollout-2026-11-24T20-38-26-b.jsonl'])).toBe('rollout-2026-11-24T20-38-40-c.jsonl')
  // none begun inside the run: nothing, rather than someone else's figures
  expect(pickRollout(names, at(21, 0, 0), at(21, 5, 0))).toBeNull()
  expect(pickRollout(names, at(20, 31, 0), at(20, 38, 0))).toBeNull()
})

test('usage: a session log tail gives the run total, not the last request, and both limit windows', async () => {
  const line = (total: number, p: number, s: number): string =>
    `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1,"cached_input_tokens":2,"output_tokens":3,"total_tokens":${total}},"last_token_usage":{"input_tokens":9,"total_tokens":77}},"rate_limits":{"limit_id":"codex","primary":{"used_percent":${p},"window_minutes":300,"resets_at":1},"secondary":{"used_percent":${s},"window_minutes":10080,"resets_at":2},"credits":{"balance":"7"}}}}`
  expect(parseCodexTail(`${line(100, 10.0, 30.0)}\n${line(22_636, 20.0, 37.0)}\n`)).toEqual({ tokens: 22_636, limits: { primary: 20, secondary: 37, primaryResetsAt: 1000, secondaryResetsAt: 2000, primaryMinutes: 300, secondaryMinutes: 10080 } })
  // a tail that starts mid-line still reads the newest whole figures
  expect(parseCodexTail(`...okens":5}}}\n${line(900, 21.5, 40)}`)).toEqual({ tokens: 900, limits: { primary: 21.5, secondary: 40, primaryResetsAt: 1000, secondaryResetsAt: 2000, primaryMinutes: 300, secondaryMinutes: 10080 } })
  expect(parseCodexTail('{"type":"session_meta"}')).toEqual({})
  // each window's own reset time comes with it, in ms; a window that names none has none
  expect(parseCodexTail('"rate_limits":{"primary":{"used_percent":23.0,"window_minutes":300,"resets_at":1795575947},"secondary":{"used_percent":38.0,"window_minutes":10080}}').limits).toEqual({
    primary: 23,
    secondary: 38,
    primaryResetsAt: 1_795_575_947_000,
    primaryMinutes: 300,
    secondaryMinutes: 10080,
  })
  // a plan with one window has one figure: it is drawn alone, whichever slot it sits in
  expect(parseCodexTail('"rate_limits":{"primary":{"used_percent":5}}')).toEqual({ limits: { primary: 5 } })
  expect(parseCodexTail('"rate_limits":{"limit_id":"codex","primary":{"used_percent":93.0,"window_minutes":10080,"resets_at":7},"secondary":null}').limits).toEqual({
    primary: 93,
    primaryResetsAt: 7000,
    primaryMinutes: 10080,
  })
  // a null first window never borrows the second's figure
  expect(parseCodexTail('"rate_limits":{"primary":null,"secondary":{"used_percent":81.0,"window_minutes":10080,"resets_at":9}}').limits).toEqual({
    primary: 81,
    primaryResetsAt: 9000,
    primaryMinutes: 10080,
  })
  // a later snapshot for another quota, both windows null, does not blank the account's own
  expect(
    parseCodexTail(`${line(50, 12.0, 34.0)}\n{"payload":{"type":"token_count","rate_limits":{"limit_id":"premium","primary":null,"secondary":null}}}`).limits,
  ).toMatchObject({ primary: 12, secondary: 34 })
})

test('usage: the ledger sums today\'s seat runs by where they ran', async () => {
  const since = dayStart(at(20, 0, 0))
  const row = (o: Record<string, unknown>): string => JSON.stringify({ kind: 'consult_call', ts: new Date(at(19, 0, 0)).toISOString(), ...o })
  const text = [
    'ens_total": 5, "cut": "first line of a tail read"}',
    row({ pool: 'agy', tokens_total: 86_607 }),
    row({ pool: 'cursor-capped', tokens_total: 32_398 }),
    row({ pool: 'cursor-free', tokens_total: 10_000 }),
    row({ pool: 'codex', tokens_total: 4_000 }),
    row({ pool: 'agy', tokens_total: null }),
    row({ pool: 'agy', tokens_total: 1, ts: new Date(since - 1000).toISOString() }),
    JSON.stringify({ kind: 'consult_outcome', ts: new Date(at(19, 0, 0)).toISOString(), pool: 'agy', tokens_total: 50 }),
  ].join('\n')
  expect(parseLedger(text, since)).toEqual({ cursor: 42_398, antigravity: 86_607 })
  expect(parseLedger('', since)).toEqual({ cursor: 0, antigravity: 0 })
})

test('usage: a new read lays over the day\'s figures; a new day starts clean', async () => {
  const day = dayStart(at(20, 0, 0))
  const first = mergeUsage(null, { cursor: 5, antigravity: 0 }, at(20, 0, 0))
  expect(first).toEqual({ day, cursor: 5, antigravity: 0 })
  // a source that could not be read keeps its last figure
  expect(mergeUsage(first, { codex: { primary: 20, secondary: 37 } }, at(21, 0, 0))).toEqual({ day, cursor: 5, antigravity: 0, codex: { primary: 20, secondary: 37 } })
  expect(mergeUsage(first, { cursor: 9 }, at(20, 0, 0) + 86_400_000)).toEqual({ day: day + 86_400_000, cursor: 9 })
  // Codex's windows roll past midnight: a reading with a reset still ahead is kept, the ledger's day figures are not
  const live = { day, cursor: 5, codex: { primary: 20, secondary: 37, secondaryResetsAt: day + 3 * 86_400_000 } }
  expect(mergeUsage(live, {}, day + 86_400_000 + 60_000)).toEqual({ day: day + 86_400_000, codex: live.codex })
  expect(mergeUsage(live, {}, day + 5 * 86_400_000)).toEqual({ day: day + 5 * 86_400_000 })
  expect(mergeUsage(first, {}, day + 86_400_000)).toEqual({ day: day + 86_400_000 })
})
