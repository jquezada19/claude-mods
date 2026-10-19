import { expect, test } from 'claude-code/testing'

import { bucketOf, formatPatterns, globMatch, isExcluded, parsePatterns, parsePrView, prFailure } from '../hooks/pr'

test('gh check buckets', () => {
  expect(bucketOf('SUCCESS')).toBe('pass')
  expect(bucketOf('NEUTRAL')).toBe('skipping')
  expect(bucketOf('TIMED_OUT')).toBe('fail')
  expect(bucketOf('ACTION_REQUIRED')).toBe('fail')
  expect(bucketOf('CANCELLED')).toBe('cancel')
  expect(bucketOf('IN_PROGRESS')).toBe('pending')
  expect(bucketOf('')).toBe('pending')
})

test('parsePrView: a re-run replaces the run it repeats; failing checks keep their links', () => {
  const info = parsePrView(
    JSON.stringify({
      number: 42,
      state: 'OPEN',
      isDraft: false,
      reviewDecision: '',
      mergeable: 'MERGEABLE',
      url: 'https://github.com/o/r/pull/42',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-09T10:00:00Z', detailsUrl: 'https://x/old' },
        { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-09T11:00:00Z', detailsUrl: 'https://x/new' },
        { __typename: 'CheckRun', name: 'lint', workflowName: 'CI', status: 'IN_PROGRESS', startedAt: '2026-10-09T11:00:00Z' },
        { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-09T11:00:00Z', detailsUrl: 'https://x/test' },
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR', targetUrl: 'https://x/legacy' },
      ],
    }),
  )
  expect(info).toEqual({
    kind: 'pr',
    number: 42,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    url: 'https://github.com/o/r/pull/42',
    baseRefName: '',
    checks: { pass: 1, fail: 2, pending: 1, skipping: 0, cancel: 0 },
    failing: [
      { name: 'test', link: 'https://x/test' },
      { name: 'ci/legacy', link: 'https://x/legacy' },
    ],
  })
})

test('prFailure: no PR is an answer, anything else is unavailable', () => {
  expect(prFailure('no pull requests found for branch "x"')).toEqual({ kind: 'none' })
  expect(prFailure('To get started with GitHub CLI, please run:  gh auth login\nmore')).toEqual({
    kind: 'error',
    message: 'To get started with GitHub CLI, please run:  gh auth login',
  })
})

test('exclude globs follow gh: whole path, then the file name; * never crosses /', () => {
  expect(isExcluded('ios/App.xcodeproj/project.pbxproj', ['*.pbxproj'])).toBe(true)
  expect(isExcluded('yarn.lock', ['*.lock'])).toBe(true)
  expect(isExcluded('generated/a.ts', ['generated/*'])).toBe(true)
  expect(isExcluded('generated/deep/a.ts', ['generated/*'])).toBe(false)
  expect(isExcluded('src/a.ts', ['*.pbxproj', '*.lock'])).toBe(false)
  expect(globMatch('a?c', 'abc')).toBe(true)
  expect(globMatch('[ab].ts', 'b.ts')).toBe(true)
  // Go negates a class only with ^; ! is an ordinary member
  expect(globMatch('[!ab].ts', 'b.ts')).toBe(true)
  expect(globMatch('[^ab].ts', 'b.ts')).toBe(false)
  expect(globMatch('[^ab].ts', 'c.ts')).toBe(true)
  expect(globMatch('[a-c].ts', 'b.ts')).toBe(true)
  // \ escapes; ? is one whole character; a malformed pattern matches nothing
  expect(globMatch('foo\\?.txt', 'foo?.txt')).toBe(true)
  expect(globMatch('foo\\?.txt', 'fooX.txt')).toBe(false)
  expect(globMatch('?.txt', '😀.txt')).toBe(true)
  expect(globMatch('[ab', 'a')).toBe(false)
  expect(globMatch('a.b', 'aXb')).toBe(false)
  expect(parsePatterns('  *.lock   *.pbxproj ')).toEqual(['*.lock', '*.pbxproj'])
  // a pattern with a space is quoted, and round-trips
  expect(parsePatterns('"dir/my file.lock" *.md')).toEqual(['dir/my file.lock', '*.md'])
  expect(formatPatterns(['dir/my file.lock', '*.md'])).toBe('"dir/my file.lock" *.md')
  expect(isExcluded('dir/my file.lock', parsePatterns('"dir/my file.lock"'))).toBe(true)
  expect(isExcluded('other/file.lock', parsePatterns('"dir/my file.lock"'))).toBe(false)
})
