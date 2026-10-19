import type { AgentRun, Session } from '../types'
import { costumeOf, ctxPercent, elapsed, fmtTime, fmtTokens, modelName, reportsTokens, totals } from './agents'
import type { Totals } from './agents'
import { ACCENT, CLAWD_CSS, CLAWD_W, clawd } from './sprite'

export const CARD_H = 66
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
const DONE = '#3B9C5F'
const FAIL = '#D0453F'
const LOST = '#9a9a96'

/** Light and dark text classes, a pulsing dot for a live row, and the Clawd motion. */
const CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
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

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${CSS}${body}</svg>`

const bareType = (type: string): string => type.replace(/^[^:]*:/, '')

/** Cuts a label the engine never bounds (an agent type, a model id, an effort) so one card stays under the Svg cap. */
const short = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

export const cardType = (row: AgentRun): string => short(bareType(row.type), 48)

export const cardMeta = (row: AgentRun): string =>
  [cardType(row), short(modelName(row.model), 32), ...(row.effort === undefined ? [] : [short(row.effort, 16)])].join(' · ')

export const cardStats = (row: AgentRun, at: number, session: Session | null): string => {
  const time = fmtTime(elapsed(row, at))

  // A lost row never reported a request; an external one reports none at all.
  if (!reportsTokens(row)) {
    return `— · — · ${time}`
  }

  const pct = ctxPercent(row, session)
  const ctx = pct === null ? `ctx ${fmtTokens(row.contextTokens)}` : `ctx ${pct}% · ${fmtTokens(row.contextTokens)}`

  const parked = row.engineStatus === undefined ? '' : ` · ${row.engineStatus}`
  const cut = row.detail?.isCutOff === true ? ' · cut off' : ''
  const asked = (row.checks?.asked ?? 0) > 0 ? ` · ${row.checks!.asked} asked` : ''
  const denied = (row.checks?.denied ?? 0) > 0 ? ` · ${row.checks!.denied} denied` : ''
  const awaiting = (row.pending ?? []).length > 0 ? ' · awaiting approval' : ''

  return `${ctx} · ${fmtTokens(row.tokens)} · ${time}${parked}${cut}${asked}${denied}${awaiting}`
}

export const cardAlt = (row: AgentRun, at: number, session: Session | null): string =>
  `${row.description || row.type}: ${cardMeta(row)}, ${row.status}, ${cardStats(row, at, session)}`

/** The summed tokens, or `—` when no row reports any. */
const fmtTotal = (tokens: number | null): string => (tokens === null ? '—' : fmtTokens(tokens))

export const headerText = (t: Totals): string => `${t.agents} agent${t.agents === 1 ? '' : 's'} · ${fmtTotal(t.tokens)} · ${fmtTime(t.time)}`

export const bandText = (running: AgentRun[], at: number): string => {
  const t = totals(running, at)

  return `${running.length} running · ${fmtTotal(t.tokens)} · ${fmtTime(t.time)}`
}

/** How many Clawds the band draws: what fits in W minus the text, at most six, at most n. */
export const bandCrabCount = (W: number, n: number): number => Math.min(n, MAX_BAND, Math.max(1, Math.floor((W - 150) / 36)))

const statusMark = (x: number, y: number, status: AgentRun['status'], color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="${DONE}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="${FAIL}" stroke-width="1.8" stroke-linecap="round"/>`

  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${LOST}" stroke-width="1.4"/>`
}

/** Three tiles: agents, tokens, time. */
export const headerSvg = (W: number, t: Totals): string => {
  const gap = 6
  const tw = (W - gap * 2) / 3
  const tile = (i: number, k: string, v: string): string =>
    `<rect class="tile" x="${i * (tw + gap)}" y="0" width="${tw}" height="40" rx="8"/>` +
    `<text class="s" x="${i * (tw + gap) + 9}" y="16" font-family="${FONT}" font-size="11">${xml(k)}</text>` +
    `<text class="t" x="${i * (tw + gap) + 9}" y="33" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${xml(v)}</text>`

  return svg(W, 44, `${tile(0, 'Agents', `${t.agents}`)}${tile(1, 'Tokens', fmtTotal(t.tokens))}${tile(2, 'Time', fmtTime(t.time))}`)
}

/** One subagent: Clawd, description, meta line, stats, a context bar and a status mark. */
export const cardSvg = (W: number, row: AgentRun, at: number, session: Session | null): string => {
  const costume = costumeOf(row.type, row.variant)
  const color = ACCENT[costume]
  const textW = W - 42 - 22
  const stats = cardStats(row, at, session)
  const pct = row.status === 'lost' ? null : ctxPercent(row, session)
  const fill = row.status === 'done' ? textW : pct === null ? 0 : Math.round((textW * pct) / 100)
  const barFill = row.status === 'done' ? DONE : color
  const isDim = row.status === 'lost'

  return svg(
    W,
    CARD_H,
    `${clawd(0, 14, costume, { isWalking: row.status === 'running', dim: isDim })}` +
      `<text class="${isDim ? 's' : 't'}" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(row.description || row.type, 13, textW))}</text>` +
      `<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(cardType(row))}</tspan><tspan class="s">  ${xml(fitText(cardMeta(row).slice(cardType(row).length + 3), 11, textW - textWidth(cardType(row), 11)))}</tspan></text>` +
      `<text class="s" x="${42 + textW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(stats)}</text>` +
      `<rect class="k" x="42" y="55" width="${textW}" height="4" rx="2"/><rect x="42" y="55" width="${fill}" height="4" rx="2" fill="${barFill}"/>` +
      `${statusMark(W - 8, 16, row.status, color)}` +
      `<line class="ln" x1="0" y1="${CARD_H - 0.5}" x2="${W}" y2="${CARD_H - 0.5}"/>`,
  )
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
