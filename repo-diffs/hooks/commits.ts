// The branch's own commits since its base, as lazygit's commits panel lists
// them, and the range that shows one commit's diff on its own.

export type Commit = { sha: string; short: string; parents: string[]; author: string; at: number; subject: string }

const FS = '\u001f'
const RS = '\u001e'

// Newest first, one record per commit: fields split by US (0x1f), records
// ended by RS (0x1e). Neither byte can occur in a name or subject, so tabs,
// quotes and unicode come through untouched. The caller appends the range.
export const LOG_ARGS: readonly string[] = [
  'log',
  '--no-color',
  '--no-decorate',
  '--format=%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s%x1e',
  '--max-count=200',
]

// `--format=` is tformat, so git adds a newline after each RS; trimming the
// record drops it (a subject never starts or ends with whitespace, git strips
// that). A record without exactly six fields is skipped, not fatal.
export function parseLog(stdout: string): Commit[] {
  const out: Commit[] = []
  for (const raw of stdout.split(RS)) {
    const rec = raw.trim()
    if (rec.length === 0) continue
    const f = rec.split(FS)
    if (f.length !== 6) continue
    const [sha, short, parents, author, at, subject] = f as [string, string, string, string, string, string]
    const secs = Number(at)
    if (!sha || !Number.isFinite(secs)) continue
    out.push({ sha, short, parents: parents.split(' ').filter(p => p.length > 0), author, at: secs * 1000, subject })
  }
  return out
}

// Git's empty tree: the "parent" of a root commit, so its diff is every file.
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// What the commit itself introduced: against its first parent (a merge shows
// what it brought onto the branch), or against nothing for a root commit.
export const commitRange = (c: Commit): string[] => [c.parents[0] ?? EMPTY_TREE, c.sha]

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// Compact age for a list row. Weeks start at 14 days so "1w" never hides
// 7-13 days; months are 30 days. A future time (clock skew) is "just now".
export function relTime(ms: number, now: number): string {
  const d = now - ms
  if (d < MIN) return 'just now'
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`
  if (d < 14 * DAY) return `${Math.floor(d / DAY)}d ago`
  if (d < 60 * DAY) return `${Math.floor(d / (7 * DAY))}w ago`
  if (d < 365 * DAY) return `${Math.floor(d / (30 * DAY))}mo ago`
  return `${Math.floor(d / (365 * DAY))}y ago`
}
