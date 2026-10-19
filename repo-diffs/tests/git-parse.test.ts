import { expect, test } from 'claude-code/testing'

import { parseNameStatus, parseNumstat, parseUnmerged } from '../hooks/git-parse'
import { hunkContext } from '../hooks/hunks'

test('numstat -z: plain rows, tab paths, binaries and renames', () => {
  const raw = '3\t1\tsrc/a.ts\u0000-\t-\timg.png\u00002\t0\tweird\tname.ts\u00005\t2\t\u0000old/x.ts\u0000new/x.ts\u0000'
  expect(parseNumstat(raw)).toEqual([
    { path: 'src/a.ts', added: 3, removed: 1, isBinary: false },
    { path: 'img.png', added: 0, removed: 0, isBinary: true },
    { path: 'weird\tname.ts', added: 2, removed: 0, isBinary: false },
    { path: 'new/x.ts', oldPath: 'old/x.ts', added: 5, removed: 2, isBinary: false },
  ])
})

test('name-status -z: renames and copies key on the new path', () => {
  const m = parseNameStatus('M\u0000src/a.ts\u0000R087\u0000old/x.ts\u0000new/x.ts\u0000A\u0000b.ts\u0000C100\u0000c.ts\u0000d.ts\u0000')
  expect(m.get('src/a.ts')).toBe('M')
  expect(m.get('new/x.ts')).toBe('R087')
  expect(m.get('old/x.ts')).toBeUndefined()
  expect(m.get('b.ts')).toBe('A')
  expect(m.get('d.ts')).toBe('C100')
})

test('ls-files -u: one path per conflict, whatever its stages', () => {
  const raw = '100644 aaa 1\tsrc/a.ts\u0000100644 bbb 2\tsrc/a.ts\u0000100644 ccc 3\tsrc/a.ts\u0000100644 ddd 2\tb c.ts\u0000'
  expect(parseUnmerged(raw)).toEqual(['src/a.ts', 'b c.ts'])
})

test('hunkContext reads git\'s funcname after the second @@', () => {
  expect(hunkContext('@@ -10,3 +10,4 @@ async function refreshOnce($: EngineInterface) {\n a\n')).toBe('async function refreshOnce($: EngineInterface) {')
  expect(hunkContext('@@ -1 +1 @@\n-a\n+b\n')).toBe('')
})
