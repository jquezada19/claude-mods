// How the selected file's patch is drawn: context lines around each change
// (lazygit's diffContextSize) and whether whitespace-only edits count
// (lazygit's ignoreWhitespaceInDiffView, git's -w), plus the key legend.

export type DiffOptions = { context: number; ignoreWhitespace: boolean }

// git's own default context is 3 lines.
export const DEFAULT_OPTIONS: DiffOptions = { context: 3, ignoreWhitespace: false }

// Past this the "Show full file" toggle is the better tool.
export const MAX_CONTEXT = 30

// Engine hotkeys are one digit or one lowercase letter, so lazygit's `{` `}`
// and `?` become letters clear of 1-9, r, j, k, n, p and w: More / Less
// context, Ignore whitespace, Help.
export const KEY_MORE_CONTEXT = 'm'
export const KEY_LESS_CONTEXT = 'l'
export const KEY_IGNORE_WHITESPACE = 'i'
export const KEY_LEGEND = 'h'
export const KEY_VIEWED = 'v'
export const KEY_NUMBERS = 'g'
// sideways pan of the current hunk (h/l were taken by the legend and less context)
export const KEY_PAN_LEFT = 'a'
export const KEY_PAN_RIGHT = 'd'

// One step of m/l, held to [0, MAX_CONTEXT]; a value that is not a whole
// number (a corrupt store entry) restarts from git's default.
export function stepContext(n: number, by: 1 | -1): number {
  const from = Number.isInteger(n) ? n : DEFAULT_OPTIONS.context
  return Math.min(MAX_CONTEXT, Math.max(0, from + by))
}

// The git diff arguments for these options. The context flag is always
// written, -U3 included, so a user's diff.context config cannot change the
// hunk shape comment anchoring relies on. -U implies -p: pass these to the
// patch call only, never to --numstat or --name-status.
export function diffFlags(o: DiffOptions, isFull: boolean): string[] {
  const flags = [isFull ? '-U100000' : `-U${o.context}`]
  if (o.ignoreWhitespace) flags.push('-w')
  return flags
}

// Every hotkey the pane binds, for the legend; `when` names the part of the
// pane that has to be showing for the key to do anything.
export const KEYS: ReadonlyArray<{ key: string; label: string; when?: 'tabs' | 'hunks' }> = [
  { key: '1-9', label: 'switch repo', when: 'tabs' },
  { key: 'r', label: 'refresh' },
  { key: 'j / k', label: 'next / previous file' },
  { key: 'n / p', label: 'next / previous change', when: 'hunks' },
  { key: 'w', label: 'wrap long lines' },
  { key: `${KEY_PAN_LEFT} / ${KEY_PAN_RIGHT}`, label: 'scroll the current change left / right (cut lines)', when: 'hunks' },
  { key: `${KEY_MORE_CONTEXT} / ${KEY_LESS_CONTEXT}`, label: 'more / less context' },
  { key: KEY_IGNORE_WHITESPACE, label: 'ignore whitespace' },
  { key: KEY_VIEWED, label: 'mark viewed, go to the next unviewed file' },
  { key: KEY_NUMBERS, label: 'tinted rows / syntax colours' },
  { key: KEY_LEGEND, label: 'show / hide keys' },
]

// The legend rows that apply right now: rows without `when` always do.
export function legendRows(have: { tabs: boolean; hunks: boolean }): Array<{ key: string; label: string }> {
  return KEYS.filter(k => k.when === undefined || have[k.when]).map(({ key, label }) => ({ key, label }))
}

// Compact status for the card header: `±3 lines`, `±5 lines · no whitespace`.
export function optionsLabel(o: DiffOptions): string {
  const ctx = `±${o.context} ${o.context === 1 ? 'line' : 'lines'}`
  return o.ignoreWhitespace ? `${ctx} · no whitespace` : ctx
}
