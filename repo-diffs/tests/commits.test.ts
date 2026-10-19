import { expect, test } from 'claude-code/testing'

import { EMPTY_TREE, LOG_ARGS, commitRange, parseLog, relTime } from '../hooks/commits'

// Captured verbatim from a scratch repo with `git log` + LOG_ARGS: a merge, a
// mainline commit, a side commit whose subject holds a tab, unicode and quotes,
// and the root. Each record ends in RS then git's own newline.
const REAL =
  "46614d9cb20684e0a31adee9957ebb78371d3c38\u001f46614d9\u001f5cbbd2f6a162fcda3e201df2ef504d0757cf9ca2 76c7b4174b54af74d452ab53f5430af5538fdbdb\u001fAda Lovelace\u001f1700000300\u001fMerge branch 'side'\u001e\n" +
  '5cbbd2f6a162fcda3e201df2ef504d0757cf9ca2\u001f5cbbd2f\u001fd1a8f923d4d007b1e813f7bf256f8bd32c2a19af\u001fAda Lovelace\u001f1700000200\u001fmain side work\u001e\n' +
  '76c7b4174b54af74d452ab53f5430af5538fdbdb\u001f76c7b41\u001fd1a8f923d4d007b1e813f7bf256f8bd32c2a19af\u001fAda Lovelace\u001f1700000100\u001ffix:\tcafé ✓ "quoted"\u001e\n' +
  'd1a8f923d4d007b1e813f7bf256f8bd32c2a19af\u001fd1a8f92\u001f\u001fAda Lovelace\u001f1700000000\u001froot commit\u001e\n'

test('LOG_ARGS: log, newest first, US/RS-delimited, capped', () => {
  expect(LOG_ARGS[0]).toBe('log')
  expect(LOG_ARGS).toContain('--no-color')
  expect(LOG_ARGS).toContain('--no-decorate')
  expect(LOG_ARGS).toContain('--format=%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s%x1e')
  expect(LOG_ARGS).toContain('--max-count=200')
})

test('parseLog: real output with a merge, a tab+unicode subject and a root', () => {
  const cs = parseLog(REAL)
  expect(cs.length).toBe(4)
  expect(cs[0]).toEqual({
    sha: '46614d9cb20684e0a31adee9957ebb78371d3c38',
    short: '46614d9',
    parents: ['5cbbd2f6a162fcda3e201df2ef504d0757cf9ca2', '76c7b4174b54af74d452ab53f5430af5538fdbdb'],
    author: 'Ada Lovelace',
    at: 1700000300000,
    subject: "Merge branch 'side'",
  })
  expect(cs[2]!.subject).toBe('fix:\tcafé ✓ "quoted"')
  expect(cs[2]!.parents).toEqual(['d1a8f923d4d007b1e813f7bf256f8bd32c2a19af'])
  expect(cs[3]!.parents).toEqual([])
  expect(cs[3]!.at).toBe(1700000000000)
  expect(cs.map(c => c.short)).toEqual(['46614d9', '5cbbd2f', '76c7b41', 'd1a8f92'])
})

test('parseLog: a malformed record is skipped, the rest survive', () => {
  const bad = 'deadbeef\u001fdead\u001fonly-three-fields\u001e\n'
  const cs = parseLog(bad + REAL)
  expect(cs.length).toBe(4)
  expect(cs[0]!.short).toBe('46614d9')
})

test('parseLog: empty and whitespace-only output is no commits', () => {
  expect(parseLog('')).toEqual([])
  expect(parseLog('\n')).toEqual([])
  expect(parseLog('  \n\u001e\n')).toEqual([])
})

test('parseLog: tolerates no trailing newline and leading whitespace', () => {
  const one = '\n  aaa\u001fa\u001fbbb\u001fX\u001f10\u001fs\u001e'
  expect(parseLog(one)).toEqual([{ sha: 'aaa', short: 'a', parents: ['bbb'], author: 'X', at: 10000, subject: 's' }])
})

test('commitRange: first parent, empty tree for a root, first parent for a merge', () => {
  const [merge, normal, , root] = parseLog(REAL)
  expect(commitRange(normal!)).toEqual(['d1a8f923d4d007b1e813f7bf256f8bd32c2a19af', '5cbbd2f6a162fcda3e201df2ef504d0757cf9ca2'])
  expect(commitRange(root!)).toEqual([EMPTY_TREE, 'd1a8f923d4d007b1e813f7bf256f8bd32c2a19af'])
  expect(commitRange(merge!)).toEqual(['5cbbd2f6a162fcda3e201df2ef504d0757cf9ca2', '46614d9cb20684e0a31adee9957ebb78371d3c38'])
  expect(EMPTY_TREE).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
})

test('relTime: unit boundaries and clock skew', () => {
  const now = 1_800_000_000_000
  const s = 1000
  const m = 60 * s
  const h = 60 * m
  const d = 24 * h
  const ago = (ms: number) => relTime(now - ms, now)
  expect(ago(59 * s)).toBe('just now')
  expect(ago(60 * s)).toBe('1m ago')
  expect(ago(59 * m)).toBe('59m ago')
  expect(ago(h)).toBe('1h ago')
  expect(ago(13 * d)).toBe('13d ago')
  expect(ago(14 * d)).toBe('2w ago')
  expect(ago(59 * d)).toBe('8w ago')
  expect(ago(60 * d)).toBe('2mo ago')
  expect(ago(364 * d)).toBe('12mo ago')
  expect(ago(365 * d)).toBe('1y ago')
  expect(relTime(now + 5 * m, now)).toBe('just now')
})
