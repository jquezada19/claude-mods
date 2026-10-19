// Browser harness for ~/.claude/mods/repo-diffs: runs the mod's real ui.render
// hook against fixture state and paints its element tree as flexbox DOM, with
// cell units = the code font's advance (how the desktop sizes bodyColumns).
import { register, loadRest } from './gen/register.tsx'
import { parseNameStatus, parseNumstat, parseUnmerged } from '../hooks/git-parse.ts'
import { buildTree, fileOrder } from '../hooks/tree.ts'

type VNode = { type: any; props: any; children: any[] }
;(globalThis as any).h = (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children })
;(globalThis as any).Fragment = 'Fragment'

// ── engine mock ────────────────────────────────────────────────────────────
const state = new Map<string, unknown>()
let renderHook: any = null
let scrollHook: any = null
const log: string[] = []
const anyProxy = (path: string): any =>
  new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : anyProxy(`${path}.${String(k)}`)),
    apply: () => {
      log.push(path)
      return Promise.resolve(undefined)
    },
  })
const $: any = new Proxy(
  {
    __state: state,
    __rerender: () => schedule(),
    ui: new Proxy(
      {
        resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button', Code: 'Code', Link: 'Link', Input: 'Input' }),
        toast: (t: string) => (log.push(`toast: ${t}`), Promise.resolve()),
        copy: () => Promise.resolve({ isCopied: true }),
        // tree selection brings a container into view: a no-op that succeeds
        scroll: (o: any) => (log.push(`scroll: ${JSON.stringify(o?.to ?? null)}`), Promise.resolve({})),
      },
      { get: (t: any, k) => (k in t ? t[k] : anyProxy(`ui.${String(k)}`)) },
    ),
    clock: { now: () => Promise.resolve(NOW) },
    process: { run: (argv: string[]) => Promise.resolve(gitAnswer(argv)) },
  },
  { get: (t: any, k) => (k in t ? t[k] : anyProxy(String(k))) },
)
const on: any = (event: string, matcher: any, hook?: any) => {
  const fn = hook ?? matcher
  if (event === 'ui.render') renderHook = fn
  if (event === 'ui.scroll') scrollHook = fn
  return { catch: () => {} }
}
register(on, {} as any)

// ── fixtures ───────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-10T10:57:00')
const K = (root: string, p: string) => `${root}\u0000${p}`
const patch = (n: number, long = false) => {
  let s = '--- a/x\n+++ b/x\n'
  for (let i = 0; i < n; i++) {
    const at = 1 + i * 40
    s += `@@ -${at},6 +${at},8 @@ export function renderProfileDetails${i}(props) {\n`
    s += ` import * as React from 'react';\n`
    s += `-import { fireEvent, render, within } from '@testing-library/react-native';\n`
    s += `+import { act, fireEvent, render, within } from '@testing-library/react-native';\n`
    s += `+import { Alert, StyleSheet } from 'react-native';\n`
    if (long) s += `+const veryLongLine = '${'x'.repeat(400)}' // a line far wider than any pane so cut vs wrap matters\n`
    s += ` import ProfileDetailsScreen from '../ProfileDetailsScreen';\n`
    s += `+// the details load waits for the saved profile, so\n`
    s += ` \n`
  }
  return s
}
// what `git diff` prints for a file the containers load: the scenario's
// recorded patch (stress.json), else one synthesised from the file's counts
let patchSource: Record<string, string> = {}
const synthPatch = (f: any) => {
  const p = f.path as string
  if (f.isBinary) return `diff --git a/${p} b/${p}\nBinary files a/${p} and b/${p} differ\n`
  const isNew = f.status === '?' || f.status === 'A'
  const adds = Math.min(f.added || (f.status === '?' ? 12 : 0), 60)
  const dels = isNew ? 0 : Math.min(f.removed, 30)
  let s = `diff --git a/${p} b/${p}\n--- ${isNew ? '/dev/null' : `a/${p}`}\n+++ b/${p}\n`
  if (isNew) {
    s += `@@ -0,0 +1,${adds} @@\n`
    for (let i = 0; i < adds; i++) s += `+export const line${i} = useMemo(() => compute${i}(props.items, props.filter), [props.items]);\n`
    return s
  }
  // hunks of up to 12 changes, 3 lines of context either side, 40 lines apart
  let a = 0, r = 0, h = 0
  while (a < adds || r < dels || h === 0) {
    const hr = Math.min(6, dels - r), ha = Math.min(6, adds - a)
    const at = 10 + h * 40
    s += `@@ -${at},${hr + 6} +${at},${ha + 6} @@ function section${h}(props) {\n`
    s += `   const { items, filter } = props;\n   if (!items) return null;\n   const out = [];\n`
    for (let i = 0; i < hr; i++) s += `-  out.push(legacyTransform(items[${r + i}], filter, { strict: false }));\n`
    for (let i = 0; i < ha; i++) s += `+  out.push(transform(items[${a + i}], filter));\n`
    s += `   return out;\n }\n \n`
    r += hr; a += ha; h++
    if (hr === 0 && ha === 0) break
  }
  return s
}
function gitAnswer(argv: string[]) {
  const fail = (stderr: string) => ({ exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })
  const at = argv.indexOf('diff')
  const dash = argv.lastIndexOf('--')
  if (argv[0] !== 'git' || at < 0 || dash < 0 || argv.includes('--numstat') || argv.includes('--name-status')) return fail('harness')
  const root = argv[argv.indexOf('-C') + 1]
  const path = argv[argv.length - 1]!
  const snap = ((state.get('snapshot') as any[]) ?? []).find(x => x.root === root)
  const f = snap?.files.find((x: any) => x.path === path)
  if (!f) return fail(`fatal: ambiguous argument '${path}': unknown revision or path not in the working tree.`)
  const stdout = patchSource[path] ?? synthPatch(f)
  // --no-index exits 1 when the files differ
  return { exitCode: argv.includes('--no-index') ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}
const appRoot = '/home/dev/wt/app-1234'
const appFiles = [
  { path: 'src/screens/Profile/EditProfile/EditProfileScreen.js', status: 'M', added: 4, removed: 6 },
  { path: 'src/screens/Profile/EditProfile/test/AvatarPicker.test.js', status: 'M', added: 105, removed: 6 },
  { path: 'src/screens/Profile/EditProfile/test/EditProfileScreen.test.js', status: 'A', added: 105, removed: 0 },
  { path: 'src/screens/Profile/ProfileDetailsScreen.js', status: 'M', added: 5, removed: 20 },
  { path: 'src/store/actions/Profile/test/profile.action.test.js', status: 'M', added: 66, removed: 1 },
  { path: 'src/store/actions/Profile/profile.action.js', status: 'M', added: 3, removed: 1 },
  { path: 'notes.txt', status: '?', added: 0, removed: 0 },
]
const commits = Array.from({ length: 5 }, (_, i) => ({
  sha: `abc${i}def0123456789`,
  short: `abc${i}def`,
  parents: ['p'],
  author: 'Dev Example',
  at: NOW - i * 3600_000,
  subject: ['fix(profile): Save on the confirmation alert goes back to Profile Details', 'test: cover the alert', 'refactor: drop the store wrapper', 'chore: lint', 'wip'][i]!,
}))
const appSnap = (extra: any = {}) => ({
  root: appRoot,
  name: 'app-1234',
  branch: 'feature/1234-profile-save-goes-back',
  base: 'base000',
  baseLabel: 'origin/develop',
  baseSource: 'pr',
  source: 'both',
  files: appFiles,
  range: ['base000'],
  head: 'h1',
  commits,
  ...extra,
})
const prOk = { kind: 'pr', number: 109, state: 'OPEN', isDraft: false, reviewDecision: '', mergeable: 'MERGEABLE', url: 'https://github.com/x/y/pull/109', baseRefName: 'develop', checks: { pass: 8, fail: 0, pending: 0, skipping: 0, cancel: 0 }, failing: [] }
const baseView = (sel: string, extra: any = {}) => ({ repo: appRoot, selected: K(appRoot, sel), full: [], collapsed: [], scope: 'all', ...extra })
const sel = appFiles[1]!.path
const readyDiff = (p: string, text: string) => ({ key: K(appRoot, p), isFull: false, text, status: 'ready' })

const deepPath = 'packages/mobile/src/features/profile/components/ProfileEditor/EditProfile/__tests__/integration/EditProfileScreenWithAVeryLongComponentName.integration.test.tsx'
const makeFiles = (n: number) => Array.from({ length: n }, (_, i) => ({
  path: `src/module${i % 12}/sub${i % 5}/File${i}WithSomeLongerName.ts`,
  status: ['M', 'A', 'D', 'R', '?'][i % 5]!,
  added: (i * 37) % 900,
  removed: (i * 13) % 400,
  ...(i % 5 === 3 ? { oldPath: `src/legacy/old/location/File${i}.ts` } : {}),
}))
const manyFiles = makeFiles(300)
const hugeFiles = makeFiles(1000)


// the 2026-10-14 screenshot's change set: 318 files over the app's real top folders
function screenshotFiles() {
  const tops: Array<[string, number]> = [['__mocks__', 2], ['__tests__', 1], ['.github', 1], ['.yarn/patches', 2], ['android/app/src/main/java/com/example/location', 4], ['android/app/src/test/java/com/example/location', 2], ['android/gradle', 1], ['ios/App', 3], ['ios', 8], ['src/components', 60], ['src/screens', 90], ['src/store', 70], ['src/utils', 30], ['src/services', 24], ['docs', 10], ['scripts', 10]]
  const out: Array<{ path: string; status: string; added: number; removed: number; oldPath?: string; isBinary?: boolean }> = []
  let i = 0
  for (const [dir, n] of tops)
    for (let k = 0; k < n; k++, i++) {
      const status = ['M', 'A', 'M', 'D', 'M', 'A', '?'][i % 7]!
      out.push({ path: `${dir}/${['Beacon', 'Swipe', 'Kebab', 'Notification', 'Profile'][i % 5]}${['Reporter', 'Module', 'Screen', 'Row', 'Test'][k % 5]}${k}.${dir.startsWith('android') ? 'kt' : dir.startsWith('ios') ? 'swift' : 'tsx'}`, status, added: (i * 211) % 1400, removed: (i * 61) % 300, ...(i % 40 === 7 ? { isBinary: true, added: 0, removed: 0 } : {}) })
    }
  return out.slice(0, 318)
}

const SCENARIOS: Record<string, () => Record<string, unknown>> = {
  'screenshot (PR #109)': () => ({
    snapshot: [appSnap()],
    view: baseView(sel),
    diff: readyDiff(sel, patch(3)),
    prs: { [appRoot]: { key: 'feature/1234-profile-save-goes-back@h1', at: NOW, info: prOk } },
  }),
  'everything open (keys, base picker, commits, composer, comments, hide field)': () => ({
    snapshot: [appSnap({ commit: commits[0], baseNote: 'origin/qa not found locally (git fetch?)', error: 'git status failed: index.lock exists' })],
    view: baseView(sel, { context: 12, ignoreWhitespace: true, wrap: true }),
    diff: readyDiff(sel, patch(3, true)),
    prs: { [appRoot]: { key: 'feature/1234-profile-save-goes-back@h1', at: NOW, info: { ...prOk, checks: { pass: 5, fail: 7, pending: 2, skipping: 1, cancel: 0 }, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED', failing: Array.from({ length: 7 }, (_, i) => ({ name: `build-and-test / ios-simulator-unit-tests-with-a-very-long-check-name (${i})`, link: 'https://x' })) } } },
    showKeys: true,
    editingBase: true,
    showCommits: true,
    editingHide: true,
    exclude: ['*.pbxproj', '*.lock', 'ios/Pods/**'],
    comments: [
      { id: 'c1', root: appRoot, path: sel, line: 3, side: 'new', tag: 'must-fix', body: 'This mocks Alert globally — scope it to the test so the other suites in this folder keep the real one, otherwise ordering bugs appear on CI only.', scope: 'all', commit: 'abc0def0123456789' },
      { id: 'c2', root: appRoot, path: sel, line: 999, side: 'old', tag: 'nit', body: 'unplaced comment', scope: 'committed' },
    ],
    composing: { root: appRoot, path: sel, line: 3, side: 'new', tag: 'suggestion', scope: 'all', commit: 'abc0def0123456789' },
  }),
  'review fixes: Clear prompt, revealed hidden files, diff error + Retry': () => ({
    snapshot: [appSnap()],
    view: baseView(sel),
    diff: { key: K(appRoot, sel), isFull: false, text: '', status: 'error', error: 'fatal: bad object base000' },
    exclude: ['*.test.js'],
    revealHidden: true,
    confirmClear: true,
    comments: [{ id: 'c1', root: appRoot, path: sel, line: 3, side: 'new', tag: 'nit', body: 'rename this', scope: 'all' }],
  }),
  'many repos (12 tabs, long names)': () => ({
    snapshot: Array.from({ length: 12 }, (_, i) => appSnap({ root: `${appRoot}-${i}`, name: `app-worktree-${11000 + i}-qa` })).map((s, i) => (i === 0 ? { ...s, root: appRoot } : s)),
    view: baseView(sel),
    diff: readyDiff(sel, patch(2)),
    prs: { [appRoot]: { key: 'feature/1234-profile-save-goes-back@h1', at: NOW, info: prOk } },
  }),
  'deep path + long branch + picked base': () => {
    const files = [{ path: deepPath, oldPath: deepPath.replace('integration', 'legacy-integration-old-location'), status: 'R', added: 1234, removed: 987, isBinary: false }, { path: 'a.png', status: 'M', added: 0, removed: 0, isBinary: true }]
    return {
      snapshot: [appSnap({ files, branch: 'feature/1234-profile-save-goes-back-to-profile-details-after-the-confirmation-alert-is-dismissed', baseLabel: 'origin/release/2.4.1-hotfix-for-profile-save', baseSource: 'picked' })],
      view: baseView(deepPath),
      diff: readyDiff(deepPath, patch(4, true)),
      prs: { [appRoot]: { key: 'x', at: 0, info: prOk } },
    }
  },
  'rebase in progress + conflicts + stale + PR error': () => ({
    snapshot: [appSnap({ op: 'rebase', isStale: true, files: [{ path: 'src/screens/Profile/ProfileDetailsScreen.js', status: '!', added: 0, removed: 0 }, { path: 'src/store/actions/Profile/profile.action.js', status: '!', added: 0, removed: 0 }, ...appFiles] })],
    view: baseView('src/screens/Profile/ProfileDetailsScreen.js'),
    diff: { key: K(appRoot, 'src/screens/Profile/ProfileDetailsScreen.js'), isFull: false, text: patch(1), status: 'ready' },
    prs: { [appRoot]: { key: 'feature/1234-profile-save-goes-back@h1', at: NOW, info: { kind: 'error', message: 'HTTP 502: Server Error — gh could not reach api.github.com after 10s; check your VPN or token scopes' } } },
    busy: true,
  }),
  '300 files, wide numbers': () => ({
    snapshot: [appSnap({ files: manyFiles })],
    view: { repo: appRoot, selected: K(appRoot, manyFiles[3]!.path), full: [], collapsed: [], scope: 'committed' },
    diff: readyDiff(manyFiles[3]!.path, patch(25)),
    prs: { [appRoot]: { key: 'feature/1234-profile-save-goes-back@h1', at: NOW, info: { ...prOk, state: 'OPEN', isDraft: true, checks: { pass: 112, fail: 0, pending: 31, skipping: 4, cancel: 0 } } } },
  }),
  '1,000 files, last one selected': () => ({
    snapshot: [appSnap({ files: hugeFiles })],
    view: { repo: appRoot, selected: K(appRoot, hugeFiles[999]!.path), full: [], collapsed: [], scope: 'all' },
    diff: readyDiff(hugeFiles[999]!.path, patch(2)),
  }),
  'diff loading': () => ({ snapshot: [appSnap()], view: baseView(sel), diff: { key: K(appRoot, sel), isFull: false, text: '', status: 'loading' } }),
  'diff error': () => ({ snapshot: [appSnap()], view: baseView(sel), diff: { key: K(appRoot, sel), isFull: false, text: '', status: 'error', error: 'fatal: bad revision base000..HEAD — the merge-base is gone after a force-push; refresh to recompute it' } }),
  'all files hidden': () => ({ snapshot: [appSnap()], view: baseView(sel), exclude: ['*'] }),
  'no changes': () => ({ snapshot: [appSnap({ files: [], commits: [] })], view: { repo: appRoot, selected: null, full: [], collapsed: [], scope: 'touched' }, prs: { [appRoot]: { key: 'feature/1234-profile-save-goes-back@h1', at: NOW, info: { kind: 'none' } } } }),
  // ── v18 (2026-10-14): the simplified pane at every size of change set
  '1 file': () => ({
    snapshot: [appSnap({ files: [appFiles[1]!], commits: commits.slice(0, 1) })],
    view: baseView(sel),
    diff: readyDiff(sel, patch(2)),
    prs: { [appRoot]: { key: 'feature/1234-profile-save-goes-back@h1', at: NOW, info: { kind: 'none' } } },
  }),
  '3 files, small fix': () => ({
    snapshot: [appSnap({ files: appFiles.slice(0, 3), commits: commits.slice(0, 2) })],
    view: baseView(sel),
    diff: readyDiff(sel, patch(2)),
    prs: { [appRoot]: { key: 'feature/1234-profile-save-goes-back@h1', at: NOW, info: prOk } },
  }),
  'screenshot 2026-10-14: 318 files, top folders seeded collapsed': () => {
    const files = screenshotFiles()
    const first = files[0]!.path
    const tops = buildTree(files).flatMap(n => (n.kind === 'dir' ? [n.path] : []))
    const holds = (dir: string) => first.startsWith(`${dir}/`)
    return {
      snapshot: [appSnap({ root: appRoot, name: 'app-5678-qa', branch: 'bugfix/5678-swipe-kebab-a11y-qa', files, commits: Array.from({ length: 36 }, (_, i) => ({ ...commits[i % 5]!, sha: `s${i}`, short: `s${i}`.padEnd(7, '0') })) })],
      view: { repo: appRoot, selected: K(appRoot, first), full: [], collapsed: tops.filter(d => !holds(d)).map(d => K(appRoot, d)), scope: 'all' },
      diff: readyDiff(first, patch(3)),
      prs: { [appRoot]: { key: 'bugfix/5678-swipe-kebab-a11y-qa@h1', at: NOW, info: { kind: 'none' } } },
    }
  },
  'everything collapsed: header, file list, every hunk': () => ({
    snapshot: [appSnap()],
    view: baseView(sel),
    diff: readyDiff(sel, patch(3)),
    shut: ['sec:header', 'sec:files', ...[0, 1, 2].map(i => `hunk:${K(appRoot, sel)}#${i}`)],
  }),
  'options row open, wrap on, syntax colours': () => ({
    snapshot: [appSnap()],
    view: baseView(sel, { wrap: true, syntax: true, context: 5 }),
    diff: readyDiff(sel, patch(3, true)),
    showOptions: true,
  }),
  'first load in flight (loading state)': () => ({ busy: true }),
  'no repos yet': () => ({}),
}

// ── stress repo: raw git output from snapshot_stress.py, parsed by the mod's own parsers
type StressEntry = { name: string; root: string; branch: string; baseLabel: string; base: string; num: string; stat: string; untracked: string; unmerged: string; patches: Record<string, string>; op: string | null; commits: unknown[] }
function stressScenario(e: StressEntry) {
  return () => {
    const status = parseNameStatus(e.stat)
    const files: any[] = parseNumstat(e.num).map(row => ({ ...row, status: status.get(row.path) ?? 'M' }))
    for (const path of e.untracked.split('\u0000').filter(Boolean)) files.push({ path, status: '?', added: 0, removed: 0 })
    for (const path of parseUnmerged(e.unmerged)) {
      const f = files.find(x => x.path === path)
      if (f) f.status = '!'
      else files.push({ path, status: '!', added: 0, removed: 0 })
    }
    files.sort((x, y) => x.path.localeCompare(y.path))
    const order = fileOrder(buildTree(files))
    // the first file that has a recorded patch, else the first file
    const pick = order.find(f => e.patches[f.path] !== undefined) ?? order[0]
    const snap = { root: e.root, name: e.root.split('/').pop(), branch: e.branch, base: e.base, baseLabel: e.baseLabel, baseSource: 'default', source: 'touched', files, range: [e.base], head: 'h', ...(e.op ? { op: e.op } : {}), ...(e.commits.length ? { commits: e.commits } : {}) }
    return {
      snapshot: [snap],
      view: { repo: e.root, selected: pick ? K(e.root, pick.path) : null, full: [], collapsed: [], scope: 'all' },
      ...(pick ? { diff: { key: K(e.root, pick.path), isFull: false, text: e.patches[pick.path] ?? '', status: 'ready' } } : {}),
      __patches: e.patches,
    }
  }
}
async function loadStress() {
  try {
    const r = await fetch('stress.json', { cache: 'no-store' })
    if (!r.ok) return 0
    const list = (await r.json()) as StressEntry[]
    for (const e of list) SCENARIOS[`stress: ${e.name}`] = stressScenario(e)
    return list.length
  } catch {
    return 0
  }
}

// ── painter ────────────────────────────────────────────────────────────────
const THEMES: Record<string, Record<string, string>> = {
  dark: { bg: '#1a1a19', text: '#e8e6e1', inactive: '#8f8d88', subtle: '#5c5a56', success: '#4fb862', error: '#e5736a', warning: '#e0a841', merged: '#a98be8', userMessageBackground: '#252523', userMessageBackgroundHover: '#2e2e2b', selectionBg: '#1f2a3a', link: '#6ea8fe', chip: '#3a3a37', diffAdded: '#203a26', diffRemoved: '#46221f', suggestion: '#b1b9f9' },
  // GitHub's dark palette, Primer primitives 11.10.0 functional tokens
  'github-dark': { bg: '#0d1117', text: '#f0f6fc', inactive: '#9198a1', subtle: '#3d444d', success: '#3fb950', error: '#f85149', warning: '#d29922', merged: '#ab7df8', userMessageBackground: '#151b23', userMessageBackgroundHover: '#656c7633', selectionBg: '#388bfd26', link: '#4493f8', chip: '#3d444d', diffAdded: '#2ea04326', diffRemoved: '#f851491a', suggestion: '#4493f8' },
  light: { bg: '#faf9f5', text: '#1f1e1c', inactive: '#76746f', subtle: '#b2b0aa', success: '#2b8a3e', error: '#c4392f', warning: '#a86b00', merged: '#7048c8', userMessageBackground: '#f0eee6', userMessageBackgroundHover: '#e8e5da', selectionBg: '#dbe7fb', link: '#2563eb', chip: '#e3e1d9', diffAdded: '#dff3e2', diffRemoved: '#fbe1de', suggestion: '#5769f7' },
}
let theme = 'github-dark'
// ?reveal=1 draws every hover-revealed control at rest (a sweep audits them too)
let revealAll = new URLSearchParams(location.search).get('reveal') === '1'
let truncStartMode: 'observed' | 'ideal' = 'observed'
const col = (c?: string) => (c ? (THEMES[theme]![c] ?? c) : undefined)
// resolved pixels, not calc(var()): a static dump of the painted DOM must
// carry sizes a detector can read (impeccable detect, 2026-10-14)
let cellW = 8.4
let lineH = 21
const cx = (n: number) => `${Math.round(n * cellW * 100) / 100}px`
const ry = (n: number) => `${Math.round(n * lineH * 100) / 100}px`

function textStyle(el: HTMLElement, p: any, isRoot: boolean) {
  if (p.color) el.style.color = col(p.color)!
  if (p.backgroundColor) el.style.background = col(p.backgroundColor)!
  if (p.bold) el.style.fontWeight = '600'
  if (p.dimColor) el.style.opacity = '0.7'
  if (p.italic) el.style.fontStyle = 'italic'
  if (!isRoot) return
  const w = p.wrap ?? 'wrap'
  const truncate = w.startsWith('truncate') || w === 'end' || w === 'middle'
  if (w === 'truncate-start' && truncStartMode === 'observed') {
    // the 2026-10-10 screenshots: truncate-start wrapped anywhere instead
    el.style.whiteSpace = 'pre-wrap'
    el.style.overflowWrap = 'anywhere'
  } else if (truncate) {
    el.style.whiteSpace = 'pre'
    el.style.overflow = 'hidden'
    el.style.textOverflow = 'ellipsis'
    el.style.minWidth = '0'
    if (w === 'truncate-start') {
      el.style.direction = 'rtl'
      el.style.unicodeBidi = 'plaintext'
    }
  } else {
    el.style.whiteSpace = 'pre-wrap'
    el.style.overflowWrap = 'anywhere'
  }
}

function paint(node: any, parentIsText = false): Node {
  if (node == null || node === false || node === true) return document.createDocumentFragment()
  if (typeof node === 'string' || typeof node === 'number') return document.createTextNode(String(node))
  if (Array.isArray(node)) {
    const f = document.createDocumentFragment()
    node.forEach(c => f.appendChild(paint(c, parentIsText)))
    return f
  }
  const n = node as VNode
  const p = n.props
  const kids = n.children.flat(Infinity)
  const tag = n.type
  if (tag === 'Box') {
    const el = document.createElement('div')
    el.dataset.el = 'Box'
    if (p.key) el.dataset.key = p.key
    const s = el.style
    s.display = 'flex'
    s.flexDirection = p.flexDirection ?? 'row'
    if (p.flexGrow != null) s.flexGrow = String(p.flexGrow)
    s.flexShrink = String(p.flexShrink ?? 1)
    if (p.flexWrap) s.flexWrap = p.flexWrap
    if (p.alignItems) s.alignItems = p.alignItems === 'flex-start' ? 'flex-start' : p.alignItems
    if (p.justifyContent) s.justifyContent = p.justifyContent
    if (p.overflow) s.overflow = p.overflow
    if (p.overflow === 'hidden') el.dataset.clip = '1'
    if (p.minWidth != null) s.minWidth = typeof p.minWidth === 'number' ? cx(p.minWidth) : p.minWidth
    if (p.width != null) s.width = typeof p.width === 'number' ? cx(p.width) : p.width
    // the pinned list's window: rows down, cells across, as the desktop lays them
    if (p.height != null) s.height = typeof p.height === 'number' ? ry(p.height) : p.height
    if (p.minHeight != null) s.minHeight = typeof p.minHeight === 'number' ? ry(p.minHeight) : p.minHeight
    if (p.position) s.position = p.position
    if (p.top != null) s.top = ry(p.top)
    if (p.left != null) s.left = cx(p.left)
    if (p.backgroundColor) s.background = col(p.backgroundColor)!
    // a desktop-style frame: a hairline, rounded for 'round'
    if (p.borderStyle) {
      s.border = `1px solid ${col(p.borderColor) ?? 'currentColor'}`
      if (p.borderStyle === 'round') s.borderRadius = '8px'
      // the desktop's dim border: the colour at half strength
      if (p.borderDimColor) s.borderColor = `color-mix(in srgb, ${col(p.borderColor) ?? 'currentColor'} 50%, transparent)`
    }
    // hidden until the nearest keyed ancestor is hovered (wired after paint)
    if (p.display === 'none') {
      s.display = 'none'
      if (p.hover?.display === 'flex') el.dataset.hov = '1'
    }
    const g = p.gap ?? 0
    s.columnGap = cx(p.columnGap ?? g)
    s.rowGap = ry(p.rowGap ?? g)
    const pad = (k: string) => p[k] ?? 0
    s.paddingLeft = cx(p.paddingLeft ?? p.paddingX ?? p.padding ?? 0)
    s.paddingRight = cx(p.paddingRight ?? p.paddingX ?? p.padding ?? 0)
    s.paddingTop = ry(p.paddingTop ?? p.paddingY ?? p.padding ?? 0)
    s.paddingBottom = ry(p.paddingBottom ?? p.paddingY ?? p.padding ?? 0)
    s.marginTop = ry(pad('marginTop') || p.marginY || 0)
    s.marginBottom = ry(pad('marginBottom') || p.marginY || 0)
    s.marginLeft = cx(pad('marginLeft') || p.marginX || 0)
    if (p.hover?.backgroundColor) {
      el.addEventListener('mouseenter', () => (s.background = col(p.hover.backgroundColor)!))
      el.addEventListener('mouseleave', () => (s.background = p.backgroundColor ? col(p.backgroundColor)! : ''))
    }
    kids.forEach(c => el.appendChild(paint(c)))
    return el
  }
  if (tag === 'Text') {
    const el = document.createElement('span')
    el.dataset.el = 'Text'
    if (p.wrap) el.dataset.wrap = p.wrap
    textStyle(el, p, !parentIsText)
    kids.forEach(c => el.appendChild(paint(c, true)))
    return el
  }
  if (tag === 'Button') {
    const el = document.createElement('button')
    el.dataset.el = 'Button'
    if (p.key) el.dataset.key = p.key
    el.className = p.plain ? 'btn plain' : `btn ${p.variant ?? 'secondary'}`
    if (p.dimColor) el.style.opacity = '0.75'
    if (p.hotkey) {
      const k = document.createElement('kbd')
      k.textContent = p.hotkey.toUpperCase()
      el.appendChild(k)
    }
    const label = document.createElement('span')
    label.className = 'lbl'
    kids.forEach(c => label.appendChild(paint(c, true)))
    el.appendChild(label)
    el.onclick = () => Promise.resolve(p.onPress?.({ surface: 'desktop' })).catch(e => log.push(`press error: ${e}`))
    return el
  }
  if (tag === 'Link') {
    const a = document.createElement('a')
    a.dataset.el = 'Link'
    a.href = '#'
    a.textContent = p.label
    a.className = 'link'
    return a
  }
  if (tag === 'Input') {
    const el = document.createElement('div')
    el.dataset.el = 'Input'
    el.className = 'input'
    if (p.label) {
      const l = document.createElement('label')
      l.textContent = p.label
      el.appendChild(l)
    }
    const i = document.createElement('input')
    i.placeholder = p.placeholder ?? ''
    i.value = p.value ?? ''
    el.appendChild(i)
    const b = document.createElement('button')
    b.className = 'btn secondary'
    b.textContent = p.submitLabel ?? 'submit'
    el.appendChild(b)
    return el
  }
  if (tag === 'Code') {
    const el = document.createElement('pre')
    el.dataset.el = 'Code'
    el.className = `code ${p.wrap === 'wrap' ? 'wrap' : 'cut'}`
    const isDiff = p.format === 'diff'
    String(p.source).split('\n').forEach((line, k) => {
      const d = document.createElement('div')
      // the engine's dim right-aligned gutter for source with startLine (ignored under diff)
      if (!isDiff && typeof p.startLine === 'number') {
        const g = document.createElement('span')
        g.textContent = String(p.startLine + k).padStart(4, ' ') + ' '
        g.style.color = col('inactive')!
        g.style.userSelect = 'none'
        d.appendChild(g)
      }
      d.appendChild(document.createTextNode(line || ' '))
      if (isDiff && line.startsWith('+')) d.style.background = col('diffAdded')!
      else if (isDiff && line.startsWith('-')) d.style.background = col('diffRemoved')!
      else if (isDiff && line.startsWith('@@')) d.style.color = col('inactive')!
      el.appendChild(d)
    })
    return el
  }
  const f = document.createDocumentFragment()
  kids.forEach(c => f.appendChild(paint(c, parentIsText)))
  return f
}

// ── page ───────────────────────────────────────────────────────────────────
const pane = document.getElementById('pane')!
const body = document.getElementById('body')!
let scenario = Object.keys(SCENARIOS)[0]!
let queued = false
function schedule() {
  if (queued) return
  queued = true
  queueMicrotask(() => {
    queued = false
    void render()
  })
}
// the pane's window over the tree, in rows, as the desktop reports it
const linePx = () => parseFloat(getComputedStyle(body).lineHeight) || 21
function paneScroll() {
  return { offset: Math.round(pane.scrollTop / linePx()), bodyRows: Math.max(1, Math.floor((pane.clientHeight - body.offsetTop) / linePx())) }
}
// the wheel as the desktop routes it: to the mod's ui.scroll hook first, with
// the cell under the pointer; next() moves the pane's own window
pane.addEventListener(
  'wheel',
  ev => {
    if (!scrollHook) return
    ev.preventDefault()
    const r = body.getBoundingClientRect()
    const cell = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell')) || 8.4
    const by = Math.sign(ev.deltaY) * Math.max(1, Math.round(Math.abs(ev.deltaY) / linePx()))
    const sc = paneScroll()
    const e = {
      component: 'Pane', requestId: 'repo-diffs', by, offset: sc.offset + by, bodyRows: sc.bodyRows,
      contentRows: Math.round(body.scrollHeight / linePx()), origin: { kind: 'person' },
      // row 0 is the body's first showing row: the body's rect moves with the
      // pane's scroll, so take the offset back out
      pointer: { column: Math.floor((ev.clientX - r.left) / cell), row: Math.floor((ev.clientY - r.top) / linePx()) - sc.offset },
    }
    const next = async (x: any) => {
      pane.scrollTop = x.offset * linePx()
      return {}
    }
    Promise.resolve(scrollHook($, e, next)).then(() => schedule(), err => log.push(`scroll error: ${err}`))
  },
  { passive: false },
)
function measureCell() {
  const probe = document.createElement('span')
  probe.style.cssText = 'font-family:var(--mono);font-size:var(--fs);position:absolute;visibility:hidden;white-space:pre'
  probe.textContent = '0'.repeat(100)
  document.body.appendChild(probe)
  const w = probe.getBoundingClientRect().width / 100
  probe.remove()
  return w
}
async function render() {
  const cell = measureCell()
  document.documentElement.style.setProperty('--cell', `${cell}px`)
  cellW = cell
  lineH = parseFloat(getComputedStyle(body).lineHeight) || Math.round((parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs')) || 14) * 1.5)
  const cols = Math.max(1, Math.floor(body.clientWidth / cell))
  const t0 = performance.now()
  const tree = await renderHook($, { surface: 'desktop', component: 'Pane', requestId: 'repo-diffs', props: { title: 'Repo diffs', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: paneScroll(), view: {} } })
  const t1 = performance.now()
  body.replaceChildren(paint(tree))
  // hover reveal: a Box drawn display none shows while its nearest keyed Box is hovered
  body.querySelectorAll<HTMLElement>('[data-hov]').forEach(el => {
    const scope = el.parentElement?.closest<HTMLElement>('[data-key]')
    if (!scope) return
    scope.addEventListener('mouseenter', () => (el.style.display = 'flex'))
    scope.addEventListener('mouseleave', () => (el.style.display = 'none'))
  })
  if (revealAll) body.querySelectorAll<HTMLElement>('[data-hov]').forEach(el => (el.style.display = 'flex'))
  const w = window as any
  w.__lastHookMs = t1 - t0
  w.__lastPaintMs = performance.now() - t1
  w.__lastCodeChars = codeChars(tree)
  w.__lastContainers = body.querySelectorAll('[data-key^="file:"]').length
  document.getElementById('cols')!.textContent = `${cols} cols · ${pane.clientWidth}px`
  ;(window as any).__lastCols = cols
}
// the engine's per-drawing Code budget is counted over every Code source
function codeChars(n: any): number {
  if (n == null || typeof n !== 'object') return 0
  if (Array.isArray(n)) return n.reduce((a: number, c: any) => a + codeChars(c), 0)
  return (n.type === 'Code' ? String(n.props?.source ?? '').length : 0) + codeChars(n.children)
}
// sets the scenario's atoms, then runs the mod's own loadRest so the other
// open containers' diffs come from the mocked git as they would live
async function loadScenario(name: string) {
  scenario = name
  state.clear()
  const { __patches, ...atoms } = SCENARIOS[name]!() as Record<string, unknown>
  patchSource = (__patches as Record<string, string>) ?? {}
  for (const [k, v] of Object.entries(atoms)) state.set(k, structuredClone(v))
  state.set('refreshedAt', NOW - 60_000)
  await loadRest($, true)
  schedule()
}

// audit: what a person would call "looks broken" at this width
function audit() {
  const issues: string[] = []
  const paneBox = body.getBoundingClientRect()
  const line = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--line-px')) || 20
  if (body.scrollWidth > body.clientWidth + 1) issues.push(`pane scrolls sideways: content ${body.scrollWidth}px > ${body.clientWidth}px`)
  body.querySelectorAll<HTMLElement>('[data-el]').forEach(el => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return
    const what = `${el.dataset.el}${el.dataset.key ? `[${el.dataset.key.replace(/\u0000/g, '∅').slice(-40)}]` : ''} "${(el.textContent ?? '').slice(0, 40)}"`
    // what shows: an overflow-hidden ancestor inside the pane clips the element:
    // the mod's own clipping boxes (overflow="hidden"), never a frame, and a
    // cut Text root (truncate-*), whose token spans it clips (v12 tinted rows)
    let visibleRight = r.right
    for (let a = el.parentElement; a && a !== body; a = a.parentElement) {
      if (a.dataset.el === 'Box' && a.dataset.clip === '1') visibleRight = Math.min(visibleRight, a.getBoundingClientRect().right)
      if (a.dataset.el === 'Text' && getComputedStyle(a).overflow === 'hidden') visibleRight = Math.min(visibleRight, a.getBoundingClientRect().right)
    }
    if (visibleRight > paneBox.right + 1) issues.push(`overflows right by ${Math.round(visibleRight - paneBox.right)}px: ${what}`)
    if (el.dataset.el === 'Text' || el.dataset.el === 'Button') {
      // real wrapped lines, not the row's stretched height
      const range = document.createRange()
      range.selectNodeContents((el.querySelector('.lbl') as HTMLElement | null) ?? el)
      const lines = new Set([...range.getClientRects()].filter(q => q.width > 0).map(q => Math.round(q.top))).size
      const len = (el.textContent ?? '').length
      // a line-number gutter is a narrow column of digits by design (v12)
      const isGutter = /^[\d\s]+$/.test(el.textContent ?? '')
      if (!isGutter && lines >= 3 && r.width < 8 * parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell')) && len > lines)
        issues.push(`crushed into a ${Math.round(r.width)}px column, ${lines} lines tall: ${what}`)
      if (el.dataset.el === 'Button' && r.width < 4 && len > 0) issues.push(`button squeezed to ${Math.round(r.width)}px: ${what}`)
      const lbl = el.querySelector('.lbl') as HTMLElement | null
      const t = lbl ?? el
      if (t.scrollWidth > t.clientWidth + 1 && getComputedStyle(t).textOverflow !== 'ellipsis' && getComputedStyle(t).overflow === 'hidden')
        issues.push(`clipped without ellipsis: ${what}`)
    }
  })
  return [...new Set(issues)]
}
async function sweep(widths: number[]) {
  const out: Record<string, string[]> = {}
  for (const w of widths) {
    setWidth(w)
    await render()
    await new Promise(r => requestAnimationFrame(() => r(null)))
    out[`${w}px/${(window as any).__lastCols}c`] = audit()
  }
  return out
}
function setWidth(w: number) {
  pane.style.width = `${w}px`
  ;(document.getElementById('w') as HTMLInputElement).value = String(w)
}
Object.assign(window as any, { state, loadStress, audit, sweep, loadScenario, setWidth, render, SCENARIOS, log, setTheme: (t: string) => ((theme = t), document.documentElement.dataset.theme = t, schedule()), setTrunc: (m: any) => ((truncStartMode = m), schedule()), setFont: (px: number) => (document.documentElement.style.setProperty('--fs', `${px}px`), document.documentElement.style.setProperty('--line-px', `${Math.round(px * 1.5)}`), schedule()) })

const sc = document.getElementById('scenario') as HTMLSelectElement
const fillScenarios = () => {
  sc.replaceChildren()
  for (const k of Object.keys(SCENARIOS)) sc.add(new Option(k, k))
}
fillScenarios()
void loadStress().then(n => {
  if (n) fillScenarios()
  ;(window as any).__stressLoaded = n
})
sc.onchange = () => void loadScenario(sc.value)
const w = document.getElementById('w') as HTMLInputElement
w.oninput = () => (setWidth(+w.value), schedule())
document.querySelectorAll<HTMLButtonElement>('[data-w]').forEach(b => (b.onclick = () => (setWidth(+b.dataset.w!), schedule())))
new ResizeObserver(() => schedule()).observe(pane)
// ?s=<scenario>&w=<px>&theme=<name>&font=<px>&reveal=1: a state for a headless capture
{
  const q = new URLSearchParams(location.search)
  const want = q.get('s')
  if (want && SCENARIOS[want]) scenario = want
  if (q.get('theme')) (window as any).setTheme(q.get('theme'))
  if (q.get('font')) (window as any).setFont(+q.get('font')!)
  if (q.get('w')) setWidth(+q.get('w')!)
  sc.value = scenario
}
void loadScenario(scenario)
Object.assign(window as any, { setReveal: (on: boolean) => ((revealAll = on), schedule()) })
