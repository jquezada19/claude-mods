// The branch's pull request, read from `gh pr view --json`, and the exclude
// globs `gh pr diff --exclude` takes. The check grouping and re-run
// de-duplication follow gh's own (pkg/cmd/pr/checks/aggregate.go).

import type { PrChecks, PrInfo } from '../types'

export const PR_FIELDS = 'number,state,isDraft,reviewDecision,mergeable,url,baseRefName,statusCheckRollup'

type Rollup = {
  __typename?: string
  name?: string
  context?: string
  workflowName?: string
  status?: string
  conclusion?: string
  state?: string
  startedAt?: string
  detailsUrl?: string
  targetUrl?: string
}

export type Bucket = keyof PrChecks

export function bucketOf(state: string): Bucket {
  switch (state) {
    case 'SUCCESS':
      return 'pass'
    case 'SKIPPED':
    case 'NEUTRAL':
      return 'skipping'
    case 'ERROR':
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
      return 'fail'
    case 'CANCELLED':
      return 'cancel'
    default:
      // EXPECTED, REQUESTED, WAITING, QUEUED, PENDING, IN_PROGRESS, STALE
      return 'pending'
  }
}

// A check run's state is its conclusion once completed, else its status; a
// commit status carries `state` itself.
const stateOf = (c: Rollup) => c.state || (c.status === 'COMPLETED' ? (c.conclusion ?? '') : (c.status ?? ''))

// Newest run per status context, or per check name + workflow: a re-run
// replaces the run it repeats instead of counting twice.
function newestOnly(items: readonly Rollup[]): Rollup[] {
  const sorted = [...items].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
  const seen = new Set<string>()
  return sorted.filter(c => {
    const key = c.context ? `ctx:${c.context}` : `run:${c.name ?? ''}/${c.workflowName ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function parsePrView(stdout: string): PrInfo {
  const j = JSON.parse(stdout) as {
    number: number
    state: string
    isDraft: boolean
    reviewDecision?: string
    mergeable?: string
    url: string
    baseRefName?: string
    statusCheckRollup?: Rollup[] | null
  }
  const checks: PrChecks = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 }
  const failing: Array<{ name: string; link: string }> = []
  for (const c of newestOnly(j.statusCheckRollup ?? [])) {
    const bucket = bucketOf(stateOf(c))
    checks[bucket]++
    if (bucket === 'fail') failing.push({ name: c.name || c.context || 'check', link: c.detailsUrl || c.targetUrl || '' })
  }
  return {
    kind: 'pr',
    number: j.number,
    state: j.state,
    isDraft: Boolean(j.isDraft),
    reviewDecision: j.reviewDecision ?? '',
    mergeable: j.mergeable ?? '',
    url: j.url,
    baseRefName: j.baseRefName ?? '',
    checks,
    failing,
  }
}

// What a failed `gh pr view` means: no PR for this branch is an answer, the
// rest (no auth, no network, not a GitHub remote) is "unavailable".
export function prFailure(stderr: string): PrInfo {
  if (/no (open )?pull requests? found/i.test(stderr)) return { kind: 'none' }
  return { kind: 'error', message: stderr.trim().split('\n')[0] || 'gh failed' }
}

// Go's path.Match, which gh's --exclude uses: `*` any run of non-slash
// characters, `?` exactly one (a whole character, not a UTF-16 half),
// `[...]` a class negated only by `^` (`!` is an ordinary member), `\` escapes
// the next character. A malformed pattern matches nothing, as gh ignores it.
export function globMatch(pattern: string, name: string): boolean {
  let re = '^'
  const lit = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else if (ch === '\\') {
      const next = pattern[++i]
      if (next === undefined) return false
      re += lit(next)
    } else if (ch === '[') {
      let j = i + 1
      let body = ''
      if (pattern[j] === '^') {
        body = '^'
        j++
      }
      let closed = false
      for (; j < pattern.length; j++) {
        const c = pattern[j]!
        if (c === ']' && body.replace(/^\^/, '').length > 0) {
          closed = true
          break
        }
        if (c === '\\') {
          const next = pattern[++j]
          if (next === undefined) return false
          body += lit(next)
        } else if (c === '-' && body.length > 0 && pattern[j + 1] !== ']') body += '-'
        else body += lit(c)
      }
      if (!closed) return false
      re += `[${body}]`
      i = j
    } else re += lit(ch)
  }
  try {
    return new RegExp(`${re}$`, 'u').test(name)
  } catch {
    return false
  }
}

// gh's rule: a pattern hides a file when it matches the whole path or, so
// `*.yml` reaches `dir/file.yml`, the file's own name.
export function isExcluded(path: string, patterns: readonly string[]): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return patterns.some(p => globMatch(p, path) || globMatch(p, base))
}

// Space-separated patterns; one holding a space is written in double quotes.
export function parsePatterns(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const p = m[1] ?? m[2] ?? ''
    if (p.length > 0) out.push(p)
  }
  return out
}

// The inverse, for the field's text: a pattern with a space goes in quotes.
export const formatPatterns = (patterns: readonly string[]) => patterns.map(p => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
