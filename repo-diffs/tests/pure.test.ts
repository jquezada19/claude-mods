import { expect, test } from 'claude-code/testing'

import { cleanPatch, clipHunk, exportComments, firstChange, hunkHolds, nextHunkIndex, pickSection, splitHunks } from '../hooks/hunks'
import { buildTree, fileOrder, visibleRows } from '../hooks/tree'

const f = (path: string) => ({ path, status: 'M', added: 1, removed: 0 })

test('tree joins single-folder chains, folders before files, sorted', async () => {
  const tree = buildTree([f('README.md'), f('src/features/x/test/a.test.ts'), f('src/features/x/b.ts'), f('ios/Pod.h')])
  const rows = visibleRows(tree, new Set()).map(n => `${'  '.repeat(n.depth)}${n.kind === 'dir' ? n.label + '/' : n.label}`)
  expect(rows).toEqual(['ios/', '  Pod.h', 'src/features/x/', '  test/', '    a.test.ts', '  b.ts', 'README.md'])
  expect(fileOrder(tree).map(x => x.path)).toEqual(['ios/Pod.h', 'src/features/x/test/a.test.ts', 'src/features/x/b.ts', 'README.md'])
})

test('a collapsed folder hides everything under it', async () => {
  const tree = buildTree([f('a/b/c.ts'), f('a/d.ts'), f('e.ts')])
  const rows = visibleRows(tree, new Set(['a'])).map(n => n.label)
  expect(rows).toEqual(['a', 'e.ts'])
})

test('hunk gaps count the unchanged lines git left out', async () => {
  const d = [
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -5,3 +5,4 @@ fn',
    ' a',
    '+b',
    ' c',
    ' d',
    '@@ -20,2 +21,2 @@',
    '-e',
    '+f',
    ' g',
    '',
  ].join('\n')
  const h = splitHunks(d)
  expect(h.map(x => x.gapBefore)).toEqual([4, 12])
  expect(h[0]!.text.startsWith('@@ -5,3')).toBe(true)
  expect(splitHunks('@@ -0,0 +1,2 @@\n+a\n+b\n')[0]!.gapBefore).toBe(0)
})

test('zero-length old ranges (diff.context=0) count gaps from after the line', async () => {
  const h = splitHunks('@@ -5,0 +6 @@\n+x\n@@ -10 +11 @@\n-a\n+b\n')
  expect(h.map(x => x.gapBefore)).toEqual([5, 4])
})

test('clipHunk keeps whole lines and rewrites the header counts', async () => {
  const c = clipHunk('@@ -1,3 +1,3 @@ ctx\n a\n-b\n+c\n d\n', 30)!
  expect(c.text).toBe('@@ -1,2 +1,2 @@ ctx\n a\n-b\n+c\n')
  expect(c.droppedLines).toBe(1)
  expect(cleanPatch('a\r\nb\u0001')).toBe('a\nb\ufffd')
})

test('firstChange points an edit at its new line, a pure deletion at its old one', () => {
  expect(firstChange('@@ -10,3 +10,3 @@\n a\n-b\n+B\n c\n')).toEqual({ line: 11, side: 'new', newLine: 11 })
  // a pure deletion: old L11, sitting at new L11 of the current file
  expect(firstChange('@@ -10,4 +10,2 @@\n a\n-b\n-c\n d\n')).toEqual({ line: 11, side: 'old', newLine: 11 })
  expect(firstChange('@@ -20,3 +5,1 @@\n-x\n-y\n z\n')).toEqual({ line: 20, side: 'old', newLine: 5 })
  expect(firstChange('@@ -0,0 +1,2 @@\n+x\n+y\n')).toEqual({ line: 1, side: 'new', newLine: 1 })
  expect(hunkHolds('@@ -10,3 +12,4 @@\n a\n', 15, 'new')).toBe(true)
  expect(hunkHolds('@@ -10,3 +12,4 @@\n a\n', 16, 'new')).toBe(false)
  expect(hunkHolds('@@ -10,3 +12,4 @@\n a\n', 12, 'old')).toBe(true)
  // a pure addition's old range is empty; a context-only (clipped) hunk has no anchor
  expect(hunkHolds('@@ -10,0 +11,1 @@\n+x\n', 10, 'old')).toBe(false)
  expect(firstChange('@@ -1,3 +1,3 @@\n a\n b\n c\n')).toBeNull()
})

test('exportComments names the repo once, or per line when there are several', () => {
  const one = exportComments([{ repo: 'app', path: 'a.ts', line: 3, side: 'new', tag: 'nit', body: 'rename' }])
  expect(one).toContain('in app')
  expect(one).toContain('- [nit] **a.ts:3** (new side): rename')
  const two = exportComments([
    { repo: 'app', path: 'a.ts', line: 3, side: 'new', tag: '', body: 'x' },
    { repo: 'app-qa', path: 'b.ts', line: 9, side: 'old', tag: 'question', body: 'why?' },
  ])
  expect(two).toContain('- **app: a.ts:3** (new side): x')
  expect(two).toContain('- [question] **app-qa: b.ts:9** (old side): why?')
})

test('nextHunkIndex walks hunks and wraps both ways', () => {
  expect(nextHunkIndex(-1, 1, 3)).toBe(0)
  expect(nextHunkIndex(0, 1, 3)).toBe(1)
  expect(nextHunkIndex(2, 1, 3)).toBe(0)
  expect(nextHunkIndex(-1, -1, 3)).toBe(2)
  expect(nextHunkIndex(0, -1, 3)).toBe(2)
  expect(nextHunkIndex(7, 1, 3)).toBe(0)
  expect(nextHunkIndex(-1, 1, 0)).toBe(-1)
})

test('pickSection keeps only the renamed file when git returns more', () => {
  const rename = 'diff --git a/old b/new\nsimilarity index 90%\nrename from old\nrename to new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-a\n+b\n'
  const extra = 'diff --git a/old/extra b/old/extra\nnew file mode 100644\n--- /dev/null\n+++ b/old/extra\n@@ -0,0 +1 @@\n+x\n'
  expect(pickSection(rename + extra, 'new')).toBe(rename)
  expect(pickSection(extra + rename, 'new')).toBe(rename)
  // one section, or none naming the path: unchanged
  expect(pickSection(rename, 'new')).toBe(rename)
  expect(pickSection(rename + extra, 'other')).toBe(rename + extra)
})

import { grouped, patchNotes } from '../hooks/hunks'

test('patchNotes names what the headers say and the hunks do not', () => {
  expect(patchNotes('diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755\n')).toEqual(['now executable (100644 → 100755)'])
  expect(patchNotes('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n')).toEqual(['renamed without changes'])
  expect(patchNotes('diff --git a/c b/c\ndeleted file mode 120000\n--- a/c\n+++ /dev/null\n@@ -1 +0,0 @@\n-t\ndiff --git a/c b/c\nnew file mode 100644\n')).toEqual(['symlink replaced by a file'])
  expect(patchNotes('diff --git a/x b/x\nindex 1..2 100644\n@@ -1 +1 @@\n-a\n+b\n')).toEqual([])
})

test('grouped prints counts the way GitHub does', () => {
  expect([grouped(0), grouped(999), grouped(1001), grouped(1234567)]).toEqual(['0', '999', '1,001', '1,234,567'])
})

import { hunkRuns } from '../hooks/hunks'

test('hunkRuns numbers each run from its own file', () => {
  const h = '@@ -10,4 +20,5 @@ function f() {\n ctx a\n-old b\n-old c\n+new b\n+new c\n+new d\n ctx e\n\\ No newline at end of file\n'
  const { header, runs } = hunkRuns(h)
  expect(header).toBe('@@ -10,4 +20,5 @@ function f() {')
  expect(runs.map(r => [r.kind, r.start, r.lines.length])).toEqual([
    ['ctx', 20, 1],
    ['del', 11, 2],
    ['add', 21, 3],
    ['ctx', 24, 2],
  ])
})
