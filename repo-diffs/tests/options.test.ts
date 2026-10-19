import { expect, test } from 'claude-code/testing'

import {
  DEFAULT_OPTIONS,
  KEY_IGNORE_WHITESPACE,
  KEY_LEGEND,
  KEY_LESS_CONTEXT,
  KEY_MORE_CONTEXT,
  KEY_NUMBERS,
  KEY_PAN_LEFT,
  KEY_PAN_RIGHT,
  KEY_VIEWED,
  KEYS,
  MAX_CONTEXT,
  diffFlags,
  legendRows,
  optionsLabel,
  stepContext,
} from '../hooks/options'

test('defaults match git', () => {
  expect(DEFAULT_OPTIONS).toEqual({ context: 3, ignoreWhitespace: false })
  expect(MAX_CONTEXT).toBe(30)
})

test('stepContext steps and clamps at 0 and MAX_CONTEXT', () => {
  expect(stepContext(3, 1)).toBe(4)
  expect(stepContext(3, -1)).toBe(2)
  expect(stepContext(1, -1)).toBe(0)
  expect(stepContext(0, -1)).toBe(0)
  expect(stepContext(MAX_CONTEXT - 1, 1)).toBe(MAX_CONTEXT)
  expect(stepContext(MAX_CONTEXT, 1)).toBe(MAX_CONTEXT)
  expect(stepContext(500, -1)).toBe(MAX_CONTEXT)
  expect(stepContext(-4, 1)).toBe(0)
})

test('stepContext restarts a non-integer from the default', () => {
  expect(stepContext(NaN, 1)).toBe(4)
  expect(stepContext(1.5, -1)).toBe(2)
  expect(stepContext(Infinity, 1)).toBe(4)
})

test('diffFlags: the context flag is always explicit, -U3 included', () => {
  expect(diffFlags(DEFAULT_OPTIONS, false)).toEqual(['-U3'])
  expect(diffFlags({ context: 0, ignoreWhitespace: false }, false)).toEqual(['-U0'])
  expect(diffFlags({ context: 12, ignoreWhitespace: false }, false)).toEqual(['-U12'])
})

test('diffFlags: full file ignores the context setting', () => {
  expect(diffFlags({ context: 0, ignoreWhitespace: false }, true)).toEqual(['-U100000'])
  expect(diffFlags({ context: 7, ignoreWhitespace: true }, true)).toEqual(['-U100000', '-w'])
})

test('diffFlags: -w only when ignoring whitespace, after the context flag', () => {
  expect(diffFlags({ context: 3, ignoreWhitespace: true }, false)).toEqual(['-U3', '-w'])
  expect(diffFlags({ context: 3, ignoreWhitespace: false }, false)).not.toContain('-w')
})

test('legendRows filters by what the pane shows', () => {
  const keys = (have: { tabs: boolean; hunks: boolean }) => legendRows(have).map(r => r.key)
  const none = keys({ tabs: false, hunks: false })
  expect(none).not.toContain('1-9')
  expect(none).not.toContain('n / p')
  expect(none).toContain('r')
  expect(none).toContain(KEY_LEGEND)
  expect(keys({ tabs: true, hunks: false })).toContain('1-9')
  expect(keys({ tabs: false, hunks: true })).toContain('n / p')
  expect(keys({ tabs: true, hunks: true }).length).toBe(KEYS.length)
  expect(legendRows({ tabs: true, hunks: true })[0]).toEqual({ key: '1-9', label: 'switch repo' })
})

test('new hotkeys are single lowercase letters clear of the existing ones and each other', () => {
  const mine = [KEY_MORE_CONTEXT, KEY_LESS_CONTEXT, KEY_IGNORE_WHITESPACE, KEY_LEGEND, KEY_VIEWED, KEY_NUMBERS, KEY_PAN_LEFT, KEY_PAN_RIGHT]
  for (const k of mine) {
    expect(/^[a-z]$/.test(k)).toBe(true)
    expect(['r', 'j', 'k', 'n', 'p', 'w']).not.toContain(k)
  }
  expect(new Set(mine).size).toBe(mine.length)
  const legend = KEYS.map(k => k.key).join(' ')
  for (const k of mine) expect(legend).toContain(k)
})

test('optionsLabel', () => {
  expect(optionsLabel(DEFAULT_OPTIONS)).toBe('±3 lines')
  expect(optionsLabel({ context: 0, ignoreWhitespace: false })).toBe('±0 lines')
  expect(optionsLabel({ context: 1, ignoreWhitespace: false })).toBe('±1 line')
  expect(optionsLabel({ context: 5, ignoreWhitespace: true })).toBe('±5 lines · no whitespace')
})
