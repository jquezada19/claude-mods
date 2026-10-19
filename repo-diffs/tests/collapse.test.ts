import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// v18 (2026-10-14): every block folds on its chevron (header detail, file
// list, conflicts, each hunk), the diff options sit behind one toggle, and a
// change set past 40 files starts with its top folders collapsed.

const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const PANE = {
  plugin: 'repo-diffs',
  component: 'Pane',
  requestId: 'repo-diffs',
  props: { title: 'Repo diffs', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const EDIT = { tool: 'Edit', file_path: '/repos/tool/src/a.ts', old_string: 'old', new_string: 'new' } as const
const K = (p: string) => `/repos/tool\u0000${p}`
const PATCH_TWO = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n x\n@@ -20,2 +20,2 @@\n-old2\n+new2\n y\n'

function wire(on: On, files: string[], route: (a: string) => ReturnType<typeof ok> | null = () => null) {
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    const hit = route(a)
    if (hit) return { value: hit }
    if (e.argv[0] === 'python3') return { value: ok('[]') }
    if (a.includes('rev-parse --show-toplevel')) return { value: ok('/repos/tool\n') }
    if (a.includes('rev-parse --abbrev-ref')) return { value: ok('feature/x\n') }
    if (a.includes('merge-base HEAD origin/develop')) return { value: ok('base000\n') }
    if (a.includes('--numstat')) return { value: ok(files.map(f => `1\t1\t${f}\u0000`).join('')) }
    if (a.includes('--name-status')) return { value: ok(files.map(f => `M\u0000${f}\u0000`).join('')) }
    if (a.includes('ls-files')) return { value: ok('') }
    if (a.includes('base000 -- ')) return { value: ok(PATCH_TWO.replace(/src\/a\.ts/g, a.slice(a.lastIndexOf(' -- ') + 4))) }
    return { value: ok('', 1) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
}

type Found = { type: string; key?: string; props: Record<string, unknown>; text?: string; children?: Found[] }
// every string drawn under an element
const wordsOf = (n: Found | undefined): string => (!n ? '' : [n.text ?? '', ...(n.children ?? []).map(wordsOf)].join('\n'))
async function allWords(ui: { find: (q: { type: string }) => Promise<unknown> }) {
  return wordsOf((await ui.find({ type: 'Box' })) as Found | undefined)
}

test('each hunk folds on its own chevron: the band stays, its lines go, and the other hunk is untouched', async ($, on) => {
  wire(on, ['src/a.ts'])
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // tinted rows pad the marker: ` + new2`
  expect(await allWords(ui)).toContain(' + new2')
  await ui.press({ key: 'hunkfold:0' })
  const folded = await allWords(ui)
  expect(folded).not.toMatch(/1 \+ new2/)
  expect(folded).toContain(' + new2')
  // the band keeps its range, so the fold reads as a fold
  expect(await ui.find({ text: /^@@ -1,2 \+1,2 @@$/ })).toBeDefined()
  expect((await ui.find({ key: 'hunkfold:0' }))?.props.label).toBe('▸')
  await ui.press({ key: 'hunkfold:0' })
  expect(await allWords(ui)).toMatch(/1 \+ new2/)
  await ui.unmount()
})

test('the file list folds to its title line and gives the diff the whole width; the header folds to its first line', async ($, on) => {
  wire(on, ['src/a.ts'])
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: `btn:${K('src/a.ts')}` })).toBeDefined()
  await ui.press({ key: 'files-fold' })
  expect(await ui.find({ key: `btn:${K('src/a.ts')}` })).toBeUndefined()
  expect(await ui.find({ key: 'edit-hide' })).toBeUndefined()
  expect((await ui.find({ key: 'files-fold' }))?.props.label).toBe('▸ Files')
  // the list is no longer pinned beside the stack: the first Box is the column layout
  const root = (await ui.find({ type: 'Box' })) as Found
  expect(root.props.flexDirection).toBe('column')
  await ui.press({ key: 'files-fold' })
  expect(await ui.find({ key: `btn:${K('src/a.ts')}` })).toBeDefined()

  // v21: the header starts folded to its first line; opening the base picker unfolds it
  expect((await ui.find({ key: 'hdr-fold' }))?.props.label).toBe('▸')
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  expect(await ui.find({ text: /^1 file$/ })).toBeDefined()
  await ui.press({ key: 'base-menu' })
  expect(await ui.find({ key: 'base:auto' })).toBeDefined()
  expect((await ui.find({ key: 'hdr-fold' }))?.props.label).toBe('▾')
  await ui.press({ key: 'hdr-fold' })
  expect(await ui.find({ key: 'base:auto' })).toBeUndefined()
  // the scope lives on the toolbar (v20), so it stays reachable folded or not
  expect(await ui.find({ key: 'scope:committed' })).toBeDefined()
  await ui.press({ key: 'hdr-fold' })
  expect(await ui.find({ key: 'base:auto' })).toBeDefined()
  await ui.unmount()
})

test('the diff options sit behind one toggle; their keys arm only while it is open', async ($, on) => {
  wire(on, ['src/a.ts'])
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'wrap' })).toBeUndefined()
  expect(await ui.find({ key: 'ctx-more' })).toBeUndefined()
  // what stays on the bar: where you are, how to move, collapse all
  expect(await ui.find({ key: 'next' })).toBeDefined()
  expect(await ui.find({ key: 'hunk-next' })).toBeDefined()
  expect(await ui.find({ key: 'fold-all' })).toBeDefined()
  await ui.press({ key: 'options' })
  expect((await ui.find({ key: 'wrap' }))?.props.hotkey).toBe('w')
  expect((await ui.find({ key: 'ctx-more' }))?.props.hotkey).toBe('m')
  await ui.press({ key: 'options' })
  expect(await ui.find({ key: 'wrap' })).toBeUndefined()
  await ui.unmount()
})

test('a change set past 40 files starts with its top folders collapsed, except the one holding the selected file; a small one starts open', async ($, on) => {
  const many = Array.from({ length: 45 }, (_, i) => `${['android', 'ios', 'src'][i % 3]}/deep/f${String(i).padStart(2, '0')}.ts`)
  wire(on, many)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the first file in tree order is android/deep/f00.ts: its folder stays open
  expect(await ui.find({ key: `btn:${K('android/deep/f00.ts')}` })).toBeDefined()
  expect(await ui.find({ key: `btn:${K('ios/deep/f01.ts')}` })).toBeUndefined()
  expect(await ui.find({ key: `btn:${K('src/deep/f02.ts')}` })).toBeUndefined()
  expect((await ui.find({ key: `dirbtn:${K('ios/deep')}` }))?.props.label).toBe('▸ ios/deep')
  // click into a folder
  await ui.press({ key: `dirbtn:${K('ios/deep')}` })
  expect(await ui.find({ key: `btn:${K('ios/deep/f01.ts')}` })).toBeDefined()
  // a refresh does not fold it again: seeding is once per repo
  await $.tool.call(EDIT)
  expect(await ui.find({ key: `btn:${K('ios/deep/f01.ts')}` })).toBeDefined()
  await ui.unmount()
})

test('40 files or fewer start with every folder open', async ($, on) => {
  const few = Array.from({ length: 40 }, (_, i) => `${['android', 'ios'][i % 2]}/f${String(i).padStart(2, '0')}.ts`)
  wire(on, few)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: `btn:${K('ios/f01.ts')}` })).toBeDefined()
  expect(await ui.find({ key: `btn:${K('android/f38.ts')}` })).toBeDefined()
  await ui.unmount()
})
