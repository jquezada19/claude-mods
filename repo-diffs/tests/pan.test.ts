import { expect, test } from 'claude-code/testing'

import { panTokens } from '../hooks/highlight'
import { PAN_STEP, panLine, panMax } from '../hooks/hunks'

test('pan: a line drops its first columns but keeps its marker; a no-newline note stays whole', async () => {
  expect(panLine('+abcdef', 0)).toBe('+abcdef')
  expect(panLine('+abcdef', 2)).toBe('+cdef')
  expect(panLine(' ab', 5)).toBe(' ')
  expect(panLine('\\ No newline at end of file', 3)).toBe('\\ No newline at end of file')
  expect(panLine('-é😀x', 1)).toBe('-😀x')
})

test('pan: the limit stops one step short of the widest line, in whole steps', async () => {
  expect(panMax('@@ -1 +1 @@\n+short')).toBe(0)
  const wide = `@@ -1 +1 @@\n ${'x'.repeat(PAN_STEP * 3 + 5)}\n+y`
  expect(panMax(wide)).toBe(PAN_STEP * 3)
})

test('pan: tokens are cut across their boundaries and keep their kinds', async () => {
  const toks = [{ text: 'const', kind: 'keyword' as const }, { text: ' ' }, { text: 'name', kind: 'entity' as const }]
  expect(panTokens(toks, 0)).toBe(toks)
  expect(panTokens(toks, 3)).toEqual([{ text: 'st', kind: 'keyword' }, { text: ' ' }, { text: 'name', kind: 'entity' }])
  expect(panTokens(toks, 7)).toEqual([{ text: 'ame', kind: 'entity' }])
  expect(panTokens(toks, 99)).toEqual([])
})
