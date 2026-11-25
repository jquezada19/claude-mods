import type { AgentRun, CodexLimits, Session, Usage } from '../types'
import { backendOf, capRatio, costumeOf, ctxPercent, elapsed, fmtTime, fmtTokens, fmtUsd, modelName, reportsTokens, statusWord, totals } from './agents'
import type { Backend, Totals } from './agents'
import { dayStart, hasLiveWindow, windowName, windowReading } from './usage'
import { ACCENT, CLAWD_CSS, CLAWD_W, clawd } from './sprite'

/** A card with a bar under its readout, one without, and the gap every card leaves beneath it. */
export const CARD_BAR_H = 72
export const CARD_FLAT_H = 60
export const CARD_GAP = 8
export const BAND_H = 22
// Every sprite is 24 units tall (the Clawd grid at 1.5 a cell, the bot grids at 1), hats
// included; the band scales it to fit and centres the whole box, so a hat or a bot's
// top row is never cut (drawn from y=-4 until 2026-10-13, which clipped them).
const SPRITE_H = 24
const BAND_SCALE = 0.85
const BAND_Y = (BAND_H - SPRITE_H * BAND_SCALE) / 2
export const STRIP_H = 32
export const MAX_STRIP = 6
const MAX_BAND = 6
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

/** Light and dark text classes, a pulsing dot for a live row, and the Clawd motion. */
const CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#d9d8d3}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0;stroke:#e4e4e1}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#40403e}.ln{stroke:#333331}.tile{fill:#262625;stroke:#333331}}
.cd{fill:#f4f3f0;stroke:#e4e4e1}.bf{fill:#286797}.bw{fill:#b26a00}.tk{fill:#9a9a96}
.st-run{fill:#245e8a}.st-ok{fill:#21653d}.st-bad{fill:#992e27}.st-warn{fill:#805300}
.pb-codex{fill:#e2ebf5}.pt-codex{fill:#284f72}.pb-cursor{fill:#ddf1ec}.pt-cursor{fill:#1f5e52}
.pb-antigravity{fill:#ece8fa}.pt-antigravity{fill:#4b3a99}.pb-claude{fill:#f8e9e1}.pt-claude{fill:#8a3f1f}
@media (prefers-color-scheme: dark){.cd{fill:#262625;stroke:#333331}.bf{fill:#78b7ea}.bw{fill:#f1bf67}.tk{fill:#7d7d79}
.st-run{fill:#8ac5f4}.st-ok{fill:#8dd4ab}.st-bad{fill:#ffada5}.st-warn{fill:#f1bf67}
.pb-codex{fill:#303e51}.pt-codex{fill:#c1d8f1}.pb-cursor{fill:#1f3d38}.pt-cursor{fill:#a5e0d2}
.pb-antigravity{fill:#38305a}.pt-antigravity{fill:#cfc6f7}.pb-claude{fill:#4a2e22}.pt-claude{fill:#f2c2ab}}
.live{animation:apulse 1.6s ease-in-out infinite}@keyframes apulse{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>${CLAWD_CSS}`

/** The one escaper every dynamic string passes through before it enters an Svg. */
export const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/** A per-character em table stands in for font metrics: no DOM measures text here. */
const charEm = (ch: string): number => (/[\s.,:;'|!il1()[\]·]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56)

export const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

/** Cuts `s` to `maxW` pixels at `size`, with an ellipsis when it had to cut. */
export const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) {
    return s
  }

  let out = ''

  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size) > maxW) {
      break
    }

    out += ch
  }

  return `${out}…`
}

/** Breaks `s` at spaces into lines no wider than `maxW` at `size`, at most `maxLines`; the last line it may use is cut with an ellipsis, and a word wider than a line is cut too. */
export const wrapText = (s: string, size: number, maxW: number, maxLines: number): string[] => {
  const lines: string[] = []
  let line = ''

  for (const word of s.replace(/\s+/g, ' ').trim().split(' ')) {
    const next = line === '' ? word : `${line} ${word}`

    if (textWidth(next, size) <= maxW) {
      line = next
      continue
    }

    if (line !== '') {
      lines.push(line)
    }

    line = word
  }

  if (line !== '') {
    lines.push(line)
  }

  if (lines.length <= maxLines) {
    return lines.map(l => fitText(l, size, maxW))
  }

  // the last kept line ended where its next word would not fit, so with that word it is too wide and fitText cuts it
  return [...lines.slice(0, maxLines - 1).map(l => fitText(l, size, maxW)), fitText(`${lines[maxLines - 1]} ${lines[maxLines]}`, size, maxW)]
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${CSS}${body}</svg>`

const bareType = (type: string): string => type.replace(/^[^:]*:/, '')

/** Cuts a label the engine never bounds (an agent type, a model id, an effort) so one card stays under the Svg cap. */
const short = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

export const cardType = (row: AgentRun): string => short(bareType(row.type), 48)

export const BACKEND_NAME: Record<Backend, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity' }

/**
 * What runs the row, after its pill: a subagent's type, model and effort; an external seat's
 * model alone (its type only repeats it, and `agy-` only says what the pill already does).
 * A Codex-relaying subagent shows the model and effort Codex runs at, not its own relay model's.
 */
export const cardMeta = (row: AgentRun): string => {
  const model = row.codex?.model ?? row.model
  const effort = row.codex === undefined ? row.effort : row.codex.effort
  const tail = effort === undefined ? [] : [short(effort, 16)]

  if (row.external !== undefined) {
    return [short(model.replace(/^agy-/, ''), 32), ...tail].join(' · ')
  }

  return [cardType(row), short(modelName(model), 32), ...tail].join(' · ')
}

/** Where a bar turns amber and its label warns, for a timeout and a context window alike; the tick on the bar marks it. */
const WARN_AT = 0.8

/** A card's readout: what the figure is, the figure, how full its bar is (null for no bar), and whether it warns. */
export type Readout = { label: string; value: string; ratio: number | null; isWarn: boolean }

export const cardReadout = (row: AgentRun, at: number, session: Session | null): Readout => {
  const time = fmtTime(elapsed(row, at))

  if (row.external !== undefined) {
    const ratio = capRatio(row, at)

    // Running: the one thing known is how much of its timeout it has spent.
    if (ratio !== null) {
      const label = ratio >= 1 ? 'Timeout reached' : ratio >= WARN_AT ? 'Timeout soon' : 'Timeout budget'

      return { label, value: `${time} / ${fmtTime(row.external.capMs ?? 0)}`, ratio, isWarn: ratio >= WARN_AT }
    }

    const exit = row.external.exit
    const label = reportsTokens(row)
      ? `${fmtTokens(row.tokens)} tokens`
      : row.status === 'lost'
        ? 'No report received'
        : exit !== undefined && exit !== 0 && exit !== 124
          ? `Exit ${exit}`
          : ''

    return { label, value: `${time} elapsed`, ratio: null, isWarn: false }
  }

  // A lost row never reported a request.
  if (row.status === 'lost') {
    return { label: 'No report received', value: `${time} elapsed`, ratio: null, isWarn: false }
  }

  const pct = ctxPercent(row, session)
  const cut = row.detail?.isCutOff === true ? ' · cut off' : ''
  const asked = (row.checks?.asked ?? 0) > 0 ? ` · ${row.checks!.asked} asked` : ''
  const denied = (row.checks?.denied ?? 0) > 0 ? ` · ${row.checks!.denied} denied` : ''
  // Zero is what the list says before the first request is priced: nothing to show yet.
  const cost = row.usd === undefined || row.usd <= 0 ? '' : ` · ${fmtUsd(row.usd)}`

  if (row.status === 'running') {
    // Before its first request there is no figure, only how long it has been going.
    if (row.steps === 0 && row.tokens === 0 && row.contextTokens === 0) {
      return { label: '', value: `${time} elapsed${cut}${asked}${denied}`, ratio: null, isWarn: false }
    }

    const ctx = pct === null ? fmtTokens(row.contextTokens) : `${pct}% · ${fmtTokens(row.contextTokens)}`

    // the same 80% mark a seat's timeout warns at: past it the window is nearly spent
    const isWarn = pct !== null && pct >= WARN_AT * 100

    return {
      label: pct === null ? 'Context' : isWarn ? 'Context nearly full' : 'Context window',
      value: `${ctx} · ${fmtTokens(row.tokens)} total${cost} · ${time}${cut}${asked}${denied}`,
      ratio: pct === null ? null : pct / 100,
      isWarn,
    }
  }

  return {
    label: `${fmtTokens(row.tokens)} tokens${cost}`,
    value: `${pct === null ? '' : `ctx ${pct}% · `}${time} elapsed${cut}${asked}${denied}`,
    ratio: null,
    isWarn: false,
  }
}

export const cardStats = (row: AgentRun, at: number, session: Session | null): string => {
  const r = cardReadout(row, at, session)

  return [r.label, r.value].filter(part => part !== '').join(' · ')
}

export const cardAlt = (row: AgentRun, at: number, session: Session | null): string =>
  `${row.description || row.type}: ${BACKEND_NAME[backendOf(row)]} · ${cardMeta(row)}, ${statusWord(row).toLowerCase()}, ${cardStats(row, at, session)}`

/**
 * The most Svg markup one pane render carries, header and cards together. On 2026-11-24 the
 * desktop pane stopped taking renders, buttons included, when a 20th card took the render
 * from 256,251 to 269,470 characters: an inferred cap near 262,144 (256 KiB), not a documented one.
 */
export const PANE_SVG_BUDGET = 200_000

/** How many of the cards, in order, fit in `budget` characters: the first always does, so a pane is never empty of them. */
export const cardsWithin = (sizes: readonly number[], budget: number): number => {
  let used = 0
  let n = 0

  for (const size of sizes) {
    if (n > 0 && used + size > budget) {
      break
    }

    used += size
    n += 1
  }

  return n
}

/** Where a card's text column starts, right of its mascot; its right edge is 12 in from the card's. */
const CARD_L = 56
const DETAIL_LH = 16

/** An opened card's detail lines, wrapped or cut to the card's text column: its task, newest tool uses, a cut-off, the start of its answer. */
export const detailLines = (row: AgentRun, W: number): { text: string; cls: string }[] => {
  const d = row.detail

  if (d === undefined) {
    return []
  }

  const room = W - 12 - CARD_L

  return [
    ...(d.task === undefined ? [] : wrapText(`Task: ${d.task}`, 11, room, 3).map(text => ({ text, cls: 's' }))),
    ...(d.tools ?? []).map(line => ({ text: fitText(`· ${line}`, 11, room), cls: 'm' })),
    ...(d.isCutOff === true ? [{ text: 'Stopped at the output limit', cls: 'st-warn' }] : []),
    ...(d.answer === undefined ? [] : wrapText(`Answer: ${d.answer}`, 11, room, 3).map(text => ({ text, cls: 's' }))),
  ]
}

/** What opened details add under the readout: a hairline and one 16-high line each; nothing when there is nothing to show. */
const detailExtra = (n: number): number => (n === 0 ? 0 : 10 + n * DETAIL_LH)

/** The card's height: taller while a bar runs under its readout, and taller again by its details when opened. */
export const cardHeight = (row: AgentRun, at: number, session: Session | null, W = 0, isOpen = false): number =>
  (cardReadout(row, at, session).ratio === null ? CARD_FLAT_H : CARD_BAR_H) + (isOpen ? detailExtra(detailLines(row, W).length) : 0) + CARD_GAP

/**
 * A line's figures joined, the summed tokens among them only when some row reports any: an
 * unknown count is left out, never a dash or a zero standing in for a number.
 */
const figures = (lead: string, tokens: number | null, time: number): string =>
  [lead, ...(tokens === null ? [] : [fmtTokens(tokens)]), fmtTime(time)].join(' · ')

/** `5h 20% · 7d 37%`: each window by its own length and what is used of it now (`reset` once its reset has passed); one window on a one-window plan. */
const codexLimitText = (c: CodexLimits, at: number): string =>
  [
    `${windowName(c.primaryMinutes, '5h')} ${windowReading(c.primary, c.primaryResetsAt, at)}`,
    ...(c.secondary === undefined ? [] : [`${windowName(c.secondaryMinutes, '7d')} ${windowReading(c.secondary, c.secondaryResetsAt, at)}`]),
  ].join(' · ')

/**
 * The usage strip's entries, each a label and its figure: Codex's own rate-limit windows, then
 * the consult ledger's Cursor and Antigravity tokens for the day. None from a figure read on an
 * earlier day, and a ledger figure only once a seat of that vendor has run today.
 */
export const usageEntries = (usage: Usage | null | undefined, at: number): [string, string][] => {
  if (usage === null || usage === undefined) {
    return []
  }

  // Codex's windows roll past midnight: a reading from an earlier day still stands while one of its resets is ahead
  const isToday = usage.day === dayStart(at)
  const codex = usage.codex !== undefined && (isToday || hasLiveWindow(usage.codex, at)) ? usage.codex : undefined

  if (!isToday) {
    return codex === undefined ? [] : [['Codex limit', codexLimitText(codex, at)]]
  }

  return [
    ...(codex === undefined ? [] : [['Codex limit', codexLimitText(codex, at)] as [string, string]]),
    ...(usage.cursor === undefined || usage.cursor <= 0 ? [] : [['Cursor today', `${fmtTokens(usage.cursor)} tokens`] as [string, string]]),
    ...(usage.antigravity === undefined || usage.antigravity <= 0 ? [] : [['Antigravity today', `${fmtTokens(usage.antigravity)} tokens`] as [string, string]]),
  ]
}

export const headerText = (t: Totals, usage?: Usage | null, at = 0): string =>
  [figures(`${t.agents} agent${t.agents === 1 ? '' : 's'}`, t.tokens, t.time), ...usageEntries(usage, at).map(([k, v]) => `${k} ${v}`)].join(' · ')

const TILES_H = 44
/** A tile's inner left edge; the usage strip's entries start on it too. */
const TILE_PAD = 12
/** Three across from this width; stacked, one a line, under it. */
const USAGE_WIDE = 540

/** The header's height: the tiles, then the usage strip's one line (wide) or one line an entry. */
export const headerHeight = (W: number, usage?: Usage | null, at = 0): number => {
  const n = usageEntries(usage, at).length

  return n === 0 ? TILES_H : TILES_H + 19 + (W >= USAGE_WIDE ? 0 : (n - 1) * 16) + 8
}

export const bandText = (running: AgentRun[], at: number): string => {
  const t = totals(running, at)

  return figures(`${running.length} running`, t.tokens, t.time)
}

/** How many Clawds the band draws: what fits in W minus the text, at most six, at most n. */
export const bandCrabCount = (W: number, n: number): number => Math.min(n, MAX_BAND, Math.max(1, Math.floor((W - 150) / 36)))

/** Three tiles: agents, tokens, time. */
export const headerSvg = (W: number, t: Totals, usage?: Usage | null, at = 0): string => {
  const gap = 8
  const tw = (W - gap * 2) / 3
  // `isQuiet`: words where a figure would be (nothing reported yet), in the label's weight and colour
  const tile = (i: number, k: string, v: string, isQuiet = false): string =>
    // the same outlined, 12-radius surface as a card, so the header and the list read as one family
    `<rect class="tile" x="${i * (tw + gap) + 0.5}" y="0.5" width="${tw - 1}" height="39" rx="12"/>` +
    `<text class="s" x="${i * (tw + gap) + TILE_PAD}" y="16" font-family="${FONT}" font-size="11">${xml(k)}</text>` +
    (isQuiet
      ? `<text class="s" x="${i * (tw + gap) + TILE_PAD}" y="32" font-family="${FONT}" font-size="13">${xml(fitText(v, 13, tw - TILE_PAD * 2))}</text>`
      : `<text class="t" x="${i * (tw + gap) + TILE_PAD}" y="33" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${xml(v)}</text>`)

  const entries = usageEntries(usage, at)
  const isWide = W >= USAGE_WIDE
  const col = tw + gap
  // label in grey, figure in the text colour: the scope of each number is read before the number
  const strip = entries
    .map(([k, v], i) => {
      // each entry starts under its tile's own label, so the strip reads as the tiles' footnotes
      const x = TILE_PAD + (isWide ? i * col : 0)
      const y = TILES_H + 19 + (isWide ? 0 : i * 16)
      const room = (isWide ? tw : W) - TILE_PAD - textWidth(`${k} · `, 11)

      return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums"><tspan class="s">${xml(k)} · </tspan><tspan class="t">${xml(fitText(v, 11, Math.max(0, room)))}</tspan></text>`
    })
    .join('')

  return svg(
    W,
    headerHeight(W, usage, at),
    `${tile(0, 'Agents', `${t.agents}`)}${t.tokens === null ? tile(1, 'Tokens', 'Not reported', true) : tile(1, 'Tokens', fmtTokens(t.tokens))}${tile(2, 'Time', fmtTime(t.time))}` +
      (entries.length === 0 ? '' : `<line class="ln" x1="0" y1="${TILES_H + 2.5}" x2="${W}" y2="${TILES_H + 2.5}"/>${strip}`),
  )
}

const STATE_CLASS = (row: AgentRun, isWarn: boolean): string =>
  row.status === 'running'
    ? isWarn || (row.pending ?? []).length > 0
      ? 'st-warn'
      : 'st-run'
    : row.status === 'done'
      ? 'st-ok'
      : row.status === 'failed'
        ? 'st-bad'
        : 's'

/**
 * One agent on a rounded card: its mascot; the task on a line of its own; a pill naming whose
 * model runs it, then the model, then its state as a word; and a labelled readout, with a bar
 * under it only while the bar measures something (a subagent's context window or an external
 * seat's timeout, one colour for both, with a tick at the 80% where it turns amber).
 */
export const cardSvg = (W: number, row: AgentRun, at: number, session: Session | null, isOpen = false): string => {
  const costume = costumeOf(row.type, row.variant)
  const read = cardReadout(row, at, session)
  const base = read.ratio === null ? CARD_FLAT_H : CARD_BAR_H
  const lines = isOpen ? detailLines(row, W) : []
  const H = base + detailExtra(lines.length)
  const L = CARD_L
  const R = W - 12
  const isDim = row.status === 'lost'
  const backend = backendOf(row)
  const pillText = BACKEND_NAME[backend]
  const pillW = Math.ceil(textWidth(pillText, 11)) + 16
  const state = statusWord(row)
  const stateW = Math.ceil(textWidth(state, 11)) + (row.status === 'running' ? 12 : 0)
  const stateClass = STATE_CLASS(row, read.isWarn)
  const metaX = L + pillW + 8
  const metaRoom = R - stateW - 12 - metaX
  const meta = metaRoom < 36 ? '' : fitText(cardMeta(row), 11, metaRoom)
  const labelW = read.label === '' ? 0 : textWidth(read.label, 11) + 12
  const value = fitText(read.value, 11, Math.max(0, R - L - labelW))
  const barW = R - L
  const bar =
    read.ratio === null
      ? ''
      : `<rect class="k" x="${L}" y="60" width="${barW}" height="4" rx="2"/>` +
        // a run that has only just started still shows where the bar begins
        // one meter colour for every card, amber only past the mark: the costume colours the mascot, and its
        // orange sat too close to the warning amber to tell a calm context bar from a seat about to time out
        `<rect class="${read.isWarn ? 'bw' : 'bf'}" x="${L}" y="60" width="${Math.max(3, Math.round(barW * Math.min(1, read.ratio)))}" height="4" rx="2"/>` +
        `<rect class="tk" x="${L + Math.round(barW * WARN_AT)}" y="58" width="1" height="8"/>`
  // opened, the details stay inside the card's own outline: a hairline under the readout, then one line each
  const details =
    lines.length === 0
      ? ''
      : `<line class="ln" x1="${L}" y1="${base + 0.5}" x2="${R}" y2="${base + 0.5}"/>` +
        lines.map((l, i) => `<text class="${l.cls}" x="${L}" y="${base + 18 + i * DETAIL_LH}" font-family="${FONT}" font-size="11">${xml(l.text)}</text>`).join('')

  return svg(
    W,
    H + CARD_GAP,
    `<rect class="cd" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12"/>` +
      `${clawd(10, (base - 36) / 2, costume, { isWalking: row.status === 'running', dim: isDim })}` +
      `<text class="${isDim ? 's' : 't'}" x="${L}" y="19" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(row.description || row.type, 13, R - L))}</text>` +
      `<rect class="pb-${backend}" x="${L}" y="23" width="${pillW}" height="20" rx="10"/>` +
      `<text class="pt-${backend}" x="${L + 8}" y="37" font-family="${FONT}" font-size="11" font-weight="600">${xml(pillText)}</text>` +
      (meta === '' ? '' : `<text class="s" x="${metaX}" y="37" font-family="${FONT}" font-size="11">${xml(meta)}</text>`) +
      (row.status === 'running' ? `<circle class="live ${stateClass}" cx="${R - stateW + 4}" cy="33" r="3"/>` : '') +
      `<text class="${stateClass}" x="${R}" y="37" text-anchor="end" font-family="${FONT}" font-size="11" font-weight="600">${xml(state)}</text>` +
      (read.label === '' ? '' : `<text class="${read.isWarn ? 'st-warn' : 's'}" x="${L}" y="53" font-family="${FONT}" font-size="11">${xml(read.label)}</text>`) +
      `<text class="s" x="${R}" y="53" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(value)}</text>` +
      bar +
      details,
  )
}

/** Finished runs of one vendor and one model (and effort, and a subagent's type): how many, their summed tokens when any reports them, their summed time. */
export type FinishedGroup = { backend: Backend; meta: string; count: number; tokens: number | null; time: number }

/** The most group rows the summary draws; the rest are one counted row. */
export const MAX_GROUPS = 12
const GROUP_H = 36

/**
 * The finished rows, newest first, as the summary shows them: each run that ended done folded into
 * its vendor-and-model group (groups ordered by their newest run), and each one that did not
 * (failed, timed out, stopped, lost) left out as `attention`, to keep its own card.
 */
export const finishedGroups = (rows: AgentRun[], at: number): { groups: FinishedGroup[]; attention: AgentRun[] } => {
  const by = new Map<string, FinishedGroup>()

  for (const a of rows) {
    if (a.status !== 'done') {
      continue
    }

    const backend = backendOf(a)
    const meta = cardMeta(a)
    const key = `${backend}\u0000${meta}`
    const g = by.get(key) ?? { backend, meta, count: 0, tokens: null, time: 0 }

    by.set(key, { ...g, count: g.count + 1, tokens: reportsTokens(a) ? (g.tokens ?? 0) + a.tokens : g.tokens, time: g.time + elapsed(a, at) })
  }

  return { groups: [...by.values()], attention: rows.filter(a => a.status !== 'done') }
}

/** `Codex · gpt-6.2-sol · low · 23 done · 7:41`, the tokens before the time only when some run in the group reported them. */
export const groupLine = (g: FinishedGroup): string =>
  [BACKEND_NAME[g.backend], g.meta, `${g.count} done`, ...(g.tokens === null ? [] : [fmtTokens(g.tokens)]), fmtTime(g.time)].join(' · ')

const moreGroups = (groups: FinishedGroup[]): string | null => {
  const rest = groups.slice(MAX_GROUPS)

  return rest.length === 0 ? null : `+${rest.length} more kinds · ${rest.reduce((n, g) => n + g.count, 0)} done`
}

/** How many rows the summary draws: its groups up to MAX_GROUPS, and one counted row past that. */
export const finishedRows = (groups: FinishedGroup[]): number => Math.min(groups.length, MAX_GROUPS) + (groups.length > MAX_GROUPS ? 1 : 0)

/** The summary's height for `n` rows, the gap under it included. */
export const finishedHeight = (n: number): number => n * GROUP_H + CARD_GAP

export const finishedAlt = (groups: FinishedGroup[]): string =>
  `Finished: ${[...groups.slice(0, MAX_GROUPS).map(groupLine), ...[moreGroups(groups) ?? []].flat()].join('; ')}`

/**
 * The finished summary: one outlined block, a 36-high row per group with a hairline between rows
 * and none under the last; in each, the vendor pill and the model on the left, then the count,
 * tokens and time in right-aligned columns that line up from row to row.
 */
export const finishedSvg = (W: number, groups: FinishedGroup[]): string => {
  const shown = groups.slice(0, MAX_GROUPS)
  const more = moreGroups(groups)
  const n = finishedRows(groups)
  const R = W - 12
  const timeX = R
  const tokensX = R - 56
  const countX = R - 112
  const num = `font-family="${FONT}" font-size="11" text-anchor="end" font-variant-numeric="tabular-nums"`
  const body = shown
    .map((g, i) => {
      const y = i * GROUP_H
      const pill = BACKEND_NAME[g.backend]
      const pillW = Math.ceil(textWidth(pill, 11)) + 16
      const metaX = 12 + pillW + 8
      const room = countX - textWidth(`${g.count} done`, 11) - 12 - metaX

      return (
        `<rect class="pb-${g.backend}" x="12" y="${y + 8}" width="${pillW}" height="20" rx="10"/>` +
        `<text class="pt-${g.backend}" x="20" y="${y + 22}" font-family="${FONT}" font-size="11" font-weight="600">${xml(pill)}</text>` +
        (room < 36 ? '' : `<text class="t" x="${metaX}" y="${y + 22}" font-family="${FONT}" font-size="12">${xml(fitText(g.meta, 12, room))}</text>`) +
        `<text class="s" x="${countX}" y="${y + 22}" ${num}>${g.count} done</text>` +
        (g.tokens === null ? '' : `<text class="s" x="${tokensX}" y="${y + 22}" ${num}>${xml(fmtTokens(g.tokens))}</text>`) +
        `<text class="s" x="${timeX}" y="${y + 22}" ${num}>${xml(fmtTime(g.time))}</text>` +
        (i < n - 1 ? `<line class="ln" x1="12" y1="${y + GROUP_H + 0.5}" x2="${R}" y2="${y + GROUP_H + 0.5}"/>` : '')
      )
    })
    .join('')
  const moreRow = more === null ? '' : `<text class="s" x="12" y="${shown.length * GROUP_H + 22}" font-family="${FONT}" font-size="11">${xml(more)}</text>`

  return svg(W, finishedHeight(n), `<rect class="cd" x="0.5" y="0.5" width="${W - 1}" height="${n * GROUP_H - 1}" rx="12"/>${body}${moreRow}`)
}

/** The compact pane: one Clawd per row in a line, running first, then +n and the totals. */
export const stripSvg = (W: number, rows: AgentRun[], t: Totals): string => {
  const ordered = [...rows.filter(a => a.status === 'running'), ...rows.filter(a => a.status !== 'running')]
  const shown = ordered.slice(0, Math.min(MAX_STRIP, Math.max(1, Math.floor((W - 150) / 36))))
  const more = ordered.length - shown.length
  const body = shown
    .map((a, i) => {
      const costume = costumeOf(a.type, a.variant)

      return (
        clawd(i * 36, 0, costume, { isWalking: a.status === 'running', dim: a.status === 'lost' }) +
        (a.status === 'running' ? `<circle class="live" cx="${i * 36 + 32}" cy="4" r="3" fill="${ACCENT[costume]}"/>` : '')
      )
    })
    .join('')
  const x = shown.length * 36 + 4

  return svg(
    W,
    STRIP_H,
    `${body}${more > 0 ? `<text class="s" x="${x}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}` +
      `<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">${xml(headerText(t))}</text>`,
  )
}

/** The band row: walking Clawds for the running agents, +n past what fits, and the summary text. */
export const bandSvg = (W: number, running: AgentRun[], at: number): string => {
  const n = bandCrabCount(W, running.length)
  const shown = running.slice(0, n)
  const more = running.length - n
  const clawds = shown.map((a, i) => clawd(i * 36, BAND_Y, costumeOf(a.type, a.variant), { isWalking: true, scale: BAND_SCALE })).join('')
  const x = n * 36 + (more > 0 ? 4 : 0)
  const moreText = more > 0 ? `<text class="s" x="${x}" y="${BAND_H / 2 + 4}" font-family="${FONT}" font-size="12">+${more}</text>` : ''
  const textX = x + (more > 0 ? 14 + textWidth(`+${more}`, 12) : 0)
  const room = Math.max(0, W - textX)

  return svg(
    W,
    BAND_H,
    `${clawds}${moreText}<text class="s" x="${textX}" y="${BAND_H / 2 + 4}" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${xml(fitText(bandText(running, at), 12.5, room))}</text>`,
  )
}

export { CLAWD_W }
