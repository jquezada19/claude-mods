import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { CommentTag, Composing, DiffState, FileChange, PrEntry, PrInfo, RepoSnap, ReviewComment, Scope, TurnEdits, View } from '../types'
import { PAN_STEP, cleanPatch, clipHunk, exportComments, firstChange, grouped, hunkContext, hunkHolds, hunkRuns, type HunkRun, nextHunkIndex, panLine, panMax, patchNotes, pickSection, splitHunks } from './hunks'
import { parseNameStatus, parseNumstat, parseUnmerged } from './git-parse'
import { PR_FIELDS, formatPatterns, isExcluded, parsePatterns, parsePrView, prFailure } from './pr'
import { LOG_ARGS, commitRange, parseLog, relTime } from './commits'
import type { Commit } from './commits'
import {
  DEFAULT_OPTIONS,
  KEY_IGNORE_WHITESPACE,
  KEY_LEGEND,
  KEY_VIEWED,
  KEY_NUMBERS,
  KEY_PAN_LEFT,
  KEY_PAN_RIGHT,
  KEY_LESS_CONTEXT,
  KEY_MORE_CONTEXT,
  diffFlags,
  legendRows,
  optionsLabel,
  stepContext,
} from './options'
import type { DiffOptions } from './options'
import { buildTree, fileOrder, visibleRows } from './tree'
import { highlightLine, panTokens, type TokenKind } from './highlight'

// Repos this session works in that are NOT the session's own cwd repo: the
// built-in Diff pane already covers that one. Sources: files touched by Edit/Write/NotebookEdit, plus any
// worktree this session holds a session-ledger lease on.

const PANE = 'repo-diffs'
const TITLE = 'Repo diffs'
// the hunk text a drawing carries; the engine draws 100,000 characters of text
// a drawing, and each drawn line adds its number and padded marker (a tenth
// to a quarter more), so the rest is that overhead and the pane's own words
const DIFF_CAP = 60_000
// How much one drawing may weigh. The desktop drops a pane's whole tree past a
// bound of its own and shows "nothing to show yet" (measured 2026-10-10: 1,639
// elements / 210k characters of JSON drew, 1,738 / 223k did not; with their
// string children, about 1.2x those counts), so remote surfaces get a margin
// under that; the terminal holds the engine's own 20,000 elements. Rows and
// file containers are drawn while they fit. Strings count as nodes: a
// highlighted row is mostly short strings between its coloured spans.
// text: every surface draws a tree's first 100,000 characters of text (strings,
// Code sources) and past that cut a Box loses its key, so a later container
// could be neither read whole nor scrolled to; 90,000 leaves the margin.
const ROOM_REMOTE = { nodes: 1_600, chars: 170_000, text: 90_000 }
const ROOM_TERMINAL = { nodes: 19_000, chars: Number.POSITIVE_INFINITY, text: 90_000 }
type Weight = { nodes: number; chars: number; text: number }
const weightOf = (el: unknown): Weight => {
  let nodes = 0
  let text = 0
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (typeof n === 'string' && n !== '') {
      nodes++
      text += n.length
    }
    if (!n || typeof n !== 'object') return
    nodes++
    const o = n as { props?: { children?: unknown; source?: unknown; label?: unknown }; children?: unknown }
    if (typeof o.props?.source === 'string') text += o.props.source.length
    if (typeof o.props?.label === 'string') text += o.props.label.length
    walk(o.children)
    walk(o.props?.children)
  }
  walk(el)
  const json = JSON.stringify(el, (_k, x: unknown) => (typeof x === 'function' ? undefined : x))
  return { nodes, chars: json?.length ?? 0, text }
}
// GitHub's diff palette. Dark: read off github.com 2026-10-10 (--diffBlob-*,
// --fgColor-*, the prettylights token colours). Light: Primer's light theme
// values, not read off a page. The row tints are alpha hex, which only a
// remote surface paints; the terminal keeps the theme's own diff keys.
type Palette = { addLine: string; addNum: string; delLine: string; delNum: string; fg?: string; muted: string } & Record<TokenKind, string>
const GH_DARK: Palette = {
  addLine: '#2ea04326', addNum: '#3fb9504d', delLine: '#f851491a', delNum: '#f851494d', fg: '#f0f6fc', muted: '#9198a1',
  keyword: '#ff7b72', entity: '#d2a8ff', type: '#ffa657', namespace: '#7ee787', constant: '#79c0ff', string: '#a5d6ff', comment: '#9198a1',
}
const GH_LIGHT: Palette = {
  addLine: '#dafbe1', addNum: '#aceebb', delLine: '#ffebe9', delNum: '#ffcecb', fg: '#1f2328', muted: '#59636e',
  keyword: '#cf222e', entity: '#8250df', type: '#953800', namespace: '#116329', constant: '#0550ae', string: '#0a3069', comment: '#59636e',
}
const BASH_DEBOUNCE_MS = 400
const WIDE_COLS = 90
// below this the tree indents one cell a level and leaves out per-file counts
const NARROW_COLS = 40
// change detection: git-dir mtimes every 3 s, `git status` every 5th tick
const WATCH_MS = 3_000
const STATUS_EVERY = 5
// files whose mtimes the status check reads; past this only status counts
const STATUS_STAT_CAP = 400
// a PR answer is re-read when the branch moves, or after this long (checks
// finish on GitHub without anything changing here)
const PR_TTL_MS = 60_000
const PR_TIMEOUT_MS = 10_000
const SCOPES: ReadonlyArray<{ value: Scope; label: string; description: string }> = [
  { value: 'all', label: 'all', description: 'Everything since the base branch, committed or not, plus untracked files' },
  { value: 'committed', label: 'committed', description: 'Commits since the base branch: what the PR shows' },
  { value: 'touched', label: 'uncommitted', description: 'Work not yet committed, plus untracked files' },
  {
    value: 'turn',
    label: 'last turn',
    description:
      "Only the files an Edit, Write or NotebookEdit changed in the latest turn (subagents included; shell commands are not counted), each with its whole diff against the base",
  },
]
const TAGS: ReadonlyArray<Exclude<CommentTag, ''>> = ['must-fix', 'suggestion', 'nit', 'question']
const TAG_COLOR: Record<string, string> = { 'must-fix': 'error', suggestion: 'success', nit: 'inactive', question: 'warning' }
const BASE_CANDIDATES = ['origin/develop', 'origin/main', 'origin/master']
// where the session ledger keeps one folder per claimed worktree, each with a lease.json
const LEASES_DIR = '.claude/leases/worktree'
// plain, parseable patches whatever the person's git config says
// -M: a moved file is one rename (old → new), not a delete and an add
const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '-M']
// what the git dir holds while an operation is stopped part-way
const IN_PROGRESS: ReadonlyArray<{ file: string; op: NonNullable<RepoSnap['op']> }> = [
  { file: 'rebase-merge', op: 'rebase' },
  { file: 'rebase-apply', op: 'rebase' },
  { file: 'MERGE_HEAD', op: 'merge' },
  { file: 'CHERRY_PICK_HEAD', op: 'cherry-pick' },
  { file: 'REVERT_HEAD', op: 'revert' },
]

// Theme keys that follow the person's light/dark theme. The background ones
// are not in the typed ThemeKey list but resolve ("another key the theme holds
// resolves too"): the transcript's own user-message band and selection blue.
const BAND = 'userMessageBackground'
const HOVER = 'userMessageBackgroundHover'
const SELECTED = 'selectionBg'
// section frames: the theme's quietest grey; the selected file's frame, the
// theme's accent, as GitHub rings the file a link or the tree jumped to
const BORDER = 'subtle'
const FOCUS = 'suggestion'
// the reference dashboard (2026-10-14): a card is a slightly lighter fill inside
// one hairline, with no bands inside it; one warm accent carries data, never a control
const CARD = 'userMessageBackground'
const ACCENT = '#ff5a2c'

const GLYPH: Record<string, { ch: string; color: string }> = {
  A: { ch: 'A', color: 'success' },
  M: { ch: 'M', color: 'warning' },
  D: { ch: 'D', color: 'error' },
  R: { ch: 'R', color: 'merged' },
  T: { ch: 'T', color: 'warning' },
  '?': { ch: 'U', color: 'success' },
  // an unmerged path: never the untracked U
  '!': { ch: '!', color: 'error' },
}
const glyphOf = (s: string) => GLYPH[s[0] ?? 'M'] ?? { ch: s[0] ?? '·', color: 'inactive' }

const EMPTY_VIEW: View = { repo: null, selected: null, full: [], collapsed: [], scope: 'all' }

const touched = atom({ plugin: 'repo-diffs', key: 'touched' } as const, [] as string[])
// The files an Edit, Write or NotebookEdit changed since the latest main turn started
// (subagents' included), recorded after the call ran, as git names them (repo root and
// path inside it, keyOf) so a symlinked or aliased path matches the listing.
// the files edited in the latest main turn: the turn's generation, the paths (git keys) and
// whether more were edited than the list holds, changed together in one update so two edits
// landing at once cannot pass the cap and a straggler of an older turn cannot join
// 0.3.0 kept the list and its overflow flag apart; a reload carries them into turnEdits once
const legacyTurn = atom({ plugin: 'repo-diffs', key: 'lastTurn' } as const, [] as string[])
const legacyTurnFull = atom({ plugin: 'repo-diffs', key: 'lastTurnFull' } as const, false)
const turnEdits = atom({ plugin: 'repo-diffs', key: 'turnEdits' } as const, { gen: 0, paths: [], isFull: false } as TurnEdits)
// The list stops at this many files; past it the scope says so instead of growing.
const LAST_TURN_CAP = 500
// how many paths are stat-ed at once when looking for symlinks
const STAT_BATCH = 16
const snapshot = atom({ plugin: 'repo-diffs', key: 'snapshot' } as const, [] as RepoSnap[])
const refreshedAt = atom({ plugin: 'repo-diffs', key: 'refreshedAt' } as const, 0)
// set on the first open, asked or not: the pane opens by itself at most once
// per session, so closing it is never undone
const autoOpened = atom({ plugin: 'repo-diffs', key: 'autoOpened' } as const, false)
const view = atom({ plugin: 'repo-diffs', key: 'view' } as const, EMPTY_VIEW)
const diff = atom({ plugin: 'repo-diffs', key: 'diff' } as const, null as DiffState | null)
// a refresh is running: the header's live dot shows it
const busy = atom({ plugin: 'repo-diffs', key: 'busy' } as const, false)
// review comments waiting to be sent to the prompt, and the one being written
const comments = atom({ plugin: 'repo-diffs', key: 'comments' } as const, [] as ReviewComment[])
const composing = atom({ plugin: 'repo-diffs', key: 'composing' } as const, null as Composing | null)
// each repo's pull request, by root
const prs = atom({ plugin: 'repo-diffs', key: 'prs' } as const, {} as Record<string, PrEntry>)
// globs whose files the tree hides (gh pr diff --exclude); kept in the store
// across sessions, so lockfile and pbxproj noise stays hidden
const exclude = atom({ plugin: 'repo-diffs', key: 'exclude' } as const, [] as string[])
// the hide field is open: letter hotkeys pause, as while writing a comment
const editingHide = atom({ plugin: 'repo-diffs', key: 'editingHide' } as const, false)
// a base the person picked per repo (root → ref), and the base picker open
const baseOverride = atom({ plugin: 'repo-diffs', key: 'baseOverride' } as const, {} as Record<string, string>)
const editingBase = atom({ plugin: 'repo-diffs', key: 'editingBase' } as const, false)
// the key legend and the branch commits list, open or folded
const showKeys = atom({ plugin: 'repo-diffs', key: 'showKeys' } as const, false)
const showCommits = atom({ plugin: 'repo-diffs', key: 'showCommits' } as const, false)
// Clear drops every comment: it asks first
const confirmClear = atom({ plugin: 'repo-diffs', key: 'confirmClear' } as const, false)
// "show" reveals hidden files for now without discarding the saved patterns
const revealHidden = atom({ plugin: 'repo-diffs', key: 'revealHidden' } as const, false)
// the tree draws this many rows, then offers more (a 1,000-file branch
// took 52 ms and ~9k elements a redraw drawn whole, 2026-10-10)
const TREE_PAGE = 150
const treeLimit = atom({ plugin: 'repo-diffs', key: 'treeLimit' } as const, TREE_PAGE)
// GitHub's Viewed: a file stays viewed while its listing entry is the one it was
// viewed at (status, rename, counts); a new commit or edit that moves it resets
// it. Kept in the plugin store across sessions, as GitHub keeps it per PR.
const viewed = atom({ plugin: 'repo-diffs', key: 'viewed' } as const, {} as Record<string, string>)
const openViewed = atom({ plugin: 'repo-diffs', key: 'openViewed' } as const, [] as string[])
// GitHub's file containers: every changed file in its own frame, folded or
// open. This many are drawn before "show more files"; a larger diff than
// LARGE_LINES waits to be asked for unless it is the selected file; the other
// containers' diffs load LOAD_PARALLEL git calls at a time
const FILE_PAGE = 25
const LARGE_LINES = 1_000
const LOAD_PARALLEL = 4
const fileLimit = atom({ plugin: 'repo-diffs', key: 'fileLimit' } as const, FILE_PAGE)
const treeScroll = atom({ plugin: 'repo-diffs', key: 'treeScroll' } as const, 0)
const diffs = atom({ plugin: 'repo-diffs', key: 'diffs' } as const, {} as Record<string, DiffState>)
// each cut hunk's sideways pan, in columns: `fileKey#hunk index` -> offset
const pan = atom({ plugin: 'repo-diffs', key: 'pan' } as const, {} as Record<string, number>)
// the diff options row: folded until asked for; the keys it holds work while it shows
const showOptions = atom({ plugin: 'repo-diffs', key: 'showOptions' } as const, false)
// every block folds on its chevron: the header's detail, the file list, the
// conflicts, and each hunk (`hunk:<fileKey>#<i>`)
// the header's detail starts folded: the first thing on screen is the list and
// a hunk, the PR reads as one line (impeccable, 2026-10-14); `open:checks`
// is the one entry that means open, not shut (the failing checks list)
const shut = atom({ plugin: 'repo-diffs', key: 'shut' } as const, ['sec:header'] as string[])
// a change set past this many files starts with its top folders collapsed, so
// the list reads as folders to open rather than a wall of paths; once per repo
const FOLD_TREE_AT = 40
const seeded = atom({ plugin: 'repo-diffs', key: 'seeded' } as const, [] as string[])
const SEC_HEADER = 'sec:header'
const SEC_FILES = 'sec:files'
const SEC_CONFLICTS = 'sec:conflicts'
// A viewed mark holds while both sides of the file's diff are what they were: the
// old side by the commit the diff starts from (side), the new side by the file's
// content id (blob, read for marked and selected files). Same counts with different
// text, or the same text against a moved base, is a different change.
const stampOf = (f: FileChange) =>
  `${f.status}|${f.oldPath ?? ''}|${f.added}|${f.removed}|${f.isBinary ? 'b' : ''}|${f.side ?? ''}|${f.blob ?? ''}`

// The content id of each path on the diff's new side: the working tree when the range
// runs to it (one rev), else the range's last revision. One git call for the batch; if
// that fails (a submodule path, a vanished file), each path alone, so one bad path costs
// only itself. In the working tree a symlink is fingerprinted by its link text, as git
// stores it, not by the file it reaches. A path with no id is left out.
async function contentIds($: EngineInterface, root: string, range: readonly string[], paths: readonly string[]) {
  const ids = new Map<string, string>()
  if (paths.length === 0) return ids
  const isWorktree = range.length === 1
  const rev = range[range.length - 1] ?? 'HEAD'
  const links: string[] = []
  const plain: string[] = []
  for (let i = 0; i < paths.length; i += STAT_BATCH) {
    const chunk = paths.slice(i, i + STAT_BATCH)
    const isLink = await Promise.all(
      chunk.map(p => (isWorktree ? $.fs.stat(`${root}/${p}`).then(st => st.isLink === true, () => false) : Promise.resolve(false))),
    )
    chunk.forEach((p, k) => (isLink[k] ? links : plain).push(p))
  }
  const ask = (batch: readonly string[]) =>
    git($, root, isWorktree ? ['hash-object', '--', ...batch] : ['rev-parse', ...batch.map(p => `${rev}:${p}`)]).catch(() => null)
  const lines = (r: Awaited<ReturnType<typeof ask>>) =>
    r && r.exitCode === 0 ? r.stdout.split('\n').filter(l => l.trim() !== '').map(l => l.trim()) : null
  // a failed batch is halved until the bad paths stand alone: one bad path among n costs
  // about 2·log2(n) calls, not n
  const hashAll = async (batch: readonly string[]): Promise<void> => {
    if (batch.length === 0) return
    const got = lines(await ask(batch))
    if (got !== null && got.length === batch.length) {
      batch.forEach((p, i) => ids.set(p, got[i]!))
      return
    }
    if (batch.length === 1) return
    const half = Math.ceil(batch.length / 2)
    await hashAll(batch.slice(0, half))
    await hashAll(batch.slice(half))
  }
  await hashAll(plain)
  for (const p of links) {
    const link = await $.process.run(['readlink', '--', `${root}/${p}`], { timeoutMs: 5_000 }).catch(() => null)
    if (!link || link.exitCode !== 0) continue
    const text = link.stdout.replace(/\n$/, '')
    const r = await $.process.run(['git', ...GIT_PREFIX, '-C', root, 'hash-object', '--stdin'], { stdin: text, timeoutMs: 5_000 }).catch(() => null)
    const id = r && r.exitCode === 0 ? r.stdout.trim() : ''
    if (id) ids.set(p, id)
  }
  return ids
}
// the hide patterns in force: none while hidden files are being shown
const activeExclude = async ($: EngineInterface) => ((await read($, revealHidden)) ? [] : await read($, exclude))

let cwdRoot: string | null = null
let running: Promise<void> | null = null
let queued = false
let diffGen = 0
let restGen = 0
// the last wide drawing's file list: its width, and how far it can scroll,
// so the wheel over it scrolls the list alone (drawing state only)
let pinnedList: { cols: number; rows: number; maxScroll: number } | null = null
// the load past its cache check, still running: a cache hit on the same file
// gives the generation back to it rather than cancelling it
let pendingLoad: { key: string; gen: number } | null = null
let bashTimer: Timer | null = null
let watchTimer: Timer | null = null
let watchTicks = 0
let isTicking = false
let isSending = false
const prInFlight = new Set<string>()
// root\0ref of PR bases a refresh was already run for: a base that is not
// fetched locally must not refresh forever
const prBaseTried = new Map<string, string>()
let commentSeq = 0
// which hunk n/p last scrolled to, per selected file: drawing state only
let hunkCursor: { key: string; at: number } = { key: '', at: -1 }
// what each repo looked like after the last refresh: git-dir mtimes, status
const statSigs = new Map<string, string>()
const statusSigs = new Map<string, string>()

const lines = (s: string) => s.split('\n').filter(l => l.length > 0)
const dirname = (p: string) => p.replace(/\/[^/]*$/, '') || '/'
const basename = (p: string) => p.replace(/\/+$/, '').replace(/^.*\//, '')
const keyOf = (root: string, path: string) => `${root}\u0000${path}`
const splitKey = (key: string) => key.split('\u0000') as [string, string]
const records = (s: string) => s.split('\u0000').filter(r => r.length > 0)

// --no-optional-locks: polling never takes index.lock from another session;
// --literal-pathspecs: a file named `*.ts` is that file, not a glob;
// suppressBlankEmpty off: blank context lines keep their leading space, so
// hunk line counting (comment anchors) holds whatever the person's config
const GIT_PREFIX = ['--no-optional-locks', '--literal-pathspecs', '-c', 'diff.suppressBlankEmpty=false']

async function git($: EngineInterface, root: string, args: string[]) {
  return $.process.run(['git', ...GIT_PREFIX, '-C', root, ...args], { timeoutMs: 15_000 })
}

async function toplevel($: EngineInterface, path: string): Promise<string | null> {
  let dir = path
  for (let i = 0; i < 6 && dir !== '/'; i++) {
    const r = await git($, dir, ['rev-parse', '--show-toplevel']).catch(() => null)
    if (r && r.exitCode === 0) return r.stdout.trim()
    dir = dirname(dir)
  }
  return null
}

// This session's leased worktrees, or null when the ledger could not be read
// (the caller then keeps the worktrees it already knew).
async function ledgerTrees($: EngineInterface): Promise<Map<string, string> | null> {
  // Read straight from the ledger's folder (no python3 to spawn). A folder that cannot be
  // listed is an unreadable ledger (null: the caller keeps what it had); one unreadable
  // lease (mid-write, another session's) is skipped, never the rest.
  let dir: string
  let entries: readonly { name: string; kind: string; isLink?: boolean }[]
  try {
    const home = await $.env.get('HOME')
    if (!home) return null
    dir = `${home}/${LEASES_DIR}`
    entries = await $.fs.list(dir)
  } catch {
    return null
  }
  const sid = await $.session.id().catch(() => '')
  const out = new Map<string, string>()
  for (const entry of entries) {
    // a lease folder may be a symlink (listed as other, isLink): its lease.json is read through it
    if (entry.kind !== 'dir' && entry.isLink !== true) continue
    try {
      const l = JSON.parse(await $.fs.read(`${dir}/${entry.name}/lease.json`)) as Record<string, unknown>
      if (l.session_id === sid && typeof l.worktree === 'string') {
        out.set(l.worktree, typeof l.base_oid === 'string' ? l.base_oid : '')
      }
    } catch {
      // mid-write or not a lease: skipped
    }
  }
  return out
}

// What to diff against, in order: a ref the person picked, the PR's base
// branch (a qa hotfix merges into qa, not develop), then develop/main/master,
// then the session's claim base. The first whose merge-base resolves wins; a
// wanted ref that does not is reported, not silently swapped.
async function pickBase(
  $: EngineInterface,
  root: string,
  leaseBase: string,
  want: { picked?: string; pr?: string },
): Promise<{ base: string; label: string; source: NonNullable<RepoSnap['baseSource']>; note?: string }> {
  const tries: Array<{ ref: string; source: 'picked' | 'pr' | 'default' }> = []
  // a ref that starts with - would reach git as an option, not a revision
  if (want.picked && !want.picked.startsWith('-')) tries.push({ ref: want.picked, source: 'picked' })
  if (want.pr && want.pr !== want.picked) tries.push({ ref: want.pr, source: 'pr' })
  for (const ref of BASE_CANDIDATES) if (!tries.some(t => t.ref === ref)) tries.push({ ref, source: 'default' })
  const missed: string[] = []
  for (const t of tries) {
    const r = await git($, root, ['merge-base', 'HEAD', t.ref]).catch(() => null)
    if (r && r.exitCode === 0) {
      const note = missed.length > 0 ? `${missed.join(', ')} not found locally (git fetch?)` : undefined
      return { base: r.stdout.trim(), label: t.ref, source: t.source, ...(note ? { note } : {}) }
    }
    if (t.source !== 'default') missed.push(t.ref)
  }
  // none of the usual names: the default branch the remote says it has (origin/trunk, …)
  const head = await git($, root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => null)
  const remoteDefault = head && head.exitCode === 0 ? head.stdout.trim() : ''
  if (remoteDefault && !remoteDefault.startsWith('-') && !tries.some(t => t.ref === remoteDefault)) {
    const r = await git($, root, ['merge-base', 'HEAD', remoteDefault]).catch(() => null)
    if (r && r.exitCode === 0) {
      const note = missed.length > 0 ? `${missed.join(', ')} not found locally (git fetch?)` : undefined
      return { base: r.stdout.trim(), label: remoteDefault, source: 'default', ...(note ? { note } : {}) }
    }
  }
  const note = missed.length > 0 ? `${missed.join(', ')} not found locally (git fetch?)` : undefined
  if (leaseBase) return { base: leaseBase, label: `claim base ${leaseBase.slice(0, 8)}`, source: 'claim', ...(note ? { note } : {}) }
  return { base: 'HEAD', label: 'HEAD', source: 'head', ...(note ? { note } : {}) }
}

async function snap(
  $: EngineInterface,
  root: string,
  leaseBase: string,
  source: RepoSnap['source'],
  previous: RepoSnap | undefined,
  scope: Scope,
  want: { picked?: string; pr?: PrEntry } = {},
  view: { commit?: string; ignoreWhitespace?: boolean; selected?: string } = {},
): Promise<RepoSnap> {
  const name = basename(root)
  try {
    const [head, headRev] = await Promise.all([
      git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
      // its own call: --symbolic-full-name would apply to a second HEAD too
      git($, root, ['rev-parse', '--verify', 'HEAD']).catch(() => null),
    ])
    if (head.exitCode !== 0) throw new Error(head.stderr.trim() || 'not a git repo')
    const headSha = headRev && headRev.exitCode === 0 ? headRev.stdout.trim() || undefined : undefined
    // a cached PR answer counts only for the branch and commit it was read for
    const prInfo = want.pr && want.pr.key === `${head.stdout.trim()}@${headSha ?? ''}` ? want.pr.info : undefined
    const prBase = prInfo?.kind === 'pr' && prInfo.baseRefName ? `origin/${prInfo.baseRefName}` : undefined
    const picked =
      scope === 'touched'
        ? { base: 'HEAD', label: 'HEAD', source: 'head' as const, note: undefined }
        : await pickBase($, root, leaseBase, { ...(want.picked ? { picked: want.picked } : {}), ...(prBase ? { pr: prBase } : {}) })
    const { base } = picked
    // the branch's commits since its base (lazygit's commits panel); one picked
    // shows only what it introduced
    const log = scope === 'touched' || base === 'HEAD' ? null : await git($, root, [...LOG_ARGS, `${base}..HEAD`]).catch(() => null)
    const commits = log && log.exitCode === 0 ? parseLog(log.stdout) : []
    // the last-turn scope is always the working tree against the base: a picked commit waits
    const commit = view.commit && scope !== 'turn' ? commits.find(c => c.sha === view.commit) : undefined
    const label = commit ? `commit ${commit.short}` : picked.label
    const range = commit ? commitRange(commit) : scope === 'committed' ? [base, 'HEAD'] : [base]
    const withUntracked = scope !== 'committed' && !commit
    // -w on the listing too: a whitespace-only file leaves the tree, not just its patch
    const listFlags = view.ignoreWhitespace ? ['-w'] : []
    const noFiles = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    // -z: paths come raw, never C-quoted (tabs, quotes, non-ASCII)
    const [num, stat, untracked, dirs, unmerged, baseRefFull] = await Promise.all([
      git($, root, ['diff', '--numstat', '-z', ...PATCH_FLAGS, ...listFlags, ...range]),
      git($, root, ['diff', '--name-status', '-z', ...PATCH_FLAGS, ...listFlags, ...range]),
      withUntracked ? git($, root, ['ls-files', '--others', '--exclude-standard', '-z']) : Promise.resolve(noFiles),
      git($, root, ['rev-parse', '--absolute-git-dir', '--git-common-dir', '--symbolic-full-name', 'HEAD']).catch(() => null),
      withUntracked ? git($, root, ['ls-files', '-u', '-z']) : Promise.resolve(noFiles),
      // the base as git names it (refs/remotes/origin/qa, refs/heads/x,
      // refs/tags/v1), for the watcher; a sha or HEAD~3 prints nothing. No
      // --end-of-options: rev-parse echoes it; a picked ref starting with -
      // never gets here (pickBase drops it)
      picked.source === 'head' || picked.source === 'claim'
        ? Promise.resolve(null)
        : git($, root, ['rev-parse', '--symbolic-full-name', picked.label]).catch(() => null),
    ])
    for (const r of [num, stat, untracked, unmerged]) {
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'git failed')
      if (r.isStdoutTruncated) throw new Error('git output too large')
    }
    const status = parseNameStatus(stat.stdout)
    const files: FileChange[] = parseNumstat(num.stdout).map(row => ({ ...row, status: status.get(row.path) ?? 'M' }))
    for (const path of records(untracked.stdout)) files.push({ path, status: '?', added: 0, removed: 0 })
    // conflicts belong to the working tree: shown in the views that include it
    if (withUntracked) {
      for (const path of parseUnmerged(unmerged.stdout)) {
        const f = files.find(x => x.path === path)
        if (f) f.status = '!'
        else files.push({ path, status: '!', added: 0, removed: 0 })
      }
    }
    files.sort((x, y) => x.path.localeCompare(y.path))
    // last turn: the all-scope listing, kept to the files the latest turn edited
    if (scope === 'turn') {
      const edited = new Set((await read($, turnEdits)).paths)
      const kept = files.filter(f => edited.has(keyOf(root, f.path)) || (f.oldPath !== undefined && edited.has(keyOf(root, f.oldPath))))
      files.splice(0, files.length, ...kept)
    }
    // the selected file too: a mark made on it certifies the text this listing read
    const marks = await read($, viewed)
    const selected = view.selected
    const wanted = files
      .filter(f => f.status !== 'D' && (marks[keyOf(root, f.path)] !== undefined || keyOf(root, f.path) === selected))
      .map(f => f.path)
    const ids = await contentIds($, root, range, wanted)
    const side = range.map(r => (r === 'HEAD' ? (headSha ?? r) : r)).join('..')
    for (const f of files) {
      f.side = side
      const id = ids.get(f.path)
      if (id) f.blob = id
    }
    const w = watchInfo(root, dirs)
    const op = w ? await inProgress($, w.gitDir) : undefined
    return {
      root,
      name,
      branch: head.stdout.trim(),
      base,
      baseLabel: label,
      source,
      files,
      range,
      // the base ref in use, apart from the label (a commit view's label is
      // "commit abc1234"); watched whatever is on screen
      baseUsed: picked.label,
      watch: w && { ...w, baseRef: refOf(baseRefFull) },
      ...(op ? { op } : {}),
      ...(headSha ? { head: headSha } : {}),
      baseSource: picked.source,
      ...(picked.note ? { baseNote: picked.note } : {}),
      ...(commits.length > 0 ? { commits } : {}),
      ...(commit ? { commit } : {}),
    }
  } catch (err) {
    // a failed or timed-out call (index.lock, a rebase) keeps the last good
    // listing, marked stale, rather than flashing "no changes"
    if (previous) return { ...previous, source, isStale: true }
    return { root, name, branch: '?', base: 'HEAD', baseLabel: '?', source, files: [], range: ['HEAD'], error: String(err) }
  }
}

// Where to look for commits, checkouts and staging in this repo; a linked
// worktree keeps HEAD and index in its own git dir, refs in the common one.
function watchInfo(root: string, r: { exitCode: number; stdout: string } | null): RepoSnap['watch'] {
  if (!r || r.exitCode !== 0) return undefined
  const [gitDir, common, ref] = lines(r.stdout)
  if (!gitDir || !common) return undefined
  const commonDir = common.startsWith('/') ? common : `${root}/${common}`
  return { gitDir, commonDir, ref: ref?.startsWith('refs/') ? ref : '', baseRef: '' }
}

// The base candidate in use (origin/develop) as a loose ref path: a fetch
// elsewhere moves the merge-base without touching HEAD or the index.
// git's own name for the base (rev-parse --symbolic-full-name): a refs/...
// path to watch, or none for a sha or an expression.
const refOf = (r: { exitCode: number; stdout: string } | null) => {
  const name = r && r.exitCode === 0 ? r.stdout.trim() : ''
  return name.startsWith('refs/') ? name : ''
}

// A rebase, merge, cherry-pick or revert stopped part-way, by what it leaves
// in the git dir; the first found.
async function inProgress($: EngineInterface, gitDir: string): Promise<RepoSnap['op']> {
  const has = (f: string) => $.fs.exists(`${gitDir}/${f}`).catch(() => false)
  for (const { file, op } of IN_PROGRESS) {
    if (!(await has(file))) continue
    // `git am` stops in rebase-apply too, marked by an `applying` file
    if (file === 'rebase-apply' && (await has('rebase-apply/applying'))) return 'am'
    return op
  }
  return undefined
}

async function mtime($: EngineInterface, path: string): Promise<number> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function statSig($: EngineInterface, w: NonNullable<RepoSnap['watch']>): Promise<string> {
  const paths = [`${w.gitDir}/HEAD`, `${w.gitDir}/index`, `${w.commonDir}/packed-refs`]
  if (w.ref) paths.push(`${w.commonDir}/${w.ref}`)
  if (w.baseRef) paths.push(`${w.commonDir}/${w.baseRef}`)
  // a rebase/merge stopping or ending (even `rebase --quit`, which leaves
  // HEAD and the index alone) adds or removes one of these
  for (const { file } of IN_PROGRESS) paths.push(`${w.gitDir}/${file}`)
  return (await Promise.all(paths.map(p => mtime($, p)))).join(':')
}

async function statusSig($: EngineInterface, root: string): Promise<string | null> {
  const r = await git($, root, ['status', '--porcelain', '-z', '--untracked-files=all']).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  // records are "XY path"; a rename adds its old path as the next record
  const paths: string[] = []
  const recs = records(r.stdout)
  for (let i = 0; i < recs.length && paths.length < STATUS_STAT_CAP; i++) {
    const rec = recs[i]!
    paths.push(rec.slice(3))
    if (rec[0] === 'R' || rec[0] === 'C') i++
  }
  const times = await Promise.all(paths.map(p => mtime($, `${root}/${p}`)))
  return `${r.stdout}\u0000${times.join(':')}`
}

type Sigs = Map<string, { stat: string; status: string | null }>

async function takeSigs($: EngineInterface, snaps: readonly RepoSnap[]): Promise<Sigs> {
  const out: Sigs = new Map()
  await Promise.all(
    snaps.map(async s => {
      if (s.watch) out.set(s.root, { stat: await statSig($, s.watch), status: await statusSig($, s.root) })
    }),
  )
  return out
}

// The baseline the watcher compares against. Taken BEFORE the listing where
// the repo was already known, so a commit landing mid-refresh shows up as a
// change on the next tick instead of being absorbed; a new repo is taken
// after. Pane reads never move it (--no-optional-locks).
async function recordSigs($: EngineInterface, snaps: readonly RepoSnap[], before: Sigs) {
  const after = await takeSigs($, snaps.filter(s => !before.has(s.root)))
  statSigs.clear()
  statusSigs.clear()
  for (const s of snaps) {
    const sig = before.get(s.root) ?? after.get(s.root)
    if (!sig) continue
    statSigs.set(s.root, sig.stat)
    if (sig.status !== null) statusSigs.set(s.root, sig.status)
  }
}

// Another session may commit, stage or edit in a leased worktree; this
// session's tool calls never see that, so look for it on a timer.
// Whether the pane is up; a host that cannot say counts as up, so watching never
// stops for want of an answer.
async function isPaneUp($: EngineInterface) {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE)
  } catch {
    return true
  }
}

async function watchTick($: EngineInterface) {
  if (running || isTicking) return
  // nobody is looking: stop polling git; the next refresh (an edit, /diffs) starts it again
  if (!(await isPaneUp($))) {
    watchTimer?.cancel()
    watchTimer = null
    return
  }
  isTicking = true
  try {
    watchTicks++
    const isSlowTick = watchTicks % STATUS_EVERY === 0
    const snaps = await read($, snapshot)
    let changed = false
    for (const s of snaps) {
      // a repo that failed or has nothing to watch is retried, not forgotten
      if (!s.watch || s.isStale || s.error) {
        if (isSlowTick) changed = true
        continue
      }
      if ((await statSig($, s.watch)) !== statSigs.get(s.root)) changed = true
    }
    if (!changed && isSlowTick) {
      for (const s of snaps) {
        if (!s.watch) continue
        const st = await statusSig($, s.root)
        if (st !== null && st !== statusSigs.get(s.root)) changed = true
      }
    }
    if (changed) await refresh($)
    else if (isSlowTick) void refreshPrs($, snaps).catch(() => undefined)
  } catch {
    // a failed poll waits for the next tick
  } finally {
    isTicking = false
  }
}

const optionsOf = (v: View): DiffOptions => ({
  context: v.context ?? DEFAULT_OPTIONS.context,
  ignoreWhitespace: v.ignoreWhitespace ?? DEFAULT_OPTIONS.ignoreWhitespace,
})

// The file's patch, cleaned for Code; throws with a reason the card shows.
// Context and -w go on this call only: -U on --numstat would print patches.
async function fileDiff($: EngineInterface, s: RepoSnap, f: FileChange, isFull: boolean, o: DiffOptions): Promise<string> {
  const isUntracked = f.status === '?'
  const flags = diffFlags(o, isFull)
  const r = isUntracked
    ? await git($, s.root, ['diff', '--no-index', '--no-color', '--no-ext-diff', ...flags, '--', '/dev/null', f.path])
    : await git($, s.root, [
        'diff',
        ...PATCH_FLAGS,
        ...flags,
        ...(s.range ?? [s.base]),
        '--',
        ...(f.oldPath ? [f.oldPath, f.path] : [f.path]),
      ])
  // --no-index exits 1 when the files differ, which is the point
  const isOk = r.exitCode === 0 || (isUntracked && r.exitCode === 1)
  if (!isOk) throw new Error(r.stderr.trim().split('\n')[0] || `git exited ${r.exitCode}`)
  if (r.isStdoutTruncated) throw new Error('This diff is larger than 4 MB; open it in your editor.')
  return cleanPatch(f.oldPath ? pickSection(r.stdout, f.path) : r.stdout)
}

// The files the tree lists: all but those an exclude glob hides. A conflict
// is never hidden: it needs resolving whatever its name.
function shownFiles(s: RepoSnap, hidden: readonly string[]): FileChange[] {
  return hidden.length === 0 ? s.files : s.files.filter(f => f.status === '!' || !isExcluded(f.path, hidden))
}

// The active repo and selected file, kept valid against a new snapshot.
function settleView(v: View, snaps: readonly RepoSnap[], hidden: readonly string[] = []): View {
  const repo = snaps.find(s => s.root === v.repo) ?? snaps[0]
  if (!repo) return { ...v, repo: null, selected: null }
  const order = fileOrder(buildTree(shownFiles(repo, hidden)))
  const keys = new Set(order.map(f => keyOf(repo.root, f.path)))
  const selected = v.selected && keys.has(v.selected) ? v.selected : order[0] ? keyOf(repo.root, order[0].path) : null
  // forget preferences for files and folders that left every diff
  const allFiles = new Set(snaps.flatMap(x => x.files.map(f => keyOf(x.root, f.path))))
  const allDirs = new Set(
    snaps.flatMap(x => visibleRows(buildTree(x.files), new Set()).flatMap(n => (n.kind === 'dir' ? [keyOf(x.root, n.path)] : []))),
  )
  return {
    repo: repo.root,
    selected,
    scope: v.scope ?? 'all',
    ...(v.wrap ? { wrap: true } : {}),
    ...(v.context !== undefined ? { context: v.context } : {}),
    ...(v.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    ...(v.syntax ? { syntax: true } : {}),
    ...(v.folded?.length ? { folded: v.folded.filter(k => allFiles.has(k)) } : {}),
    // a picked commit stays only while the repo still lists it
    // (an older refresh that started before the pick lists it too, so it no
    // longer drops a pick made while it ran)
    ...(v.commit && snaps.some(x => x.root === v.commit!.root && x.commits?.some(c => c.sha === v.commit!.sha))
      ? { commit: v.commit }
      : {}),
    full: v.full.filter(k => allFiles.has(k)),
    collapsed: v.collapsed.filter(k => allDirs.has(k)),
  }
}

// Loads the selected file's diff. Every call takes a generation first, before
// any await, and every write checks it inside the update, so an older, slower
// load can never overwrite a newer selection (update may re-run its fn). A
// cache hit on the file a load is already fetching (a refresh, a scope
// change) hands the generation back to that load instead of cancelling it.
async function loadDiff($: EngineInterface, force: boolean) {
  await loadSelected($, force)
  await loadRest($, force)
}

// the cache key of a file's diff: the range and the flags it was read with
const rangeKey = (s: RepoSnap | undefined, opts: DiffOptions, isFull: boolean) =>
  `${(s?.range ?? [s?.base ?? '']).join(' ')}|${diffFlags(opts, isFull).join(' ')}`

// whether a file's container is open: not folded by its chevron, not viewed
// (unless opened again), and, unless selected, not too large to draw unasked
function isOpenFile(v: View, key: string, f: FileChange, marks: Record<string, string>, opened: readonly string[]) {
  if ((v.folded ?? []).includes(key)) return false
  if (opened.includes(key)) return true
  if (marks[key] === stampOf(f)) return false
  return key === v.selected || f.added + f.removed <= LARGE_LINES
}

// Loads the diffs of the open containers drawn besides the selected one, a few
// git calls at a time; what left the drawn window leaves the cache. A newer
// call supersedes an older one between batches.
// the first file container drawn: the list's top, or the selected file's own
// place once it sits past the first window, so it and the files after it show
const windowStart = (selIndex: number, limit: number) => (selIndex >= limit ? selIndex : 0)

async function loadRest($: EngineInterface, force: boolean) {
  const gen = ++restGen
  const v = await read($, view)
  const s = (await read($, snapshot)).find(x => x.root === v.repo)
  if (!s) {
    await update($, diffs, m => (gen === restGen ? {} : m))
    return
  }
  const order = fileOrder(buildTree(shownFiles(s, await activeExclude($))))
  const marks = await read($, viewed)
  const opened = await read($, openViewed)
  const limit = await read($, fileLimit)
  const opts = optionsOf(v)
  const cache = await read($, diffs)
  // the selected file past the window is loadSelected's, never this cache's
  const at = order.findIndex(f => keyOf(s.root, f.path) === v.selected)
  const start = windowStart(at, limit)
  const want = order.slice(start, start + limit).filter(f => {
    const k = keyOf(s.root, f.path)
    return k !== v.selected && isOpenFile(v, k, f, marks, opened)
  })
  const wanted = new Set(want.map(f => keyOf(s.root, f.path)))
  const todo: { f: FileChange; key: string; isFull: boolean; range: string; stamp: string }[] = []
  for (const f of want) {
    const key = keyOf(s.root, f.path)
    const isFull = v.full.includes(key)
    const range = rangeKey(s, opts, isFull)
    const c = cache[key]
    const isSame = c && c.status === 'ready' && c.range === range && c.isFull === isFull && c.stamp === stampOf(f)
    if (force || !isSame) todo.push({ f, key, isFull, range, stamp: stampOf(f) })
  }
  // what left the window goes; a reloading diff keeps its old text meanwhile
  await update($, diffs, m => (gen === restGen ? Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => wanted.has(k))) : m))
  for (let i = 0; i < todo.length; i += LOAD_PARALLEL) {
    const done = await Promise.all(
      todo.slice(i, i + LOAD_PARALLEL).map(async (t): Promise<DiffState> => {
        try {
          return { key: t.key, isFull: t.isFull, range: t.range, stamp: t.stamp, text: await fileDiff($, s, t.f, t.isFull, opts), status: 'ready' }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          return { key: t.key, isFull: t.isFull, range: t.range, stamp: t.stamp, text: '', status: 'error', error }
        }
      }),
    )
    if (gen !== restGen) return
    await update($, diffs, m => (gen === restGen ? { ...(m ?? {}), ...Object.fromEntries(done.map(d => [d.key, d])) } : m))
  }
}

async function loadSelected($: EngineInterface, force: boolean) {
  const gen = ++diffGen
  const v = await read($, view)
  const cur = await read($, diff)
  const key = v.selected
  if (!key) {
    await update($, diff, d => (gen === diffGen ? null : d))
    return
  }
  const isFull = v.full.includes(key)
  const [root, path] = splitKey(key)
  const s = (await read($, snapshot)).find(x => x.root === root)
  const f = s?.files.find(x => x.path === path)
  const opts = optionsOf(v)
  // the cache knows the range and the flags it was read with
  const range = rangeKey(s, opts, isFull)
  const isSame = cur?.key === key && cur.isFull === isFull && cur.status === 'ready' && cur.range === range
  if (!force && isSame) {
    if (gen === diffGen && pendingLoad?.key === key) diffGen = pendingLoad.gen
    return
  }
  if (!s || !f) return
  pendingLoad = { key, gen }
  const loading: DiffState = { key, isFull, range, text: '', status: 'loading' }
  if (!isSame) await update($, diff, d => (gen === diffGen ? loading : d))
  let next: DiffState
  try {
    next = { key, isFull, range, text: await fileDiff($, s, f, isFull, opts), status: 'ready' }
  } catch (err) {
    next = { key, isFull, range, text: '', status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
  await update($, diff, d => (gen === diffGen ? next : d))
  if (pendingLoad?.gen === gen) pendingLoad = null
}

async function refreshOnce($: EngineInterface) {
  const leases = await ledgerTrees($)
  const touchedRoots = await read($, touched)
  const previous = await read($, snapshot)
  const scope = (await read($, view)).scope ?? 'all'
  const before = await takeSigs($, previous.filter(p => p.watch && !p.isStale && !p.error))
  const roots = new Map<string, RepoSnap['source']>()
  for (const r of touchedRoots) roots.set(r, 'touched')
  const leased = leases ?? new Map(previous.filter(p => p.source !== 'touched').map(p => [p.root, '']))
  for (const r of leased.keys()) roots.set(r, roots.has(r) ? 'both' : 'ledger')
  if (cwdRoot) roots.delete(cwdRoot)
  const overrides = await read($, baseOverride)
  const prCache = await read($, prs)
  const wantFor = (root: string) => ({
    ...(overrides[root] ? { picked: overrides[root] } : {}),
    ...(prCache[root] ? { pr: prCache[root] } : {}),
  })
  const cur = await read($, view)
  const viewFor = (root: string) => ({
    ...(cur.commit && cur.commit.root === root ? { commit: cur.commit.sha } : {}),
    ...(cur.ignoreWhitespace ? { ignoreWhitespace: true } : {}),
    ...(cur.selected ? { selected: cur.selected } : {}),
  })
  const snaps = await Promise.all(
    [...roots].map(([root, src]) =>
      snap($, root, leased.get(root) ?? '', src, previous.find(p => p.root === root), scope, wantFor(root), viewFor(root)),
    ),
  )
  await update($, snapshot, () => snaps)
  await update($, refreshedAt, () => Date.now())
  const hidden = await activeExclude($)
  await update($, view, v => settleView(v ?? EMPTY_VIEW, snaps, hidden))
  await seedCollapsed($, snaps, hidden)
  await noteSelectedBlob($)
  await loadDiff($, true)
  await recordSigs($, snaps, before)
  // restarted on every refresh: a refused period ends an interval silently
  if (snaps.length > 0) {
    watchTimer?.cancel()
    watchTimer = $.clock.every(WATCH_MS, () => void watchTick($))
  }
  if (snaps.length > 0 && !(await read($, autoOpened))) {
    await update($, autoOpened, () => true)
    await $.ui.open({ id: PANE, title: TITLE })
  }
  // network, so never on the listing's path
  void refreshPrs($, snaps).catch(() => undefined)
}

// The branch's pull request per repo, via gh in the repo's folder. Re-read
// when branch@head changes or the answer is older than PR_TTL_MS; one call
// per repo at a time.
const prKey = (s: RepoSnap) => `${s.branch}@${s.head ?? ''}`

async function refreshPrs($: EngineInterface, snaps: readonly RepoSnap[]) {
  // the engine's clock, so the TTL follows a test's mock clock too
  const now = await $.clock.now().catch(() => Date.now())
  const cache = await read($, prs)
  await Promise.all(
    snaps.map(async s => {
      if (!s.head || s.error || prInFlight.has(s.root)) return
      const key = prKey(s)
      const had = cache[s.root]
      if (had && had.key === key && now - had.at < PR_TTL_MS) return
      prInFlight.add(s.root)
      try {
        let info: PrInfo
        try {
          // the branch named, so a checkout mid-call cannot change the question
          const which = s.branch && s.branch !== 'HEAD' ? [s.branch] : []
          const r = await $.process.run(['gh', 'pr', 'view', ...which, '--json', PR_FIELDS], {
            cwd: s.root,
            timeoutMs: PR_TIMEOUT_MS,
          })
          info =
            r.exitCode !== 0
              ? prFailure(r.stderr)
              : r.isStdoutTruncated
                ? { kind: 'error', message: 'gh output too large' }
                : parsePrView(r.stdout)
        } catch (err) {
          info = { kind: 'error', message: err instanceof Error ? err.message : String(err) }
        }
        await update($, prs, m => ({ ...(m ?? {}), [s.root]: { key, at: now, info } }))
        // the PR merges somewhere else than the base in use: list again, once
        // per root and base (an unfetched base would otherwise loop)
        const prBase = info.kind === 'pr' && info.baseRefName ? `origin/${info.baseRefName}` : ''
        // compared with the base in use, never the label (a commit view shows
        // "commit abc1234"); the latest attempt per root is remembered, so a
        // retarget qa → main → qa still re-lists while an unfetched base does not loop
        if (prBase && prBase !== s.baseUsed && s.baseSource !== 'picked' && prBaseTried.get(s.root) !== prBase) {
          prBaseTried.set(s.root, prBase)
          void refresh($).catch(() => undefined)
        }
      } finally {
        prInFlight.delete(s.root)
      }
      // the branch moved while gh answered: ask again for the current one
      const now2 = (await read($, snapshot)).find(x => x.root === s.root)
      if (now2 && now2.head && prKey(now2) !== key) await refreshPrs($, [now2])
    }),
  )
}

// one refresh at a time; a request during a run schedules exactly one more
function refresh($: EngineInterface): Promise<void> {
  if (running) {
    queued = true
    return running
  }
  running = (async () => {
    await update($, busy, () => true)
    do {
      queued = false
      await refreshOnce($)
    } while (queued)
  })().finally(() => {
    running = null
    void update($, busy, () => false).catch(() => undefined)
  })
  return running
}

// Bash calls come in bursts: refresh once they go quiet
function refreshSoon($: EngineInterface) {
  bashTimer?.cancel()
  bashTimer = $.clock.after(BASH_DEBOUNCE_MS, () => {
    bashTimer = null
    void refresh($)
  })
}

// The selected file's content id, read as its diff is about to load, so a mark made
// on it certifies the text the pane shows (a listing hashes it only once selected).
async function noteSelectedBlob($: EngineInterface) {
  const key = (await read($, view))?.selected
  if (!key) return
  const s = (await read($, snapshot)).find(x => key.startsWith(`${x.root}\u0000`))
  const f = s?.files.find(x => keyOf(s.root, x.path) === key)
  if (!s || !f || f.blob || f.status === 'D') return
  const id = (await contentIds($, s.root, s.range, [f.path])).get(f.path)
  if (!id) return
  await update($, snapshot, snaps =>
    (snaps ?? []).map(x =>
      x.root !== s.root ? x : { ...x, files: x.files.map(y => (y.path === f.path && stampOf(y) === stampOf(f) ? { ...y, blob: id } : y)) },
    ),
  )
}

async function select($: EngineInterface, key: string) {
  // a folder collapsed around the file opens: the selected row is always drawn
  const [root, path] = splitKey(key)
  const isAround = (k: string) => {
    const [r, dir] = splitKey(k)
    return r === root && path.startsWith(`${dir}/`)
  }
  await update($, view, v => {
    const cur = v ?? EMPTY_VIEW
    return { ...cur, selected: key, collapsed: cur.collapsed.filter(k => !isAround(k)) }
  })
  await noteSelectedBlob($)
  await loadDiff($, false)
}

async function step($: EngineInterface, by: 1 | -1) {
  const v = await read($, view)
  const s = (await read($, snapshot)).find(x => x.root === v.repo)
  if (!s) return
  const order = fileOrder(buildTree(shownFiles(s, await activeExclude($)))).map(f => keyOf(s.root, f.path))
  const at = v.selected ? order.indexOf(v.selected) : -1
  const next = order[(at + by + order.length) % order.length]
  if (next) {
    await select($, next)
    await reveal($, next)
  }
}

// a tree row: select the file and bring its container into view
async function jump($: EngineInterface, key: string) {
  await select($, key)
  await reveal($, key)
}

// brings a file's container to the top of the pane, as GitHub's tree jumps;
// quiet when it cannot (the file is not drawn, the surface does not scroll)
async function reveal($: EngineInterface, key: string) {
  await $.ui.scroll({ to: { key: `file:${key}` }, in: PANE, block: 'start' }).catch(() => undefined)
}

// a container's chevron: folds it, or opens it (past a viewed fold too)
async function toggleFold($: EngineInterface, key: string, isOpen: boolean) {
  await update($, view, v => {
    const cur = v ?? EMPTY_VIEW
    const folded = (cur.folded ?? []).filter(k => k !== key)
    return { ...cur, folded: isOpen ? [...folded, key] : folded }
  })
  await update($, openViewed, list => {
    const rest = (list ?? []).filter(k => k !== key)
    return isOpen ? rest : [...rest, key]
  })
  await loadRest($, false)
}

// collapse all (keys: every file shown) / expand all (keys: the viewed ones,
// opened too); a large diff still waits for its own "load diff", as on GitHub
async function foldAll($: EngineInterface, keys: string[], isFolding: boolean) {
  await update($, view, v => ({ ...(v ?? EMPTY_VIEW), folded: isFolding ? keys : [] }))
  await update($, openViewed, () => (isFolding ? [] : keys))
  await loadRest($, false)
}

async function showMoreFiles($: EngineInterface, limit: number) {
  await update($, fileLimit, () => limit)
  await loadRest($, false)
}

async function toggleFull($: EngineInterface, key: string) {
  await update($, view, v => {
    const cur = v ?? EMPTY_VIEW
    const full = cur.full.includes(key) ? cur.full.filter(k => k !== key) : [...cur.full, key]
    return { ...cur, full }
  })
  await loadDiff($, false)
}

// a repo's first listing past FOLD_TREE_AT files starts with its top folders
// collapsed (the selected file's own folder stays open: its row is always drawn)
async function seedCollapsed($: EngineInterface, snaps: readonly RepoSnap[], hidden: readonly string[]) {
  const done = await read($, seeded)
  const fresh = snaps.filter(s => !done.includes(s.root))
  if (fresh.length === 0) return
  await update($, seeded, list => [...new Set([...(list ?? []), ...fresh.map(s => s.root)])])
  const keys = fresh.flatMap(s => {
    const files = shownFiles(s, hidden)
    if (files.length <= FOLD_TREE_AT) return []
    return buildTree(files).flatMap(n => (n.kind === 'dir' ? [keyOf(s.root, n.path)] : []))
  })
  if (keys.length === 0) return
  await update($, view, v => {
    const cur = v ?? EMPTY_VIEW
    const [selRoot, selPath] = cur.selected ? splitKey(cur.selected) : ['', '']
    const holdsSelected = (k: string) => {
      const [r, dir] = splitKey(k)
      return r === selRoot && selPath.startsWith(`${dir}/`)
    }
    return { ...cur, collapsed: [...new Set([...cur.collapsed, ...keys.filter(k => !holdsSelected(k))])] }
  })
}

// a block's chevron: folds it or opens it
async function toggleShut($: EngineInterface, key: string) {
  await update($, shut, list => {
    const cur = list ?? []
    return cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]
  })
}

async function toggleDir($: EngineInterface, key: string) {
  await update($, view, v => {
    const cur = v ?? EMPTY_VIEW
    const collapsed = cur.collapsed.includes(key) ? cur.collapsed.filter(k => k !== key) : [...cur.collapsed, key]
    return { ...cur, collapsed }
  })
}

async function pickRepo($: EngineInterface, root: string) {
  const snaps = await read($, snapshot)
  const hidden = await activeExclude($)
  await update($, view, v => settleView({ ...(v ?? EMPTY_VIEW), repo: root, selected: null }, snaps, hidden))
  await loadDiff($, false)
}

// A new scope is a new listing: the files and the base both change.
// n/p: scroll the pane to the next or previous hunk of the selected file,
// wrapping at either end.
async function stepHunk($: EngineInterface, by: 1 | -1, count: number, key: string) {
  if (count === 0) return
  // moved before any await, so two quick presses land on two hunks
  const at = nextHunkIndex(hunkCursor.key === key ? hunkCursor.at : -1, by, count)
  hunkCursor = { key, at }
  try {
    const r = await $.ui.scroll({ to: { key: `hunk:${at}` }, in: PANE, block: 'start' })
    if (r.deny) $.ui.toast(`Repo diffs: could not scroll (${r.deny})`)
  } catch (err) {
    $.ui.toast(`Repo diffs: could not scroll (${err instanceof Error ? err.message : String(err)})`)
  }
}

// New hide globs: kept for later sessions, and a hidden selection moves on.
async function setExclude($: EngineInterface, patterns: string[]) {
  await update($, exclude, () => patterns)
  await update($, editingHide, () => false)
  await update($, revealHidden, () => false)
  await $.store.set('exclude', patterns).catch(() => undefined)
  const snaps = await read($, snapshot)
  await update($, view, v => settleView(v ?? EMPTY_VIEW, snaps, patterns))
  await loadDiff($, false)
}

// "show" / "hide again": hidden files come and go; the saved patterns stay
async function toggleReveal($: EngineInterface) {
  await update($, revealHidden, r => !r)
  const snaps = await read($, snapshot)
  const active = await activeExclude($)
  await update($, view, v => settleView(v ?? EMPTY_VIEW, snaps, active))
  await loadDiff($, false)
}

// A base for this repo, or null for automatic (PR base, then develop/main/master).
async function setBase($: EngineInterface, root: string, ref: string | null) {
  await update($, baseOverride, m => {
    const next = { ...(m ?? {}) }
    if (ref) next[root] = ref
    else delete next[root]
    return next
  })
  await update($, editingBase, () => false)
  await refresh($)
}

async function stepContextBy($: EngineInterface, by: 1 | -1) {
  await update($, view, v => {
    const cur = v ?? EMPTY_VIEW
    return { ...cur, context: stepContext(cur.context ?? DEFAULT_OPTIONS.context, by) }
  })
  await loadDiff($, false)
}

// -w changes which files are listed, so it re-lists rather than reloading one
// g: GitHub's tinted rows, or syntax-coloured Code runs (a Code paints its own
// background, so it cannot carry the tint)
async function toggleSyntax($: EngineInterface) {
  await update($, view, v => {
    const cur = v ?? EMPTY_VIEW
    const { syntax: _drop, ...rest } = cur
    return cur.syntax ? rest : { ...rest, syntax: true }
  })
}

async function toggleWhitespace($: EngineInterface) {
  await update($, view, v => {
    const cur = v ?? EMPTY_VIEW
    return { ...cur, ignoreWhitespace: !cur.ignoreWhitespace }
  })
  await refresh($)
}

// A commit of this repo's branch to show alone, or null for the whole branch.
async function pickCommit($: EngineInterface, root: string, sha: string | null) {
  await update($, view, v => {
    const cur = v ?? EMPTY_VIEW
    const { commit: _drop, ...rest } = cur
    return sha ? { ...rest, commit: { root, sha }, selected: null } : { ...rest, selected: null }
  })
  await refresh($)
}

// one hunk's sideways pan, kept within 0..max columns
async function panBy($: EngineInterface, key: string, by: number, max: number) {
  await update($, pan, p => {
    const next = Math.max(0, Math.min(max, (p[key] ?? 0) + by))
    const { [key]: _drop, ...rest } = p
    return next > 0 ? { ...rest, [key]: next } : rest
  })
}

// a/d: pan the hunk n/p last landed on in the selected file, else its first
async function panCurrent($: EngineInterface, file: string, hunks: string[], by: number) {
  const at = hunkCursor.key === file && hunkCursor.at < hunks.length ? hunkCursor.at : 0
  const text = hunks[at]
  if (text === undefined) return
  const max = panMax(text)
  if (max === 0) return $.ui.toast('Repo diffs: nothing to scroll in this change')
  await panBy($, `${file}#${at}`, by, max)
}

async function toggleWrap($: EngineInterface) {
  await update($, view, v => {
    const cur = v ?? EMPTY_VIEW
    return { ...cur, wrap: !cur.wrap }
  })
}

// path:line on the clipboard, absolute so it means one checkout among several
async function copyText($: EngineInterface, text: string, surface: RenderSurface) {
  const r = await $.ui.copy({ text, surface }).catch(() => ({ isCopied: false }))
  $.ui.toast(r.isCopied ? `Copied ${text}` : 'Repo diffs: could not copy to the clipboard')
}

async function pickScope($: EngineInterface, scope: Scope) {
  await update($, view, v => ({ ...(v ?? EMPTY_VIEW), scope }))
  await refresh($)
}

async function startComment($: EngineInterface, at: Omit<Composing, 'tag' | 'scope' | 'commit'>) {
  const v = await read($, view)
  const scope = v.scope ?? 'all'
  const commit = v.commit && v.commit.root === at.root ? v.commit.sha : undefined
  await update($, composing, () => ({ ...at, scope, tag: '', ...(commit ? { commit } : {}) }))
}

async function setTag($: EngineInterface, tag: CommentTag) {
  await update($, composing, c => (c ? { ...c, tag: c.tag === tag ? '' : tag } : c))
}

async function addComment($: EngineInterface, body: string) {
  const text = body.trim()
  const c = await read($, composing)
  if (!c || !text) return
  const id = `${Date.now()}-${++commentSeq}`
  await update($, comments, list => [...(list ?? []), { ...c, id, body: text }])
  await update($, composing, () => null)
  // a Clear prompt left open as the last comment went never greets the next
  await update($, confirmClear, () => false)
}

// v / "[ ] viewed": mark the selected file viewed and move to the next unviewed
// one, as GitHub folds a viewed file and the reviewer scrolls on; again unmarks.
async function toggleViewed($: EngineInterface, key: string) {
  const s = (await read($, snapshot)).find(x => key.startsWith(`${x.root}\u0000`))
  const f = s?.files.find(x => keyOf(s.root, x.path) === key)
  if (!s || !f) return
  const marks = await read($, viewed)
  const isOn = marks[key] === stampOf(f)
  const next = { ...marks }
  if (isOn) delete next[key]
  else {
    // the content id the listing read (the selected file's), or read now for a file
    // marked from another container; the next listing compares against it
    const id = f.blob ?? (f.status === 'D' ? undefined : (await contentIds($, s.root, s.range, [f.path])).get(f.path))
    next[key] = stampOf(id ? { ...f, blob: id } : f)
    // a freshly read id goes on the listing on screen, unless that listing moved meanwhile
    if (id && !f.blob) {
      await update($, snapshot, snaps =>
        (snaps ?? []).map(x =>
          x.root !== s.root
            ? x
            : { ...x, files: x.files.map(y => (y.path === f.path && stampOf(y) === stampOf(f) ? { ...y, blob: id } : y)) },
        ),
      )
    }
  }
  await update($, viewed, () => next)
  await update($, openViewed, list => (list ?? []).filter(k => k !== key))
  await $.store.set('viewed', next).catch(() => undefined)
  // marked from another file's container: the selection stays where it is
  if (isOn || key !== (await read($, view)).selected) {
    await loadRest($, false)
    return
  }
  const order = fileOrder(buildTree(shownFiles(s, await activeExclude($))))
  const at = order.findIndex(x => keyOf(s.root, x.path) === key)
  const rest = [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))]
  const unviewed = rest.find(x => next[keyOf(s.root, x.path)] !== stampOf(x))
  if (unviewed) {
    await select($, keyOf(s.root, unviewed.path))
    await reveal($, keyOf(s.root, unviewed.path))
  } else await loadRest($, false)
}

// Clear, once confirmed: every comment goes
async function clearComments($: EngineInterface) {
  await update($, comments, () => [])
  await update($, confirmClear, () => false)
}

async function removeComment($: EngineInterface, id: string) {
  await update($, comments, list => (list ?? []).filter(c => c.id !== id))
}

// Hands every comment to the prompt box as one review block; they are
// cleared only once the box took them.
async function sendComments($: EngineInterface) {
  if (isSending) return
  isSending = true
  try {
    const list = await read($, comments)
    if (list.length === 0) return
    const text = exportComments(list.map(c => ({ ...c, repo: repoLabel(c.root, list) })))
    const r = await $.prompt.fill({ text, mode: 'append' })
    if (!r.isFilled) {
      $.ui.toast(`Repo diffs: the prompt box did not take the comments${r.refusal ? ` (${r.refusal})` : ''}`)
      return
    }
    // only what went out: a comment added during the fill stays
    const sent = new Set(list.map(c => c.id))
    await update($, comments, cur => (cur ?? []).filter(c => !sent.has(c.id)))
    $.ui.toast(`Repo diffs: ${plural(list.length, 'comment')} added to the prompt`)
  } finally {
    isSending = false
  }
}

// The repo's folder name, or its whole path when two commented repos share
// a folder name (client/app and server/app).
function repoLabel(root: string, list: readonly ReviewComment[]): string {
  const name = basename(root)
  const clash = list.some(c => c.root !== root && basename(c.root) === name)
  return clash ? root : name
}

// 'new' the first time a repo is edited, 'known' after, null outside one
async function addTouched($: EngineInterface, filePath: string): Promise<'new' | 'known' | null> {
  const root = await toplevel($, dirname(filePath))
  if (!root || root === cwdRoot) return null
  const list = await read($, touched)
  if (list.includes(root)) return 'known'
  await update($, touched, l => [...(l ?? []), root])
  return 'new'
}

// A repo's first edit waits for its listing so the pane shows it; later edits
// refresh without holding the tool's result back.
async function refreshAfterEdit($: EngineInterface, filePath: string) {
  const seen = await addTouched($, filePath)
  if (seen === 'new') await refresh($)
  else if (seen === 'known') void refresh($).catch(() => undefined)
}

const fmtTime = (t: number) => (t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'never')
const sum = (files: readonly FileChange[], k: 'added' | 'removed') => files.reduce((a, f) => a + f[k], 0)
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// Which main turn is current: an edit counts for the turn it started in, so one still
// running when the next turn begins belongs to neither.

// The listing's key for a file (repo root as git resolves it, path inside the repo).
async function gitKeyOf($: EngineInterface, filePath: string): Promise<string | null> {
  const r = await git($, dirname(filePath), ['rev-parse', '--show-toplevel', '--show-prefix']).catch(() => null)
  if (!r || r.exitCode !== 0) return null
  const [root, prefix = ''] = r.stdout.split('\n')
  return root ? keyOf(root.trim(), `${prefix.trim()}${basename(filePath)}`) : null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // a reload from 0.3.0 mid-turn: keep that turn's list and flag
    const oldPaths = await read($, legacyTurn)
    if (Array.isArray(oldPaths) && oldPaths.length > 0) {
      const oldFull = (await read($, legacyTurnFull)) === true
      await update($, turnEdits, t =>
        t && (t.gen > 0 || t.paths.length > 0) ? t : { gen: 0, paths: oldPaths.filter((x): x is string => typeof x === 'string').slice(0, LAST_TURN_CAP), isFull: oldFull },
      )
      await update($, legacyTurn, () => [])
      await update($, legacyTurnFull, () => false)
    }
    cwdRoot = await toplevel($, e.cwd)
    await $.command.register({
      name: 'diffs',
      description: 'Show branch diffs for the project repos/worktrees this session touches',
    })
    // hide globs from earlier sessions, unless this session already set some
    const saved = await $.store.get('exclude').catch(() => undefined)
    if (Array.isArray(saved) && (await read($, exclude)).length === 0) {
      await update($, exclude, () => saved.filter((p): p is string => typeof p === 'string'))
    }
    const savedViewed = await $.store.get('viewed').catch(() => undefined)
    if (savedViewed && typeof savedViewed === 'object' && !Array.isArray(savedViewed)) {
      const marks = Object.fromEntries(Object.entries(savedViewed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      await update($, viewed, cur => ({ ...marks, ...(cur ?? {}) }))
    }
    void refresh($)
    return started
  })

  // /clear and /resume (session.end reason clear or resume) start another conversation with
  // no session.start: the pane may open itself again on its first edit (/branch does not). The repos stay: their edits are on disk.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await update($, autoOpened, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'diffs' }, async $ => {
    await update($, autoOpened, () => true)
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    const snaps = await read($, snapshot)
    const n = snaps.reduce((a, s) => a + s.files.length, 0)
    return { text: `Repo diffs pane opened: ${snaps.length} repo(s), ${n} changed file(s).` }
  })

  // A new main turn starts the last-turn list over; a subagent's turn is part of it.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turnEdits, t => ({ gen: (t?.gen ?? 0) + 1, paths: [], isFull: false }))
      if ((await read($, view)).scope === 'turn') void refresh($).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Observes only, never gates: the .catch replays the call's own result if
  // anything after next() throws.
  on('tool.call', async ($, e, next) => {
    const gen = (await read($, turnEdits)).gen
    const result = await next(e)
    // an edit that ran (not refused, not an error) in the turn it started in joins the list
    const edited = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : undefined
    if (edited !== undefined && result.deny === undefined && result.isError !== true) {
      const key = await gitKeyOf($, edited)
      if (key !== null) {
        await update($, turnEdits, t => {
          const cur = t ?? { gen: 0, paths: [], isFull: false }
          if (cur.gen !== gen || cur.paths.includes(key)) return cur
          if (cur.paths.length >= LAST_TURN_CAP) return cur.isFull ? cur : { ...cur, isFull: true }
          return { ...cur, paths: [...cur.paths, key] }
        })
      }
    }
    if (e.tool === 'Edit' || e.tool === 'Write') {
      await refreshAfterEdit($, e.file_path)
    } else if (e.tool === 'NotebookEdit') {
      await refreshAfterEdit($, e.notebook_path)
    } else if (e.tool === 'Bash') {
      // Bash may commit, claim a worktree, or edit files directly
      refreshSoon($)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    // A terminal's faint text measured under 4.5:1 (light themes ~3.9 on white,
    // dark ~4.3 on the band); the desktop's own dim measured 9.7:1. So dim only
    // off the terminal, where each on/off control also changes its label.
    const canDim = e.surface !== 'terminal'
    const { Box, Text, Button, Code, Link } = ui
    // the phone draws no text field (its table has no Input); named by surface
    // as well, since a test engine's table may hold one anyway
    const Input = e.surface !== 'mobile' && 'Input' in ui ? ui.Input : null
    const snaps = await read($, snapshot)
    const v = await read($, view)
    const d = await read($, diff)
    const cached = await read($, diffs)
    const pans = await read($, pan)
    const fileCap = await read($, fileLimit)
    const at = await read($, refreshedAt)
    const isBusy = await read($, busy)
    const allComments = await read($, comments)
    const comp = await read($, composing)
    const prMap = await read($, prs)
    const hidden = await read($, exclude)
    const isRevealing = await read($, revealHidden)
    // the patterns in force: none while hidden files are being shown
    const active = isRevealing ? [] : hidden
    const isConfirmingClear = await read($, confirmClear)
    const rowLimit = await read($, treeLimit)
    const marks = await read($, viewed)
    const openList = await read($, openViewed)
    const isEditingHide = await read($, editingHide)
    const isEditingBase = await read($, editingBase)
    const overrides = await read($, baseOverride)
    const isShowingKeys = await read($, showKeys)
    const isShowingCommits = await read($, showCommits)
    const isShowingOptions = await read($, showOptions)
    const shutList = await read($, shut)
    const now = await $.clock.now().catch(() => Date.now())
    const opts = optionsOf(v)
    const scope = v.scope ?? 'all'
    const isTurnFull = (await read($, turnEdits)).isFull
    const cols = e.props.bodyColumns || 80
    // the person's theme picks GitHub's light or dark palette; unknown reads dark
    const themeRow = await $.config.list().then(rows => rows?.find(r => r.key === 'theme'), () => undefined)
    const gh = /light/i.test(String(themeRow?.value ?? '')) ? GH_LIGHT : GH_DARK
    const pal: Palette =
      e.surface === 'terminal'
        ? { ...gh, addLine: 'diffAddedDimmed', addNum: 'diffAdded', delLine: 'diffRemovedDimmed', delNum: 'diffRemoved', fg: undefined, muted: 'inactive' }
        : gh
    const isWide = cols >= WIDE_COLS

    // a loading placeholder that holds the room a diff takes: three dim rows,
    // so the card does not jump when the lines arrive (no spinner element exists)
    const skeleton = (label: string) => (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text dimColor={canDim}>{label}</Text>
        <Text color="subtle">{'░'.repeat(28)}</Text>
        <Text color="subtle">{'░'.repeat(44)}</Text>
        <Text color="subtle">{'░'.repeat(18)}</Text>
      </Box>
    )
    // the first listing is still running: not "no repos" (empty/loading state check, 2026-10-14)
    if (snaps.length === 0 && isBusy) return skeleton('Looking for project repos…')
    if (snaps.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          <Text bold>No project repos yet</Text>
          <Text dimColor={canDim}>
            A repo shows up here once this session claims its worktree or edits a file in it. Changes in this
            session's own folder are in the built-in Diff pane.
          </Text>
          <Box>
            <Button key="refresh" plain dimColor={canDim} onPress={() => refresh($)}>
              ↻ refresh
            </Button>
          </Box>
        </Box>
      )
    }

    const repo = snaps.find(s => s.root === v.repo) ?? snaps[0]!
    const files = shownFiles(repo, active)
    // what the saved patterns hide, shown or not
    const hiddenCount = repo.files.length - shownFiles(repo, hidden).length
    const tree = buildTree(files)
    const collapsed = new Set(v.collapsed.filter(k => k.startsWith(`${repo.root}\u0000`)).map(k => splitKey(k)[1]))
    const rows = visibleRows(tree, collapsed)
    const selRow = rows.findIndex(n => n.kind === 'file' && keyOf(repo.root, n.file.path) === v.selected)
    // a narrow pane: shallower indents, and the counts stay on the card
    const isNarrow = cols < NARROW_COLS
    // each section a rounded panel; flat on a narrow pane, where the frame's two
    // cells a side would come out of the content
    const panel = isNarrow ? { backgroundColor: CARD } : { borderStyle: 'round', borderColor: BORDER, backgroundColor: CARD }
    // the desktop has a pointer (hover tints); secondary actions are still
    // drawn always, dim: a control shown only under the pointer has no
    // keyboard path (impeccable audit, 2026-10-14)
    const canHover = e.surface === 'desktop'
    // the file list's own width: beside the card it is a fraction of the pane
    // a quarter of the pane, not a third: the diff is what is read (Codex, 2026-10-14)
    const treeCols = isWide ? Math.max(24, Math.min(40, Math.round(cols * 0.26))) : cols
    const isViewedFile = (f: FileChange) => marks[keyOf(repo.root, f.path)] === stampOf(f)
    const viewedCount = files.filter(isViewedFile).length
    // the largest change in the list sizes the share bars
    const BAR_CELLS = 6
    const maxChange = files.reduce((m, f) => Math.max(m, f.added + f.removed), 0)
    const order = fileOrder(tree)
    const [, selPath] = v.selected ? splitKey(v.selected) : ['', '']
    const selFile = repo.files.find(f => f.path === selPath)
    const selIndex = order.findIndex(f => f.path === selPath)
    const commentsIn = (path: string) => allComments.filter(c => c.root === repo.root && c.path === path)
    // a comment's line numbers belong to the view it was written in
    const viewingCommit = repo.commit?.sha
    const isHere = (c: { scope?: Scope; commit?: string }) => (c.scope ?? 'all') === scope && c.commit === viewingCommit
    const conflicts = repo.files.filter(f => f.status === '!')
    // letter hotkeys pause while a comment is typed
    // the draft's box is drawn only on its own file's card: elsewhere it is kept
    // (and back on return) but must not hold the keys
    const isComposerShown = comp !== null && Boolean(selFile) && comp.root === repo.root && comp.path === selPath
    // an editor opened on another surface (the phone draws no field) holds no keys here
    const isTyping = isComposerShown || (Input !== null && (isEditingHide || isEditingBase))
    const hk = (key: string) => (isTyping ? undefined : key)

    // GitHub's stat: additions then deletions, each only when there are any
    // isPlain: on the selection colour, where red, green and grey all measured
    // under 4.5:1 in the terminal themes; the − and + still say which is which
    // the reference's delta chip: a tinted pill around a bold figure
    const chip = (text: string, tint: string, color: string | undefined) => (
      <Box paddingX={1} backgroundColor={tint}>
        <Text color={color} bold>
          {text}
        </Text>
      </Box>
    )
    const chips = (added: number, removed: number) => (
      <Box flexDirection="row" columnGap={1}>
        {/* plain bold text on the tint: red text on the red tint over a card fill measured 4.3:1 */}
        {added > 0 && chip(`+${grouped(added)}`, 'diffAdded', undefined)}
        {removed > 0 && chip(`−${grouped(removed)}`, 'diffRemoved', undefined)}
        {added === 0 && removed === 0 && chip('±0', HOVER, 'inactive')}
      </Box>
    )
    const stat = (added: number, removed: number, isBinary?: boolean, isPlain?: boolean) =>
      isBinary ? (
        <Text dimColor={canDim && !isPlain}>bin</Text>
      ) : added === 0 && removed === 0 ? (
        <Text color={isPlain ? undefined : 'inactive'}>±0</Text>
      ) : (
        // GitHub's order and grouping: +1,001 −75
        <Text>
          {added > 0 && <Text color={isPlain ? undefined : 'success'}>{`+${grouped(added)}`}</Text>}
          {removed > 0 && added > 0 && ' '}
          {removed > 0 && <Text color={isPlain ? undefined : 'error'}>{`−${grouped(removed)}`}</Text>}
        </Text>
      )
    // GitHub's five-block diffstat beside the totals
    const blocks = (added: number, removed: number) => {
      const total = added + removed
      const green = total ? Math.min(Math.round((5 * added) / total), removed ? 4 : 5) : 0
      const red = total ? Math.min(5 - green, Math.max(removed ? 1 : 0, Math.round((5 * removed) / total))) : 0
      return (
        <Text>
          <Text color="success">{'■'.repeat(green)}</Text>
          <Text color="error">{'■'.repeat(red)}</Text>
          <Text color="inactive">{'■'.repeat(5 - green - red)}</Text>
        </Text>
      )
    }
    // G1, after gh pr status: number (a link), state, checks, mergeable, review
    const prRow = (info: PrInfo) => {
      if (info.kind === 'none') return <Text color="inactive">No pull request for this branch</Text>
      if (info.kind === 'error') {
        return (
          <Text color="inactive" wrap="truncate-end">
            {`PR status unavailable: ${info.message}`}
          </Text>
        )
      }
      const st =
        info.state === 'OPEN' && info.isDraft
          ? { label: 'Draft', color: 'inactive' }
          : info.state === 'OPEN'
            ? { label: 'Open', color: 'success' }
            : info.state === 'MERGED'
              ? { label: 'Merged', color: 'merged' }
              : { label: 'Closed', color: 'error' }
      const review =
        info.reviewDecision === 'APPROVED'
          ? { label: 'approved', color: 'success' }
          : info.reviewDecision === 'CHANGES_REQUESTED'
            ? { label: 'changes requested', color: 'error' }
            : info.reviewDecision === 'REVIEW_REQUIRED'
              ? { label: 'review required', color: 'warning' }
              : // empty means no review decision yet, never approval
                { label: 'no review yet', color: 'inactive' }
      const c = info.checks
      const total = c.pass + c.fail + c.pending + c.skipping + c.cancel
      return (
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Link key="pr-link" href={info.url} label={`PR #${info.number}`} />
          <Text color={st.color}>{st.label}</Text>
          {total > 0 && (
            <Text>
              {c.fail > 0 && <Text color="error">{`✗ ${c.fail} `}</Text>}
              {c.pending > 0 && <Text color="warning">{`● ${c.pending} `}</Text>}
              <Text color={c.fail ? 'inactive' : 'success'}>{`✓ ${c.pass}/${total - c.skipping}`}</Text>
            </Text>
          )}
          {info.mergeable === 'CONFLICTING' && <Text color="error">merge conflicts</Text>}
          {info.mergeable === 'MERGEABLE' && <Text color="inactive">mergeable</Text>}
          <Text color={review.color}>{review.label}</Text>
        </Box>
      )
    }
    const live = isBusy
      ? { color: 'warning', label: 'updating' }
      : repo.isStale
        ? { color: 'error', label: 'stale' }
        : { color: 'success', label: 'live' }
    const totalAdded = sum(files, 'added')
    const totalRemoved = sum(files, 'removed')
    // an answer for another branch or commit is not this one's
    const prEntry = prMap[repo.root]
    const pr = prEntry && prEntry.key === prKey(repo) ? prEntry.info : undefined
    const baseTag =
      repo.baseSource === 'picked' ? 'picked' : repo.baseSource === 'pr' ? 'PR base' : repo.baseSource === 'claim' ? 'claim' : ''
    const prBaseRef = pr?.kind === 'pr' && pr.baseRefName ? `origin/${pr.baseRefName}` : ''
    // lazygit's diffing menu: automatic, the usual targets, or any ref
    const baseChoices = [...new Set([prBaseRef, 'origin/develop', 'origin/qa', 'origin/main'].filter(Boolean))]
    const isHeaderShut = shutList.includes(SEC_HEADER)
    const isFilesShut = shutList.includes(SEC_FILES)
    const isConflictsShut = shutList.includes(SEC_CONFLICTS)
    const isChecksOpen = shutList.includes('open:checks')

    // ── header: repo tabs, repo · branch → base · totals, scope, comments
    // the PR in one line while the header is folded: number, state, checks
    const prCompact = (info: PrInfo) => {
      if (info.kind !== 'pr') return null
      const c = info.checks
      const total = c.pass + c.fail + c.pending + c.skipping + c.cancel
      const st = info.state === 'OPEN' && info.isDraft ? 'draft' : info.state.toLowerCase()
      return (
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Link key="pr-link" href={info.url} label={`PR #${info.number}`} />
          <Text color="inactive">{st}</Text>
          {total > 0 && (
            <Text color={c.fail > 0 ? 'error' : c.pending > 0 ? 'warning' : 'success'}>
              {c.fail > 0 ? `✗ ${c.fail}` : c.pending > 0 ? `● ${c.pending}` : `✓ ${c.pass}`}
            </Text>
          )}
        </Box>
      )
    }
    const header = (
      <Box flexDirection="column" paddingX={1} {...panel}>
        {snaps.length > 1 && (
          <Box flexDirection="row" columnGap={1} flexWrap="wrap" marginBottom={1}>
            {snaps.map((s, i) => (
              <Button
                key={`repo:${s.root}`}
                hotkey={i < 9 && !isTyping ? String(i + 1) : undefined}
                variant={s.root === repo.root ? 'primary' : 'secondary'}
                onPress={() =>
                  pickRepo($, s.root).catch(err => $.ui.toast(`Repo diffs: could not switch to ${s.name}: ${String(err)}`))
                }
              >
                {`${s.name} ${shownFiles(s, active).length}`}
              </Button>
            ))}
          </Box>
        )}
        {/* one line: what is compared and how much changed; wraps rather than
            shrinks, so a narrow pane puts the totals on their own line */}
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1} minWidth={0} overflow="hidden">
            <Button key="hdr-fold" plain dimColor={canDim} onPress={() => toggleShut($, SEC_HEADER)}>
              {isHeaderShut ? '▸' : '▾'}
            </Button>
            <Text bold wrap="truncate-end">
              {repo.name}
            </Text>
            <Text color="inactive" wrap="truncate-middle">
              {repo.branch}
            </Text>
            {/* the picker lives in the header's detail: opening it unfolds the header */}
            <Button
              key="base-menu"
              plain
              dimColor={canDim}
              onPress={async () => {
                await update($, shut, list => (list ?? []).filter(k => k !== SEC_HEADER))
                await update($, editingBase, b => !b)
              }}
            >
              {`→ ${repo.baseLabel}${baseTag ? ` (${baseTag})` : ''} ▾`}
            </Button>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1} minWidth={0}>
            {isHeaderShut && pr && prCompact(pr)}
            <Text color="inactive">{plural(files.length, 'file')}</Text>
            {chips(totalAdded, totalRemoved)}
            {isShowingKeys ? (
              <Button key="keys" variant="secondary" hotkey={hk(KEY_LEGEND)} onPress={() => update($, showKeys, k => !k)}>
                keys
              </Button>
            ) : (
              <Button key="keys" plain dimColor={canDim} hotkey={hk(KEY_LEGEND)} onPress={() => update($, showKeys, k => !k)}>
                keys
              </Button>
            )}
            {/* one control: the live dot, the last refresh and the arrow that refreshes */}
            <Button key="refresh" plain dimColor={canDim} hotkey={isTyping ? undefined : 'r'} onPress={() => refresh($)}>
              <Text color={live.color}>●</Text>
              {` ${live.label === 'live' ? fmtTime(at) : live.label} ↻`}
            </Button>
          </Box>
        </Box>
        {repo.error && <Text color="error">{repo.error}</Text>}
        {repo.isStale && <Text color="warning">git busy, showing last good listing</Text>}
        {repo.baseNote && <Text color="warning">{`Base: ${repo.baseNote}`}</Text>}
        {isShowingKeys && (
          <Box flexDirection="column" paddingX={1} backgroundColor={HOVER}>
            {/* two columns once the pane is wide enough: half the rows (impeccable, 2026-10-14) */}
            {(() => {
              const legend = legendRows({ tabs: snaps.length > 1, hunks: true })
              const half = cols >= 70 ? Math.ceil(legend.length / 2) : legend.length
              const col = (list: typeof legend) => (
                <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                  {list.map(row => (
                    <Box key={`legend:${row.key}`} flexDirection="row" flexWrap="wrap" columnGap={2}>
                      <Box width={8} flexShrink={0}>
                        <Text bold>{row.key}</Text>
                      </Box>
                      <Text color="inactive">{row.label}</Text>
                    </Box>
                  ))}
                </Box>
              )
              return (
                <Box flexDirection="row" columnGap={2}>
                  {col(legend.slice(0, half))}
                  {half < legend.length && col(legend.slice(half))}
                </Box>
              )
            })()}
            {SCOPES.map(x => (
              <Box key={`legend-scope:${x.value}`} flexDirection="row" flexWrap="wrap" columnGap={2}>
                <Box width={12} flexShrink={0}>
                  <Text bold>{x.label}</Text>
                </Box>
                <Text color="inactive">{x.description}</Text>
              </Box>
            ))}
            <Text color="inactive">
              {`Keys work while the pane has focus, and pause while you type in a field. Listing from ${repo.source === 'both' ? 'the ledger claim and edits' : repo.source === 'ledger' ? 'the ledger claim' : 'edits'}.`}
            </Text>
          </Box>
        )}
        {repo.commit && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1} backgroundColor={HOVER}>
            <Box flexShrink={1} minWidth={0}>
              <Text color="warning">{`Viewing commit ${repo.commit.short}`}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text wrap="truncate-end">{repo.commit.subject}</Text>
            </Box>
            <Box flexShrink={0}>
              <Button key="commit-exit" plain dimColor={canDim} onPress={() => pickCommit($, repo.root, null)}>
                back to branch
              </Button>
            </Box>
          </Box>
        )}
        {!isHeaderShut && isEditingBase && (
          <Box flexDirection="column" paddingX={1} backgroundColor={HOVER}>
            <Box flexDirection="row" columnGap={1} flexWrap="wrap">
              <Text color="inactive">Compare against:</Text>
              <Button key="base:auto" plain dimColor={canDim && (Boolean(overrides[repo.root]))} onPress={() => setBase($, repo.root, null)}>
                {overrides[repo.root] ? 'auto' : '● auto'}
              </Button>
              {baseChoices.map(ref => (
                <Button
                  key={`base:${ref}`}
                  plain
                  dimColor={canDim && (overrides[repo.root] !== ref)}
                  onPress={() => setBase($, repo.root, ref)}
                >
                  {`${overrides[repo.root] === ref ? '● ' : ''}${ref}${ref === prBaseRef ? ' (PR)' : ''}`}
                </Button>
              ))}
            </Box>
            {Input && (
              <Input
                key="base-input"
                label="Other ref"
                placeholder="origin/release-1.2, a sha, HEAD~5"
                submitLabel="compare"
                onSubmit={(ref: string) => (ref.trim() ? setBase($, repo.root, ref.trim()) : undefined)}
              />
            )}
            <Box>
              <Button key="cancel-base" plain dimColor={canDim} onPress={() => update($, editingBase, () => false)}>
                cancel
              </Button>
            </Box>
          </Box>
        )}
        {!isHeaderShut && pr && prRow(pr)}
        {/* failing checks: one line with the count, the list behind its chevron */}
        {!isHeaderShut && pr?.kind === 'pr' && pr.failing.length > 0 && (
          <Box paddingLeft={2}>
            <Button key="checks-fold" plain onPress={() => toggleShut($, 'open:checks')}>
              {`${isChecksOpen ? '▾' : '▸'} ${plural(pr.failing.length, 'failing check')}`}
            </Button>
          </Box>
        )}
        {!isHeaderShut && isChecksOpen && pr?.kind === 'pr' && pr.failing.length > 0 && (
          <Box flexDirection="column" paddingLeft={4}>
            {pr.failing.slice(0, 5).map((c, i) => (
              <Box key={`fail:${i}`} flexDirection="row" gap={1}>
                <Text color="error">✗</Text>
                {c.link ? <Link key={`faillink:${i}`} href={c.link} label={c.name} /> : <Text>{c.name}</Text>}
              </Box>
            ))}
            {pr.failing.length > 5 && <Link key="failmore" href={`${pr.url}/checks`} label={`+${pr.failing.length - 5} more failing`} />}
          </Box>
        )}
        {(repo.op || conflicts.length > 0) && (
          <Text color="warning">
            {`⚠ ${repo.op ? `${repo.op} in progress` : 'unresolved conflicts'}${conflicts.length > 0 ? ` · ${plural(conflicts.length, 'conflict')} to resolve` : ''}`}
          </Text>
        )}
        {allComments.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1} paddingX={1} backgroundColor={HOVER} alignItems="center">
            {isConfirmingClear ? (
              <Text color="warning">{`Clear ${plural(allComments.length, 'comment')}? This can't be undone.`}</Text>
            ) : (
              <Text color="merged">{`✎ ${plural(allComments.length, 'comment')}`}</Text>
            )}
            <Box flexGrow={1} />
            {isConfirmingClear && (
              <Button key="clear-yes" variant="secondary" onPress={() => clearComments($)}>
                Clear all
              </Button>
            )}
            {isConfirmingClear && (
              <Button key="clear-no" plain dimColor={canDim} onPress={() => update($, confirmClear, () => false)}>
                keep
              </Button>
            )}
            {!isConfirmingClear && (
              <Button key="send" variant="primary" onPress={() => sendComments($)}>
                Send to prompt
              </Button>
            )}
            {/* drops every comment: asks first */}
            {!isConfirmingClear && (
              <Button key="clear" plain dimColor={canDim} onPress={() => update($, confirmClear, () => true)}>
                clear…
              </Button>
            )}
          </Box>
        )}
      </Box>
    )

    const treeRow = (n: (typeof rows)[number]) => {
      // capped at a third of the list's width: a deep tree that cannot be joined still leaves room for names
      const indent = Math.min(1 + n.depth * (isNarrow ? 1 : 2), Math.max(1, Math.floor(treeCols / 3)))
      if (n.kind === 'dir') {
        const dirKey = keyOf(repo.root, n.path)
        const isCollapsed = collapsed.has(n.path)
        // review progress per folder: how many of its files are viewed; a
        // finished folder recedes (impeccable, 2026-10-14)
        const under = fileOrder(n.children)
        const done = under.filter(isViewedFile).length
        const isDone = under.length > 0 && done === under.length
        return (
          <Box key={`dir:${dirKey}`} flexDirection="row" gap={1} paddingLeft={indent} paddingRight={1} hover={{ backgroundColor: HOVER }}>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Button key={`dirbtn:${dirKey}`} plain dimColor={canDim && isDone} onPress={() => toggleDir($, dirKey)}>
                {`${isCollapsed ? '▸' : '▾'} ${n.label}`}
              </Button>
            </Box>
            {(isCollapsed || isDone) && !isNarrow && (
              <Box flexShrink={0}>
                <Text color={isDone ? 'success' : 'inactive'}>{isDone ? '✓' : `${done}/${under.length}`}</Text>
              </Box>
            )}
          </Box>
        )
      }
      const fileKey = keyOf(repo.root, n.file.path)
      const isSel = fileKey === v.selected
      const g = glyphOf(n.file.status)
      const nComments = commentsIn(n.file.path).length
      // the desktop marks the selected row with the quiet band and a bold name,
      // keeping the status colours; the terminal keeps its selection colour,
      // where red, green and grey measured under 4.5:1 on it, so there the row
      // goes plain (Gemini, 2026-10-14)
      const isPlainSel = isSel && !canHover
      // the common case recedes: a modified file's M is quiet, A D R U ! keep their colour
      const glyphColor = isPlainSel ? undefined : n.file.status === 'M' ? 'inactive' : g.color
      return (
        <Box
          key={`row:${fileKey}`}
          flexDirection="row"
          gap={1}
          paddingLeft={indent}
          paddingRight={1}
          backgroundColor={isSel ? (canHover ? BAND : SELECTED) : undefined}
          hover={isSel ? undefined : { backgroundColor: HOVER }}
        >
          <Box flexShrink={0}>
            <Text color={glyphColor} bold={n.file.status !== 'M'}>
              {g.ch}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            {/* a viewed file recedes; the selected one is bold */}
            <Button key={`btn:${fileKey}`} plain dimColor={canDim && !isSel && isViewedFile(n.file)} onPress={() => jump($, fileKey)}>
              {isSel ? <Text bold>{n.label}</Text> : n.label}
            </Button>
          </Box>
          {isViewedFile(n.file) && (
            <Box flexShrink={0}>
              <Text color={isPlainSel ? undefined : 'success'}>✓</Text>
            </Box>
          )}
          {nComments > 0 && (
            <Box flexShrink={0}>
              <Text color={isPlainSel ? undefined : 'merged'}>{`✎${nComments}`}</Text>
            </Box>
          )}
          {/* the reference's row: name, an accent bar for the file's share of the change, the figure */}
          {/* only where the list is wide enough that the name keeps its room: 36 columns and up */}
          {isWide && treeCols >= 36 && !isPlainSel && !n.file.isBinary && n.file.status !== '?' && maxChange > 0 && (
            <Box flexShrink={0}>
              <Text>
                <Text color={ACCENT}>{'▬'.repeat(Math.max(1, Math.round((BAR_CELLS * (n.file.added + n.file.removed)) / maxChange)))}</Text>
                <Text color="subtle">{'▬'.repeat(BAR_CELLS - Math.max(1, Math.round((BAR_CELLS * (n.file.added + n.file.removed)) / maxChange)))}</Text>
              </Text>
            </Box>
          )}
          {!isNarrow && (
            <Box flexShrink={0}>
              {n.file.status === '?' ? (
                <Text color={isPlainSel ? undefined : 'success'}>new</Text>
              ) : (
                stat(n.file.added, n.file.removed, n.file.isBinary, isPlainSel)
              )}
            </Box>
          )}
        </Box>
      )
    }

    // ── file tree: status letter, name tinted as GitHub-style viewers tint added/removed
    // stacked, the column stretches the list to the pane: a width of 100% plus a
    // frame would overflow wherever the frame is drawn outside the width
    // the leading rows drawn (shown of them), plus the selected file's row
    // wherever it sits; isCut when the pane's room, not rowLimit, ended them
    type RowFit = { els: ReturnType<typeof treeRow>[]; shown: number; isCut: boolean }
    const isSelBeyond = (shown: number) => selRow >= shown
    const treeColWith = (fit: RowFit) => {
      const isSelPast = isSelBeyond(fit.shown)
      const restRows = rows.length - fit.shown - (isSelPast ? 1 : 0)
      return (
      <Box flexDirection="column" width={isWide && !isFilesShut ? treeCols : undefined} flexShrink={0} {...panel}>
        <Box flexDirection="column" paddingX={1} marginBottom={isFilesShut ? 0 : 1}>
          {/* the panel's title: what it lists, how many, and the viewed count once there is one */}
          <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={1}>
            <Box flexDirection="row" columnGap={1} flexShrink={1} minWidth={0}>
              <Button key="files-fold" plain dimColor={canDim} onPress={() => toggleShut($, SEC_FILES)}>
                {`${isFilesShut ? '▸' : '▾'} Files`}
              </Button>
              <Text color="inactive">{String(files.length)}</Text>
              {/* review progress, always: n of N (impeccable, 2026-10-14) */}
              {files.length > 0 && <Text color={viewedCount === files.length ? 'success' : 'inactive'}>{`· ${viewedCount}/${files.length} viewed`}</Text>}
              {hiddenCount > 0 && isFilesShut && <Text color="inactive">{`· ${hiddenCount} hidden`}</Text>}
            </Box>
            {Input && !isFilesShut && !isEditingHide && hidden.length === 0 && (
              <Button key="edit-hide" plain dimColor={canDim} onPress={() => update($, editingHide, () => true)}>
                hide…
              </Button>
            )}
          </Box>
          {isFilesShut ? null : Input && isEditingHide ? (
            <Box flexDirection="column">
              <Input
                key="exclude-input"
                label="Hide"
                autoFocus
                placeholder="*.pbxproj *.lock"
                value={formatPatterns(hidden)}
                submitLabel="hide"
                onSubmit={(text: string) => setExclude($, parsePatterns(text))}
              />
              <Button key="cancel-hide" plain dimColor={canDim} onPress={() => update($, editingHide, () => false)}>
                cancel
              </Button>
            </Box>
          ) : (
            hidden.length > 0 && (
              <Box flexDirection="row" columnGap={1} flexWrap="wrap">
                <Text color="inactive" wrap="truncate-end">
                  {`Hiding ${formatPatterns(hidden)}`}
                </Text>
                {Input && (
                  <Button key="edit-hide" plain dimColor={canDim} onPress={() => update($, editingHide, () => true)}>
                    edit
                  </Button>
                )}
              </Box>
            )
          )}
          {hiddenCount > 0 && !isFilesShut && (
            <Box flexDirection="row" gap={1}>
              <Text color="inactive">{isRevealing ? `Showing ${hiddenCount} hidden` : `${hiddenCount} hidden`}</Text>
              {/* reveals for now; the patterns stay saved */}
              <Button key="show-hidden" plain dimColor={canDim} onPress={() => toggleReveal($)}>
                {isRevealing ? 'hide again' : 'show'}
              </Button>
            </Box>
          )}
        </Box>
        {!isFilesShut && (
        <Box flexDirection="column">
        {repo.files.length === 0 && (
          <Box paddingX={1}>
            <Text dimColor={canDim}>No changes vs {repo.baseLabel}.</Text>
          </Box>
        )}
        {repo.files.length > 0 && files.length === 0 && (
          <Box paddingX={1}>
            <Text dimColor={canDim}>Every changed file is hidden by the patterns above.</Text>
          </Box>
        )}
        {(repo.commits?.length ?? 0) > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Box paddingX={1}>
              <Button key="commits-toggle" plain dimColor={canDim} onPress={() => update($, showCommits, c => !c)}>
                {`${isShowingCommits ? '▾' : '▸'} Commits (${repo.commits!.length})`}
              </Button>
            </Box>
            {isShowingCommits && repo.commit && (
              <Box paddingLeft={3}>
                <Button key="commit:all" plain dimColor={canDim} onPress={() => pickCommit($, repo.root, null)}>
                  all changes
                </Button>
              </Box>
            )}
            {isShowingCommits &&
              repo.commits!.map((c: Commit) => {
                const isOn = repo.commit?.sha === c.sha
                return (
                  <Box
                    key={`crow:${c.sha}`}
                    flexDirection="row"
                    gap={1}
                    paddingLeft={3}
                    paddingRight={1}
                    backgroundColor={isOn ? SELECTED : undefined}
                    hover={isOn ? undefined : { backgroundColor: HOVER }}
                  >
                    <Box flexShrink={0}>
                      <Text color={isOn ? undefined : 'warning'}>{c.short}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                      <Button key={`commit:${c.sha}`} plain onPress={() => pickCommit($, repo.root, isOn ? null : c.sha)}>
                        {c.subject}
                      </Button>
                    </Box>
                    {!isNarrow && (
                      <Box flexShrink={0}>
                        <Text color={isOn ? undefined : 'inactive'}>{relTime(c.at, now)}</Text>
                      </Box>
                    )}
                  </Box>
                )
              })}
          </Box>
        )}
        {conflicts.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Box paddingX={1}>
              <Button key="conflicts-fold" plain onPress={() => toggleShut($, SEC_CONFLICTS)}>
                {`${isConflictsShut ? '▸' : '▾'} Conflicts (${conflicts.length})`}
              </Button>
            </Box>
            {!isConflictsShut && conflicts.map(f => {
              const fileKey = keyOf(repo.root, f.path)
              return (
                <Box
                  key={`crow:${fileKey}`}
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={fileKey === v.selected ? SELECTED : undefined}
                  hover={fileKey === v.selected ? undefined : { backgroundColor: HOVER }}
                >
                  <Text color={fileKey === v.selected ? undefined : 'error'} bold>
                    !
                  </Text>
                  <Button key={`conflict:${fileKey}`} plain onPress={() => jump($, fileKey)}>
                    {f.path}
                  </Button>
                </Box>
              )
            })}
          </Box>
        )}
        {fit.els}
        {isSelPast && selRow > fit.shown && (
          <Box paddingX={1}>
            <Text color="inactive">{`⋯ ${plural(selRow - fit.shown, 'row')}`}</Text>
          </Box>
        )}
        {isSelPast && selRow >= 0 && treeRow(rows[selRow]!)}
        {restRows > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1} marginTop={1}>
            {fit.isCut ? (
              <Text color="inactive">{`${plural(restRows, 'more row')}: more than this pane draws at once. Fold folders or hide files to reach them.`}</Text>
            ) : (
              <Text color="inactive">{`${plural(restRows, 'more row')} in the tree`}</Text>
            )}
            {!fit.isCut && (
              <Button key="tree-more" plain dimColor={canDim} onPress={() => update($, treeLimit, l => l + TREE_PAGE)}>
                {`show ${Math.min(TREE_PAGE, restRows)} more`}
              </Button>
            )}
            {!fit.isCut && (
              <Button key="tree-all" plain dimColor={canDim} onPress={() => update($, treeLimit, () => Number.MAX_SAFE_INTEGER)}>
                show all
              </Button>
            )}
          </Box>
        )}
        </Box>
        )}
      </Box>
      )
    }

    // the comment's line, tag and remove on top; its words get the full width below
    // no fill of its own: a tag in the error colour on the hover fill measured 4.3:1; the card's fill is enough
    const commentRow = (c: ReviewComment) => (
      <Box key={`c:${c.id}`} flexDirection="column" paddingLeft={2} paddingRight={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Box flexShrink={0}>
            <Text color="merged">✎</Text>
          </Box>
          {c.tag && (
            <Box flexShrink={0}>
              <Text color={TAG_COLOR[c.tag] ?? 'inactive'} bold>
                {`[${c.tag}]`}
              </Text>
            </Box>
          )}
          <Box flexShrink={0}>
            <Text color="inactive">{`${c.side === 'old' ? 'old ' : ''}L${c.line}`}</Text>
          </Box>
          <Box flexGrow={1} />
          <Box flexShrink={0}>
            <Button key={`rm:${c.id}`} plain dimColor={canDim} onPress={() => removeComment($, c.id)}>
              ✕ remove
            </Button>
          </Box>
        </Box>
        <Box paddingLeft={2}>
          <Text>{c.body}</Text>
        </Box>
      </Box>
    )

    const composer = (c: Composing) => (
      <Box key="composer" flexDirection="column" paddingX={1}>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          <Text color="inactive">Tag:</Text>
          {TAGS.map(t => (
            <Button key={`tag:${t}`} plain dimColor={canDim && (c.tag !== t)} onPress={() => setTag($, t)}>
              {c.tag === t ? `[${t}]` : t}
            </Button>
          ))}
        </Box>
        {Input ? (
          <Input
            key={`comment-input:${c.path}:${c.side}:${c.line}`}
            // the field's accessible name: a placeholder goes once typing starts
            label={`Comment on ${c.side === 'old' ? 'old ' : ''}line ${c.line}`}
            autoFocus
            placeholder="What should change here?"
            submitLabel="add"
            onSubmit={(body: string) => addComment($, body)}
          />
        ) : (
          <Text dimColor={canDim}>Comments can be written on desktop or in the terminal.</Text>
        )}
        <Box>
          <Button key="cancel-comment" plain dimColor={canDim} onPress={() => update($, composing, () => null)}>
            cancel
          </Button>
        </Box>
      </Box>
    )

    // ── GitHub's file containers: every changed file in its own frame, folded or
    // open, the selected one ringed in the accent; the diff options sit in one
    // bar above them. The first fileCap files are drawn, plus the selected one.
    const winStart = windowStart(selIndex, fileCap)
    const drawn = order.slice(winStart, winStart + fileCap)
    const restFiles = Math.max(0, order.length - winStart - drawn.length)
    // Code draws 100k characters per drawing: the selected file's hunks first,
    // clipped to fit, then each other open file whole while the rest fits
    let budget = DIFF_CAP
    type Plan = { shown: ReturnType<typeof splitHunks>; hidden: number; clippedLines: number; isOver: boolean }
    const planOf = (text: string, canClip: boolean): Plan => {
      const hunks = splitHunks(text)
      if (!canClip) {
        const total = hunks.reduce((n, h) => n + h.text.length, 0)
        if (total > budget) return { shown: [], hidden: hunks.length, clippedLines: 0, isOver: true }
        budget -= total
        return { shown: hunks, hidden: 0, clippedLines: 0, isOver: false }
      }
      const shown: ReturnType<typeof splitHunks> = []
      let clippedLines = 0
      for (const hunk of hunks) {
        if (hunk.text.length <= budget) {
          shown.push(hunk)
          budget -= hunk.text.length
          continue
        }
        const clipped = clipHunk(hunk.text, budget)
        if (clipped) {
          shown.push({ text: clipped.text, gapBefore: hunk.gapBefore })
          clippedLines = clipped.droppedLines
          budget -= clipped.text.length
        }
        break
      }
      return { shown, hidden: hunks.length - shown.length, clippedLines, isOver: false }
    }
    const selState = d && d.key === v.selected ? d : undefined
    const isSelOpen = Boolean(selFile && v.selected && isOpenFile(v, v.selected, selFile, marks, openList))
    const selPlan = isSelOpen && selState?.status === 'ready' ? planOf(selState.text, true) : null
    const selHunks = selPlan?.shown.length ?? 0
    const allKeys = order.map(f => keyOf(repo.root, f.path))
    const isAllFolded = allKeys.length > 0 && allKeys.every(k => (v.folded ?? []).includes(k))
    const viewedKeys = order.filter(isViewedFile).map(f => keyOf(repo.root, f.path))
    // GitHub's view of a hunk: its range on a band, then each run numbered from
    // its own file in the engine's source gutter, tinted with the theme's diff
    // colours; the +/− marker stays on every line
    const hunkRange = (text: string) => hunkRuns(text).header.replace(/^(@@ [^@]* @@).*$/, '$1')
    // GitHub's view of a hunk: each run on a row tinted by what it is, its
    // numbers (new file; old for removed lines) in a stronger gutter. Text, not
    // Code: a Code paints its own background, so the tint cannot reach it (g
    // gives the syntax colours instead). One row a run; one a line while lines
    // wrap, so a wrapped line cannot push its neighbours' numbers out of line.
    const tinted = (text: string, i: number, path: string, off: number) => {
      const { runs } = hunkRuns(text)
      const last = Math.max(1, ...runs.map(r => Math.max(r.oldStart, r.newStart) + r.lines.length))
      const width = String(last).length
      const wrap = v.wrap ? 'wrap' : 'truncate-end'
      // each line: its padded marker, then its code in GitHub's token colours
      const codeOf = (lines: string[]) =>
        lines.flatMap((l, k) => {
          const head = k > 0 ? '\n' : ''
          if (l.startsWith('\\')) return [`${head}${l}`]
          return [
            `${head} ${l.slice(0, 1)} `,
            ...panTokens(highlightLine(l.slice(1), path), off).map(t => (t.kind ? <Text color={pal[t.kind]}>{t.text}</Text> : t.text)),
          ]
        })
      // weight is the one hierarchy this surface has: changed rows stay bold
      // (the desktop's code face reads thin on the tints, measured v12), the
      // unchanged context recedes to regular weight; numbers never bold
      const isCtx = (kind: HunkRun['kind']) => kind === 'ctx'
      // never inactive + dim on one text: stacked they fell under 4.5:1 in the
      // harness (impeccable detect, 2026-10-14); one or the other
      // two gutters, old then new, as GitHub draws them: a removed line has
      // only an old number, an added one only a new, context both. One
      // column could not say which file a number counts (impeccable, 2026-10-14)
      const gutter = (kind: HunkRun['kind'], nums: string[], key: string) => (
        <Box key={key} flexShrink={0} paddingLeft={1} backgroundColor={kind === 'add' ? pal.addNum : kind === 'del' ? pal.delNum : undefined}>
          <Text color={isCtx(kind) ? pal.muted : pal.fg}>
            {nums.join('\n')}
          </Text>
        </Box>
      )
      // a cell of air at the row's right edge: code never touches the card's frame (impeccable detect, 2026-10-14)
      const rowOf = (kind: HunkRun['kind'], olds: string[], news: string[], lines: string[], key: string) => (
        <Box key={key} flexDirection="row" minWidth={0} paddingRight={1} backgroundColor={kind === 'add' ? pal.addLine : kind === 'del' ? pal.delLine : undefined}>
          {gutter(kind, olds, `${key}:o`)}
          {gutter(kind, news, `${key}:n`)}
          <Box width={1} flexShrink={0} backgroundColor={kind === 'add' ? pal.addNum : kind === 'del' ? pal.delNum : undefined} />
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {/* context: regular weight, never dim: dim over the token colours fell to 4.2:1 (impeccable detect) */}
            <Text key={`diff:${key}`} color={pal.fg} bold={!isCtx(kind)} wrap={wrap}>
              {codeOf(lines)}
            </Text>
          </Box>
        </Box>
      )
      return (
        <Box flexDirection="column">
          {runs.flatMap((r, j) => {
            // a "\ No newline" line takes no number; the side a run does not touch is blank
            let oldNo = r.oldStart
            let newNo = r.newStart
            const olds = r.lines.map(l => (l.startsWith('\\') || r.kind === 'add' ? '' : String(oldNo++)).padStart(width))
            const news = r.lines.map(l => (l.startsWith('\\') || r.kind === 'del' ? '' : String(newNo++)).padStart(width))
            const key = `trun:${i}:${j}`
            return v.wrap
              ? r.lines.map((l, k) => rowOf(r.kind, [olds[k]!], [news[k]!], [l], `${key}:${k}`))
              : [rowOf(r.kind, olds, news, r.lines, key)]
          })}
        </Box>
      )
    }
    // GitHub's marker sits apart from the code: a cell either side of it
    const padMarker = (line: string) => (line.startsWith('\\') ? line : ` ${line.slice(0, 1)} ${line.slice(1)}`)
    const numbered = (text: string, i: number, path: string, off: number) => {
      const { runs } = hunkRuns(text)
      return (
        <Box flexDirection="column">
          {runs.map((r, j) => (
            // GitHub's tint is on the gutter, the code on the surface's own
            // background: a Code paints its own, so a tinted Box behind it only
            // showed as a slab past the code's end. The bar is the tint here.
            <Box key={`run:${i}:${j}`} flexDirection="row" minWidth={0}>
              <Box width={1} flexShrink={0} backgroundColor={r.kind === 'add' ? 'diffAdded' : r.kind === 'del' ? 'diffRemoved' : undefined} />
              {/* a column, so the code takes the card's width and cuts or wraps there */}
              <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                <Code source={r.lines.map(l => padMarker(panLine(l, off))).join('\n')} startLine={r.start} path={path} wrap={v.wrap ? 'wrap' : 'truncate-end'} />
              </Box>
            </Box>
          ))}
        </Box>
      )
    }

    // the bar above the files: where you are and how to move (file, change),
    // collapse all, and an options toggle; the options themselves (context,
    // wrap, colours, sideways pan) sit on their own row only while asked for,
    // since their keys live on their buttons
    // what the listing compares, left; where you are and how to move, right. Drawn
    // even with no file: a scope or the whitespace toggle can empty the tree, and
    // the way back must stay on screen
    const scopePills = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {SCOPES.map(x =>
          x.value === scope ? (
            <Button key={`scope:${x.value}`} variant="secondary" onPress={() => pickScope($, x.value)}>
              {x.label}
            </Button>
          ) : (
            <Button key={`scope:${x.value}`} plain dimColor={canDim} onPress={() => pickScope($, x.value)}>
              {x.label}
            </Button>
          ),
        )}
        <Box width={1} />
        {opts.ignoreWhitespace ? (
          <Button key="ws" variant="secondary" hotkey={hk(KEY_IGNORE_WHITESPACE)} onPress={() => toggleWhitespace($)}>
            no whitespace
          </Button>
        ) : (
          <Button key="ws" plain dimColor={canDim} hotkey={hk(KEY_IGNORE_WHITESPACE)} onPress={() => toggleWhitespace($)}>
            ignore whitespace
          </Button>
        )}
        {scope === 'turn' && isTurnFull && (
          <Text color="warning">{`This turn edited more than ${LAST_TURN_CAP} files; the list keeps the first ${LAST_TURN_CAP}.`}</Text>
        )}
      </Box>
    )
    const toolbar = (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} justifyContent="space-between">
          {scopePills}
          {order.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="prev" plain dimColor={canDim} hotkey={hk('k')} onPress={() => step($, -1)}>
              ‹
            </Button>
            <Box flexShrink={0}>
              <Text color="inactive">{`${selIndex + 1}/${order.length}`}</Text>
            </Box>
            <Button key="next" plain dimColor={canDim} hotkey={hk('j')} onPress={() => step($, 1)}>
              ›
            </Button>
            {selHunks > 1 && (
              <Button key="hunk-prev" plain dimColor={canDim} hotkey={hk('p')} onPress={() => stepHunk($, -1, selHunks, v.selected!)}>
                ↑
              </Button>
            )}
            {selHunks > 1 && (
              <Button key="hunk-next" plain dimColor={canDim} hotkey={hk('n')} onPress={() => stepHunk($, 1, selHunks, v.selected!)}>
                ↓
              </Button>
            )}
            <Box width={1} />
            <Button key="fold-all" plain dimColor={canDim} onPress={() => foldAll($, isAllFolded ? viewedKeys : allKeys, !isAllFolded)}>
              {isAllFolded ? '▾ expand all' : '▸ collapse all'}
            </Button>
            {isShowingOptions ? (
              <Button key="options" variant="secondary" onPress={() => update($, showOptions, o => !o)}>
                options
              </Button>
            ) : (
              <Button key="options" plain dimColor={canDim} onPress={() => update($, showOptions, o => !o)}>
                options
              </Button>
            )}
          </Box>
          )}
        </Box>
        {order.length > 0 && isShowingOptions && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
            {/* context: stepper; wrap and syntax colours: pills, filled while on */}
            <Button key="ctx-less" plain dimColor={canDim} hotkey={hk(KEY_LESS_CONTEXT)} onPress={() => stepContextBy($, -1)}>
              −
            </Button>
            <Box flexShrink={0}>
              <Text color="inactive">{optionsLabel(opts)}</Text>
            </Box>
            <Button key="ctx-more" plain dimColor={canDim} hotkey={hk(KEY_MORE_CONTEXT)} onPress={() => stepContextBy($, 1)}>
              +
            </Button>
            <Box width={1} />
            {v.wrap ? (
              <Button key="wrap" variant="secondary" hotkey={hk('w')} onPress={() => toggleWrap($)}>
                wrap lines
              </Button>
            ) : (
              <Button key="wrap" plain dimColor={canDim} hotkey={hk('w')} onPress={() => toggleWrap($)}>
                wrap lines
              </Button>
            )}
            {v.syntax ? (
              <Button key="numbers" variant="secondary" hotkey={hk(KEY_NUMBERS)} onPress={() => toggleSyntax($)}>
                syntax colours
              </Button>
            ) : (
              <Button key="numbers" plain dimColor={canDim} hotkey={hk(KEY_NUMBERS)} onPress={() => toggleSyntax($)}>
                syntax colours
              </Button>
            )}
            {selHunks > 0 && !v.wrap && (
              <Button key="pan-left" plain dimColor={canDim} hotkey={hk(KEY_PAN_LEFT)} onPress={() => panCurrent($, v.selected!, selPlan!.shown.map(h => h.text), -PAN_STEP)}>
                ‹ scroll
              </Button>
            )}
            {selHunks > 0 && !v.wrap && (
              <Button key="pan-right" plain dimColor={canDim} hotkey={hk(KEY_PAN_RIGHT)} onPress={() => panCurrent($, v.selected!, selPlan!.shown.map(h => h.text), PAN_STEP)}>
                scroll ›
              </Button>
            )}
          </Box>
        )}
      </Box>
    )

    const container = (f: FileChange) => {
      const fileKey = keyOf(repo.root, f.path)
      const path = f.path
      const isSel = fileKey === v.selected
      // the selected container keeps the plain keys (and the hotkeys); the others' carry their file
      const kk = (k: string) => (isSel ? k : `${k}@${fileKey}`)
      const g = glyphOf(f.status)
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      const isFull = v.full.includes(fileKey)
      const isOpen = isOpenFile(v, fileKey, f, marks, openList)
      const isFileViewed = isViewedFile(f)
      const isUserFolded = (v.folded ?? []).includes(fileKey)
      const isLarge = !isSel && !isFileViewed && !isUserFolded && !isOpen
      const st = isSel ? selState : cached[fileKey]
      const isLoaded = st?.status === 'ready'
      const plan = !isOpen || !st || st.status !== 'ready' ? null : isSel ? selPlan : planOf(st.text, false)
      const shown = plan?.shown ?? []
      const fileComments = commentsIn(path)
      const unplaced = fileComments.filter(c => !isHere(c) || !shown.some(h => hunkHolds(h.text, c.line, c.side)))
      // the composer sits under the hunk that holds its line; when expanding
      // context or a refresh moved that line out of view, it sits at the end
      const isComposingHere = isSel && comp !== null && comp.root === repo.root && comp.path === path
      const composerHunk = isComposingHere ? shown.findIndex(h => isHere(comp) && hunkHolds(h.text, comp.line, comp.side)) : -1
      const isBinaryText = Boolean(isLoaded && plan && !plan.isOver && shown.length === 0 && /^Binary files /m.test(st.text))
      const notes = isLoaded && isOpen ? patchNotes(st.text) : []
      // narrow, every frame goes; wide, the selected file's is the accent
      const frame = isNarrow ? { backgroundColor: CARD } : { borderStyle: 'round', borderColor: isSel ? FOCUS : BORDER, backgroundColor: CARD }
      return (
        <Box key={`file:${fileKey}`} flexDirection="column" flexShrink={0} minWidth={0} {...frame}>
          {/* the header wraps under the path rather than squeezing it to a sliver */}
          <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2} paddingX={1}>
            {/* the counts wrap under the path on a narrow pane rather than past its edge */}
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Box flexShrink={0}>
                <Button key={kk('fold')} plain dimColor={canDim} onPress={() => toggleFold($, fileKey, isOpen)}>
                  {isOpen ? '▾' : '▸'}
                </Button>
              </Box>
              {/* too long for one line: the file name moves under its folder
                  rather than either being cut mid-word */}
              <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1} minWidth={0}>
                <Box flexShrink={0}>
                  <Text color={g.color} bold>
                    {g.ch}
                  </Text>
                </Box>
                {/* the file first, its folder after it in the quiet colour (Codex, 2026-10-14):
                    the name is what is reviewed, the path supports it */}
                <Box flexShrink={1} minWidth={0}>
                  {isSel ? (
                    <Text bold>{basename(path)}</Text>
                  ) : (
                    <Button key={kk('pick')} plain onPress={() => select($, fileKey)}>
                      {basename(path)}
                    </Button>
                  )}
                </Box>
                {(f.oldPath || dir) && (
                  <Box flexShrink={1} minWidth={0} overflow="hidden">
                    <Text color="inactive" wrap="truncate-start">
                      {`${f.oldPath ? `${f.oldPath} → ` : ''}${dir ? `${dir}/` : ''}`}
                    </Text>
                  </Box>
                )}
              </Box>
              <Box flexShrink={0}>
                {f.status === '?' ? (
                  <Text color="success">new file</Text>
                ) : f.status === '!' ? (
                  <Text color="error">conflict</Text>
                ) : (
                  stat(f.added, f.removed, f.isBinary)
                )}
              </Box>
              {fileComments.length > 0 && (
                <Box flexShrink={0}>
                  <Text color="merged">{`✎ ${fileComments.length}`}</Text>
                </Box>
              )}
            </Box>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1} minWidth={0}>
              <Button
                key={kk('viewed')}
                plain
                dimColor={canDim && !isFileViewed}
                hotkey={isSel ? hk(KEY_VIEWED) : undefined}
                onPress={() => toggleViewed($, fileKey)}
              >
                {isFileViewed ? '✓ viewed' : 'viewed'}
              </Button>
              {/* under the pointer only: the card's frame is its hover scope */}
              <Box>
                <Button key={kk('copy-file')} plain dimColor={canDim} onPress={press => copyText($, `${repo.root}/${path}`, press.surface)}>
                  copy path
                </Button>
              </Box>
            </Box>
          </Box>
          {!isOpen && isFileViewed && !isUserFolded && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1}>
              <Text color="success">✓ Viewed</Text>
              <Button key={kk('open-viewed')} plain dimColor={canDim} onPress={() => toggleFold($, fileKey, false)}>
                show diff
              </Button>
            </Box>
          )}
          {isLarge && (
            // GitHub's "Large diffs are not rendered by default"
            <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1}>
              <Text color="inactive">{`Large diff: ${plural(f.added + f.removed, 'line')} changed.`}</Text>
              <Button key={kk('load-large')} plain dimColor={canDim} onPress={() => toggleFold($, fileKey, false)}>
                load diff
              </Button>
            </Box>
          )}
          {isOpen && (
            <Box flexDirection="column">
              {f.status === '!' && (
                <Box paddingX={1}>
                  <Text color="error">
                    {`Unresolved conflict${repo.op ? ` (${repo.op} in progress)` : ''}: resolve the <<<<<<< markers, then git add the file.`}
                  </Text>
                </Box>
              )}
              {!isLoaded && (
                <Box paddingX={1} paddingY={1}>
                  {st?.status === 'error' ? (
                    <Box flexDirection="column" gap={1}>
                      <Text color="error">{`Could not load this diff: ${st.error ?? 'unknown error'}`}</Text>
                      <Box>
                        <Button key={kk('retry-diff')} variant="secondary" onPress={() => (isSel ? loadDiff($, true) : loadRest($, true))}>
                          Retry
                        </Button>
                      </Box>
                    </Box>
                  ) : (
                    skeleton('Loading diff…')
                  )}
                </Box>
              )}
              {plan?.isOver && (
                <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1} paddingY={1}>
                  <Text dimColor={canDim}>Too large to draw beside the selected file.</Text>
                  <Button key={kk('show-over')} plain dimColor={canDim} onPress={() => jump($, fileKey)}>
                    show it
                  </Button>
                </Box>
              )}
              {isLoaded && (f.isBinary || isBinaryText) && (
                <Box paddingX={1} paddingY={1}>
                  <Text dimColor={canDim}>Binary file: no text diff.</Text>
                </Box>
              )}
              {notes.length > 0 && (
                <Box flexDirection="column" paddingX={1} paddingTop={1}>
                  {notes.map(n => (
                    <Box key={`note:${n}`}>
                      <Text color="inactive">{`· ${n}`}</Text>
                    </Box>
                  ))}
                </Box>
              )}
              {isLoaded && plan && !plan.isOver && !f.isBinary && !isBinaryText && shown.length === 0 && notes.length === 0 && (
                <Box paddingX={1} paddingY={1}>
                  <Text dimColor={canDim}>No text changes.</Text>
                </Box>
              )}
              {shown.map((hunk, i) => {
                const at0 = firstChange(hunk.text)
                const ctx = hunkContext(hunk.text)
                const here = fileComments.filter(c => isHere(c) && hunkHolds(hunk.text, c.line, c.side))
                const isComposing = composerHunk === i
                // sideways pan: cut mode only; wrapping already shows every column
                const panKey = `${fileKey}#${i}`
                const maxOff = v.wrap ? 0 : panMax(hunk.text)
                const off = Math.min(pans[panKey] ?? 0, maxOff)
                // folded on its chevron: the band stays, the lines go
                const isHunkShut = shutList.includes(`hunk:${panKey}`)
                return (
                  <Box key={kk(`hunk:${i}`)} flexDirection="column">
                    {hunk.gapBefore > 0 && (
                      <Box flexDirection="row" paddingX={1} hover={{ backgroundColor: HOVER }} key={`gap:${i}`}>
                        <Button key={kk(`gapbtn:${i}`)} plain dimColor={canDim} onPress={() => toggleFull($, fileKey)}>
                          {`⋯  ${plural(hunk.gapBefore, 'unmodified line')}`}
                        </Button>
                      </Box>
                    )}
                    {
                      // GitHub's one band per hunk: its chevron, range and function beside copy and comment
                      // each hunk's band defines it, except right under the card's own band, so bands never stack into a slab
                      <Box key={`meta:${i}`} flexDirection="row" flexWrap="wrap" justifyContent="space-between" gap={1} paddingX={1} hover={{ backgroundColor: HOVER }}>
                        <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
                          <Box flexShrink={0}>
                            <Button key={kk(`hunkfold:${i}`)} plain dimColor={canDim} onPress={() => toggleShut($, `hunk:${panKey}`)}>
                              {isHunkShut ? '▸' : '▾'}
                            </Button>
                          </Box>
                          <Box flexShrink={0}>
                            <Text color="inactive">{hunkRange(hunk.text)}</Text>
                          </Box>
                          {ctx && (
                            <Text color="inactive" wrap="truncate-end">
                              {`in ${ctx}`}
                            </Text>
                          )}
                        </Box>
                        {!isHunkShut && (at0 || maxOff > 0) && (
                          // under the pointer on the desktop (the band is keyed, so it is the hover scope);
                          // wraps on a pane too narrow for the row (17-21 columns at 18 px): no control is cut
                          <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1} minWidth={0}>
                            {maxOff > 0 && (
                              <Button key={kk(`panl:${i}`)} plain dimColor={canDim || off === 0} onPress={() => panBy($, panKey, -PAN_STEP, maxOff)}>
                                ‹
                              </Button>
                            )}
                            {maxOff > 0 && (
                              <Box flexShrink={0}>
                                <Text color="inactive">{off > 0 ? `col ${off + 1}` : 'scroll'}</Text>
                              </Box>
                            )}
                            {maxOff > 0 && (
                              <Button key={kk(`panr:${i}`)} plain dimColor={canDim || off >= maxOff} onPress={() => panBy($, panKey, PAN_STEP, maxOff)}>
                                ›
                              </Button>
                            )}
                            {at0 && (
                              <Button
                                key={kk(`copy:${i}`)}
                                plain
                                dimColor={canDim}
                                onPress={press =>
                                  copyText($, f.status[0] === 'D' ? `${repo.root}/${path}` : `${repo.root}/${path}:${at0.newLine}`, press.surface)
                                }
                              >
                                copy line
                              </Button>
                            )}
                            {/* the phone draws no text field: a comment starts where one can be typed;
                                another file's comment selects that file first, where the field is drawn */}
                            {at0 && !isComposing && Input && (
                              <Button
                                key={kk(`cmt:${i}`)}
                                plain
                                dimColor={canDim}
                                onPress={async () => {
                                  if (!isSel) await select($, fileKey)
                                  await startComment($, { root: repo.root, path, line: at0.line, side: at0.side })
                                }}
                              >
                                + comment
                              </Button>
                            )}
                          </Box>
                        )}
                      </Box>
                    }
                    {!isHunkShut && (v.syntax ? numbered(hunk.text, i, path, off) : tinted(hunk.text, i, path, off))}
                    {!isHunkShut && here.map(commentRow)}
                    {isComposing && comp && composer(comp)}
                  </Box>
                )
              })}
              {isComposingHere && composerHunk === -1 && comp && composer(comp)}
              {unplaced.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  <Box paddingX={1}>
                    <Text color="inactive">Comments on lines not shown here (or written in another view)</Text>
                  </Box>
                  {unplaced.map(commentRow)}
                </Box>
              )}
              {plan && (plan.hidden > 0 || plan.clippedLines > 0) && !plan.isOver && (
                <Box paddingX={1} paddingY={1}>
                  <Text dimColor={canDim}>
                    {`Diff too large for the pane: ${[plan.clippedLines > 0 && plural(plan.clippedLines, 'line'), plan.hidden > 0 && plural(plan.hidden, 'hunk')].filter(Boolean).join(' and ')} not shown.`}
                  </Text>
                </Box>
              )}
              {isLoaded && !f.isBinary && f.status !== '?' && shown.length > 0 && (
                <Box paddingX={1} marginTop={1}>
                  <Button key={kk('fullctx')} plain dimColor={canDim} onPress={() => toggleFull($, fileKey)}>
                    {isFull ? 'show changes only' : 'show full file'}
                  </Button>
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    }

    // ── fit the drawing to the surface's room: the header, the toolbar, the
    // list's frame and the selected file's container always; then the tree's
    // rows, up to half of what is left; then the other containers in order
    const room = e.surface === 'terminal' ? ROOM_TERMINAL : ROOM_REMOTE
    const spent: Weight = { nodes: 0, chars: 0, text: 0 }
    const spend = (w: Weight) => {
      spent.nodes += w.nodes
      spent.chars += w.chars
      spent.text += w.text
    }
    const fits = (w: Weight, limit: Weight) =>
      spent.nodes + w.nodes <= limit.nodes && spent.chars + w.chars <= limit.chars && spent.text + w.text <= limit.text
    spend(weightOf(header))
    spend(weightOf(toolbar))
    spend(weightOf(treeColWith({ els: [], shown: 0, isCut: false })))
    const selCard = drawn.find(f => keyOf(repo.root, f.path) === v.selected)
    const selEl = selCard ? container(selCard) : null
    if (selEl) spend(weightOf(selEl))
    const half = (k: keyof Weight) => spent[k] + (room[k] - spent[k]) / 2
    const rowRoom = { nodes: half('nodes'), chars: half('chars'), text: half('text') }
    const rowEnd = Math.min(rowLimit, rows.length)
    const rowEls: ReturnType<typeof treeRow>[] = []
    for (const n of rows.slice(0, rowEnd)) {
      const el = treeRow(n)
      const w = weightOf(el)
      if (!fits(w, rowRoom)) break
      rowEls.push(el)
      spend(w)
    }
    // in file order; the selected one is weighed first, so the room never cuts it
    const cardEls: ReturnType<typeof container>[] = []
    // the containers the room left out; once one is, the rest after it are too
    let cardsCut = 0
    for (const f of drawn) {
      if (f === selCard && selEl) {
        cardEls.push(selEl)
        continue
      }
      if (cardsCut > 0) {
        cardsCut++
        continue
      }
      const el = container(f)
      const w = weightOf(el)
      if (!fits(w, room)) {
        cardsCut++
        continue
      }
      cardEls.push(el)
      spend(w)
    }
    const restCards = restFiles + cardsCut

    // the done moment: every file viewed (impeccable, 2026-10-14)
    const isAllViewed = files.length > 0 && viewedCount === files.length
    const stack = (
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={1}>
        {toolbar}
        {isAllViewed && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1}>
            <Text color="success">{`✓ All ${plural(files.length, 'file')} viewed.`}</Text>
            <Text color="inactive">
              {allComments.length > 0 ? `${plural(allComments.length, 'comment')} waiting: send them to the prompt above.` : 'Nothing left to review in this scope.'}
            </Text>
          </Box>
        )}
        {winStart > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1}>
            <Text color="inactive">{`${plural(winStart, 'earlier file')} above`}</Text>
            <Button key="files-first" plain dimColor={canDim} onPress={() => jump($, keyOf(repo.root, order[0]!.path))}>
              back to the first
            </Button>
          </Box>
        )}
        {cardEls}
        {restCards > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingX={1}>
            {cardsCut > 0 ? (
              <Text color="inactive">{`${plural(restCards, 'more file')}: more than this pane draws at once. Pick one in the list to open it.`}</Text>
            ) : (
              <Text color="inactive">{`${plural(restCards, 'more file')}`}</Text>
            )}
            {cardsCut === 0 && (
              <Button key="files-more" plain dimColor={canDim} onPress={() => showMoreFiles($, fileCap + FILE_PAGE)}>
                {`show ${Math.min(FILE_PAGE, restCards)} more`}
              </Button>
            )}
            {cardsCut === 0 && (
              <Button key="files-all" plain dimColor={canDim} onPress={() => showMoreFiles($, Number.MAX_SAFE_INTEGER)}>
                show all
              </Button>
            )}
          </Box>
        )}
      </Box>
    )

    const treeCol = treeColWith({ els: rowEls, shown: rowEls.length, isCut: rowEls.length < rowEnd })
    // a folded file list is one line: it sits above the files and gives the
    // diff the whole width, wide or not
    if (isFilesShut) {
      pinnedList = null
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {treeCol}
          {stack}
        </Box>
      )
    }
    const { offset, bodyRows } = e.props.scroll ?? { offset: 0, bodyRows: 40 }
    // the list's rows: a title, the commits line, the tree, a closing line, the frame
    const listRows = rowEls.length + (isSelBeyond(rowEls.length) ? 2 : 0) + 8
    if (!isWide) {
      // stacked (a narrow pane): one row stays in view at the pane's scroll
      // offset, with the count, the review progress and file stepping; its
      // chevron opens the list in a window under half the body tall, which the
      // wheel scrolls on its own. A whole pinned list covered most of a short
      // pane, so the row is the default and the list is asked
      // for. The header scrolls with the page; the bar carries what it needs.
      const isPinOpen = shutList.includes('open:pin')
      const frameRows = isNarrow ? 0 : 2
      const pinRows = rowEls.length + (isSelBeyond(rowEls.length) ? 2 : 0) + 2 + ((repo.commits?.length ?? 0) > 0 ? 1 : 0) + frameRows
      const winRows = isPinOpen ? Math.max(8, Math.min(1 + pinRows, Math.floor(bodyRows * 0.45))) : 1
      const maxPin = isPinOpen ? Math.max(0, 1 + pinRows - winRows) : 0
      pinnedList = { cols: cols, rows: winRows, maxScroll: maxPin }
      const pinTop = Math.min(await read($, treeScroll), maxPin)
      const bar = (
        <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" columnGap={1} paddingX={1} backgroundColor={CARD}>
          <Box flexDirection="row" columnGap={1} flexShrink={1} minWidth={0} overflow="hidden">
            {/* open, the list's own title carries the count and progress right under this row */}
            <Button key="pin-toggle" plain onPress={() => toggleShut($, 'open:pin')}>
              {isPinOpen ? '▾ Files' : `▸ Files ${files.length}`}
            </Button>
            {!isPinOpen && files.length > 0 && <Text color={viewedCount === files.length ? 'success' : 'inactive'}>{`· ${viewedCount}/${files.length} viewed`}</Text>}
          </Box>
          {order.length > 0 && (
            <Box flexDirection="row" columnGap={1} flexShrink={0}>
              <Button key="pin-prev" plain dimColor={canDim} onPress={() => step($, -1)}>
                ‹
              </Button>
              <Text color="inactive">{`${selIndex + 1}/${order.length}`}</Text>
              <Button key="pin-next" plain dimColor={canDim} onPress={() => step($, 1)}>
                ›
              </Button>
            </Box>
          )}
        </Box>
      )
      return (
        <Box flexDirection="column" gap={1} position="relative">
          {/* the room the pinned row takes, first: the row is drawn at the scroll
              offset, so at offset 0 it must land here and not over the header's
              first line ("Files 0" once sat on the repo row) */}
          <Box minHeight={winRows}>
            <Text> </Text>
          </Box>
          {header}
          {stack}
          <Box position="absolute" top={offset} left={0} width={cols} height={winRows} overflow="hidden" backgroundColor={CARD}>
            <Box position="absolute" top={-pinTop} left={0} width={cols} flexDirection="column">
              {bar}
              {isPinOpen && treeCol}
            </Box>
          </Box>
        </Box>
      )
    }
    // GitHub's layout: the pane's own scroll moves the header and the file
    // containers; the file list stays in view beside them, redrawn at the
    // pane's scroll offset, and the wheel over it scrolls it alone (ui.scroll)
    const maxScroll = Math.max(0, listRows - bodyRows)
    pinnedList = { cols: treeCols, rows: Number.POSITIVE_INFINITY, maxScroll }
    const listTop = Math.min(await read($, treeScroll), maxScroll)
    return (
      <Box flexDirection="row" gap={2}>
        <Box width={treeCols} flexShrink={0} minHeight={Math.min(listRows, bodyRows)} position="relative">
          <Box position="absolute" top={offset} left={0} width={treeCols} height={bodyRows} overflow="hidden">
            <Box position="absolute" top={-listTop} left={0} width={treeCols} flexDirection="column">
              {treeCol}
            </Box>
          </Box>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={1}>
          {header}
          {stack}
        </Box>
      </Box>
    )
  })

  // the wheel over the pinned file list scrolls the list, not the pane
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const list = pinnedList
    // over the pinned window: left of its columns (wide) and within its rows (stacked)
    if (!list || !e.pointer || e.origin.kind !== 'person' || e.pointer.column >= list.cols || e.pointer.row >= list.rows || e.pointer.row < 0) return next(e)
    await update($, treeScroll, t => Math.max(0, Math.min(list.maxScroll, (t ?? 0) + e.by)))
    return {}
  }).catch(($, e, next) => next(e))
}
