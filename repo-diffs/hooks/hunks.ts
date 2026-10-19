// Splits a unified diff into hunks and counts the unchanged lines git left out
// before each one, so the pane can draw "N unmodified lines" between them.

export type Hunk = { text: string; gapBefore: number }

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

// Code draws tab and newline as its only control characters: drop CR (CRLF
// files) and mark any other control character visibly.
export function cleanPatch(text: string): string {
  return text.replace(/\r(?=\n|$)/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '�')
}

export function splitHunks(diff: string): Hunk[] {
  const out: Hunk[] = []
  let cur: string[] | null = null
  let prevEnd = 1 // first old-side line after the previous hunk
  let gap = 0
  const flush = () => {
    if (cur) out.push({ text: cur.join('\n') + '\n', gapBefore: gap })
  }
  for (const line of diff.split('\n')) {
    const m = HEADER.exec(line)
    if (m) {
      flush()
      const start = Number(m[1])
      const len = m[2] === undefined ? 1 : Number(m[2])
      // an empty old range "-s,0" sits AFTER old line s (s is 0 for a new file)
      const first = len === 0 ? start + 1 : start
      gap = Math.max(0, first - prevEnd)
      prevEnd = first + len
      cur = [line]
    } else if (cur && line !== '') {
      cur.push(line)
    }
  }
  flush()
  return out
}

// A hunk cut to at most `budget` characters that still parses: whole lines
// only, the header's counts rewritten to what is kept. Null when not even the
// header and one line fit.
export function clipHunk(text: string, budget: number): { text: string; droppedLines: number } | null {
  const rows = text.split('\n').filter(l => l !== '')
  const m = HEADER.exec(rows[0] ?? '')
  if (!m) return null
  const kept: string[] = []
  let size = rows[0]!.length + 1
  let oldN = 0
  let newN = 0
  for (const row of rows.slice(1)) {
    if (size + row.length + 1 > budget) break
    kept.push(row)
    size += row.length + 1
    if (row[0] === ' ' || row[0] === '-') oldN++
    if (row[0] === ' ' || row[0] === '+') newN++
  }
  if (kept.length === 0) return null
  const dropped = rows.length - 1 - kept.length
  const header = `@@ -${m[1]},${oldN} +${m[3]},${newN} @@${m[5] ?? ''}`
  return { text: [header, ...kept].join('\n') + '\n', droppedLines: dropped }
}

// The line a comment on this hunk points at: its first added line on the new
// side (an edit is about the code that replaced the old), else its first
// deleted line on the old side; null when the hunk shows no change at all
// (a clipped full-context hunk can hold context only).
export function firstChange(text: string): { line: number; side: 'old' | 'new'; newLine: number } | null {
  const rows = text.split('\n')
  const m = HEADER.exec(rows[0] ?? '')
  let oldLine = m ? Number(m[1]) : 1
  let newLine = m ? Number(m[3]) : 1
  let firstDeleted: { old: number; at: number } | null = null
  for (const row of rows.slice(1)) {
    if (row[0] === '+') return { line: newLine, side: 'new', newLine }
    if (row[0] === '-') {
      firstDeleted ??= { old: oldLine, at: newLine }
      oldLine++
    } else if (row[0] === ' ') {
      oldLine++
      newLine++
    }
  }
  // newLine: where the deletion sits in the current file, for a location
  return firstDeleted === null ? null : { line: firstDeleted.old, side: 'old', newLine: firstDeleted.at }
}

// Whether a line on one side falls inside this hunk's range on that side.
export function hunkHolds(text: string, line: number, side: 'old' | 'new'): boolean {
  const m = HEADER.exec(text.split('\n')[0] ?? '')
  if (!m) return false
  const start = Number(side === 'old' ? m[1] : m[3])
  const len = Number((side === 'old' ? m[2] : m[4]) ?? 1)
  // a zero-length range (a pure addition's old side) holds no lines
  return line >= start && line < start + len
}

export type ExportComment = { repo: string; path: string; line: number; side: 'old' | 'new'; tag: string; body: string }

// One markdown block a coding agent can act on, in the shape GitHub-style diff
// viewers hand their agents: tag, bold file:line, which side, then the note.
export function exportComments(comments: readonly ExportComment[]): string {
  const repos = new Set(comments.map(c => c.repo))
  const lines = comments.map(c => {
    const tag = c.tag ? `[${c.tag}] ` : ''
    const where = `${repos.size > 1 ? `${c.repo}: ` : ''}${c.path}${c.line > 0 ? `:${c.line}` : ''}`
    const side = c.line > 0 ? ` (${c.side} side)` : ''
    return `- ${tag}**${where}**${side}: ${c.body}`
  })
  const scope = repos.size === 1 ? ` in ${[...repos][0]}` : ''
  return `## Code review comments${scope}\n\nPlease address the following:\n\n${lines.join('\n')}\n`
}

// The function or section git names after the second @@ (its funcname
// context), trimmed; '' when git found none.
export function hunkContext(text: string): string {
  const m = HEADER.exec(text.split('\n')[0] ?? '')
  return (m?.[5] ?? '').trim()
}

// n/p over `count` hunks: the next index from `from` (-1 before the first),
// wrapping at either end.
export function nextHunkIndex(from: number, by: 1 | -1, count: number): number {
  if (count <= 0) return -1
  const start = from < 0 || from >= count ? (by === 1 ? -1 : count) : from
  return (start + by + count) % count
}

// The one file section of a patch whose new path is `path` (git can return
// more than the pair asked for: `-- old new` also matches files under old/).
// The whole patch when no section names it, so nothing is lost.
export function pickSection(patch: string, path: string): string {
  const sections = patch.split(/^(?=diff --git )/m).filter(x => x.length > 0)
  if (sections.length <= 1) return patch
  const hit = sections.find(x => x.includes(`\n+++ b/${path}\n`) || x.includes(`\nrename to ${path}\n`))
  return hit ?? patch
}

// What a patch says that its hunks don't: GitHub's "File renamed without
// changes", a mode change, a symlink swapped for a file. Read from the git
// headers, which the card otherwise drops; one line each, plain words.
export function patchNotes(patch: string): string[] {
  const notes: string[] = []
  const oldMode = /^old mode (\d+)$/m.exec(patch)?.[1]
  const newMode = /^new mode (\d+)$/m.exec(patch)?.[1]
  if (oldMode && newMode) {
    const exec = (m: string) => m.endsWith('755')
    const what = exec(newMode) && !exec(oldMode) ? 'now executable' : exec(oldMode) && !exec(newMode) ? 'no longer executable' : 'mode changed'
    notes.push(`${what} (${oldMode} → ${newMode})`)
  }
  if (/^similarity index 100%$/m.test(patch)) notes.push('renamed without changes')
  const gone = /^deleted file mode (\d+)$/m.exec(patch)?.[1]
  const born = /^new file mode (\d+)$/m.exec(patch)?.[1]
  const kind = (m: string) => (m === '120000' ? 'symlink' : m === '160000' ? 'submodule' : 'file')
  if (gone && born && kind(gone) !== kind(born)) notes.push(`${kind(gone)} replaced by a ${kind(born)}`)
  return notes
}

// 1001 -> "1,001", as GitHub prints counts (no Intl assumed in the mod's runtime)
export function grouped(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// One hunk as GitHub draws it: its "@@" line, then runs of unchanged, added and
// removed lines, each numbered from the file it belongs to (new for unchanged
// and added, old for removed). The marker stays on every line, so the kind is
// never told by colour alone. "\ No newline at end of file" joins the run above.
export type HunkRun = { kind: 'add' | 'del' | 'ctx'; start: number; oldStart: number; newStart: number; lines: string[] }
export function hunkRuns(hunk: string): { header: string; runs: HunkRun[] } {
  const lines = hunk.replace(/\n$/, '').split('\n')
  const header = lines[0] ?? ''
  const m = HEADER.exec(header)
  let oldNo = m ? Number(m[1]) : 1
  let newNo = m ? Number(m[3]) : 1
  const runs: HunkRun[] = []
  for (const line of lines.slice(1)) {
    if (line.startsWith('\\')) {
      runs[runs.length - 1]?.lines.push(line)
      continue
    }
    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'
    const no = kind === 'del' ? oldNo : newNo
    const last = runs[runs.length - 1]
    if (last && last.kind === kind) last.lines.push(line)
    else runs.push({ kind, start: no, oldStart: oldNo, newStart: newNo, lines: [line] })
    if (kind !== 'add') oldNo++
    if (kind !== 'del') newNo++
  }
  return { header, runs }
}

// Horizontal pan for a cut hunk: the surfaces have no sideways scroll, so a
// block is panned by dropping its lines' first `off` columns (code points, a
// tab as one). The +/- marker stays; a "\ No newline" line is left whole.
export const PAN_STEP = 20
export function panLine(line: string, off: number): string {
  if (off <= 0 || line.startsWith('\\')) return line
  return line.slice(0, 1) + Array.from(line.slice(1)).slice(off).join('')
}
// how far a hunk can pan: the last whole step that still leaves part of its
// widest line in view (64 columns stop at 60, showing the final 4)
export function panMax(text: string): number {
  let widest = 0
  for (const l of text.split('\n').slice(1)) if (!l.startsWith('\\')) widest = Math.max(widest, Array.from(l).length - 1)
  return Math.max(0, Math.ceil((widest - PAN_STEP) / PAN_STEP) * PAN_STEP)
}
