// status: git's letter (M A D R…), '?' untracked, '!' unmerged (a conflict);
// oldPath: where a renamed file came from
// blob: the content id on the diff's new side, read for marked and selected files;
// side: the commit(s) the diff starts from, HEAD resolved
export type FileChange = {
  path: string
  oldPath?: string
  status: string
  added: number
  removed: number
  isBinary?: boolean
  blob?: string
  side?: string
}
export type RepoSnap = {
  root: string
  name: string
  branch: string
  base: string
  baseLabel: string
  source: 'ledger' | 'touched' | 'both'
  files: FileChange[]
  error?: string
  // the last good listing, kept because this refresh's git calls failed
  isStale?: boolean
  // the `git diff` range for the scope the listing was taken in
  range: string[]
  // where change detection looks: this worktree's git dir, the shared one
  // (refs, packed-refs) and the branch ref; absent when they could not be read
  watch?: { gitDir: string; commonDir: string; ref: string; baseRef: string }
  // an operation stopped part-way in this checkout
  op?: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'am'
  // HEAD's commit, so a PR answer is re-read when the branch moves
  head?: string
  // where the base came from: picked by the person, the PR's base branch, the
  // develop/main/master default, the session's claim, or HEAD
  baseSource?: 'picked' | 'pr' | 'default' | 'claim' | 'head'
  // the base ref in use (origin/qa), apart from a commit view's label
  baseUsed?: string
  // a wanted base (picked or the PR's) that could not be used, and why
  baseNote?: string
  // the branch's commits since its base, newest first; the one shown alone
  commits?: Commit[]
  commit?: Commit
}
// one branch commit, as hooks/commits.ts parses it from git log (kept inline:
// the contract must not import)
export type Commit = { sha: string; short: string; parents: string[]; author: string; at: number; subject: string }
// the branch's pull request, from `gh pr view`
export type PrChecks = { pass: number; fail: number; pending: number; skipping: number; cancel: number }
export type PrInfo =
  | {
      kind: 'pr'
      number: number
      state: string
      isDraft: boolean
      reviewDecision: string
      mergeable: string
      url: string
      // the branch the PR merges into: the pane's default base
      baseRefName: string
      checks: PrChecks
      failing: Array<{ name: string; link: string }>
    }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
// key: branch@head the answer was read for; at: when
export type PrEntry = { key: string; at: number; info: PrInfo }
// all: merge-base→working tree (+ untracked); committed: merge-base→HEAD (the
// PR); touched: HEAD→working tree (+ untracked), the uncommitted work
export type Scope = 'all' | 'committed' | 'touched' | 'turn'
export type CommentTag = 'must-fix' | 'suggestion' | 'nit' | 'question' | ''
export type ReviewComment = {
  id: string
  root: string
  path: string
  line: number
  side: 'old' | 'new'
  tag: CommentTag
  body: string
  // the view it was written in: line numbers mean different code per scope
  scope?: Scope
  // the branch commit being viewed alone when it was written, if any
  commit?: string
}
// the comment being written: which file and line, and the tag picked so far
export type Composing = { root: string; path: string; line: number; side: 'old' | 'new'; tag: CommentTag; scope: Scope; commit?: string }
// what the pane shows: the active repo, the selected file (root\0path), the
// files expanded to full context and the collapsed folders (root\0dir)
// context/ignoreWhitespace: lazygit's diff options; commit: one branch commit
// shown alone (root + sha)
export type View = {
  repo: string | null
  selected: string | null
  full: string[]
  collapsed: string[]
  scope: Scope
  wrap?: boolean
  context?: number
  ignoreWhitespace?: boolean
  // syntax-coloured Code runs instead of GitHub's tinted rows (g)
  syntax?: boolean
  // file containers the person folded with their chevron (root\0path)
  folded?: string[]
  commit?: { root: string; sha: string }
}
export type DiffState = { key: string; isFull: boolean; range?: string; stamp?: string; text: string; status: 'loading' | 'ready' | 'error'; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'repo-diffs': {
      touched: string[]
      turnEdits: TurnEdits
      /** 0.3.0's last-turn list and overflow flag, read once on a reload and emptied. */
      lastTurn: string[]
      lastTurnFull: boolean
      snapshot: RepoSnap[]
      refreshedAt: number
      autoOpened: boolean
      view: View
      diff: DiffState | null
      busy: boolean
      comments: ReviewComment[]
      composing: Composing | null
      prs: Record<string, PrEntry>
      exclude: string[]
      editingHide: boolean
      baseOverride: Record<string, string>
      editingBase: boolean
      showKeys: boolean
      showCommits: boolean
      // Clear asks before it drops every comment
      confirmClear: boolean
      // hidden files shown for now; the saved patterns are kept
      revealHidden: boolean
      // tree rows drawn before "show more"
      treeLimit: number
      // the pinned file list's own scroll, in rows (the wheel over the list)
      treeScroll: number
      // GitHub's Viewed: file key -> the listing stamp it was viewed at
      viewed: Record<string, string>
      // files opened past an automatic fold: viewed, or too large to draw unasked
      openViewed: string[]
      // other files' diffs drawn in their own containers below the selected one
      diffs: Record<string, DiffState>
      // each cut hunk's sideways pan in columns, by `fileKey#hunk index`
      pan: Record<string, number>
      // file containers drawn before "show more files"
      fileLimit: number
      // the diff options row (context, wrap, colours, pan) is shown
      showOptions: boolean
      // blocks folded by their chevron: `sec:header`, `sec:files`,
      // `sec:conflicts`, and hunks as `hunk:<root\0path>#<index>`
      shut: string[]
      // repos whose tree was seeded with its top folders collapsed (a large
      // change set starts folded; done once per repo)
      seeded: string[]
    }
  }
}

/** The latest main turn's edited files: its generation, the paths as git keys, and whether it edited more than the list holds. */
export type TurnEdits = { gen: number; paths: string[]; isFull: boolean }
