import { expect, test } from 'claude-code/testing'

import { panTokens } from '../hooks/highlight'
import { PAN_STEP, cellsOf, gutterDigits, hunkCells, hunkId, panLine, panMax } from '../hooks/hunks'

test('pan: a line drops its first columns but keeps its marker; a no-newline note stays whole', async () => {
  expect(panLine('+abcdef', 0)).toBe('+abcdef')
  expect(panLine('+abcdef', 2)).toBe('+cdef')
  expect(panLine(' ab', 5)).toBe(' ')
  expect(panLine('\\ No newline at end of file', 3)).toBe('\\ No newline at end of file')
  expect(panLine('-é😀x', 1)).toBe('-😀x')
})

test('pan: the limit is where the widest line ends in a window of the given room; a hunk that fits has none', async () => {
  expect(panMax('@@ -1 +1 @@\n+short')).toBe(0)
  const wide = `@@ -1 +1 @@\n ${'x'.repeat(PAN_STEP * 3 + 5)}\n+y`
  // the default room is one step: 65 columns stop at 45, the last 20 in view
  expect(panMax(wide)).toBe(PAN_STEP * 2 + 5)
  // a 60-column window needs only the last 5
  expect(panMax(wide, 60)).toBe(5)
  // and one as wide as the line, nothing
  expect(panMax(wide, 65)).toBe(0)
  expect(panMax(wide, 200)).toBe(0)
})

test('gutter digits: from the range, the larger side', async () => {
  expect(gutterDigits('@@ -1,2 +1,2 @@\n a\n')).toBe(1)
  expect(gutterDigits('@@ -98,5 +98,5 @@ fn\n a\n')).toBe(3)
  expect(gutterDigits('@@ -0,0 +1 @@\n+a\n')).toBe(1)
})

test('pan: tokens are cut across their boundaries and keep their kinds', async () => {
  const toks = [{ text: 'const', kind: 'keyword' as const }, { text: ' ' }, { text: 'name', kind: 'entity' as const }]
  expect(panTokens(toks, 0)).toBe(toks)
  expect(panTokens(toks, 3)).toEqual([{ text: 'st', kind: 'keyword' }, { text: ' ' }, { text: 'name', kind: 'entity' }])
  expect(panTokens(toks, 7)).toEqual([{ text: 'ame', kind: 'entity' }])
  expect(panTokens(toks, 99)).toEqual([])
})

test('cells: tabs run to the next eighth column, wide glyphs take two, joiners none; a hunk is as wide as its widest code line', async () => {
  expect(cellsOf('abc')).toBe(3)
  expect(cellsOf('\tx')).toBe(9)
  expect(cellsOf('ab\tx')).toBe(9)
  expect(cellsOf('日本')).toBe(4)
  expect(cellsOf('é')).toBe(1)
  expect(hunkCells('@@ -1,2 +1,2 @@ a very long function context that is not code\n short\n+a longer line\n\\ No newline at end of file\n')).toBe(13)
})

test('hunk id: the old-file line of the first change, the same at any context; a context-only hunk by its start', async () => {
  expect(hunkId('@@ -20,2 +20,2 @@\n-old2\n+new2\n y\n')).toBe('o20')
  // three more lines of context above: the range moves, the name does not
  expect(hunkId('@@ -17,5 +17,5 @@\n a\n b\n c\n-old2\n+new2\n y\n')).toBe('o20')
  // an addition is named by the old line it lands before
  expect(hunkId('@@ -5,2 +5,3 @@\n a\n+new\n b\n')).toBe('o6')
  expect(hunkId('@@ -9,1 +9,1 @@\n same\n')).toBe('h9')
})
