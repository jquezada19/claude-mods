// The test host runs under a real timer, but the mod's lib declares none.
declare const setTimeout: (callback: () => void, ms: number) => unknown
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ok = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const PANE_PROPS = {
  title: 'Repo diffs',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

// fake host: one worktree leased to this session, one repo touched by Edit
const PATCH_A = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
const PATCH_NEW = '--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,1 @@\n+fresh line\n'
function fakeGit(argv: readonly string[]) {
  const a = argv.join(' ')
  // toplevel and prefix as git gives them: an aliased path resolves to the real root
  if (a.includes('--show-prefix')) {
    const dir = argv[argv.indexOf('-C') + 1] ?? ''
    const rel = dir.replace(/^\/(repos|alias)\/tool\/?/, '')
    return ok(`/repos/tool\n${rel === '' ? '' : `${rel}/`}\n`)
  }
  if (a.includes('rev-parse --show-toplevel')) return ok('/repos/tool\n')
  if (a.includes('rev-parse --abbrev-ref')) return ok('feature/x\n')
  if (a.includes('merge-base HEAD origin/develop')) return ok('base000\n')
  if (a.includes('--numstat')) return ok('3\t1\tsrc/a.ts\u0000')
  if (a.includes('--name-status')) return ok('M\u0000src/a.ts\u0000')
  if (a.includes('ls-files --others')) return ok('new.md\u0000')
  // no conflicts: real git prints nothing and exits 0
  if (a.includes('ls-files -u')) return ok('')
  if (a.includes('base000 -- src/a.ts')) return ok(PATCH_A)
  if (a.includes('--no-index') && a.includes('new.md')) return ok(PATCH_NEW, 1)
  return ok('', 1)
}

test('tabs both repos, selects the first file and draws its hunks; another file switches', async ($, on) => {
  ledgerFs(on)
  on('process.run', async (_$, e) => ({ value: fakeGit(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)

  await $.tool.call({ tool: 'Edit', file_path: '/repos/tool/src/a.ts', old_string: 'old', new_string: 'new' })
  const out = await $.command.run({ command: 'diffs' } as never)
  expect(out.text).toContain('2 repo(s)')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'repo-diffs', surface, component: 'Pane', requestId: 'repo-diffs', props: PANE_PROPS })
    expect(await ui.find({ key: 'repo:/wt/app-1' })).toBeDefined()
    expect(await ui.find({ key: 'repo:/repos/tool' })).toBeDefined()
    expect(await ui.find({ text: /app-2/ })).toBeUndefined()
    // folder row, the selected file's card and one hunk
    expect(await ui.find({ key: 'dirbtn:/repos/tool\u0000src' })).toBeDefined()
    expect(await firstDiff(ui)).toBeDefined()
    expect(await ui.find({ text: /1\/2/ })).toBeDefined()

    expect((await codeText(ui))).toContain('+new')
    await ui.press({ key: 'btn:/repos/tool\u0000new.md' })
    expect(await ui.find({ text: /2\/2/ })).toBeDefined()
    expect((await codeText(ui))).toContain('+fresh line')
    await ui.press({ key: 'next' })
    expect(await ui.find({ text: /1\/2/ })).toBeDefined()

    // collapsing the folder hides its file row
    await ui.press({ key: 'dirbtn:/repos/tool\u0000src' })
    expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeUndefined()
    await ui.press({ key: 'dirbtn:/repos/tool\u0000src' })
    await ui.unmount()
  }
})

// The session ledger as files: one worktree leased to this session, one to another.
const LEASES: Record<string, Record<string, string>> = {
  a: { session_id: 'S1', worktree: '/wt/app-1', base_oid: 'abc12345' },
  b: { session_id: 'OTHER', worktree: '/wt/app-2', base_oid: 'def' },
}
function ledgerFs(on: On, leases: Record<string, Record<string, string>> | null = LEASES, counts = { lists: 0 }) {
  mock.env(on, { HOME: '/home/t' })
  on('fs.list', async (_$, e) => {
    if ((e as { path?: string }).path !== '/home/t/.claude/leases/worktree') throw new Error('no such folder')
    counts.lists++
    if (leases === null) throw new Error('unreadable')
    return { value: Object.keys(leases).map(name => ({ name, kind: 'dir' as const })) } as never
  })
  on('fs.read', async (_$, e) => {
    const m = /\/home\/t\/\.claude\/leases\/worktree\/([^/]+)\/lease\.json$/.exec((e as { path: string }).path)
    if (!m || !leases?.[m[1]!]) throw new Error('missing')
    return { value: JSON.stringify(leases[m[1]!]) } as never
  })
  return counts
}

function noLeases(argv: readonly string[]) {
  return fakeGit(argv)
}

const EDIT = { tool: 'Edit', file_path: '/repos/tool/src/a.ts', old_string: 'old', new_string: 'new' } as const

test('auto-opens the pane once, on the first repo', async ($, on) => {
  let opens = 0
  on('process.run', async (_$, e) => ({ value: noLeases(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => {
    opens++
    return { value: { isPlaced: true as const } }
  })
  on('tool.call', async () => ({ result: 'ok' }) as never)

  await $.tool.call(EDIT)
  expect(opens).toBe(1)
  await $.tool.call(EDIT)
  await $.tool.call({ ...EDIT, file_path: '/repos/tool/src/b.ts' })
  expect(opens).toBe(1)
})

test('an explicit /diffs counts as the open: no second auto-open', async ($, on) => {
  let opens = 0
  on('process.run', async (_$, e) => ({ value: noLeases(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => {
    opens++
    return { value: { isPlaced: true as const } }
  })
  on('tool.call', async () => ({ result: 'ok' }) as never)

  await $.command.run({ command: 'diffs' } as never)
  expect(opens).toBe(1)
  await $.tool.call(EDIT)
  expect(opens).toBe(1)
})

test('the lease ledger: an unreadable folder keeps the last good leases; an unreadable lease skips only itself', async ($, on) => {
  let leases: Record<string, Record<string, string>> | null = { ...LEASES, c: { session_id: 'S1', worktree: '/wt/app-3' } }
  mock.env(on, { HOME: '/home/t' })
  on('fs.list', async (_$, e) => {
    if ((e as { path?: string }).path !== '/home/t/.claude/leases/worktree') throw new Error('no such folder')
    if (leases === null) throw new Error('unreadable')
    return { value: [...Object.keys(leases), 'broken'].map(name => ({ name, kind: 'dir' as const })) } as never
  })
  on('fs.read', async (_$, e) => {
    const m = /\/worktree\/([^/]+)\/lease\.json$/.exec((e as { path: string }).path)
    if (m?.[1] === 'broken') return { value: '{ not json' } as never
    if (!m || !leases?.[m[1]!]) throw new Error('missing')
    return { value: JSON.stringify(leases[m[1]!]) } as never
  })
  on('process.run', async (_$, e) => ({ value: fakeGit(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'diffs' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'repo:/wt/app-1' })).toBeDefined()
  expect(await ui.find({ key: 'repo:/wt/app-3' })).toBeDefined()
  // the ledger becomes unreadable: the leased repos stay listed
  leases = null
  await $.command.run({ command: 'diffs' } as never)
  expect(await ui.find({ key: 'repo:/wt/app-1' })).toBeDefined()
  await ui.unmount()
})

test('a default branch other than develop, main or master is found through origin/HEAD', async ($, on) => {
  const calls: string[] = []
  wired(on, a => {
    calls.push(a)
    if (/merge-base HEAD origin\/(develop|main|master)$/.test(a)) return ok('', 1)
    if (a.includes('symbolic-ref --short refs/remotes/origin/HEAD')) return ok('origin/trunk\n')
    if (a.includes('merge-base HEAD origin/trunk')) return ok('trunk000\n')
    return null
  })
  await $.tool.call(EDIT)
  expect(calls.some(c => c.includes('--numstat') && c.endsWith('trunk000'))).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /origin\/trunk/ })).toBeDefined()
  await ui.unmount()
})

test('no repo, no auto-open', async ($, on) => {
  let opens = 0
  on('process.run', async (_$, e) => ({
    value: ok('', 128),
  }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => {
    opens++
    return { value: { isPlaced: true as const } }
  })
  on('tool.call', async () => ({ result: 'ok' }) as never)

  await $.tool.call({ ...EDIT, file_path: '/not/a/repo/x.ts' })
  expect(opens).toBe(0)
})

test('a burst of Bash calls refreshes once, after they go quiet', async ($, on) => {
  const clock = mock.clock(on)
  const ledger = ledgerFs(on)
  on('process.run', async (_$, e) => {
    return { value: fakeGit(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)

  const BASH = { tool: 'Bash', command: 'true' } as const
  await $.tool.call(BASH)
  await clock.advance(200)
  await $.tool.call(BASH)
  await clock.advance(200)
  await $.tool.call(BASH)
  expect(ledger.lists).toBe(0)
  await clock.advance(500)
  expect(ledger.lists).toBe(1)
})


const PANE = { plugin: 'repo-diffs', component: 'Pane', requestId: 'repo-diffs', props: PANE_PROPS } as const

// a run's line as the hunk had it: the drawing pads the marker a cell either
// side (` + new`), the hunk reads `+new`
const unpad = (src: string) => src.replace(/^ ([+\- ]) /gm, '$1')
// the diff text a drawn element carries: a syntax view's Code source, or the
// text of a tinted row: a Text with a wrap whose every line is a padded
// marker line (the host keeps no keys on nested elements)
const diffTextOf = (n: { type?: string; props?: Record<string, unknown>; children?: unknown[] }): string | undefined => {
  if (n.type === 'Code') return String(n.props?.source ?? '')
  if (n.type !== 'Text' || n.props?.wrap === undefined) return undefined
  // its own strings and those of the token spans inside it
  const all = (x: { children?: unknown[] }): string =>
    (x.children ?? []).map(c => (typeof c === 'string' ? c : c && typeof c === 'object' ? all(c as typeof x) : '')).join('')
  const t = all(n)
  return t !== '' && t.split('\n').every(l => /^ [+\- ] |^\\/.test(l)) ? t : undefined
}
// the first drawn diff element: a Code, or a tinted row's Text
async function firstDiff(ui: { find: (q: { type: string }) => Promise<unknown> }) {
  type N = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const walk = (n: N): N | undefined => {
    if (diffTextOf(n) !== undefined) return n
    for (const c of n.children ?? []) {
      const hit = c && typeof c === 'object' ? walk(c as N) : undefined
      if (hit) return hit
    }
    return undefined
  }
  const root = (await ui.find({ type: 'Box' })) as N | undefined
  return root ? walk(root) : undefined
}
// every drawn diff text, joined: runs split a hunk across several
async function codeText(ui: { find: (q: { type: string }) => Promise<unknown> }): Promise<string> {
  const out: string[] = []
  const walk = (n: { type?: string; props?: Record<string, unknown>; children?: unknown[] }) => {
    const t = diffTextOf(n)
    if (t !== undefined) out.push(t)
    for (const c of n.children ?? []) walk(c as typeof n)
  }
  const root = (await ui.find({ type: 'Box' })) as Parameters<typeof walk>[0] | undefined
  if (root) walk(root)
  return unpad(out.join('\n'))
}

test('a slow load of an earlier selection never overwrites the newer one', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  let slowArmed = false
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (slowArmed && a.includes('base000 -- src/a.ts')) await gate
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // select new.md, then go back to a.ts (slow), then forward to new.md again
  await ui.press({ key: 'btn:/repos/tool\u0000new.md' })
  slowArmed = true
  const slow = ui.press({ key: 'btn:/repos/tool\u0000src/a.ts' })
  await ui.press({ key: 'btn:/repos/tool\u0000new.md' })
  release()
  await slow
  expect((await codeText(ui))).toContain('+fresh line')
  expect(await ui.find({ text: /2\/2/ })).toBeDefined()
})

test('a failing git call keeps the last good listing, marked stale', async ($, on) => {
  let isBroken = false
  on('process.run', async (_$, e) => {
    if (isBroken && e.argv.includes('--numstat')) return { value: ok('', 128) }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  isBroken = true
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
  expect(await ui.find({ text: /git busy/ })).toBeDefined()
})

test('paths with tabs survive (-z), CRLF is cleaned, a failed diff says why', async ($, on) => {
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.includes('--numstat')) return { value: ok('1\t0\tweird\tname.ts\u00001\t1\tbroken.ts\u0000') }
    if (a.includes('--name-status')) return { value: ok('M\u0000weird\tname.ts\u0000M\u0000broken.ts\u0000') }
    if (a.includes('ls-files --others')) return { value: ok('') }
    if (a.includes('-- weird\tname.ts')) return { value: ok('@@ -1,1 +1,1 @@\r\n-x\r\n+y\r\n') }
    if (a.includes('-- broken.ts')) return { value: { ...ok(''), exitCode: 128, stderr: 'fatal: bad object' } }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // tree order: broken.ts, then weird<TAB>name.ts; broken.ts is selected first
  expect(await ui.find({ text: /Could not load this diff: fatal: bad object/ })).toBeDefined()
  await ui.press({ key: 'btn:/repos/tool\u0000weird\tname.ts' })
  const src = (await codeText(ui)) as string
  expect(src).toContain('+y')
  expect(src.includes('\r')).toBe(false)
})

test('an oversized first hunk is clipped to a valid hunk, not drawn whole', async ($, on) => {
  const big = '@@ -0,0 +1,30000 @@\n' + Array.from({ length: 30000 }, (_, i) => `+line ${i} of a very large added file`).join('\n') + '\n'
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.includes('base000 -- src/a.ts')) return { value: ok(big) }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the clipped hunk keeps a valid range on its band and its first lines
  const src = (await codeText(ui)) as string
  expect(src.length).toBeLessThanOrEqual(90000)
  // drawn whole: no part of it past the engine's 100,000 characters
  expect(src.startsWith('+line 0 of')).toBe(true)
  expect(await ui.find({ text: /^@@ -0,0 \+1,\d+ @@$/ })).toBeDefined()
  expect(await ui.find({ text: /Diff too large for the pane/ })).toBeDefined()
})

test('pressing another repo tab switches the header, tree and card to that repo', async ($, on) => {
  ledgerFs(on)
  on('process.run', async (_$, e) => ({ value: fakeGit(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)

  await $.tool.call(EDIT)
  await $.command.run({ command: 'diffs' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'repo-diffs', surface, component: 'Pane', requestId: 'repo-diffs', props: PANE_PROPS })
    expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
    await ui.press({ key: 'repo:/wt/app-1' })
    expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeUndefined()
    expect(await ui.find({ key: 'btn:/wt/app-1\u0000src/a.ts' })).toBeDefined()
    expect((await codeText(ui))).toContain('+new')
    await ui.press({ key: 'repo:/repos/tool' })
    expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
    await ui.unmount()
  }
})

test('scopes: Committed diffs merge-base..HEAD without untracked; Uncommitted diffs HEAD with them', async ($, on) => {
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    calls.push(e.argv.join(' '))
    return { value: fakeGit(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeDefined()

  calls.length = 0
  await ui.press({ key: 'scope:committed' })
  expect(calls.some(c => c.includes('--numstat') && c.endsWith('base000 HEAD'))).toBe(true)
  expect(calls.some(c => c.includes('ls-files --others'))).toBe(false)
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeUndefined()
  // what each scope means lives in the ? legend
  await ui.press({ key: 'keys' })
  expect(await ui.find({ text: /Commits since the base branch/ })).toBeDefined()
  await ui.press({ key: 'keys' })

  calls.length = 0
  await ui.press({ key: 'scope:touched' })
  expect(calls.some(c => c.includes('--numstat') && c.endsWith(' HEAD') && !c.includes('base000'))).toBe(true)
  expect(calls.some(c => c.includes('merge-base'))).toBe(false)
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeDefined()
  await ui.unmount()
})

test('last turn: only the files edited since the latest main turn started; denied edits and earlier turns left out; subagents count', async ($, on) => {
  on('process.run', async (_$, e) => ({ value: fakeGit(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  // A Write to new.md is denied; everything else runs.
  on('tool.call', async (_$, e) =>
    ((e as { file_path?: string }).file_path?.endsWith('new.md') ? { deny: 'not allowed' } : { result: 'ok' }) as never,
  )
  const WRITE_NEW = { tool: 'Write', file_path: '/repos/tool/new.md', content: 'x' } as const
  const A = 'btn:/repos/tool\u0000src/a.ts'
  const NEW = 'btn:/repos/tool\u0000new.md'
  await $.turn.start({ text: 'first', turnId: 'm1' } as never)
  await $.tool.call(EDIT)
  await $.tool.call(WRITE_NEW).catch(() => undefined)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // All: both changed files; last turn: only the edit that ran.
  expect(await ui.find({ key: A })).toBeDefined()
  expect(await ui.find({ key: NEW })).toBeDefined()
  await ui.press({ key: 'scope:turn' })
  expect(await ui.find({ key: A })).toBeDefined()
  expect(await ui.find({ key: NEW })).toBeUndefined()
  // A new main turn starts the list over; a subagent's turn does not.
  await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'sub-1' } as never)
  expect(await ui.find({ key: A })).toBeDefined()
  await $.turn.start({ text: 'second', turnId: 'm2' } as never)
  expect(await ui.find({ key: A })).toBeUndefined()
  // A subagent's edit inside the main turn is listed.
  await $.tool.call({ ...EDIT, agentId: 'sub-1' } as never)
  expect(await ui.find({ key: A })).toBeDefined()
  // What the scope means lives in the ? legend.
  await ui.press({ key: 'keys' })
  expect(await ui.find({ text: /Edit, Write or NotebookEdit/ })).toBeDefined()
  expect(await ui.find({ text: /shell commands are not counted/ })).toBeDefined()
  await ui.unmount()
})

test('last turn: an edit through an aliased path is matched as git names it; an edit that errored is left out', async ($, on) => {
  on('process.run', async (_$, e) => ({ value: fakeGit(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('tool.call', async (_$, e) =>
    ((e as { file_path?: string }).file_path?.endsWith('new.md') ? { result: 'failed', isError: true } : { result: 'ok' }) as never,
  )
  await $.turn.start({ text: 'first', turnId: 'm1' } as never)
  await $.tool.call({ ...EDIT, file_path: '/alias/tool/src/a.ts' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/repos/tool/new.md', content: 'x' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scope:turn' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeUndefined()
  await ui.unmount()
})

test('last turn: an edit still running when the next main turn starts belongs to neither', async ($, on) => {
  on('process.run', async (_$, e) => ({ value: fakeGit(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('tool.call', async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    return { result: 'ok' } as never
  })
  await $.turn.start({ text: 'first', turnId: 'm1' } as never)
  const slow = $.tool.call(EDIT)
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  await $.turn.start({ text: 'second', turnId: 'm2' } as never)
  await slow
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scope:turn' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeUndefined()
  await ui.unmount()
})

test('last turn: a turn that starts while git is still naming an edited file keeps it out', async ($, on) => {
  on('process.run', async (_$, e) => {
    // git is slow to name the file: the next main turn starts meanwhile
    if (e.argv.join(' ').includes('--show-prefix')) await new Promise<void>(resolve => setTimeout(resolve, 20))
    return { value: fakeGit(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.turn.start({ text: 'first', turnId: 'm1' } as never)
  const naming = $.tool.call(EDIT)
  await new Promise<void>(resolve => setTimeout(resolve, 5))
  await $.turn.start({ text: 'second', turnId: 'm2' } as never)
  await naming
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scope:turn' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeUndefined()
  await ui.unmount()
})

test('last turn: the list holds 500 files and says when a turn edited more', async ($, on) => {
  on('process.run', async (_$, e) => ({ value: fakeGit(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.turn.start({ text: 'big', turnId: 'm1' } as never)
  for (let i = 0; i < 500; i++) await $.tool.call({ ...EDIT, file_path: `/repos/tool/gen/f${i}.ts` } as never)
  // the 501st file: exactly one past the cap
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scope:turn' })
  expect(await ui.find({ text: /more than 500 files/ })).toBeDefined()
  // the list itself stopped at 500: the 501st file edited is not in it
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeUndefined()
  // a new turn starts the count over
  await $.turn.start({ text: 'small', turnId: 'm2' } as never)
  await ui.redraw()
  expect(await ui.find({ text: /more than 500 files/ })).toBeUndefined()
  await ui.unmount()
})

test('last turn ignores a picked commit: it lists the working tree against the base', async ($, on) => {
  laneWired(on)
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  await $.turn.start({ text: 'first', turnId: 'm1' } as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'commits-toggle' })
  await ui.press({ key: 'commit:c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000only-second.ts' })).toBeDefined()
  await ui.press({ key: 'scope:turn' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
  expect(await ui.find({ key: 'btn:/repos/tool\u0000only-second.ts' })).toBeUndefined()
  await ui.unmount()
})

test('a hunk comment, tagged, goes to the prompt box as one review block and then clears', async ($, on) => {
  const fills: string[] = []
  on('process.run', async (_$, e) => ({ value: noLeases(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('prompt.fill', async (_$, e) => {
    fills.push(e.text)
    return { isFilled: true }
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // a.ts is selected; its one hunk changes line 1
  expect(await ui.find({ key: 'cmt:0' })).toBeDefined()
  await ui.press({ key: 'cmt:0' })
  expect(await ui.find({ key: 'comment-input:src/a.ts:new:1' })).toBeDefined()
  await ui.press({ key: 'tag:must-fix' })
  await ui.input({ key: 'comment-input:src/a.ts:new:1', text: 'handle the null user id' })
  expect(await ui.find({ key: 'comment-input:src/a.ts:new:1' })).toBeUndefined()
  expect(await ui.find({ text: /handle the null user id/ })).toBeDefined()
  expect(await ui.find({ text: /✎1/ })).toBeDefined()

  // an empty submit adds nothing
  await ui.press({ key: 'cmt:0' })
  await ui.input({ key: 'comment-input:src/a.ts:new:1', text: '   ' })
  await ui.press({ key: 'cancel-comment' })
  expect(await ui.find({ text: /1 comment$/ })).toBeDefined()

  await ui.press({ key: 'send' })
  expect(fills).toHaveLength(1)
  expect(fills[0]).toContain('## Code review comments in tool')
  expect(fills[0]).toContain('- [must-fix] **src/a.ts:1** (new side): handle the null user id')
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  await ui.unmount()
})

test('comments stay when the prompt box refuses them', async ($, on) => {
  on('process.run', async (_$, e) => ({ value: noLeases(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('prompt.fill', async () => ({ isFilled: false, refusal: 'dialog' as const }))
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'cmt:0' })
  await ui.input({ key: 'comment-input:src/a.ts:new:1', text: 'keep me' })
  await ui.press({ key: 'send' })
  expect(await ui.find({ key: 'send' })).toBeDefined()
  expect(await ui.find({ text: /keep me/ })).toBeDefined()
  await ui.unmount()
})

test('the watcher refreshes when another session moves HEAD or edits files, and not otherwise', async ($, on) => {
  const clock = mock.clock(on)
  let headMtime = 1
  let status = ' M src/a.ts\u0000'
  let listings = 0
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.includes('--numstat')) listings++
    if (a.includes('rev-parse --absolute-git-dir')) return { value: ok('/repos/tool/.git\n.git\nrefs/heads/feature/x\n') }
    if (a.includes('status --porcelain')) return { value: ok(status) }
    return { value: noLeases(e.argv) }
  })
  on('fs.stat', async (_$, e) => ({
    value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: e.path.endsWith('/HEAD') ? headMtime : 1 },
  }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  expect(listings).toBe(1)

  // quiet repo: ticks pass, including a status tick, with no refresh
  await clock.advance(16_000)
  expect(listings).toBe(1)

  // a checkout or commit elsewhere touches HEAD: the next tick refreshes
  headMtime = 2
  await clock.advance(3_100)
  expect(listings).toBe(2)

  // an unstaged edit elsewhere shows only in status: caught within 5 ticks
  status = ' M src/a.ts\u0000 M src/b.ts\u0000'
  await clock.advance(16_000)
  expect(listings).toBe(3)
})

test('closing the pane stops the watch; /diffs brings it back; /clear re-arms auto-open and keeps the repos', async ($, on) => {
  const clock = mock.clock(on)
  let headMtime = 1
  let listings = 0
  let opens = 0
  const open = new Set<string>()
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.includes('--numstat')) listings++
    if (a.includes('rev-parse --absolute-git-dir')) return { value: ok('/repos/tool/.git\n.git\nrefs/heads/feature/x\n') }
    if (a.includes('status --porcelain')) return { value: ok(' M src/a.ts\u0000') }
    return { value: noLeases(e.argv) }
  })
  on('fs.stat', async (_$, e) => ({
    value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: e.path.endsWith('/HEAD') ? headMtime : 1 },
  }))
  on('session.id', async () => ({ value: 'S1' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async (_$, e) => {
    opens++
    open.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', async () => ({ value: [...open].map(id => ({ id, isPlaced: true })) }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  expect(listings).toBe(1)
  expect(opens).toBe(1)

  // positive control: while the pane is up, a HEAD move elsewhere refreshes on the next tick
  headMtime = 2
  await clock.advance(3_100)
  expect(listings).toBe(2)

  // the person closes the pane: the same change is no longer polled for
  open.delete('repo-diffs')
  await clock.advance(3_100)
  headMtime = 3
  await clock.advance(16_000)
  expect(listings).toBe(2)

  // /diffs reopens it and watching resumes
  await $.command.run({ command: 'diffs', args: '' } as never)
  expect(listings).toBe(3)
  headMtime = 4
  await clock.advance(3_100)
  expect(listings).toBe(4)

  // /clear: the pane may open itself again on the next edit; the repo stays listed
  open.delete('repo-diffs')
  await $.session.end({ reason: 'clear', sessionId: 'S1' } as never)
  await $.tool.call(EDIT)
  // a known file refreshes in the background: let it land
  await clock.advance(500)
  expect(opens).toBe(3)
})

test('a comment added while the prompt box is filling is kept, not cleared with the sent ones', async ($, on) => {
  let drive: { press: (t: { key: string }) => Promise<unknown>; input: (t: { key: string; text: string }) => Promise<unknown> } | null = null
  let fills = 0
  on('process.run', async (_$, e) => ({ value: noLeases(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('prompt.fill', async () => {
    fills++
    // the person adds a second comment before the fill settles
    await drive!.press({ key: 'cmt:0' })
    await drive!.input({ key: 'comment-input:src/a.ts:new:1', text: 'second' })
    return { isFilled: true }
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  drive = ui
  await ui.press({ key: 'cmt:0' })
  await ui.input({ key: 'comment-input:src/a.ts:new:1', text: 'first' })
  await ui.press({ key: 'send' })
  expect(fills).toBe(1)
  expect(await ui.find({ text: /second/ })).toBeDefined()
  expect(await ui.find({ text: /first/ })).toBeUndefined()
  await ui.unmount()
})

test('a re-click during a scope change never leaves the old scope\'s patch showing', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.includes('base000 HEAD -- src/a.ts')) {
      await gate
      return { value: ok('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+committed\n') }
    }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await codeText(ui))).toContain('+new')
  const switching = ui.press({ key: 'scope:committed' })
  await ui.press({ key: 'btn:/repos/tool\u0000src/a.ts' })
  release()
  await switching
  expect((await codeText(ui))).toContain('+committed')
  await ui.unmount()
})

test('the watcher sees a second edit to a modified file, a commit mid-refresh, and a fetch of the base', async ($, on) => {
  const clock = mock.clock(on)
  const mt: Record<string, number> = {}
  let listings = 0
  let onListing: (() => void) | null = null
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.includes('--numstat')) {
      listings++
      onListing?.()
      onListing = null
    }
    if (a.includes('rev-parse --absolute-git-dir')) return { value: ok('/repos/tool/.git\n.git\nrefs/heads/feature/x\n') }
    if (a.includes('status --porcelain')) return { value: ok(' M src/a.ts\u0000') }
    // as real git names the base for the watcher
    if (a.includes('rev-parse --symbolic-full-name origin/develop')) return { value: ok('refs/remotes/origin/develop\n') }
    return { value: noLeases(e.argv) }
  })
  on('fs.stat', async (_$, e) => ({ value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: mt[e.path] ?? 1 } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  await clock.advance(16_000)
  expect(listings).toBe(1)

  // same status line, but the file itself changed again
  mt['/repos/tool/src/a.ts'] = 2
  await clock.advance(16_000)
  expect(listings).toBe(2)

  // a commit lands while the listing is being read: caught on a later tick
  onListing = () => (mt['/repos/tool/.git/HEAD'] = 5)
  mt['/repos/tool/.git/index'] = 3
  await clock.advance(3_100)
  expect(listings).toBe(3)
  await clock.advance(3_100)
  expect(listings).toBe(4)

  // another process fetches origin/develop: the merge-base may move
  mt['/repos/tool/.git/refs/remotes/origin/develop'] = 9
  await clock.advance(3_100)
  expect(listings).toBe(5)
  await clock.advance(16_000)
  expect(listings).toBe(5)
})

test('file diffs pass --literal-pathspecs, so a file named *.ts is only that file', async ($, on) => {
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    calls.push([...e.argv])
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const fileDiffs = calls.filter(c => c.includes('--') && c.includes('src/a.ts'))
  expect(fileDiffs.length).toBeGreaterThan(0)
  for (const c of fileDiffs) {
    expect(c).toContain('--literal-pathspecs')
    expect(c).toContain('diff.suppressBlankEmpty=false')
  }
})

test('re-clicking the file while a refresh reloads it keeps the fresh patch', async ($, on) => {
  let content = 'new'
  let gated = false
  let release: () => void = () => {}
  let started: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const begun = new Promise<void>(r => (started = r))
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.includes('base000 -- src/a.ts')) {
      if (gated) {
        started()
        await gate
      }
      return { value: ok(`--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+${content}\n`) }
    }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await codeText(ui))).toContain('+new')
  // the file changes; a refresh starts reloading it, the person re-clicks it
  content = 'newer'
  gated = true
  const refreshing = ui.press({ key: 'refresh' })
  await begun
  await ui.press({ key: 'btn:/repos/tool\u0000src/a.ts' })
  release()
  await refreshing
  expect((await codeText(ui))).toContain('+newer')
  await ui.unmount()
})

test('a repo whose first listing failed is retried by the watcher once git recovers', async ($, on) => {
  const clock = mock.clock(on)
  let isBroken = true
  on('process.run', async (_$, e) => {
    if (isBroken && e.argv.includes('--numstat')) return { value: ok('', 128) }
    return { value: noLeases(e.argv) }
  })
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: 1 } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeUndefined()
  isBroken = false
  await clock.advance(16_000)
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
  await ui.unmount()
})

// two hunks, each with git's function context after the second @@
const PATCH_TWO = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,1 +1,1 @@ function first() {',
  '-old',
  '+new',
  '@@ -40,1 +40,1 @@ function second() {',
  '-x',
  '+y',
  '',
].join('\n')

function wired(on: On, route: (a: string, argv: readonly string[]) => ReturnType<typeof ok> | null) {
  on('process.run', async (_$, e) => ({ value: route(e.argv.join(' '), e.argv) ?? noLeases(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
}

test('D1: each hunk names the function git found for it', async ($, on) => {
  wired(on, a => (a.includes('base000 -- src/a.ts') ? ok(PATCH_TWO) : null))
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'options' })
  expect(await ui.find({ text: /in function first\(\) \{/ })).toBeDefined()
  expect(await ui.find({ text: /in function second\(\) \{/ })).toBeDefined()
  // numbered (default): the hunk's band carries its range; plain (g): the first changed line
  expect(await ui.find({ text: /^@@ -40,1 \+40,1 @@$/ })).toBeDefined()
  // the syntax view (g) keeps the same band
  await ui.press({ key: 'numbers' })
  expect(await ui.find({ text: /^@@ -40,1 \+40,1 @@$/ })).toBeDefined()
  await ui.unmount()
})

test('D2: a rebase with a conflict says so, flags the file ! (not U), and lists it first', async ($, on) => {
  wired(on, a => {
    if (a.includes('ls-files -u')) return ok('100644 aaa 2\tsrc/a.ts\u0000100644 bbb 3\tsrc/a.ts\u0000')
    if (a.includes('rev-parse --absolute-git-dir')) return ok('/repos/tool/.git\n.git\nrefs/heads/feature/x\n')
    return null
  })
  on('fs.exists', async (_$, e) => ({ value: e.path === '/repos/tool/.git/rebase-merge' }))
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /rebase in progress · 1 conflict to resolve/ })).toBeDefined()
  expect(await ui.find({ key: 'conflict:/repos/tool\u0000src/a.ts' })).toBeDefined()
  expect(await ui.find({ text: /Unresolved conflict \(rebase in progress\)/ })).toBeDefined()
  // the untracked file keeps its U; the conflict is never U
  expect(await ui.find({ text: /^conflict$/ })).toBeDefined()
  // conflicts are working-tree state: the Committed view leaves them out
  await ui.press({ key: 'scope:committed' })
  expect(await ui.find({ key: 'conflict:/repos/tool\u0000src/a.ts' })).toBeUndefined()
  await ui.unmount()
})

test('D3: n/p ask the pane to scroll; j/k step files; letters pause while typing', async ($, on) => {
  const toasts: string[] = []
  wired(on, a => (a.includes('base000 -- src/a.ts') ? ok(PATCH_TWO) : null))
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'options' })
  expect((await ui.find({ key: 'hunk-next' }))?.props.hotkey).toBe('n')
  expect((await ui.find({ key: 'hunk-prev' }))?.props.hotkey).toBe('p')
  expect((await ui.find({ key: 'next' }))?.props.hotkey).toBe('j')
  expect((await ui.find({ key: 'prev' }))?.props.hotkey).toBe('k')
  // the test host lays nothing out, so the scroll itself is refused; a press
  // still reaches $.ui.scroll and says why it did not move
  await ui.press({ key: 'hunk-next' })
  expect(toasts.some(t => t.startsWith('Repo diffs: could not scroll'))).toBe(true)
  await ui.press({ key: 'cmt:0' })
  expect((await ui.find({ key: 'next' }))?.props.hotkey).toBeUndefined()
  expect((await ui.find({ key: 'wrap' }))?.props.hotkey).toBeUndefined()
  await ui.unmount()
})

test('D4: copy puts the absolute path:line, or the file path, on the clipboard', async ($, on) => {
  const copied: string[] = []
  wired(on, () => null)
  on('ui.copy', async (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'copy:0' })
  await ui.press({ key: 'copy-file' })
  expect(copied).toEqual(['/repos/tool/src/a.ts:1', '/repos/tool/src/a.ts'])
  await ui.unmount()
})

test('D5: a rename lists once as old → new and its patch pairs both paths', async ($, on) => {
  const diffs: string[][] = []
  wired(on, (a, argv) => {
    if (a.includes('--numstat')) return ok('1\t1\t\u0000old/x.ts\u0000new/x.ts\u0000')
    if (a.includes('--name-status')) return ok('R090\u0000old/x.ts\u0000new/x.ts\u0000')
    if (a.includes('ls-files --others')) return ok('')
    if (argv.includes('new/x.ts')) {
      diffs.push([...argv])
      return ok('--- a/old/x.ts\n+++ b/new/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n')
    }
    return null
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new/x.ts' })).toBeDefined()
  expect(await ui.find({ key: 'btn:/repos/tool\u0000old/x.ts' })).toBeUndefined()
  expect(await ui.find({ text: /old\/x\.ts → / })).toBeDefined()
  const last = diffs[diffs.length - 1]!
  expect(last.slice(last.indexOf('--'))).toEqual(['--', 'old/x.ts', 'new/x.ts'])
  expect(last).toContain('-M')
  await ui.unmount()
})

test('D6: the wrap toggle switches the diff between wrapping and cutting long lines', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'options' })
  expect((await firstDiff(ui))?.props?.wrap).toBe('truncate-end')
  await ui.press({ key: 'wrap' })
  expect((await firstDiff(ui))?.props?.wrap).toBe('wrap')
  // and the syntax view (g) follows it
  await ui.press({ key: 'numbers' })
  expect((await ui.find({ type: 'Code' }))?.props.wrap).toBe('wrap')
  await ui.press({ key: 'wrap' })
  expect((await ui.find({ type: 'Code' }))?.props.wrap).toBe('truncate-end')
  await ui.unmount()
})

test('pan: a cut hunk with a long line scrolls sideways on its own ‹ ›, and wrap hides them', async ($, on) => {
  const long = 'x'.repeat(30) + 'TAIL' + 'y'.repeat(30)
  wired(on, a => (a.includes('base000 -- src/a.ts') ? ok(`--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,1 @@\n+${long}\n`) : null))
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'options' })
  const text = async () => unpad(diffTextOf((await firstDiff(ui)) as never) ?? '')
  expect(await text()).toContain(`+${long}`)
  await ui.press({ key: 'panr:0' })
  expect(await text()).toContain(`+${long.slice(20)}`)
  expect(await ui.find({ text: /^col 21$/ })).toBeDefined()
  await ui.press({ key: 'panr:0' })
  await ui.press({ key: 'panr:0' })
  await ui.press({ key: 'panr:0' })
  // held at the last stop: 64 columns leave the final 4 in view at column 61
  expect(await ui.find({ text: /^col 61$/ })).toBeDefined()
  expect(await text()).toContain('+yyyy')
  await ui.press({ key: 'panl:0' })
  expect(await ui.find({ text: /^col 41$/ })).toBeDefined()
  await ui.press({ key: 'wrap' })
  expect(await ui.find({ key: 'panr:0' })).toBeUndefined()
  expect(await text()).toContain(`+${long}`)
  await ui.unmount()
})

test('pan keys: a/d scroll the change n/p last landed on, show in the legend, and leave with wrap', async ($, on) => {
  const long = 'x'.repeat(30) + 'TAIL' + 'y'.repeat(30)
  wired(on, a => (a.includes('base000 -- src/a.ts') ? ok(`--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,1 @@\n+${long}\n`) : null))
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'options' })
  expect((await ui.find({ key: 'pan-right' }))?.props.hotkey).toBe('d')
  expect((await ui.find({ key: 'pan-left' }))?.props.hotkey).toBe('a')
  await ui.press({ key: 'pan-right' })
  expect(await ui.find({ text: /^col 21$/ })).toBeDefined()
  await ui.press({ key: 'pan-left' })
  expect(await ui.find({ text: /^col \d+$/ })).toBeUndefined()
  await ui.press({ key: 'wrap' })
  expect(await ui.find({ key: 'pan-right' })).toBeUndefined()
  await ui.unmount()
})

test('v4 review: a stopped git am is not a rebase, and a rebase --quit clears the warning', async ($, on) => {
  const clock = mock.clock(on)
  const present = new Set(['/repos/tool/.git/rebase-apply', '/repos/tool/.git/rebase-apply/applying'])
  wired(on, a => (a.includes('rev-parse --absolute-git-dir') ? ok('/repos/tool/.git\n.git\nrefs/heads/feature/x\n') : null))
  on('fs.exists', async (_$, e) => ({ value: present.has(e.path) }))
  on('fs.stat', async (_$, e) => {
    if (!present.has(e.path) && e.path.includes('rebase')) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: 1 } }
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /am in progress/ })).toBeDefined()
  expect(await ui.find({ text: /rebase in progress/ })).toBeUndefined()
  // the operation ends without touching HEAD or the index
  present.clear()
  await clock.advance(3_100)
  expect(await ui.find({ text: /in progress/ })).toBeUndefined()
  await ui.unmount()
})

test('v4 review: a cut-off conflict scan keeps the last good listing instead of a partial one', async ($, on) => {
  let cut = false
  wired(on, a => {
    if (a.includes('ls-files -u')) return cut ? { ...ok('100644 aaa 2\tsrc/a'), isStdoutTruncated: true } : ok('')
    return null
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  cut = true
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ text: /showing last good listing/ })).toBeDefined()
  expect(await ui.find({ text: /^conflict$/ })).toBeUndefined()
  await ui.unmount()
})

test('v4 review: copy on a deletion copies where it sits in the current file', async ($, on) => {
  const copied: string[] = []
  wired(on, a => (a.includes('base000 -- src/a.ts') ? ok('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -20,3 +5,1 @@\n-x\n-y\n z\n') : null))
  on('ui.copy', async (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.toast', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the plain view names the first changed line; numbered draws the range instead
  await ui.press({ key: 'copy:0' })
  expect(copied).toEqual(['/repos/tool/src/a.ts:5'])
  await ui.unmount()
})

test('v4 review: a renamed file\'s card never shows a neighbour git matched under the old path', async ($, on) => {
  wired(on, (a, argv) => {
    if (a.includes('--numstat')) return ok('1\t1\t\u0000old\u0000new\u0000')
    if (a.includes('--name-status')) return ok('R090\u0000old\u0000new\u0000')
    if (a.includes('ls-files --others')) return ok('')
    if (argv.includes('new'))
      return ok(
        'diff --git a/old b/new\nrename from old\nrename to new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-a\n+b\n' +
          'diff --git a/old/extra b/old/extra\nnew file mode 100644\n--- /dev/null\n+++ b/old/extra\n@@ -0,0 +1 @@\n+NEIGHBOUR\n',
      )
    return null
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const sources = await codeText(ui)
  expect(sources).toContain('+b')
  expect(sources).not.toContain('NEIGHBOUR')
  await ui.unmount()
})

const PR_JSON = JSON.stringify({
  number: 42,
  state: 'OPEN',
  isDraft: false,
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  url: 'https://github.com/o/r/pull/42',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-09T11:00:00Z' },
    { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-09T11:00:00Z', detailsUrl: 'https://x/test' },
    { __typename: 'CheckRun', name: 'lint', workflowName: 'CI', status: 'IN_PROGRESS', startedAt: '2026-10-09T11:00:00Z' },
  ],
})

// the async PR read lands after the listing: look until it does
// links by what they point at: a Link's key is not a lookup address here
const linkTo = async (ui: { findAll: (q: { type: string }) => Promise<Array<{ props: Record<string, unknown> }>> }, href: string) =>
  (await ui.findAll({ type: 'Link' })).find(l => l.props.href === href)

async function eventually<T>(redraw: () => Promise<void>, look: () => Promise<T | undefined>): Promise<T | undefined> {
  for (let i = 0; i < 50; i++) {
    const hit = await look()
    if (hit !== undefined) return hit
    await redraw()
  }
  return undefined
}

function prWired(on: On, gh: (argv: readonly string[]) => ReturnType<typeof ok>, head = { sha: 'aaa111' }) {
  const calls = { gh: 0 }
  wired(on, (a, argv) => {
    if (argv[0] === 'gh') {
      calls.gh++
      return gh(argv)
    }
    // as real git prints it: three lines, the commit from its own call
    if (a.includes('rev-parse --absolute-git-dir')) return ok('/repos/tool/.git\n.git\nrefs/heads/feature/x\n')
    if (a.includes('rev-parse --verify HEAD')) return ok(`${head.sha}\n`)
    return null
  })
  return calls
}

test('G1+G3: the header shows the branch PR with its checks, review state and links', async ($, on) => {
  const asked: string[][] = []
  const calls = prWired(on, argv => {
    asked.push([...argv])
    return argv[1] === 'pr' && argv[2] === 'view' && argv.includes('--json') ? ok(PR_JSON) : ok('', 1)
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // v21: the header starts folded; the PR detail is behind its chevron
  await ui.press({ key: 'hdr-fold' })
  const link = await eventually(() => ui.redraw(), () => linkTo(ui, 'https://github.com/o/r/pull/42'))
  expect(link?.props.label).toBe('PR #42')
  expect(await ui.find({ text: /^Open$/ })).toBeDefined()
  expect(await ui.find({ text: /✗ 1/ })).toBeDefined()
  expect(await ui.find({ text: /● 1/ })).toBeDefined()
  expect(await ui.find({ text: /✓ 1\/3/ })).toBeDefined()
  expect(await ui.find({ text: /^no review yet$/ })).toBeDefined()
  expect(await ui.find({ text: /^mergeable$/ })).toBeDefined()
  // v21: the failing checks sit behind one line with the count
  expect(await ui.find({ text: /^▸ 1 failing check$/ })).toBeDefined()
  await ui.press({ key: 'checks-fold' })
  expect((await linkTo(ui, 'https://x/test'))?.props.label).toBe('test')
  expect(calls.gh).toBe(1)
  // the branch is named, so a checkout mid-call cannot change the question
  expect(asked[0]!.slice(0, 4)).toEqual(['gh', 'pr', 'view', 'feature/x'])
  await ui.unmount()
})

test('G1: no PR is said plainly; a gh failure says unavailable; same head inside the TTL is not re-read', async ($, on) => {
  let answer = ok('', 1)
  answer = { ...ok('', 1), stderr: 'no pull requests found for branch "feature/x"' }
  const head = { sha: 'aaa111' }
  const calls = prWired(on, () => answer, head)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // v21: the header starts folded; the PR detail is behind its chevron
  await ui.press({ key: 'hdr-fold' })
  expect(await eventually(() => ui.redraw(), () => ui.find({ text: /No pull request for this branch/ }))).toBeDefined()
  // a refresh with the same branch@head inside the TTL asks gh nothing
  await ui.press({ key: 'refresh' })
  expect(calls.gh).toBe(1)
  // the branch moves: asked again, and this time gh cannot answer
  head.sha = 'bbb222'
  answer = { ...ok('', 4), stderr: 'To get started with GitHub CLI, please run:  gh auth login' }
  await ui.press({ key: 'refresh' })
  expect(await eventually(() => ui.redraw(), () => ui.find({ text: /PR status unavailable: To get started/ }))).toBeDefined()
  expect(calls.gh).toBe(2)
  await ui.unmount()
})

test('G2: hide globs drop files from the tree and totals, never a conflict, and persist', async ($, on) => {
  const stored: Record<string, unknown> = {}
  wired(on, a => (a.includes('ls-files -u') ? ok('100644 aaa 2\tconflicted.md\u0000') : null))
  on('store.set', async (_$, e) => {
    stored[e.key] = e.value
    return { value: undefined } as never
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeDefined()
  await ui.press({ key: 'edit-hide' })
  // letters pause while the field is open
  expect((await ui.find({ key: 'next' }))?.props.hotkey).toBeUndefined()
  await ui.input({ key: 'exclude-input', text: '*.md  ' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeUndefined()
  expect(await ui.find({ key: 'conflict:/repos/tool\u0000conflicted.md' })).toBeDefined()
  expect(await ui.find({ text: /^1 hidden$/ })).toBeDefined()
  expect(await ui.find({ text: /^Hiding \*\.md$/ })).toBeDefined()
  expect(stored.exclude).toEqual(['*.md'])
  expect((await ui.find({ key: 'next' }))?.props.hotkey).toBe('j')
  // "show" reveals them for now and keeps the saved patterns; "hide again" restores
  await ui.press({ key: 'show-hidden' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeDefined()
  expect(await ui.find({ text: /^Showing 1 hidden$/ })).toBeDefined()
  expect(stored.exclude).toEqual(['*.md'])
  await ui.press({ key: 'show-hidden' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeUndefined()
  expect(await ui.find({ text: /^1 hidden$/ })).toBeDefined()
  await ui.unmount()
})

test('G1: an open pane re-reads the PR once its answer is a minute old, with nothing changed locally', async ($, on) => {
  const clock = mock.clock(on)
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: 1 } }))
  const calls = prWired(on, () => ok(PR_JSON))
  await $.tool.call(EDIT)
  await clock.advance(0)
  expect(calls.gh).toBe(1)
  await clock.advance(31_000)
  expect(calls.gh).toBe(1)
  await clock.advance(46_000)
  expect(calls.gh).toBe(2)
})

test('G2: hide globs saved in an earlier session apply from the start', async ($, on) => {
  mock.store(on, { exclude: ['*.md'] })
  // the session's own folder is no repo, so it hides nothing
  wired(on, a => (a.includes('-C /elsewhere') ? ok('', 128) : null))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.start', async () => ({ cwd: '/elsewhere' }) as never)
  await $.session.start({ cwd: '/elsewhere' } as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeUndefined()
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
  await ui.unmount()
})

test('v5 review: an answer for the old branch is never shown, and a switch mid-call re-asks', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const head = { sha: 'aaa111' }
  const askedFor: string[] = []
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (e.argv[0] === 'gh') {
      const sha = head.sha
      askedFor.push(sha)
      // the first answer is held until the branch has moved on
      if (askedFor.length === 1) await gate
      return { value: ok(PR_JSON.replace('"number":42', `"number":${sha === 'aaa111' ? 42 : 43}`).replace('/pull/42', `/pull/${sha === 'aaa111' ? 42 : 43}`)) }
    }
    if (a.includes('rev-parse --absolute-git-dir')) return { value: ok('/repos/tool/.git\n.git\nrefs/heads/feature/x\n') }
    if (a.includes('rev-parse --verify HEAD')) return { value: ok(`${head.sha}\n`) }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  head.sha = 'bbb222'
  await ui.press({ key: 'refresh' })
  release()
  // the stale answer (42, for aaa111) is dropped; the re-ask answers 43
  const fresh = await eventually(() => ui.redraw(), () => linkTo(ui, 'https://github.com/o/r/pull/43'))
  expect(fresh?.props.label).toBe('PR #43')
  expect(await linkTo(ui, 'https://github.com/o/r/pull/42')).toBeUndefined()
  expect(askedFor).toEqual(['aaa111', 'bbb222'])
  await ui.unmount()
})

test('v5 review: tab counts and the empty tree follow the hide patterns', async ($, on) => {
  ledgerFs(on)
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.includes('ls-files -u')) return { value: ok('') }
    return { value: fakeGit(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('store.set', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'edit-hide' })
  await ui.input({ key: 'exclude-input', text: '*.md *.ts' })
  expect((await ui.find({ key: 'repo:/repos/tool' }))?.props.label).toBe('tool 0')
  expect(await ui.find({ text: /Every changed file is hidden/ })).toBeDefined()
  await ui.unmount()
})

test('v5 review: cut-off gh output says so instead of a JSON parse error', async ($, on) => {
  prWired(on, () => ({ ...ok(PR_JSON.slice(0, 40)), isStdoutTruncated: true }))
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // v21: the header starts folded; the PR detail is behind its chevron
  await ui.press({ key: 'hdr-fold' })
  expect(await eventually(() => ui.redraw(), () => ui.find({ text: /PR status unavailable: gh output too large/ }))).toBeDefined()
  await ui.unmount()
})

test('v5 review: while the new branch\'s PR is being asked for, the old branch\'s is not shown', async ($, on) => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  const head = { sha: 'aaa111' }
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (e.argv[0] === 'gh') {
      if (head.sha === 'bbb222') await gate
      const n = head.sha === 'aaa111' ? 42 : 43
      return { value: ok(PR_JSON.replace('"number":42', `"number":${n}`).replace('/pull/42', `/pull/${n}`)) }
    }
    if (a.includes('rev-parse --absolute-git-dir')) return { value: ok('/repos/tool/.git\n.git\nrefs/heads/feature/x\n') }
    if (a.includes('rev-parse --verify HEAD')) return { value: ok(`${head.sha}\n`) }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await eventually(() => ui.redraw(), () => linkTo(ui, 'https://github.com/o/r/pull/42'))).toBeDefined()
  head.sha = 'bbb222'
  await ui.press({ key: 'refresh' })
  await ui.redraw()
  expect(await linkTo(ui, 'https://github.com/o/r/pull/42')).toBeUndefined()
  release()
  expect(await eventually(() => ui.redraw(), () => linkTo(ui, 'https://github.com/o/r/pull/43'))).toBeDefined()
  await ui.unmount()
})

// ── lazygit steals (L1–L5)

const LOG_TWO =
  'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2\u001fc2c2c2c\u001fc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1\u001fDev\u001f1760000000\u001ffix: second\u001e\n' +
  'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1\u001fc1c1c1c\u001fbase000\u001fDev\u001f1759990000\u001ffeat: first\u001e\n'

function laneWired(on: On, opts: { prBase?: string; qaFetched?: boolean; commitFile?: string } = {}) {
  const cf = opts.commitFile ?? 'only-second.ts'
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    calls.push(a)
    if (e.argv[0] === 'gh') {
      return { value: ok(PR_JSON.replace('"url"', `"baseRefName":"${opts.prBase ?? 'develop'}","url"`)) }
    }
    if (a.includes('rev-parse --absolute-git-dir')) return { value: ok('/repos/tool/.git\n.git\nrefs/heads/feature/x\n') }
    if (a.includes('rev-parse --verify HEAD')) return { value: ok('aaa111\n') }
    if (a.includes('merge-base HEAD origin/qa')) return { value: opts.qaFetched === false ? ok('', 1) : ok('qa000\n') }
    if (a.includes('merge-base HEAD origin/main')) return { value: ok('main000\n') }
    if (a.includes('merge-base HEAD upstream/main')) return { value: ok('base000\n') }
    if (a.includes('rev-parse --symbolic-full-name upstream/main')) return { value: ok('refs/remotes/upstream/main\n') }
    if (a.includes(' log ')) return { value: ok(LOG_TWO) }
    if (a.includes('-- only-second.ts')) return { value: ok('--- a/only-second.ts\n+++ b/only-second.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n') }
    if (a.includes('--numstat') && a.includes('qa000')) return { value: ok('9\t0\tbackport.ts\u0000') }
    if (a.includes('--name-status') && a.includes('qa000')) return { value: ok('A\u0000backport.ts\u0000') }
    if (a.includes('--numstat') && a.includes('c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1 c2c2')) return { value: ok(`1\t1\t${cf}\u0000`) }
    if (a.includes('--name-status') && a.includes('c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1 c2c2')) return { value: ok(`M\u0000${cf}\u0000`) }
    if (a.includes('c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1 c2c2') && a.includes(`-- ${cf}`)) return { value: ok(`--- a/${cf}\n+++ b/${cf}\n@@ -1,1 +1,1 @@\n-x\n+y\n`) }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  return calls
}

test('L1: a PR that merges into qa makes origin/qa the base, and says so', async ($, on) => {
  laneWired(on, { prBase: 'qa' })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const row = await eventually(() => ui.redraw(), () => ui.find({ key: 'btn:/repos/tool\u0000backport.ts' }))
  expect(row).toBeDefined()
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeUndefined()
  expect((await ui.find({ key: 'base-menu' }))?.props.label).toBe('→ origin/qa (PR base) ▾')
  await ui.unmount()
})

test('L1: a PR base that is not fetched falls back once, with a note, and does not loop', async ($, on) => {
  const calls = laneWired(on, { prBase: 'qa', qaFetched: false })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await eventually(() => ui.redraw(), () => ui.find({ text: /origin\/qa not found locally/ }))).toBeDefined()
  for (let i = 0; i < 10; i++) await ui.redraw()
  const listings = calls.filter(c => c.includes('--numstat')).length
  expect(listings).toBeLessThanOrEqual(2)
  expect((await ui.find({ key: 'base-menu' }))?.props.label).toBe('→ origin/develop ▾')
  await ui.unmount()
})

test('L1: the picker sets a base for this repo, and auto hands it back', async ($, on) => {
  const calls = laneWired(on)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'base-menu' })
  expect((await ui.find({ key: 'next' }))?.props.hotkey).toBeUndefined()
  await ui.press({ key: 'base:origin/main' })
  expect((await ui.find({ key: 'base-menu' }))?.props.label).toBe('→ origin/main (picked) ▾')
  expect(calls.some(c => c.includes('--numstat') && c.includes('main000'))).toBe(true)
  await ui.press({ key: 'base-menu' })
  await ui.press({ key: 'base:auto' })
  // auto: the PR's base again (this fake PR merges into develop)
  expect((await ui.find({ key: 'base-menu' }))?.props.label).toBe('→ origin/develop (PR base) ▾')
  await ui.unmount()
})

test('L2: the branch commits list shows one commit alone, and back to the branch', async ($, on) => {
  const calls = laneWired(on)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'commits-toggle' }))?.props.label).toBe('▸ Commits (2)')
  await ui.press({ key: 'commits-toggle' })
  await ui.press({ key: 'commit:c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000only-second.ts' })).toBeDefined()
  // a single commit has no untracked files
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeUndefined()
  expect(await ui.find({ text: /Viewing commit c2c2c2c/ })).toBeDefined()
  expect(calls.some(c => c.includes(`log`) && c.includes('base000..HEAD'))).toBe(true)
  await ui.press({ key: 'commit-exit' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000new.md' })).toBeDefined()
  expect(await ui.find({ text: /Viewing commit/ })).toBeUndefined()
  await ui.unmount()
})

test('L3+L4: context lines step the patch call only; ignoring whitespace re-lists with -w', async ($, on) => {
  const calls = laneWired(on)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'options' })
  calls.length = 0
  await ui.press({ key: 'ctx-more' })
  expect(calls.some(c => c.includes('-U4') && c.includes('-- src/a.ts'))).toBe(true)
  expect(await ui.find({ text: /^±4 lines$/ })).toBeDefined()
  await ui.press({ key: 'ctx-less' })
  await ui.press({ key: 'ctx-less' })
  expect(await ui.find({ text: /^±2 lines$/ })).toBeDefined()
  expect(calls.some(c => c.includes('--numstat') && /-U\d/.test(c))).toBe(false)
  calls.length = 0
  await ui.press({ key: 'ws' })
  expect(calls.some(c => c.includes('--numstat') && c.includes(' -w '))).toBe(true)
  expect(calls.some(c => c.includes('-- src/a.ts') && c.includes(' -w'))).toBe(true)
  expect(await ui.find({ text: /no whitespace/ })).toBeDefined()
  await ui.unmount()
})

test('L5: ? shows the key legend, built from the same keys the buttons use', async ($, on) => {
  laneWired(on)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'options' })
  expect((await ui.find({ key: 'keys' }))?.props.hotkey).toBe('h')
  expect((await ui.find({ key: 'ctx-more' }))?.props.hotkey).toBe('m')
  expect((await ui.find({ key: 'ws' }))?.props.hotkey).toBe('i')
  expect(await ui.find({ text: /more \/ less context/ })).toBeUndefined()
  await ui.press({ key: 'keys' })
  expect(await ui.find({ text: /more \/ less context/ })).toBeDefined()
  expect(await ui.find({ text: /ignore whitespace/ })).toBeDefined()
  await ui.unmount()
})

test('L1: an unfetched PR base costs one extra listing per session, not one per PR re-read', async ($, on) => {
  const clock = mock.clock(on)
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: 1 } }))
  const calls = laneWired(on, { prBase: 'qa', qaFetched: false })
  await $.tool.call(EDIT)
  await clock.advance(0)
  const settled = calls.filter(c => c.includes('--numstat')).length
  // five PR re-reads (60 s TTL, checked on 15 s ticks)
  await clock.advance(5 * 61_000)
  const gh = calls.filter(c => c.startsWith('gh ')).length
  expect(gh).toBeGreaterThanOrEqual(4)
  expect(calls.filter(c => c.includes('--numstat')).length).toBe(settled)
})

test('L2: a comment written on one commit stays with that commit, not the branch view', async ($, on) => {
  // the commit and the branch both change src/a.ts at line 1
  laneWired(on, { commitFile: 'src/a.ts' })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'commits-toggle' })
  await ui.press({ key: 'commit:c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2' })
  await ui.press({ key: 'btn:/repos/tool\u0000src/a.ts' })
  await ui.press({ key: 'cmt:0' })
  await ui.input({ key: 'comment-input:src/a.ts:new:1', text: 'on the commit' })
  expect(await ui.find({ text: /Comments on lines not shown/ })).toBeUndefined()
  await ui.press({ key: 'commit-exit' })
  await ui.press({ key: 'btn:/repos/tool\u0000src/a.ts' })
  // the branch view's line 1 is other code: the comment waits in "not shown here"
  expect(await ui.find({ text: /Comments on lines not shown/ })).toBeDefined()
  await ui.unmount()
})

// ── v6 review fixes

function switchWired(on: On, state: { branch: string; gate?: Promise<void> }, calls: string[] = []) {
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    calls.push(a)
    if (e.argv[0] === 'gh') {
      const b = state.branch
      if (b === 'feature/b' && state.gate) await state.gate
      const base = b === 'feature/a' ? 'qa' : 'develop'
      return { value: ok(PR_JSON.replace('"url"', `"baseRefName":"${base}","url"`)) }
    }
    if (a.includes('rev-parse --abbrev-ref HEAD')) return { value: ok(`${state.branch}\n`) }
    if (a.includes('rev-parse --verify HEAD')) return { value: ok(state.branch === 'feature/a' ? 'aaa111\n' : 'bbb222\n') }
    if (a.includes('rev-parse --absolute-git-dir')) return { value: ok(`/repos/tool/.git\n.git\nrefs/heads/${state.branch}\n`) }
    if (a.includes('merge-base HEAD origin/qa')) return { value: ok('qa000\n') }
    if (a.includes('--numstat') && a.includes('qa000')) return { value: ok('9\t0\tbackport.ts\u0000') }
    if (a.includes('--name-status') && a.includes('qa000')) return { value: ok('A\u0000backport.ts\u0000') }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  return calls
}

test('v6 review: after a branch switch, the old branch\'s PR base never sets the new branch\'s base', async ($, on) => {
  let release: () => void = () => {}
  const state = { branch: 'feature/a', gate: new Promise<void>(r => (release = r)) as Promise<void> | undefined }
  switchWired(on, state)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await eventually(() => ui.redraw(), async () => ((await ui.find({ key: 'base-menu' }))?.props.label === '→ origin/qa (PR base) ▾' ? true : undefined))).toBe(true)
  // switch to feature/b; its PR answer is held, so only the stale feature/a answer is cached
  state.branch = 'feature/b'
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ key: 'base-menu' }))?.props.label).toBe('→ origin/develop ▾')
  expect(await ui.find({ key: 'btn:/repos/tool\u0000backport.ts' })).toBeUndefined()
  release()
  await ui.unmount()
})

test('v6 review: a retarget qa → main → qa re-lists every time; an unchanged target does not', async ($, on) => {
  const clock = mock.clock(on)
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: 1 } }))
  let target = 'qa'
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    calls.push(a)
    if (e.argv[0] === 'gh') return { value: ok(PR_JSON.replace('"url"', `"baseRefName":"${target}","url"`)) }
    if (a.includes('rev-parse --verify HEAD')) return { value: ok('aaa111\n') }
    if (a.includes('rev-parse --absolute-git-dir')) return { value: ok('/repos/tool/.git\n.git\nrefs/heads/feature/x\n') }
    if (a.includes('merge-base HEAD origin/qa')) return { value: ok('qa000\n') }
    if (a.includes('merge-base HEAD origin/main')) return { value: ok('main000\n') }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  const listedAgainst = (sha: string) => calls.filter(c => c.includes('--numstat') && c.includes(sha)).length
  await $.tool.call(EDIT)
  await clock.advance(0)
  expect(listedAgainst('qa000')).toBe(1)
  target = 'main'
  await clock.advance(76_000)
  expect(listedAgainst('main000')).toBe(1)
  target = 'qa'
  await clock.advance(76_000)
  expect(listedAgainst('qa000')).toBe(2)
  // nothing retargeted: a minute passes without another listing
  await clock.advance(76_000)
  expect(listedAgainst('qa000')).toBe(2)
})

test('v6 review: a picked base is watched under the ref git names, even while a commit is shown', async ($, on) => {
  const clock = mock.clock(on)
  const mt: Record<string, number> = {}
  const calls = laneWired(on)
  on('fs.stat', async (_$, e) => ({ value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: mt[e.path] ?? 1 } }))
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'base-menu' })
  await ui.input({ key: 'base-input', text: 'upstream/main' })
  expect((await ui.find({ key: 'base-menu' }))?.props.label).toBe('→ upstream/main (picked) ▾')
  await ui.press({ key: 'commits-toggle' })
  await ui.press({ key: 'commit:c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2' })
  await clock.advance(3_100)
  const before = calls.filter(c => c.includes('--numstat')).length
  // a fetch moves upstream/main: its loose ref file changes
  mt['/repos/tool/.git/refs/remotes/upstream/main'] = 9
  await clock.advance(3_100)
  expect(calls.filter(c => c.includes('--numstat')).length).toBe(before + 1)
  await ui.unmount()
})

test('v6 review: the whitespace toggle stays reachable when ignoring whitespace empties the tree', async ($, on) => {
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.includes(' -w ') && (a.includes('--numstat') || a.includes('--name-status'))) return { value: ok('') }
    if (a.includes('ls-files --others')) return { value: ok('') }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'ws' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'ws' })).toBeDefined()
  await ui.press({ key: 'ws' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
  await ui.unmount()
})

test('v6 review: a typed base starting with - never reaches git', async ($, on) => {
  const calls = laneWired(on)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'base-menu' })
  await ui.input({ key: 'base-input', text: '--output=/tmp/x' })
  expect(calls.some(c => c.includes('--output=/tmp/x'))).toBe(false)
  await ui.unmount()
})

test('v6 review: a commit picked while an older refresh runs is not dropped by it', async ($, on) => {
  let release: () => void = () => {}
  let gated = false
  const gate = new Promise<void>(r => (release = r))
  const calls: string[] = []
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    calls.push(a)
    if (gated && a.includes('--numstat') && !a.includes('c2c2')) {
      gated = false
      await gate
    }
    if (a.includes('rev-parse --verify HEAD')) return { value: ok('aaa111\n') }
    if (a.includes(' log ')) return { value: ok(LOG_TWO) }
    if (a.includes('--numstat') && a.includes('c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1 c2c2')) return { value: ok('1\t1\tonly-second.ts\u0000') }
    if (a.includes('--name-status') && a.includes('c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1 c2c2')) return { value: ok('M\u0000only-second.ts\u0000') }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'commits-toggle' })
  // an older refresh starts (a later edit to a known repo refreshes without
  // waiting) and stalls in its listing
  gated = true
  await $.tool.call(EDIT)
  // the person picks a commit meanwhile; that refresh queues behind the stalled one
  const picking = ui.press({ key: 'commit:c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2' })
  release()
  await picking
  await ui.redraw()
  expect(await ui.find({ text: /Viewing commit c2c2c2c/ })).toBeDefined()
  await ui.unmount()
})

test('v6 review: viewing a commit does not make each PR re-read re-list the branch', async ($, on) => {
  const clock = mock.clock(on)
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: 1, isLink: false, mtimeMs: 1 } }))
  const calls = laneWired(on)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'commits-toggle' })
  await ui.press({ key: 'commit:c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2' })
  await clock.advance(3_100)
  const before = calls.filter(c => c.includes('--numstat')).length
  await clock.advance(2 * 61_000)
  expect(calls.filter(c => c.startsWith('gh ')).length).toBeGreaterThanOrEqual(2)
  expect(calls.filter(c => c.includes('--numstat')).length).toBe(before)
  await ui.unmount()
})

test('UI review: Clear asks before dropping every comment, and Keep keeps them', async ($, on) => {
  on('process.run', async (_$, e) => ({ value: noLeases(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'cmt:0' })
  await ui.input({ key: 'comment-input:src/a.ts:new:1', text: 'keep this one' })
  // one press only asks
  await ui.press({ key: 'clear' })
  expect(await ui.find({ text: /keep this one/ })).toBeDefined()
  expect(await ui.find({ text: /Clear 1 comment\? This can't be undone\./ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  await ui.press({ key: 'clear-no' })
  expect(await ui.find({ text: /keep this one/ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeDefined()
  // confirmed, they go
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'clear-yes' })
  expect(await ui.find({ text: /keep this one/ })).toBeUndefined()
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  // the next comment starts with Send, not a leftover question
  await ui.press({ key: 'cmt:0' })
  await ui.input({ key: 'comment-input:src/a.ts:new:1', text: 'zebra note' })
  expect(await ui.find({ key: 'send' })).toBeDefined()
  // the question left open while the last comment is removed by hand
  await ui.press({ key: 'clear' })
  const rm = await ui.find({ type: 'Button', text: /^✕ remove$/ })
  expect(rm).toBeDefined()
  await ui.press({ key: rm!.props.key as string })
  expect(await ui.find({ text: /zebra note/ })).toBeUndefined()
  await ui.press({ key: 'cmt:0' })
  await ui.input({ key: 'comment-input:src/a.ts:new:1', text: 'after' })
  expect(await ui.find({ key: 'send' })).toBeDefined()
  await ui.unmount()
})

test('UI review: a diff that failed to load offers Retry, which loads it again', async ($, on) => {
  let isBroken = true
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (isBroken && a.includes('base000 -- src/a.ts')) return { value: { ...ok(''), exitCode: 128, stderr: 'fatal: bad object' } }
    return { value: noLeases(e.argv) }
  })
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Could not load this diff: fatal: bad object/ })).toBeDefined()
  expect(await ui.find({ key: 'retry-diff' })).toBeDefined()
  isBroken = false
  await ui.press({ key: 'retry-diff' })
  expect((await codeText(ui))).toContain('+new')
  expect(await ui.find({ key: 'retry-diff' })).toBeUndefined()
  await ui.unmount()
})

// paging on the terminal, whose room holds every page; a remote surface's
// smaller room is the size test below
test('perf: a large tree draws 150 rows, keeps the selected file drawn, and shows more on request', async ($, on) => {
  const names = Array.from({ length: 200 }, (_, i) => `f${String(i + 1).padStart(3, '0')}.ts`)
  wired(on, a => {
    if (a.includes('--numstat')) return ok(names.map(n => `1\t0\t${n}\u0000`).join(''))
    if (a.includes('--name-status')) return ok(names.map(n => `M\u0000${n}\u0000`).join(''))
    return null
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = (n: string) => ui.find({ key: `btn:/repos/tool\u0000${n}` })
  // 201 rows (200 + the untracked new.md): the first 150 are drawn
  expect(await row('f150.ts')).toBeDefined()
  expect(await row('f151.ts')).toBeUndefined()
  expect(await ui.find({ text: /^show 51 more$/ })).toBeDefined()
  // stepping back from the first file lands on the last row, drawn after a gap marker
  await ui.press({ key: 'prev' })
  expect(await row('new.md')).toBeDefined()
  expect(await ui.find({ text: /^⋯ 50 rows$/ })).toBeDefined()
  expect(await row('f151.ts')).toBeUndefined()
  await ui.press({ key: 'tree-more' })
  expect(await row('f151.ts')).toBeDefined()
  expect(await row('f200.ts')).toBeDefined()
  expect(await ui.find({ key: 'tree-more' })).toBeUndefined()
  await ui.unmount()
})

// a remote surface drops a whole drawing past its own bound (the desktop's
// "nothing to show yet"), so a big change set is fitted to the pane's room
test('size: a big change set on the desktop draws what fits, keeps the selected file, and says what it left out', async ($, on) => {
  const names = Array.from({ length: 229 }, (_, i) => `f${String(i + 1).padStart(3, '0')}.ts`)
  const patchOf = (n: string) =>
    `diff --git a/${n} b/${n}\n--- a/${n}\n+++ b/${n}\n@@ -1,0 +1,40 @@\n` +
    Array.from({ length: 40 }, (_, i) => `+export const v${i} = ${i} // ${n}`).join('\n') +
    '\n'
  wired(on, a => {
    const m = /base000 -- (f\d+\.ts)$/.exec(a)
    if (m) return ok(patchOf(m[1]!))
    if (a.includes('--numstat')) return ok(names.map(n => `40\t0\t${n}\u0000`).join(''))
    if (a.includes('--name-status')) return ok(names.map(n => `A\u0000${n}\u0000`).join(''))
    return null
  })
  await $.tool.call(EDIT)
  const sizes: Record<string, number> = {}
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    let nodes = 0
    const count = (n: Found) => {
      nodes++
      for (const c of n.children ?? []) count(c)
    }
    count((await ui.find({ type: 'Box' })) as Found)
    sizes[surface] = nodes
    if (surface === 'desktop') {
      // the drawing stays under the remote room (this host also counts each
      // string child, ~1.2-1.3x the mod's count: 1,300 there), under the
      // terminal's, and says what it left out
      expect(nodes).toBeLessThanOrEqual(1_700)
      expect(nodes).toBeLessThan(sizes.terminal!)
      expect(await ui.find({ text: /more than this pane draws at once/ })).toBeDefined()
      expect(await ui.find({ key: 'tree-more' })).toBeUndefined()
      expect(await ui.find({ key: 'files-more' })).toBeUndefined()
    } else {
      // the terminal's room holds the usual pages
      expect(await ui.find({ key: 'files-more' })).toBeDefined()
    }
    // the selected file's container is always drawn
    expect(await containerOf(ui, FOLD())).toBeDefined()
    // stepping back from the first file lands on the last row, drawn wherever it sits
    await ui.press({ key: 'prev' })
    expect(await ui.find({ key: `btn:/repos/tool\u0000new.md` })).toBeDefined()
    expect(await containerOf(ui, FOLD())).toBeDefined()
    await ui.press({ key: 'next' })
    await ui.unmount()
  }
})

// every Text under a found element, depth first
type Found = { type: string; key?: string; props: Record<string, unknown>; text?: string; children?: Found[] }
const texts = (el: Found | undefined): Found[] =>
  !el ? [] : [...(el.type === 'Text' ? [el] : []), ...(el.children ?? []).flatMap(c => texts(c as Found))]
// the tree row holding a file's button: that button's grandparent Box
function rowOf(root: Found | undefined, buttonKey: string): Found | undefined {
  const walk = (n: Found, up: Found[]): Found | undefined => {
    if (n.type === 'Button' && (n.key ?? n.props?.key) === buttonKey) return up[up.length - 2]
    for (const c of n.children ?? []) {
      const hit = walk(c, [...up, n])
      if (hit) return hit
    }
    return undefined
  }
  return root ? walk(root, []) : undefined
}

// a file's container: the test host keeps no Box keys, so it is the framed Box
// around the container's own fold chevron (`fold` on the selected file,
// `fold@<root>\0<path>` on the others)
const KEY = (path: string) => `/repos/tool\u0000${path}`
const FOLD = (path?: string) => (path ? `fold@${KEY(path)}` : 'fold')
async function containerOf(ui: { find: (q: { type: string }) => Promise<unknown> }, foldKey: string): Promise<Found | undefined> {
  const walk = (n: Found, frame: Found | undefined): Found | undefined => {
    const here = n.type === 'Box' && n.props?.borderStyle ? n : frame
    if (n.type === 'Button' && (n.key ?? n.props?.key) === foldKey) return here
    for (const c of n.children ?? []) {
      const hit = walk(c, here)
      if (hit) return hit
    }
    return undefined
  }
  const root = (await ui.find({ type: 'Box' })) as Found | undefined
  return root ? walk(root, undefined) : undefined
}
// the props of every Code drawn inside a container; no container is its own failure
async function codesIn(ui: { find: (q: { type: string }) => Promise<unknown> }, foldKey: string): Promise<Array<Record<string, unknown>>> {
  const box = await containerOf(ui, foldKey)
  if (!box) throw new Error(`no container holding ${foldKey}`)
  const out: Array<Record<string, unknown>> = []
  const walk = (n: Found) => {
    if (n.type === 'Code') out.push(n.props)
    else {
      const t = diffTextOf(n)
      if (t !== undefined) out.push({ source: t })
    }
    for (const c of n.children ?? []) walk(c)
  }
  walk(box)
  return out
}
// every Button key drawn inside a container
async function buttonsIn(ui: { find: (q: { type: string }) => Promise<unknown> }, foldKey: string): Promise<string[]> {
  const box = await containerOf(ui, foldKey)
  if (!box) throw new Error(`no container holding ${foldKey}`)
  const out: string[] = []
  const walk = (n: Found) => {
    if (n.type === 'Button') out.push(String(n.key ?? n.props?.key))
    for (const c of n.children ?? []) walk(c)
  }
  walk(box)
  return out
}

test('contrast R2: secondary controls dim on desktop, never on the terminal', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desk.find({ key: 'refresh' }))?.props.dimColor).toBe(true)
  expect((await desk.find({ key: 'scope:committed' }))?.props.dimColor).toBe(true)
  await desk.unmount()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ key: 'refresh' }))?.props.dimColor).toBe(false)
  expect((await term.find({ key: 'scope:committed' }))?.props.dimColor).toBe(false)
  expect((await term.find({ key: 'dirbtn:/repos/tool\u0000src' }))?.props.dimColor).toBe(false)
  await term.unmount()
})

test('contrast R1: the selected tree row draws its letter and counts in the text colour', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // src/a.ts is selected; new.md is not
  const root = (await ui.find({ type: 'Box' })) as Found | undefined
  const sel = texts(rowOf(root, 'btn:/repos/tool\u0000src/a.ts'))
  expect(sel.length).toBeGreaterThan(0)
  expect(sel.filter(t => t.props?.color !== undefined)).toEqual([])
  const other = texts(rowOf(root, 'btn:/repos/tool\u0000new.md'))
  expect(other.some(t => t.props?.color === "success")).toBe(true)
  await ui.unmount()
})

test('N1: the comment field is named by its line, not only by a placeholder', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'cmt:0' })
  expect((await ui.find({ key: 'comment-input:src/a.ts:new:1' }))?.props.label).toBe('Comment on line 1')
  await ui.unmount()
})

test('N2: the compare-against picker has its own Cancel', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'base-menu' })
  expect(await ui.find({ key: 'base-input' })).toBeDefined()
  await ui.press({ key: 'cancel-base' })
  expect(await ui.find({ key: 'base-input' })).toBeUndefined()
  await ui.unmount()
})

test('P1: the phone offers no comment it cannot take', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ key: 'cmt:0' })).toBeDefined()
  await desk.unmount()
  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await firstDiff(phone)).toBeDefined()
  expect(await phone.find({ key: 'cmt:0' })).toBeUndefined()
  await phone.unmount()
})

test('P2: plain controls read lower case; names from the repo keep theirs', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // open what holds the most plain controls: the base picker and a comment's composer
  await ui.press({ key: 'base-menu' })
  await ui.press({ key: 'cmt:0' })
  const buttons: Found[] = []
  const walk = (n: Found) => {
    if (n.type === 'Button') buttons.push(n)
    for (const c of n.children ?? []) walk(c)
  }
  walk((await ui.find({ type: 'Box' })) as Found)
  // file, folder, commit and repo names are content, not wording
  const isContent = (k: string) => /^(btn|dirbtn|conflict|commit|repo|base):/.test(k)
  const plain = buttons.filter(b => b.props?.plain && !isContent(String(b.key ?? b.props?.key ?? '')))
  expect(plain.length).toBeGreaterThan(10)
  const labels = plain.map(b => String(b.props?.label ?? b.text ?? '').trim())
  // the controls this test is about are in the set it reads
  expect(labels).toContain('hide…')
  expect(labels).toContain('show full file')
  expect(labels).toContain('cancel')
  expect(labels.filter(t => /^[A-Z]/.test(t))).toEqual([])
  await ui.unmount()
})

test('panels: header, file list and each file container are framed; a narrow pane goes flat', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const framed = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE_PROPS, bodyColumns }, surface: 'desktop' })
    const boxes: Found[] = []
    const walk = (n: Found) => {
      if (n.type === 'Box' && n.props?.borderStyle) boxes.push(n)
      for (const c of n.children ?? []) walk(c)
    }
    walk((await ui.find({ type: 'Box' })) as Found)
    // the file list's title says what it lists
    const title = await ui.find({ text: /Files$/ })
    await ui.unmount()
    return { frames: boxes.map(b => `${b.props.borderStyle}/${b.props.borderColor}`), hasTitle: Boolean(title) }
  }
  // header, file list, then one container per file: the selected one in the accent
  // v21: header, list and each card are framed (defined blocks)
  expect(await framed(100)).toEqual({ frames: ['round/subtle', 'round/subtle', 'round/suggestion', 'round/subtle'], hasTitle: true })
  expect((await framed(30)).frames).toEqual([])
})

test('a comment left open on one file does not hold the keys hostage on another', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'cmt:0' })
  // while typing, letters pause
  expect((await ui.find({ key: 'next' }))?.props.hotkey).toBeUndefined()
  // another file: the draft is not on screen, so the keys come back
  await ui.press({ key: 'btn:/repos/tool\u0000new.md' })
  expect(await ui.find({ key: 'comment-input:src/a.ts:new:1' })).toBeUndefined()
  expect((await ui.find({ key: 'next' }))?.props.hotkey).toBe('j')
  await ui.unmount()
})

test('viewed: v marks the file, moves on, folds it, counts it, and a change resets it', async ($, on) => {
  let added = 3
  const stored: Record<string, unknown> = {}
  wired(on, a => (a.includes('--numstat') ? ok(`${added}\t1\tsrc/a.ts\u0000`) : null))
  on('store.set', async (_$, e) => {
    stored[e.key] = e.value
    return { value: undefined } as never
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const A = 'btn:/repos/tool\u0000src/a.ts'
  expect(await ui.find({ text: /Files$/ })).toBeDefined()
  expect((await ui.find({ key: 'viewed' }))?.props.hotkey).toBe('v')
  // marking a.ts moves to the next unviewed file
  await ui.press({ key: 'viewed' })
  expect(await ui.find({ text: /^· 1\/2 viewed$/ })).toBeDefined()
  expect(await ui.find({ text: /^2\/2$/ })).toBeDefined()
  expect(Object.keys(stored.viewed as object)).toEqual(['/repos/tool\u0000src/a.ts'])
  // back on a.ts: its container folds to its header, the diff a press away
  await ui.press({ key: A })
  expect(await codesIn(ui, FOLD())).toEqual([])
  expect(await ui.find({ text: /^✓ Viewed$/ })).toBeDefined()
  await ui.press({ key: 'open-viewed' })
  expect((await codesIn(ui, FOLD())).length).toBeGreaterThan(0)
  expect((await ui.find({ key: 'viewed' }))?.props.label).toBe('✓ viewed')
  // the file changes: the mark no longer holds
  added = 9
  await $.tool.call(EDIT)
  expect(await ui.find({ text: /Files$/ })).toBeDefined()
  expect((await ui.find({ key: 'viewed' }))?.props.label).toBe('viewed')
  await ui.unmount()
})

test('viewed: same counts, new content un-views the file', async ($, on) => {
  let blob = 'a1a1a1'
  const asked: string[] = []
  wired(on, a => {
    if (a.includes('hash-object')) {
      asked.push(a)
      return ok(`${blob}\n`)
    }
    return null
  })
  on('store.set', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const A = 'btn:/repos/tool\u0000src/a.ts'
  await ui.press({ key: 'viewed' })
  await ui.press({ key: A })
  expect((await ui.find({ key: 'viewed' }))?.props.label).toBe('✓ viewed')
  // an edit that keeps the counts (3 added, 1 removed) but not the text
  blob = 'b2b2b2'
  await $.tool.call(EDIT)
  expect((await ui.find({ key: 'viewed' }))?.props.label).toBe('viewed')
  // the marked file is hashed by its path; hashing is a git call on listed paths only
  expect(asked.some(c => c.endsWith('hash-object -- src/a.ts'))).toBe(true)
  expect(asked.every(c => /hash-object -- \S/.test(c))).toBe(true)
  await ui.unmount()
})

test('viewed: marking certifies what the pane listed, not what changed on disk since', async ($, on) => {
  let blob = 'aaa111'
  wired(on, a => (a.includes('hash-object') ? ok(`${blob}\n`) : null))
  on('store.set', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const A = 'btn:/repos/tool\u0000src/a.ts'
  // another session rewrites a.ts (same counts) before any refresh; the pane still shows the old text
  blob = 'bbb222'
  await ui.press({ key: 'viewed' })
  await ui.press({ key: A })
  expect((await ui.find({ key: 'viewed' }))?.props.label).toBe('✓ viewed')
  // the next listing reads the new text: the mark was for the old one, so it no longer holds
  await $.tool.call(EDIT)
  expect((await ui.find({ key: 'viewed' }))?.props.label).toBe('viewed')
  await ui.unmount()
})

test('viewed: a new base with the same counts and the same file text un-views it', async ($, on) => {
  let base = 'base000'
  wired(on, a => {
    if (a.includes('hash-object')) return ok('ccc333\n')
    if (a.includes('merge-base')) return ok(`${base}\n`)
    return null
  })
  on('store.set', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const A = 'btn:/repos/tool\u0000src/a.ts'
  await ui.press({ key: 'viewed' })
  await ui.press({ key: A })
  expect((await ui.find({ key: 'viewed' }))?.props.label).toBe('✓ viewed')
  // the branch is rebased: the old side moved, the new side and the counts did not
  base = 'base999'
  await $.tool.call(EDIT)
  expect((await ui.find({ key: 'viewed' }))?.props.label).toBe('viewed')
  await ui.unmount()
})

test('viewed: a symlink is fingerprinted by where it points, not by the file it reaches', async ($, on) => {
  let target = '../one.ts'
  const readlinks: string[][] = []
  const piped: (string | undefined)[] = []
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (e.argv[0] === 'readlink') {
      readlinks.push([...e.argv])
      return { value: ok(`${target}\n`) }
    }
    // what the mod pipes in reaches the process as its input
    if (a.includes('hash-object --stdin')) {
      const stdin = (e as { init?: { stdin?: string } }).init?.stdin
      piped.push(stdin)
      return { value: ok(`link-${stdin}\n`) }
    }
    // following the link: both targets hold the same text
    if (a.includes('hash-object --')) return { value: ok('same-content\n') }
    return { value: noLeases(e.argv) }
  })
  on('fs.stat', async (_$, e) => ({
    value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: (e as { path: string }).path.endsWith('src/a.ts') },
  }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('store.set', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'viewed' })
  await ui.press({ key: 'btn:/repos/tool\u0000src/a.ts' })
  expect((await ui.find({ key: 'viewed' }))?.props.label).toBe('✓ viewed')
  // retargeted to another file with the same text: a different change
  target = '../two.ts'
  await $.command.run({ command: 'diffs' } as never)
  expect((await ui.find({ key: 'viewed' }))?.props.label).toBe('viewed')
  // the link is read where it stands, and git hashes exactly its text (no trailing newline), as it stores a symlink
  expect(readlinks[0]).toEqual(['readlink', '--', '/repos/tool/src/a.ts'])
  expect(piped).toContain('../one.ts')
  expect(piped).toContain('../two.ts')
  await ui.unmount()
})

test('viewed: a path git cannot hash (a submodule) costs only itself', async ($, on) => {
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    if (a.includes('--numstat')) return { value: ok('3\t1\tsrc/a.ts\u0000-\t-\tvendor/sub\u0000') }
    if (a.includes('--name-status')) return { value: ok('M\u0000src/a.ts\u0000M\u0000vendor/sub\u0000') }
    if (a.includes('hash-object --') && a.includes('vendor/sub')) return { value: ok('', 128) }
    if (a.includes('hash-object -- src/a.ts')) return { value: ok('aaa111\n') }
    return { value: noLeases(e.argv) }
  })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('store.set', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const A = 'btn:/repos/tool\u0000src/a.ts'
  const SUB = 'btn:/repos/tool\u0000vendor/sub'
  await ui.press({ key: A })
  await ui.press({ key: 'viewed' })
  await ui.press({ key: SUB })
  await ui.press({ key: 'viewed' })
  // three files listed (new.md is untracked): the two marked ones count
  expect(await ui.find({ text: /^· 2\/3 viewed$/ }), 'both marked before the refresh').toBeDefined()
  // a refresh that is waited for, so the listing below is the new one: both stay viewed,
  // read before anything re-selects (selecting re-hashes a file alone, which would hide it)
  await $.command.run({ command: 'diffs' } as never)
  expect(await ui.find({ text: /^· 2\/3 viewed$/ }), 'both still marked after it').toBeDefined()
  await ui.unmount()
})

test('notes: a mode-only change says so instead of "No text changes."', async ($, on) => {
  wired(on, a => {
    if (a.includes('--numstat')) return ok('0\t0\tsrc/a.ts\u0000')
    if (a.includes('base000 -- src/a.ts')) return ok('diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n')
    return null
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /^· now executable \(100644 → 100755\)$/ })).toBeDefined()
  expect(await ui.find({ text: /^No text changes\.$/ })).toBeUndefined()
  await ui.unmount()
})

test('C1: stepping into a collapsed folder opens it, so the selected row is drawn', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'btn:/repos/tool\u0000new.md' })
  await ui.press({ key: 'dirbtn:/repos/tool\u0000src' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeUndefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
  await ui.unmount()
})

test('C2: a deep unjoinable tree indents at most a third of the pane', async ($, on) => {
  // 12 nested folders, each holding a file, so the tree cannot join them into one row
  const paths = Array.from({ length: 12 }, (_, i) => Array.from({ length: i + 1 }, (_, j) => `d${j}`).join('/') + '/keep.ts')
  wired(on, a => {
    if (a.includes('--numstat')) return ok(paths.map(p => `1\t0\t${p}\u0000`).join(''))
    if (a.includes('--name-status')) return ok(paths.map(p => `M\u0000${p}\u0000`).join(''))
    return null
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE_PROPS, bodyColumns: 30 }, surface: 'desktop' })
  const pads: number[] = []
  const walk = (n: Found) => {
    if (n.type === 'Box' && typeof n.props?.paddingLeft === 'number') pads.push(n.props.paddingLeft as number)
    for (const c of n.children ?? []) walk(c)
  }
  walk((await ui.find({ type: 'Box' })) as Found)
  expect(Math.max(...pads)).toBeLessThanOrEqual(10)
  await ui.unmount()
})

test('C3: a hide editor opened on desktop holds no keys on the phone', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'edit-hide' })
  expect((await desk.find({ key: 'next' }))?.props.hotkey).toBeUndefined()
  await desk.unmount()
  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect((await phone.find({ key: 'next' }))?.props.hotkey).toBe('j')
  await phone.unmount()
})

test('views: hunks draw as GitHub-style tinted rows; g gives syntax-coloured numbered runs', async ($, on) => {
  wired(on, a => (a.includes('base000 -- src/a.ts') ? ok('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -7,3 +7,3 @@ fn\n keep\n-old\n+new\n keep2\n') : null))
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'options' })
  // tinted (default): one row a run, tinted by what it is, numbered in its gutter
  type N = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const rows: Array<[unknown, string, string]> = []
  const walk = (n: N) => {
    const kids = (n.children ?? []).filter((c): c is N => Boolean(c) && typeof c === 'object')
    // v20: two gutters (old, new), a marker column, then the code
    if (n.type === 'Box' && kids.length === 4 && kids[3]!.children?.some(c => diffTextOf(c as N) !== undefined)) {
      const numOf = (k: N) => ((k.children?.[0] as N)?.children ?? []).join('').trim()
      const code = diffTextOf(kids[3]!.children!.find(c => diffTextOf(c as N) !== undefined) as N)!
      rows.push([n.props?.backgroundColor, `${numOf(kids[0]!)}|${numOf(kids[1]!)}`, code])
      return
    }
    kids.forEach(walk)
  }
  walk((await containerOf(ui, FOLD())) as N)
  expect(rows).toEqual([
    [undefined, '7|7', '   keep'],
    // GitHub's own tints on the desktop (dark: --diffBlob-*-bgColor); a removed line counts in the old file only, an added one in the new
    ['#f851491a', '8|', ' - old'],
    ['#2ea04326', '|8', ' + new'],
    [undefined, '9|9', '   keep2'],
  ])
  expect(await ui.find({ text: /^@@ -7,3 \+7,3 @@$/ })).toBeDefined()
  expect(await ui.find({ text: /^in fn$/ })).toBeDefined()
  // syntax (g): each run a Code numbered from its own file
  await ui.press({ key: 'numbers' })
  const codes = await codesIn(ui, FOLD())
  expect(codes.map(c => [c.startLine, c.source, c.format ?? 'source'])).toEqual([
    [7, '   keep', 'source'],
    [8, ' - old', 'source'],
    [8, ' + new', 'source'],
    [9, '   keep2', 'source'],
  ])
  expect((await ui.find({ key: 'numbers' }))?.props.hotkey).toBe('g')
  await ui.press({ key: 'numbers' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.unmount()
})

// ── GitHub's file containers: every changed file stacked in its own frame

const frameOf = async (ui: Parameters<typeof containerOf>[0], foldKey: string) => {
  const box = await containerOf(ui, foldKey)
  return box ? `${box.props.borderStyle}/${box.props.borderColor}` : undefined
}

test('containers: every changed file has its own; the selected one is ringed in the accent and keeps the plain keys', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const NEW = KEY('new.md')
  expect(await frameOf(ui, FOLD())).toBe('round/suggestion')
  expect(await frameOf(ui, FOLD('new.md'))).toBe('round/subtle')
  // the selected container's buttons are the plain keys; the other's carry its file
  expect(await buttonsIn(ui, FOLD())).toEqual(expect.arrayContaining(['viewed', 'copy-file', 'copy:0', 'fullctx']))
  expect((await buttonsIn(ui, FOLD())).some(k => k.startsWith('pick'))).toBe(false)
  expect(await buttonsIn(ui, FOLD('new.md'))).toEqual(expect.arrayContaining([`viewed@${NEW}`, `copy-file@${NEW}`, `pick@${NEW}`]))
  expect((await ui.find({ key: `viewed@${NEW}` }))?.props.hotkey).toBeUndefined()
  expect((await ui.find({ key: 'viewed' }))?.props.hotkey).toBe('v')
  // the shared toolbar sits outside every container
  expect(await buttonsIn(ui, FOLD())).not.toContain('fold-all')
  expect(await ui.find({ key: 'fold-all' })).toBeDefined()
  // picking the other file by its name moves the accent and the plain keys
  await ui.press({ key: `pick@${NEW}` })
  expect(await ui.find({ text: /^2\/2$/ })).toBeDefined()
  expect(await frameOf(ui, FOLD())).toBe('round/suggestion')
  expect(await buttonsIn(ui, FOLD())).toContain('viewed')
  expect(await frameOf(ui, FOLD('src/a.ts'))).toBe('round/subtle')
  await ui.unmount()
})

test('containers: a file besides the selected one draws its diff, read through the diffs cache', async ($, on) => {
  let newReads = 0
  wired(on, a => {
    if (a.includes('--no-index') && a.includes('new.md')) newReads++
    return null
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await codesIn(ui, FOLD('new.md'))).map(c => unpad(String(c.source)))).toEqual(['+fresh line'])
  expect(unpad((await codesIn(ui, FOLD())).map(c => c.source).join('\n'))).toContain('+new')
  // read once; folding and opening the selected file reloads the others from the cache, not git
  const reads = newReads
  expect(reads).toBeGreaterThan(0)
  await ui.press({ key: FOLD() })
  await ui.press({ key: FOLD() })
  expect(newReads).toBe(reads)
  expect((await codesIn(ui, FOLD('new.md'))).map(c => unpad(String(c.source)))).toEqual(['+fresh line'])
  await ui.unmount()
})

test('containers: one file folds and opens on its chevron, and stays folded across a refresh', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const fold = FOLD('new.md')
  expect((await ui.find({ key: fold }))?.text ?? (await ui.find({ key: fold }))?.props.label).toMatch(/^▾$/)
  await ui.press({ key: fold })
  expect(await codesIn(ui, fold)).toEqual([])
  expect(await ui.find({ text: /^✓ Viewed$/ })).toBeUndefined()
  expect(JSON.stringify(await ui.find({ key: fold }))).toContain('"label":"▸"')
  // the selected file is untouched
  expect((await codesIn(ui, FOLD())).length).toBeGreaterThan(0)
  // a refresh keeps the fold
  await $.tool.call(EDIT)
  expect(await codesIn(ui, fold)).toEqual([])
  await ui.press({ key: fold })
  expect((await codesIn(ui, fold)).map(c => unpad(String(c.source)))).toEqual(['+fresh line'])
  expect(JSON.stringify(await ui.find({ key: fold }))).toContain('"label":"▾"')
  await ui.unmount()
})

test('containers: collapse all folds every file to its header; expand all opens them again', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(JSON.stringify(await ui.find({ key: 'fold-all' }))).toContain('▸ collapse all')
  await ui.press({ key: 'fold-all' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  // the headers stay
  expect(await containerOf(ui, FOLD())).toBeDefined()
  expect(await containerOf(ui, FOLD('new.md'))).toBeDefined()
  expect(JSON.stringify(await ui.find({ key: 'fold-all' }))).toContain('▾ expand all')
  await ui.press({ key: 'fold-all' })
  expect((await codesIn(ui, FOLD())).length).toBeGreaterThan(0)
  expect((await codesIn(ui, FOLD('new.md'))).map(c => unpad(String(c.source)))).toEqual(['+fresh line'])
  expect(JSON.stringify(await ui.find({ key: 'fold-all' }))).toContain('▸ collapse all')
  await ui.unmount()
})

test('containers: a file over 1000 changed lines besides the selected one waits for load diff', async ($, on) => {
  let bigReads = 0
  wired(on, a => {
    if (a.includes('--numstat')) return ok('3\t1\tsrc/a.ts\u0000600\t401\tz/big.ts\u0000')
    if (a.includes('--name-status')) return ok('M\u0000src/a.ts\u0000M\u0000z/big.ts\u0000')
    if (a.includes('base000 -- z/big.ts')) {
      bigReads++
      return ok('--- a/z/big.ts\n+++ b/z/big.ts\n@@ -1,1 +1,1 @@\n-big old\n+big new\n')
    }
    return null
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const big = KEY('z/big.ts')
  expect(await ui.find({ text: /^1\/3$/ })).toBeDefined()
  expect(await ui.find({ text: /^Large diff: 1001 lines changed\.$/ })).toBeDefined()
  expect(await codesIn(ui, FOLD('z/big.ts'))).toEqual([])
  expect(bigReads).toBe(0)
  await ui.press({ key: `load-large@${big}` })
  expect(bigReads).toBe(1)
  expect(unpad((await codesIn(ui, FOLD('z/big.ts'))).map(c => c.source).join('\n'))).toContain('+big new')
  expect(await ui.find({ key: `load-large@${big}` })).toBeUndefined()
  await ui.unmount()
})

test('containers: marking another file viewed folds its container to ✓ Viewed, and show diff opens it', async ($, on) => {
  wired(on, () => null)
  on('store.set', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const NEW = KEY('new.md')
  await ui.press({ key: `viewed@${NEW}` })
  expect(await ui.find({ text: /^· 1\/2 viewed$/ })).toBeDefined()
  expect(await codesIn(ui, FOLD('new.md'))).toEqual([])
  expect(await buttonsIn(ui, FOLD('new.md'))).toContain(`open-viewed@${NEW}`)
  expect(await ui.find({ text: /^✓ Viewed$/ })).toBeDefined()
  // the selected file stays open
  expect((await codesIn(ui, FOLD())).length).toBeGreaterThan(0)
  await ui.press({ key: `open-viewed@${NEW}` })
  expect((await codesIn(ui, FOLD('new.md'))).map(c => unpad(String(c.source)))).toEqual(['+fresh line'])
  expect(await ui.find({ text: /^✓ Viewed$/ })).toBeUndefined()
  await ui.unmount()
})

test('containers: 25 files draw at first, more come on request, and a file picked past them starts the window', async ($, on) => {
  const names = Array.from({ length: 100 }, (_, i) => `f${String(i + 1).padStart(3, '0')}.ts`)
  const diffReads = new Set<string>()
  wired(on, a => {
    const m = /base000 -- (f\d+\.ts)$/.exec(a)
    if (m) diffReads.add(m[1]!)
    if (a.includes('--numstat')) return ok(names.map(n => `1\t0\t${n}\u0000`).join(''))
    if (a.includes('--name-status')) return ok(names.map(n => `M\u0000${n}\u0000`).join(''))
    return null
  })
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const drawn = async (n: string) => Boolean(await containerOf(ui, FOLD(n)))
  // 101 files (100 + the untracked new.md); f001 is selected
  expect(await containerOf(ui, FOLD())).toBeDefined()
  expect(await drawn('f025.ts')).toBe(true)
  expect(await drawn('f026.ts')).toBe(false)
  expect(await ui.find({ text: /^76 more files$/ })).toBeDefined()
  expect(JSON.stringify(await ui.find({ key: 'files-more' }))).toContain('show 25 more')
  await ui.press({ key: 'files-more' })
  expect(await drawn('f050.ts')).toBe(true)
  expect(await drawn('f051.ts')).toBe(false)
  // a file picked past the window starts it: it and the files after it, the earlier ones said
  await ui.press({ key: `btn:${KEY('f058.ts')}` })
  expect(await frameOf(ui, FOLD())).toBe('round/suggestion')
  expect(await ui.find({ text: /^58\/101$/ })).toBeDefined()
  expect(await ui.find({ text: /^57 earlier files above$/ })).toBeDefined()
  expect(await drawn('f057.ts')).toBe(false)
  expect(await drawn('f059.ts')).toBe(true)
  expect(await drawn('new.md')).toBe(true)
  // the files between the old window and it were never read from git
  expect(diffReads.has('f050.ts')).toBe(true)
  expect(diffReads.has('f055.ts')).toBe(false)
  // back to the first: the window returns to the top
  await ui.press({ key: 'files-first' })
  expect(await ui.find({ text: /^1\/101$/ })).toBeDefined()
  expect(await ui.find({ text: /earlier files? above/ })).toBeUndefined()
  expect(await drawn('f050.ts')).toBe(true)
  await ui.unmount()
})

test('layout: on a wide pane the file list stays in view, redrawn at the pane\'s scroll offset, one window tall', async ($, on) => {
  wired(on, () => null)
  await $.tool.call(EDIT)
  // the clipping window: the absolutely placed Box with a height that holds the list
  const windowOf = async (ui: Parameters<typeof containerOf>[0]) => {
    const walk = (n: Found): Found | undefined => {
      if (n.type === 'Box' && n.props?.position === 'absolute' && n.props?.overflow === 'hidden') return n
      for (const c of n.children ?? []) {
        const hit = c && typeof c === 'object' ? walk(c as Found) : undefined
        if (hit) return hit
      }
      return undefined
    }
    return walk((await ui.find({ type: 'Box' })) as Found)
  }
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await windowOf(ui))?.props).toMatchObject({ top: 0, height: 40 })
    // the pane scrolled 30 rows: the list moves down with it, so it stays in view
    await ui.redraw({ ...PANE_PROPS, scroll: { offset: 30, bodyRows: 24 } })
    expect((await windowOf(ui))?.props).toMatchObject({ top: 30, height: 24 })
    // the tree is inside the window, the header and the containers are not
    expect(await ui.find({ key: `btn:${KEY('new.md')}` })).toBeDefined()
    await ui.unmount()
  }
  // v24: a narrow pane stacks the list above the containers and pins one row
  // (count, progress, file stepping) at the pane's scroll offset; its chevron
  // opens the list in a window under half the body
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE_PROPS, bodyColumns: 60, scroll: { offset: 7, bodyRows: 40 } }, surface: 'desktop' })
  let win = await windowOf(narrow)
  expect(win?.props.top).toBe(7)
  expect(win?.props.width).toBe(60)
  expect(win?.props.height).toBe(1)
  // the row's reserved room comes first, so at offset 0 the row sits in it and
  // not over the header's repo line (2026-10-15: "Files 0" drew on ".claude main")
  const stackOf = (n: Found): Found | undefined => {
    if (n.type === 'Box' && n.props?.position === 'relative' && n.props?.flexDirection === 'column') return n
    for (const c of n.children ?? []) {
      const hit = c && typeof c === 'object' ? stackOf(c as Found) : undefined
      if (hit) return hit
    }
    return undefined
  }
  const first = stackOf((await narrow.find({ type: 'Box' })) as Found)?.children?.[0] as Found | undefined
  expect(first?.props?.minHeight).toBe(1)
  expect((await narrow.find({ key: 'pin-toggle' }))?.props.label).toBe('▸ Files 2')
  await narrow.press({ key: 'pin-toggle' })
  win = await windowOf(narrow)
  expect(win?.props.height as number).toBeLessThanOrEqual(18)
  expect(win?.props.height as number).toBeGreaterThanOrEqual(8)
  expect((await narrow.find({ key: 'pin-toggle' }))?.props.label).toBe('▾ Files')
  await narrow.press({ key: 'pin-next' })
  expect(await narrow.find({ text: /^2\/2$/ })).toBeDefined()
  await narrow.unmount()
})

test('containers: the stack keeps file order; a file picked past the first page leads it', async ($, on) => {
  const names = Array.from({ length: 60 }, (_, i) => `f${String(i + 1).padStart(3, '0')}.ts`)
  wired(on, a => {
    if (a.includes('--numstat')) return ok(names.map(n => `1\t0\t${n}\u0000`).join(''))
    if (a.includes('--name-status')) return ok(names.map(n => `M\u0000${n}\u0000`).join(''))
    return null
  })
  await $.tool.call(EDIT)
  // each container's fold key, top to bottom (the selected one's is the plain `fold`)
  const order = async (ui: Parameters<typeof containerOf>[0]) => {
    const out: string[] = []
    const walk = (n: Found) => {
      const key = n.key ?? (n.props?.key as string | undefined)
      if (n.type === 'Button' && key && (key === 'fold' || key.startsWith('fold@'))) out.push(key)
      for (const c of n.children ?? []) if (c && typeof c === 'object') walk(c as Found)
    }
    walk((await ui.find({ type: 'Box' })) as Found)
    return out
  }
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await order(ui))[0]).toBe('fold')
    // inside the first page the order holds: f010 stays tenth
    await ui.press({ key: `btn:${KEY('f010.ts')}` })
    const inPage = await order(ui)
    expect(inPage[0]).toBe(FOLD('f001.ts'))
    expect(inPage[9]).toBe('fold')
    // past it: f044 leads, f045 after it, nothing earlier drawn
    await ui.press({ key: `btn:${KEY('f044.ts')}` })
    expect(await ui.find({ text: /^44\/61$/ })).toBeDefined()
    const after = await order(ui)
    expect(after[0]).toBe('fold')
    expect(after[1]).toBe(FOLD('f045.ts'))
    expect(after).not.toContain(FOLD('f001.ts'))
    await ui.press({ key: `btn:${KEY('f001.ts')}` })
    await ui.unmount()
  }
})

test('containers: marking another file viewed keeps the selection where it is', async ($, on) => {
  wired(on, a => {
    if (a.includes('--numstat')) return ok('3\t1\tsrc/a.ts\u00002\t0\tsrc/b.ts\u0000')
    if (a.includes('--name-status')) return ok('M\u0000src/a.ts\u0000M\u0000src/b.ts\u0000')
    return null
  })
  on('store.set', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // src/a.ts, src/b.ts, new.md: a.ts selected; marking b.ts would once have jumped to new.md
  expect(await ui.find({ text: /^1\/3$/ })).toBeDefined()
  await ui.press({ key: `viewed@${KEY('src/b.ts')}` })
  expect(await ui.find({ text: /^1\/3$/ })).toBeDefined()
  expect(await buttonsIn(ui, FOLD('src/b.ts'))).toContain(`open-viewed@${KEY('src/b.ts')}`)
  // v on the selected file still moves on, to the next unviewed one
  await ui.press({ key: 'viewed' })
  expect(await ui.find({ text: /^3\/3$/ })).toBeDefined()
  await ui.unmount()
})

test('containers: expand all opens viewed files but leaves a large one waiting for load diff', async ($, on) => {
  let bigReads = 0
  wired(on, a => {
    if (a.includes('--numstat')) return ok('3\t1\tsrc/a.ts\u0000600\t401\tz/big.ts\u0000')
    if (a.includes('--name-status')) return ok('M\u0000src/a.ts\u0000M\u0000z/big.ts\u0000')
    if (a.includes('base000 -- z/big.ts')) {
      bigReads++
      return ok('--- a/z/big.ts\n+++ b/z/big.ts\n@@ -1,1 +1,1 @@\n-big old\n+big new\n')
    }
    return null
  })
  on('store.set', async () => ({ value: undefined }) as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const NEW = KEY('new.md')
  await ui.press({ key: `viewed@${NEW}` })
  expect(await codesIn(ui, FOLD('new.md'))).toEqual([])
  await ui.press({ key: 'fold-all' })
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'fold-all' })
  // the selected and the viewed file open; the large one still asks first
  expect((await codesIn(ui, FOLD())).length).toBeGreaterThan(0)
  expect((await codesIn(ui, FOLD('new.md'))).map(c => unpad(String(c.source)))).toEqual(['+fresh line'])
  expect(await codesIn(ui, FOLD('z/big.ts'))).toEqual([])
  expect(await ui.find({ key: `load-large@${KEY('z/big.ts')}` })).toBeDefined()
  expect(bigReads).toBe(0)
  await ui.unmount()
})


test('the lease ledger: a lease folder that is a symlink is read too', async ($, on) => {
  mock.env(on, { HOME: '/home/t' })
  on('fs.list', async (_$, e) => {
    if ((e as { path?: string }).path !== '/home/t/.claude/leases/worktree') throw new Error('no such folder')
    // as the engine lists a symlink: kind other, isLink
    return {
      value: [
        { name: 'a', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false },
        { name: 'linked', kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true },
        { name: 'notes.txt', kind: 'file' as const, size: 3, mtimeMs: 0, isLink: false },
      ],
    } as never
  })
  on('fs.read', async (_$, e) => {
    const path = (e as { path: string }).path
    if (path.endsWith('/a/lease.json')) return { value: JSON.stringify(LEASES.a) } as never
    if (path.endsWith('/linked/lease.json')) return { value: JSON.stringify({ session_id: 'S1', worktree: '/wt/app-7' }) } as never
    throw new Error('missing')
  })
  on('process.run', async (_$, e) => ({ value: fakeGit(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  await $.command.run({ command: 'diffs' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'repo:/wt/app-1' })).toBeDefined()
  expect(await ui.find({ key: 'repo:/wt/app-7' })).toBeDefined()
  await ui.unmount()
})

test('last turn: two edits landing at once past 499 files keep the list at 500 and say it overflowed', async ($, on) => {
  on('process.run', async (_$, e) => ({ value: fakeGit(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('tool.call', async () => ({ result: 'ok' }) as never)
  await $.turn.start({ text: 'big', turnId: 'm1' } as never)
  for (let i = 0; i < 499; i++) await $.tool.call({ ...EDIT, file_path: `/repos/tool/gen/f${i}.ts` } as never)
  await Promise.all([$.tool.call({ ...EDIT, file_path: '/repos/tool/gen/x.ts' } as never), $.tool.call({ ...EDIT, file_path: '/repos/tool/gen/y.ts' } as never)])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scope:turn' })
  expect(await ui.find({ text: /more than 500 files/ })).toBeDefined()
  await ui.unmount()
})

test('viewed: one path git cannot hash among many costs a bounded number of git calls', async ($, on) => {
  const N = 40
  const names = [...Array.from({ length: N }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`), 'vendor/sub']
  let hashes = 0
  const seen: string[] = []
  on('process.run', async (_$, e) => {
    const a = e.argv.join(' ')
    seen.push(a)
    if (a.includes('--numstat')) return { value: ok(names.map(n => `1\t0\t${n}`).join('\u0000') + '\u0000') }
    if (a.includes('--name-status')) return { value: ok(names.map(n => `M\u0000${n}`).join('\u0000') + '\u0000') }
    if (a.includes('hash-object --') && !a.includes('--stdin')) {
      hashes++
      const paths = e.argv.slice(e.argv.indexOf('--') + 1)
      if (paths.includes('vendor/sub')) return { value: ok('', 128) }
      return { value: ok(paths.map(p => `id-${p}`).join('\n') + '\n') }
    }
    if (a.includes('-C /elsewhere')) return { value: ok('', 128) }
    return { value: noLeases(e.argv) }
  })
  // marks as the mod stamps them: status, sizes, the diff's side and the content id
  mock.store(on, { viewed: Object.fromEntries(names.map(n => [`/repos/tool\u0000${n}`, `M||1|0||base000|id-${n}`])) })
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('session.start', async () => ({ cwd: '/elsewhere' }) as never)
  await $.session.start({ cwd: '/elsewhere' } as never)
  await $.tool.call(EDIT)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  hashes = 0
  await $.command.run({ command: 'diffs' } as never)
  // one listing: halving around the bad path, not one call per path (the untracked new.md makes 42 files)
  expect(hashes, seen.join('\n')).toBeGreaterThan(0)
  expect(hashes).toBeLessThanOrEqual(16)
  // every hashable mark still holds; only the submodule, which has no id, is not viewed
  expect(await ui.find({ text: new RegExp(`^· ${N}/${N + 2} viewed$`) })).toBeDefined()
  await ui.unmount()
})

test('last turn: a reload from 0.3.0 keeps the turn list it had', async ($, on) => {
  on('state.get', async (_$, e, next) =>
    (e as { key: string }).key === 'lastTurn' && !legacyRead.done
      ? ((legacyRead.done = true), { value: { value: ['/repos/tool\u0000src/a.ts'], version: 1 } } as never)
      : next(e),
  )
  const legacyRead = { done: false }
  mock.store(on, {})
  on('process.run', async (_$, e) => ({ value: e.argv.join(' ').includes('-C /elsewhere') ? ok('', 128) : fakeGit(e.argv) }))
  on('session.id', async () => ({ value: 'S1' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('session.start', async () => ({ cwd: '/elsewhere' }) as never)
  await $.session.start({ cwd: '/elsewhere' } as never)
  // another file's edit lists the repo; src/a.ts can come only from the carried list
  await $.tool.call({ ...EDIT, file_path: '/repos/tool/src/b.ts' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'scope:turn' })
  // wait for the scope's own listing
  await $.command.run({ command: 'diffs' } as never)
  expect(await ui.find({ key: 'btn:/repos/tool\u0000src/a.ts' })).toBeDefined()
  await ui.unmount()
})
