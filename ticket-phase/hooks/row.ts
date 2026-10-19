import type { MascotKey } from './mascot'
import { MASCOT_CSS, MASCOT_H, MASCOT_W, mascot } from './mascot'

export type RowColor = 'green' | 'yellow' | 'red' | 'gray'

export type RowInput = {
  /** `#12345 full` */
  title: string
  /** cellsOf(state): eight of ◆ ◈ ◇ */
  cells: string
  current: number | null
  /** `5 Implement`, `between phases`, `done 3h0m` */
  pill: string
  /** The next phase's label for its ghost (`6 Review`); '' when there is no next phase. */
  next: string
  color: RowColor
  /** `23m/41m · ~2h10m left · 184k · R6×2`, dim; '' when nothing */
  stats: string
  /** Time in the current phase over its median; null with no median. Drives the ghost's strength. */
  progress: number | null
  /** How long ago the current phase was entered; the slide-in plays while this is short. */
  enteredAgoMs: number | null
  isDone: boolean
}

export const ROW_H = 22
/** The mascot's slot at the row's end: the GIF plus a little air. */
const MASCOT_BOX = MASCOT_W + 2
export const BAR_MIN = 96
const BAR_H = 16
const CELL = 3
/** How far a phase's arrow edge points into the next, and the gap between the two. */
const ARROW = 5
const GAP = 1.5
/** Label padding inside a chevron, both sides together. */
const PAD = 24
/** The labels are bold: they run this much wider than the regular-weight estimate. */
const BOLD = 1.1
const MIN_W = 180
const MAX_W = 1600
/** The stats column is as wide as this, whatever the stats say, so the bar keeps one length. */
const STATS_REF = '1h57m/30m · ~15h46m left · 971k · R6×2'
/** The slide-in on entering a phase, and how long after the enter a redraw still shows it. */
const SLIDE_S = 0.55
const SLIDE_WINDOW_MS = 4000
/** The ghost of the next phase: barely there as the phase starts, this strong at the median. */
const GHOST_MIN = 0.05
const GHOST_MAX = 0.55
const GHOST_NO_MEDIAN = 0.12
/**
 * The tail falls off with distance behind the chevron, in segments: nearly solid and bold right
 * behind it, thinning to a few faint dots a reach back. The reach grows with the phase, from
 * about 2 segments in phase 2 to about 4.5 in phase 8: later phases trail a longer tail.
 */
const reachFor = (index: number): number => 1.4 + 0.45 * index
/** The pulse's front is ragged by up to this many seconds a column. */
const PULSE_JITTER = 0.5
/**
 * Each dot blinks on one of these rhythms, picked by noise: a soft shimmer, a slow fade almost
 * out and back, or a quick blink. [keyframes, duration s, delay s]
 */
const TWINKLES: readonly (readonly [string, number, number])[] = [
  ['ptw', 2.2, -0.0], ['ptx', 3.7, -1.9], ['pty', 2.9, -0.4], ['ptw', 1.7, -1.1],
  ['ptx', 4.6, -3.2], ['ptw', 3.1, -2.6], ['pty', 1.9, -1.5], ['ptx', 2.6, -0.8],
  ['ptw', 2.7, -2.0], ['pty', 3.4, -2.9], ['ptx', 5.3, -4.4], ['ptw', 1.4, -0.3],
]
const TWINKLE_CSS =
  TWINKLES.map(([name, dur, delay], k) => `.t${k}{animation:${name} ${dur}s ease-in-out ${delay}s infinite}`).join('') +
  '@keyframes ptw{0%,100%{opacity:1}50%{opacity:.55}}' +
  '@keyframes ptx{0%,100%{opacity:1}40%,55%{opacity:.08}}' +
  '@keyframes pty{0%,82%,100%{opacity:1}88%{opacity:.15}}'
const TWINKLE_CLASSES = TWINKLES.map((_, k) => `.t${k}`).join(',')
/** The tail's pulse: one sweep every PULSE_S seconds, travelling back PULSE_SPEED px a second. */
const PULSE_S = 2.4
const PULSE_SPEED = 160
/**
 * Done: the whole bar fills with dots at one density, every dot flashing on its own beat, and bright
 * sparks popping across the field. A dot takes a rhythm (fK: keyframes and duration) and a start
 * (dJ: delay), both picked by noise, so no two patches of the bar ever flash in step. [keyframes, duration s]
 */
const DONE_DENSITY = 0.8
/** The share of the field's dots that also carry a spark. */
const DONE_SPARKS = 0.16
const FLASHES: readonly (readonly [string, number])[] = [
  ['pfa', 1.3], ['pfb', 2.1], ['pfa', 0.9], ['pfc', 1.7], ['pfb', 1.1], ['pfa', 2.6],
  ['pfc', 1.5], ['pfb', 0.8], ['pfa', 1.9], ['pfc', 2.3], ['pfb', 1.4], ['pfa', 1.0],
]
/** The sparks' beats: a pop from nothing to full and back, on durations that never line up. */
const SPARKS: readonly number[] = [1.1, 1.7, 2.3, 1.3, 2.9, 1.9, 3.3, 1.5, 2.1, 2.7, 1.2, 3.1]
/** The starts, in seconds back into the beat; the delay classes come last so they beat the shorthands. */
const STARTS: readonly number[] = [0, 0.31, 0.57, 0.92, 1.13, 1.48, 1.71, 2.04, 2.26, 2.59, 2.83, 3.17, 3.42, 3.76, 3.99, 4.33]
const SPARK = '#e6fff0'
const DONE_CLASSES = [...FLASHES.map((_, k) => `.f${k}`), ...SPARKS.map((_, k) => `.s${k}`)].join(',')
const DONE_CSS =
  FLASHES.map(([name, dur], k) => `.f${k}{animation:${name} ${dur}s linear infinite}`).join('') +
  SPARKS.map((dur, k) => `.s${k}{animation:psk ${dur}s linear infinite}`).join('') +
  STARTS.map((delay, j) => `.d${j}{animation-delay:-${delay}s}`).join('') +
  '.sp{opacity:0}' +
  '@keyframes pfa{0%,100%{opacity:.4}5%,12%{opacity:1}}' +
  '@keyframes pfb{0%,100%{opacity:.5}8%{opacity:1}22%{opacity:.5}}' +
  '@keyframes pfc{0%,100%{opacity:.35}3%,7%{opacity:1}14%,18%{opacity:1}}' +
  '@keyframes psk{0%,100%{opacity:0}3%,9%{opacity:1}}' +
  `@media (prefers-reduced-motion: reduce){${DONE_CLASSES}{animation:none}}`
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const COLORS: Record<RowColor, string> = { green: '#3B9C5F', yellow: '#C9A227', red: '#D0453F', gray: '#9a9a96' }
const DONE = '#5fbf8f'

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const charEm = (ch: string): number => (/[\s.,:;'|!il1()[\]·]/.test(ch) ? 0.3 : /[A-Z#mw@%]/.test(ch) ? 0.72 : 0.56)
const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)
const fitText = (s: string, size: number, maxW: number): string => {
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

/** Deterministic noise so the dither does not shimmer between redraws. */
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453

  return s - Math.floor(s)
}


/**
 * What fits. The bar's length depends on the row's width and the title alone, never on
 * the phase or the stats: the stats get a fixed column. When the bar would go under
 * BAR_MIN the stats column goes first, then the Clawd, then the title's share drops
 * from 40 % to 25 %. Done is the one exception: nothing follows it that could move the
 * bar again, so the column shrinks to its own text and the bar takes the rest.
 */
export const layout = (input: Pick<RowInput, 'title'> & Partial<Pick<RowInput, 'isDone' | 'pill' | 'stats'>>, W0: number) => {
  const W = Math.max(MIN_W, Math.min(MAX_W, W0))
  const doneText = input.isDone === true ? [input.pill ?? '', input.stats ?? ''].filter(one => one !== '').join(' · ') : null
  const statsW = doneText === null
    ? Math.round(textWidth(STATS_REF, 12.5)) + 10
    : Math.round(textWidth(doneText, 12.5)) + 10
  let share = 0.4
  let showStats = true
  let showCrab = true
  const measure = (): { title: string; barX: number; barW: number } => {
    const title = fitText(input.title, 13, Math.max(40, W * share))
    const barX = Math.round(16 + textWidth(title, 13) + 12)
    const barW = W - barX - (showStats ? statsW : 0) - 10 - (showCrab ? MASCOT_BOX + 6 : 0)

    return { title, barX, barW }
  }
  let m = measure()

  if (m.barW < BAR_MIN && showStats) {
    showStats = false
    m = measure()
  }

  if (m.barW < BAR_MIN && showCrab) {
    showCrab = false
    m = measure()
  }

  if (m.barW < BAR_MIN) {
    share = 0.25
    m = measure()
  }

  return { W, title: m.title, barX: m.barX, barW: Math.max(BAR_MIN, m.barW), showStats, showCrab, statsW }
}

/**
 * One phase as a chevron from x0 to x1: notched on the left where the phase before
 * points in (a chevron starting at the bar's start is flat, and the bar's round end
 * rounds it), pointed on the right; the last phase ends flat, so the bar's round end
 * closes the cycle.
 */
const chevron = (x0: number, x1: number, isFirst: boolean, isLast: boolean): string => {
  const m = BAR_H / 2
  const left = isFirst ? [[x0, BAR_H], [x0, 0]] : [[x0 + GAP, BAR_H], [x0 + GAP + ARROW, m], [x0 + GAP, 0]]
  const right = isLast ? [[x1, 0], [x1, BAR_H]] : [[x1, 0], [x1 + ARROW, m], [x1, BAR_H]]

  return [...left, ...right].map(([x, y]) => `${x!.toFixed(1)},${y}`).join(' ')
}

/** The room a label takes in a chevron starting at x0: its padded text, plus the notch unless flat. */
const roomFor = (label: string, isFlat: boolean): number => textWidth(label, 11) * BOLD + PAD + (isFlat ? 0 : GAP + ARROW)

/**
 * The current phase's chevron. Its right edge is its own phase's boundary, always: a label
 * that does not fit its segment stretches the chevron back over the phases before, as far
 * as it needs, and never forward. A label that does not fit even from the bar's start
 * shows the phase number alone.
 */
export const pillOf = (index: number, pill: string, current: number, seg: number) => {
  const x1 = (index + 1) * seg
  const own = index * seg

  if (roomFor(pill, index === 0) <= seg) {
    return { x0: own, x1, label: pill }
  }

  const back = x1 - roomFor(pill, false)

  if (back >= 0) {
    return { x0: back, x1, label: pill }
  }

  if (roomFor(pill, true) <= x1) {
    return { x0: 0, x1, label: pill }
  }

  return { x0: own, x1, label: String(current) }
}

/** The next phase's label in its ghost: the name when it fits the segment, else the number. */
const ghostLabel = (next: string, seg: number, isFlat: boolean): string =>
  roomFor(next, isFlat) <= seg ? next : next.split(' ')[0] ?? next

/**
 * The worked phases as a dither, densest and boldest right behind the current phase and
 * thinning out further back, with a pulse running from the current phase back. Each column is one group: its
 * fill-opacity is the fade, its animation delay (growing with distance) is the pulse.
 */
const tail = (cells: string[], seg: number, color: string, anchor: number, reach: number): { clips: string[]; parts: string[] } => {
  const clips: string[] = []
  const parts: string[] = []
  const rows = Math.floor(BAR_H / CELL)

  cells.forEach((cell, i) => {
    if (cell !== '◆') {
      return
    }

    const x0 = i * seg
    const columns: string[] = []

    // One dot grid across the whole bar; each phase takes the columns from its start through its
    // arrow tip, and its chevron clips them, so the dots run right up to the next phase's edge.
    for (let c = Math.max(0, Math.floor((x0 - 1) / CELL)); c * CELL + 1 < x0 + seg + ARROW; c += 1) {
      const x = c * CELL + 1
      // Segments behind the chevron; 0 right behind it.
      const behind = Math.max(0, anchor - x) / seg
      const falloff = Math.exp(-behind / reach)
      const density = 0.06 + 0.9 * falloff
      const dots: string[] = []

      for (let r = 0; r < rows; r += 1) {
        if (noise(c, r) < density) {
          dots.push(`<rect class="t${Math.floor(noise(r + 31, c) * TWINKLES.length)}" x="${x.toFixed(1)}" y="${r * CELL + 1}" width="2" height="2"/>`)
        }
      }

      if (dots.length > 0) {
        const fade = 0.2 + 0.8 * falloff
        // The pulse dims the far tail more than the dots right behind the chevron, which stay bold.
        const band = behind < 1 ? 'w0' : behind < 2.5 ? 'w1' : 'w2'
        // The pulse leaves the current phase and travels back at PULSE_SPEED, its front ragged by
        // up to PULSE_JITTER s; a negative delay puts every column in its steady place from the first frame.
        const lag = (anchor - x) / PULSE_SPEED + (noise(c, 97) - 0.5) * PULSE_JITTER
        const delay = (-(PULSE_S - (((lag % PULSE_S) + PULSE_S) % PULSE_S))).toFixed(2)
        columns.push(`<g class="w ${band}" fill-opacity="${fade.toFixed(2)}" style="animation-delay:${delay}s">${dots.join('')}</g>`)
      }
    }

    clips.push(`<clipPath id="cs${i}"><polygon points="${chevron(x0, x0 + seg, i === 0, i === 7)}"/></clipPath>`)
    parts.push(`<g class="dots" data-cell="${i + 1}" fill="${color}" clip-path="url(#cs${i})">${columns.join('')}</g>`)
  })

  return { clips, parts }
}

/**
 * The done field: dots over the whole bar at one density (no tail, no fade), each on a rhythm and a
 * start of its own, and a bright spark over some of them. One group each; the bar's round end clips them.
 */
const field = (barW: number, color: string): string => {
  const rows = Math.floor(BAR_H / CELL)
  // One path per rhythm-and-start pair: every dot on the same beat is one element, so the
  // field stays well under the source cap at the widest row.
  const dots = new Map<string, string[]>()
  const sparks = new Map<string, string[]>()
  const add = (into: Map<string, string[]>, classes: string, d: string): void => {
    const list = into.get(classes) ?? []
    list.push(d)
    into.set(classes, list)
  }

  for (let c = 0; c * CELL + 1 < barW; c += 1) {
    const x = c * CELL + 1

    for (let r = 0; r < rows; r += 1) {
      if (noise(c, r) >= DONE_DENSITY) {
        continue
      }

      const f = Math.floor(noise(r + 31, c) * FLASHES.length)
      const d = Math.floor(noise(c + 53, r + 7) * STARTS.length)
      add(dots, `f${f} d${d}`, `M${x} ${r * CELL + 1}h2v2h-2z`)

      if (noise(r + 11, c + 89) < DONE_SPARKS) {
        const k = Math.floor(noise(c + 5, r + 67) * SPARKS.length)
        const start = Math.floor(noise(r + 41, c + 19) * STARTS.length)
        add(sparks, `sp s${k} d${start}`, `M${x - 0.5} ${r * CELL + 0.5}h3v3h-3z`)
      }
    }
  }

  const paths = (of: Map<string, string[]>): string =>
    [...of].map(([classes, ds]) => `<path class="${classes}" d="${ds.join('')}"/>`).join('')

  return `<g class="dots done" fill="${color}">${paths(dots)}</g><g class="sparks" fill="${SPARK}">${paths(sparks)}</g>`
}

/** The mascot for the row's state: the current phase's, else waiting between phases, else done. */
export const mascotKey = (input: Pick<RowInput, 'current' | 'isDone'>): MascotKey =>
  input.current !== null && input.current >= 1 && input.current <= 8 ? (String(input.current) as MascotKey) : input.isDone ? 'done' : 'between'

const mascotOf = (input: RowInput, x: number, y: number): string =>
  mascot(mascotKey(input), x, y, { isWalking: input.current !== null, isDone: input.isDone })

const label = (x: number, text: string, fill: string, extra = ''): string =>
  `<text${extra} x="${x.toFixed(1)}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${fill}">${xml(text)}</text>`

/** One SVG row: dot, title, the eight-segment bar with the current chevron and the next one's ghost, the stats, the Clawd. */
export const rowSvg = (input: RowInput, W0: number): string => {
  const l = layout(input, W0)
  const color = input.isDone ? DONE : COLORS[input.color]
  const y0 = (ROW_H - BAR_H) / 2
  const seg = l.barW / 8
  const cells = [...input.cells].slice(0, 8)
  const at = cells.indexOf('◈')
  const pill = at >= 0 && input.current !== null ? pillOf(at, input.pill, input.current, seg) : null
  const lastWorked = cells.lastIndexOf('◆')
  // The tail is boldest where it meets the chevron, or at its own end with no phase open.
  const anchor = pill !== null ? pill.x0 + GAP : (lastWorked + 1) * seg
  // Done fills the whole bar whatever was entered: the celebration is the ticket's, not a phase's.
  const { clips, parts } = input.isDone
    ? { clips: [], parts: [field(l.barW, color)] }
    : tail(cells, seg, color, anchor, reachFor(at >= 0 ? at : lastWorked + 1))
  const hasGhost = at >= 0 && at < 7 && input.next !== ''
  let css = ''

  parts.unshift(...cells.map((_, i) => `<rect class="seg" x="${(i * seg).toFixed(1)}" y="0" width="${seg.toFixed(1)}" height="${BAR_H}" fill="none"/>`))

  if (hasGhost) {
    const gx0 = (at + 1) * seg
    const strength = input.progress === null ? GHOST_NO_MEDIAN : GHOST_MIN + (GHOST_MAX - GHOST_MIN) * Math.max(0, Math.min(1, input.progress))
    parts.push(
      `<g class="ghost" opacity="${strength.toFixed(3)}">` +
        `<polygon points="${chevron(gx0, gx0 + seg, false, at + 1 === 7)}" fill="${color}"/>` +
        label(gx0 + (GAP + ARROW + seg) / 2, ghostLabel(input.next, seg, false), '#ffffff') +
        `</g>`,
    )
  }

  // An arrow edge marks every phase boundary, drawn where a chevron's arrow sits (x to x + ARROW),
  // except where the current chevron or the ghost already draws one.
  for (let b = 1; b < 8; b += 1) {
    const x = b * seg

    if (input.isDone) {
      // A full bar is one field: no boundaries.
      break
    }

    if (pill !== null && x >= pill.x0 - 1 && x <= pill.x1 + ARROW + 1) {
      continue
    }

    if (hasGhost && b === at + 2) {
      continue
    }

    parts.push(`<polyline class="tick" points="${x.toFixed(1)},3 ${(x + ARROW).toFixed(1)},${BAR_H / 2} ${x.toFixed(1)},${BAR_H - 3}"/>`)
  }

  if (pill !== null) {
    const isFlat = pill.x0 <= 0.5
    const inset = isFlat ? 0 : GAP + ARROW
    // A fresh enter slides the chevron in from the phase before; a negative delay puts a later
    // redraw at the right point of the slide, past its end once the window closes.
    const isSliding = input.enteredAgoMs !== null && input.enteredAgoMs < SLIDE_WINDOW_MS && at > 0

    if (isSliding) {
      const ago = (-(input.enteredAgoMs ?? 0) / 1000).toFixed(2)
      css =
        `@keyframes ps{from{transform:translateX(-${seg.toFixed(1)}px)}to{transform:none}}@keyframes pf{0%,60%{opacity:0}100%{opacity:1}}` +
        `.slide{animation:ps ${SLIDE_S}s cubic-bezier(.2,.8,.2,1) ${ago}s both}.slide text{animation:pf ${SLIDE_S}s linear ${ago}s both}` +
        `@media (prefers-reduced-motion: reduce){.slide,.slide text{animation:none}}`
    }

    parts.push(
      `<g${isSliding ? ' class="slide"' : ''}>` +
        `<polygon class="pill" points="${chevron(pill.x0, pill.x1, isFlat, at === 7)}" fill="${color}"/>` +
        label((pill.x0 + inset + pill.x1) / 2, pill.label, '#ffffff') +
        `</g>`,
    )
  }

  // Between phases and done, the phase text leads the stats column.
  const statsText = input.current === null ? [input.pill, input.stats].filter(one => one !== '').join(' · ') : input.stats
  const statsX = l.W - (l.showCrab ? MASCOT_BOX + 6 : 0)
  const stats = l.showStats && statsText !== ''
    ? `<text class="m" x="${statsX}" y="${ROW_H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${xml(fitText(statsText, 12.5, l.statsW - 10))}</text>`
    : ''
  const sprite = l.showCrab
    ? mascotOf(input, l.W - MASCOT_W, (ROW_H - MASCOT_H) / 2)
    : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${l.W}" height="${ROW_H}" viewBox="0 0 ${l.W} ${ROW_H}">` +
    `<style>` +
    `.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tick{fill:none;stroke:#b4b4b0;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}` +
    `@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tick{stroke:#5a5a5a}}` +
    `${TWINKLE_CSS}` +
    `.w{animation:pw2 ${PULSE_S}s ease-out infinite both}.w0{animation-name:pw0}.w1{animation-name:pw1}` +
    `@keyframes pw0{0%{opacity:1}22%,100%{opacity:.85}}@keyframes pw1{0%{opacity:1}22%,100%{opacity:.62}}@keyframes pw2{0%{opacity:1}22%,100%{opacity:.45}}` +
    `${css}${input.isDone ? DONE_CSS : ''}` +
    `@media (prefers-reduced-motion: reduce){${TWINKLE_CLASSES},.w{animation:none}}` +
    `${MASCOT_CSS}</style>` +
    `<defs><clipPath id="pc"><rect x="0" y="0" width="${l.barW}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>${clips.join('')}</defs>` +
    `<circle cx="5" cy="${ROW_H / 2}" r="4" fill="${color}"/>` +
    `<text class="t" x="16" y="${ROW_H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(l.title)}</text>` +
    `<g transform="translate(${l.barX},${y0})"><rect class="k" width="${l.barW}" height="${BAR_H}" rx="${BAR_H / 2}"/><g clip-path="url(#pc)">${parts.join('')}</g></g>` +
    `${stats}${sprite}</svg>`
  )
}
