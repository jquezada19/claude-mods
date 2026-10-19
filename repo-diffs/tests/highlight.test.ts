import { expect, test } from 'claude-code/testing'

import { highlightLine } from '../hooks/highlight'

const kinds = (line: string, path: string) => highlightLine(line, path).map(t => [t.text, t.kind ?? '-'])

test('highlight: keywords, calls, strings, numbers, constants and comments take GitHub kinds', async () => {
  expect(kinds('export function useFlag(name: string) { // hi', 'a.ts')).toEqual([
    ['export', 'keyword'],
    [' ', '-'],
    ['function', 'keyword'],
    [' ', '-'],
    ['useFlag', 'entity'],
    ['(name: ', '-'],
    ['string', 'type'],
    [') { ', '-'],
    ['// hi', 'comment'],
  ])
  expect(kinds(`x = 'it\\'s' + 0x1F + true`, 'a.ts')).toEqual([
    ['x = ', '-'],
    [`'it\\'s'`, 'string'],
    [' + ', '-'],
    ['0x1F', 'constant'],
    [' + ', '-'],
    ['true', 'constant'],
  ])
})

test('highlight: # comments only where the language has them; prose is left plain', async () => {
  expect(kinds('x = 1  # note // here', 'a.py').at(-1)).toEqual(['# note // here', 'comment'])
  // in a slash language a # is code, and the line keeps its colours after it
  expect(kinds('a #b // c', 'a.ts').at(-1)).toEqual(['// c', 'comment'])
  expect(kinds('see https://x.y # ok', 'notes.md')).toEqual([['see https://x.y # ok', '-']])
  // the text is kept whole, whatever the colours
  const line = `  const s = "a\\"b" /* c */ + f(2.5e3)`
  expect(highlightLine(line, 'a.ts').map(t => t.text).join('')).toBe(line)
})

test('highlight: module paths after import / package / from / using are namespaces, the type they bring in a type', async () => {
  expect(kinds('package com.example.location', 'A.kt')).toEqual([
    ['package', 'keyword'],
    [' ', '-'],
    ['com.example.location', 'namespace'],
  ])
  expect(kinds('import android.os.Handler', 'A.kt')).toEqual([
    ['import', 'keyword'],
    [' ', '-'],
    ['android.os.', 'namespace'],
    ['Handler', 'type'],
  ])
  expect(kinds('using System.Linq;', 'a.cs').slice(2)).toEqual([
    ['System.', 'namespace'],
    ['Linq', 'type'],
    [';', '-'],
  ])
  // a brace ends the path: named imports are types, the source a string
  expect(kinds("import { EventEmitter } from 'events'", 'a.ts')).toEqual([
    ['import', 'keyword'],
    [' { ', '-'],
    ['EventEmitter', 'type'],
    [' } ', '-'],
    ['from', 'keyword'],
    [' ', '-'],
    ["'events'", 'string'],
  ])
})

test('highlight: types, decorators and calls each take their own kind', async () => {
  expect(kinds('@Override fun post(url: String): Int', 'A.kt')).toEqual([
    ['@Override', 'entity'],
    [' ', '-'],
    ['fun', 'keyword'],
    [' ', '-'],
    ['post', 'entity'],
    ['(url: ', '-'],
    ['String', 'type'],
    ['): ', '-'],
    ['Int', 'type'],
  ])
  // a property is left plain; a method call is a function
  expect(kinds('foo.bar(1)', 'a.ts')).toEqual([
    ['foo.', '-'],
    ['bar', 'entity'],
    ['(', '-'],
    ['1', 'constant'],
    [')', '-'],
  ])
})
