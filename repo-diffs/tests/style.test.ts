import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// v19 (2026-10-14): picked states are filled pills (variant primary), the rest
// plain; secondary actions sit in a Box the desktop reveals under the pointer
// and other surfaces show always; the header is unframed.

const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const PANE = {
  plugin: 'repo-diffs',
  component: 'Pane',
  requestId: 'repo-diffs',
  props: { title: 'Repo diffs', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const EDIT = { tool: 'Edit', file_path: '/repos/tool/src/a.ts', old_string: 'old', new_string: 'new' } as const
const PATCH = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n x\n'

function wire(on: On) {
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (e.argv[0] === 'python3') return { value: ok('[]') }
    if (a.includes('rev-parse --show-toplevel')) return { value: ok('/repos/tool\n') }
    if (a.includes('rev-parse --abbrev-ref')) return { value: ok('feature/x\n') }
    if (a.includes('merge-base HEAD origin/develop')) return { value: ok('base000\n') }
    if (a.includes('--numstat')) return { value: ok('1\t1\tsrc/a.ts\u0000') }
    if (a.includes('--name-status')) return { value: ok('M\u0000src/a.ts\u0000') }
    if (a.includes('ls-files')) return { value: ok('') }
    if (a.includes('base000 -- src/a.ts')) return { value: ok(PATCH) }
    return { value: ok('', 1) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
}

// the test host reports a Box's hover beside its props
type Found = { type: string; key?: string; props: Record<string, unknown>; hover?: Record<string, unknown>; children?: Found[] }
// the Box right above an element with this key
function parentOf(root: Found | undefined, key: string): Found | undefined {
  const walk = (n: Found, up: Found | undefined): Found | undefined => {
    if ((n.key ?? n.props?.key) === key) return up
    for (const c of n.children ?? []) {
      const hit = walk(c, n)
      if (hit) return hit
    }
    return undefined
  }
  return root ? walk(root, undefined) : undefined
}

test('the picked scope and each on-toggle are filled pills; the others plain and dim', async ($, on) => {
  wire(on)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const variant = async (key: string) => (await ui.find({ key }))?.props.variant
  const plain = async (key: string) => (await ui.find({ key }))?.props.plain
  expect(await variant('scope:all')).toBe('secondary')
  expect(await plain('scope:committed')).toBe(true)
  expect(await variant('scope:committed')).toBeUndefined()
  await ui.press({ key: 'scope:committed' })
  expect(await variant('scope:committed')).toBe('secondary')
  expect(await plain('scope:all')).toBe(true)
  // toggles: ignore whitespace, options, keys, wrap, syntax colours
  expect(await plain('ws')).toBe(true)
  await ui.press({ key: 'ws' })
  expect(await variant('ws')).toBe('secondary')
  expect(await plain('options')).toBe(true)
  await ui.press({ key: 'options' })
  expect(await variant('options')).toBe('secondary')
  expect(await plain('wrap')).toBe(true)
  await ui.press({ key: 'wrap' })
  expect(await variant('wrap')).toBe('secondary')
  await ui.press({ key: 'numbers' })
  expect(await variant('numbers')).toBe('secondary')
  expect(await plain('keys')).toBe(true)
  await ui.press({ key: 'keys' })
  expect(await variant('keys')).toBe('secondary')
  // the pane's own words stay lower case on every pill
  for (const k of ['scope:all', 'scope:committed', 'scope:touched', 'ws', 'options', 'wrap', 'numbers', 'keys']) {
    const label = String((await ui.find({ key: k }))?.props.label ?? '')
    expect(label).toMatch(/^[a-z]/)
  }
  await ui.unmount()
})

test('copy path and a hunk\'s copy line / + comment are drawn always, dim, on every surface (no hover-only control)', async ($, on) => {
  wire(on)
  await $.tool.call(EDIT)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const root = (await ui.find({ type: 'Box' })) as Found
    for (const key of ['copy-file', 'cmt:0', 'copy:0']) {
      expect(await ui.find({ key })).toBeDefined()
      // no ancestor hides it until hovered: a keyboard user reaches it as drawn
      expect(parentOf(root, key)?.props?.display).toBeUndefined()
    }
    await ui.press({ key: 'copy-file' })
    await ui.unmount()
  }
})

test('the header, the list and each card are framed at full strength; the selected card in the accent', async ($, on) => {
  wire(on)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const root = (await ui.find({ type: 'Box' })) as Found
  const frames: Array<{ color: unknown; dim: unknown }> = []
  const walk = (n: Found) => {
    if (n.type === 'Box' && n.props?.borderStyle) frames.push({ color: n.props.borderColor, dim: n.props.borderDimColor })
    for (const c of n.children ?? []) walk(c)
  }
  walk(root)
  // v21 (defined blocks): the header, the file list and the one, selected, card (accent); none dim
  expect(frames).toEqual([
    { color: 'subtle', dim: undefined },
    { color: 'subtle', dim: undefined },
    { color: 'suggestion', dim: undefined },
  ])
  await ui.unmount()
})

test('empty and loading states: the first listing in flight reads as loading, never as "no repos"; a diff loading holds its room', async ($, on) => {
  let release: (() => void) | null = null
  const gate = new Promise<void>(r => (release = r))
  let reached: (() => void) | null = null
  const arrived = new Promise<void>(r => (reached = r))
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (e.argv[0] === 'python3') return { value: ok('[]') }
    if (a.includes('rev-parse --show-toplevel')) return { value: ok('/repos/tool\n') }
    // the first branch read waits until the test lets it go
    if (a.includes('rev-parse --abbrev-ref')) {
      reached!()
      await gate
      return { value: ok('feature/x\n') }
    }
    if (a.includes('merge-base HEAD origin/develop')) return { value: ok('base000\n') }
    if (a.includes('--numstat')) return { value: ok('1\t1\tsrc/a.ts\u0000') }
    if (a.includes('--name-status')) return { value: ok('M\u0000src/a.ts\u0000') }
    if (a.includes('ls-files')) return { value: ok('') }
    if (a.includes('base000 -- src/a.ts')) return { value: ok(PATCH) }
    return { value: ok('', 1) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  const edit = $.tool.call(EDIT)
  // the refresh is in flight (its first branch read has arrived and waits): the pane says so instead of "no repos"
  await arrived
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /^Looking for project repos…$/ })).toBeDefined()
  expect(await ui.find({ text: /No project repos yet/ })).toBeUndefined()
  release!()
  await edit
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
  expect(await ui.find({ text: /^Looking for project repos…$/ })).toBeUndefined()
  await ui.unmount()
})
