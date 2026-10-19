// A small line highlighter for the tinted diff rows: a Code paints its own
// background, so rows that carry GitHub's tint are Text, and their colours come
// from here. Line by line, no state across lines: a block comment or string
// that spans lines is coloured only on the line it opens. Kinds are the scopes
// delta's syntect themes and GitHub's prettylights both colour apart: keyword
// (pl-k), function and decorator names (pl-en), types (pl-v), the module path
// after import / package / from / using (pl-ent), constants and numbers
// (pl-c1), strings (pl-s), comments (pl-c).

export type TokenKind = 'keyword' | 'entity' | 'type' | 'namespace' | 'constant' | 'string' | 'comment'
export type Token = { text: string; kind?: TokenKind }

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue data def default defer del delete do else elif enum ' +
    'export extends extension final finally fn for from fun func function get go guard if impl implements import in init ' +
    'inout interface internal is lambda let match mod module mut namespace new nil not object of open operator or ' +
    'override package pass private protected public raise readonly return sealed self set static struct super switch ' +
    'throw throws trait try type typealias typeof unsafe use using val var when where while with yield require'
  ).split(' '),
)
const CONSTANTS = new Set('true false null undefined None True False nil this'.split(' '))
// built-in type names that are not capitalised
const TYPES = new Set(
  'string number boolean bigint symbol any unknown never object void int long short byte char float double bool uint u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 usize isize str dict list tuple set'.split(' '),
)
// the words a module path follows
const IMPORTISH = new Set('import package from using namespace module use require'.split(' '))

// '#' starts a comment in these; elsewhere '//' does
const HASH_COMMENT = /\.(py|sh|bash|zsh|rb|ya?ml|toml|conf|ini|r|pl|mk)$|(^|\/)(Makefile|Dockerfile|Gemfile|Podfile|\.[a-z]*rc)$/i
const NO_SYNTAX = /\.(md|mdx|txt|rst|csv|lock|log|svg)$/i

const tokenRe = (comment: string) =>
  new RegExp(
    `(${comment})|("(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|\`(?:\\\\.|[^\`\\\\])*\`?)` +
      `|(\\b0x[0-9a-fA-F_]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[a-zA-Z]?\\b)` +
      `|(@[A-Za-z_][\\w.]*)|([A-Za-z_$][\\w$]*)(?=\\s*\\()|([A-Za-z_$][\\w$]*)`,
    'g',
  )
const SLASH = tokenRe('\\/\\/.*|\\/\\*.*?(?:\\*\\/|$)')
const HASH = tokenRe('#.*')

// one line of code (no diff marker) as runs of plain and coloured text
export function highlightLine(line: string, path: string): Token[] {
  if (NO_SYNTAX.test(path)) return [{ text: line }]
  const isHash = HASH_COMMENT.test(path)
  const out: Token[] = []
  let at = 0
  const push = (text: string, kind?: TokenKind) => {
    if (!text) return
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push(kind ? { text, kind } : { text })
  }
  // inside a module path: from an import-ish keyword to the first gap that is
  // not a dot (a brace, a comma, "as")
  let isPath = false
  for (const m of line.matchAll(isHash ? HASH : SLASH)) {
    const [whole, comment, str, num, deco, call, word] = m
    const i = m.index ?? 0
    const gap = line.slice(at, i)
    if (isPath && !/^\s*$|^\.$/.test(gap)) isPath = false
    push(gap, isPath && gap === '.' ? 'namespace' : undefined)
    const name = call ?? word
    if (comment) push(whole, 'comment')
    else if (str) push(whole, 'string')
    else if (num) push(whole, 'constant')
    else if (deco) push(whole, 'entity')
    else if (name && KEYWORDS.has(name)) {
      push(whole, 'keyword')
      isPath = IMPORTISH.has(name)
    } else if (name && isPath) {
      // a path's last segment, capitalised, is the type it brings in
      const isLast = line[i + whole.length] !== '.'
      push(whole, isLast && /^[A-Z]/.test(name) ? 'type' : 'namespace')
    }
    else if (call) push(whole, /^[A-Z]/.test(call) ? 'type' : 'entity')
    else if (word) push(whole, CONSTANTS.has(word) ? 'constant' : TYPES.has(word) || /^[A-Z][a-z0-9]\w*$/.test(word) ? 'type' : undefined)
    at = i + whole.length
  }
  push(line.slice(at))
  return out
}

// a highlighted line with its first `off` code points dropped, kinds kept
export function panTokens(tokens: Token[], off: number): Token[] {
  if (off <= 0) return tokens
  const out: Token[] = []
  let skip = off
  for (const t of tokens) {
    const cps = Array.from(t.text)
    if (skip >= cps.length) {
      skip -= cps.length
      continue
    }
    out.push({ ...t, text: cps.slice(skip).join('') })
    skip = 0
  }
  return out
}
