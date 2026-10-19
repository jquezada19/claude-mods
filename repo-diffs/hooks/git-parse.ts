// Parsers for git's -z output with rename detection on: a rename carries its
// old and new paths as two NUL-terminated fields instead of one.

export type NumstatRow = { path: string; oldPath?: string; added: number; removed: number; isBinary: boolean }

// `git diff --numstat -z -M`: "added\tremoved\tpath\0", or for a rename
// "added\tremoved\t\0old\0new\0". Paths may hold tabs, so only the first two
// tabs split a row.
export function parseNumstat(raw: string): NumstatRow[] {
  const out: NumstatRow[] = []
  let i = 0
  while (i < raw.length) {
    const t1 = raw.indexOf('\t', i)
    const t2 = t1 < 0 ? -1 : raw.indexOf('\t', t1 + 1)
    if (t2 < 0) break
    const a = raw.slice(i, t1)
    const r = raw.slice(t1 + 1, t2)
    i = t2 + 1
    let path: string
    let oldPath: string | undefined
    if (raw[i] === '\u0000') {
      const o = raw.indexOf('\u0000', i + 1)
      const n = o < 0 ? -1 : raw.indexOf('\u0000', o + 1)
      if (n < 0) break
      oldPath = raw.slice(i + 1, o)
      path = raw.slice(o + 1, n)
      i = n + 1
    } else {
      const e = raw.indexOf('\u0000', i)
      if (e < 0) break
      path = raw.slice(i, e)
      i = e + 1
    }
    const isBinary = a === '-' && r === '-'
    out.push({ path, ...(oldPath !== undefined ? { oldPath } : {}), added: Number(a) || 0, removed: Number(r) || 0, isBinary })
  }
  return out
}

// `git diff --name-status -z -M`: "S\0path\0", or "R100\0old\0new\0" for a
// rename (C for a copy). Keyed by the new path.
export function parseNameStatus(raw: string): Map<string, string> {
  const recs = raw.split('\u0000').filter(r => r.length > 0)
  const out = new Map<string, string>()
  for (let i = 0; i < recs.length; ) {
    const st = recs[i]!
    if (st[0] === 'R' || st[0] === 'C') {
      const to = recs[i + 2]
      if (to !== undefined) out.set(to, st)
      i += 3
    } else {
      const path = recs[i + 1]
      if (path !== undefined) out.set(path, st)
      i += 2
    }
  }
  return out
}

// `git ls-files -u -z`: "mode sha stage\tpath\0", one row per stage of each
// unmerged path; the distinct paths.
export function parseUnmerged(raw: string): string[] {
  const out = new Set<string>()
  for (const rec of raw.split('\u0000')) {
    const tab = rec.indexOf('\t')
    if (tab >= 0) out.add(rec.slice(tab + 1))
  }
  return [...out]
}
