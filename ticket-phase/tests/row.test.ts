import { expect, test } from 'claude-code/testing'

import type { RowInput } from '../hooks/row'
import { BAR_MIN, ROW_H, layout, pillOf, rowSvg } from '../hooks/row'

const NAMES = ['', 'Recall', 'Research', 'Plan', 'Test', 'Implement', 'Review', 'Ship', 'Compound']
const base: RowInput = {
  title: '#1002 full',
  cells: '◆◆◆◆◈◇◇◇',
  current: 5,
  pill: '5 Implement',
  next: '6 Review',
  color: 'green',
  stats: '23m/41m · ~2h10m left · 184k · R6×2',
  progress: 0.5,
  enteredAgoMs: 23 * 60_000,
  isDone: false,
}
/** The row for phase p, every phase before it worked. */
const at = (p: number, extra: Partial<RowInput> = {}): RowInput => ({
  ...base,
  cells: `${'◆'.repeat(p - 1)}◈${'◇'.repeat(8 - p)}`,
  current: p,
  pill: `${p} ${NAMES[p]}`,
  next: p < 8 ? `${p + 1} ${NAMES[p + 1]}` : '',
  ...extra,
})
const num = (s: string): number => Number(s)
/** The current chevron's points, x0 (its left edge, before the notch gap) and x1 (its right edge). */
const pillEdges = (s: string) => {
  const m = /class="pill" points="([^"]+)"/.exec(s)
  if (m === null) return null
  const pts = m[1]!.split(' ').map(p => p.split(',').map(Number) as [number, number])
  const flat = pts[0]![0] === pts[1]![0]
  const x0 = flat ? pts[0]![0] : pts[0]![0] - 1.5
  const x1 = pts.find(([, y], k) => k >= (flat ? 2 : 3) && y === 0)![0]

  return { x0, x1, flat }
}
const pillText = (s: string) => {
  const m = /class="pill"[^>]*\/>(?:<\/g>)?<text x="([\d.]+)"[^>]*>([^<]*)</.exec(s)

  return m === null ? null : { x: num(m[1]!), text: m[2]! }
}
const ticks = (s: string) => [...s.matchAll(/class="tick" points="([\d.]+),3 ([\d.]+),8/g)].map(m => [num(m[1]!), num(m[2]!)] as const)

test('rowSvg: eight segments, the dither only on worked phases, the current chevron and the stats', async () => {
  const s = rowSvg(base, 900)
  expect(s.startsWith('<svg')).toBe(true)
  expect(s).toContain(`height="${ROW_H}"`)
  expect((s.match(/class="seg"/g) ?? []).length).toBe(8)
  expect((s.match(/<g class="dots" data-cell="(\d)"/g) ?? []).map(m => m.slice(-2, -1))).toEqual(['1', '2', '3', '4'])
  expect(s).toContain('class="pill"')
  expect(s).toContain('>5 Implement<')
  expect(s).toContain('23m/41m · ~2h10m left · 184k · R6×2')
  expect(s).toContain('data-mascot="hammer"')
  expect(s).toContain('prefers-reduced-motion')
  expect(s).toContain('#1002 full')
})

test('the bar is one length in every phase and for any stats at a given width', async () => {
  for (const W of [300, 600, 900, 1600]) {
    const widths = new Set<string>()
    for (let p = 1; p <= 8; p += 1) {
      for (const stats of ['', 'ETA —', '1h57m/30m · ~15h46m left · 971k · R6×2 · R3×4 · R2×2']) {
        const s = rowSvg(at(p, { stats }), W)
        widths.add(/<clipPath id="pc"><rect x="0" y="0" width="([\d.]+)"/.exec(s)![1]!)
      }
    }
    widths.add(String(layout({ title: base.title }, W).barW))
    expect(widths.size).toBe(1)
  }
  // Between phases keeps the same bar too: its text sits in the stats column.
  const between = rowSvg({ ...base, cells: '◆◆◇◇◇◇◇◇', current: null, pill: 'between phases', next: '', stats: 'ETA —' }, 900)
  expect(between).toContain(`width="${layout(base, 900).barW}"`)
})

test('done grows the bar into the stats column, up to its own text, with the mascot where it was', async () => {
  for (const W of [600, 900, 1600]) {
    const input: RowInput = { ...base, cells: '◆◆◆◆◆◆◆◆', current: null, pill: 'done 15d7h', next: '', stats: '', isDone: true }
    const s = rowSvg(input, W)
    const fixed = layout(base, W)
    const l = layout(input, W)
    expect(l.barW).toBeGreaterThan(fixed.barW + 100)
    expect(s).toContain(`<clipPath id="pc"><rect x="0" y="0" width="${l.barW}"`)
    // The text starts about 20 px past the bar's end and still ends against the mascot.
    const text = /<text class="m" x="([\d.]+)"/.exec(s)!
    const textX = num(text[1]!)
    const textW = l.statsW - 10
    expect(textX - textW - (l.barX + l.barW)).toBeGreaterThan(14)
    expect(textX - textW - (l.barX + l.barW)).toBeLessThan(26)
    expect(textX).toBe(num(/<text class="m" x="([\d.]+)"/.exec(rowSvg(at(5), W))![1]!))
    expect(s).toContain('>done 15d7h<')
    expect(s).toContain('data-mascot="party"')
    expect(l.barX + l.barW + 10 + l.statsW + 32).toBeLessThanOrEqual(l.W)
  }
  // Rounds and a tally after the pill still fit: the column is sized to the whole text.
  const long = rowSvg({ ...base, cells: '◆◆◆◆◆◆◆◆', current: null, pill: 'done 15d7h', next: '', stats: '971k · R6×2', isDone: true }, 900)
  expect(long).toContain('>done 15d7h · 971k · R6×2<')
})

test('the current chevron ends on its own boundary and never reaches into the next phase', async () => {
  for (let W = 1600; W >= 180; W -= 23) {
    const seg = layout(base, W).barW / 8
    for (let p = 1; p <= 8; p += 1) {
      const e = pillEdges(rowSvg(at(p), W))!
      expect(Math.abs(e.x1 - p * seg)).toBeLessThan(0.06)
      expect(e.x0).toBeGreaterThan(-0.06)
    }
    // Phase 8 ends flat at the bar's end, where the bar's round end closes it; it points nowhere.
    const last = /class="pill" points="([^"]+)"/.exec(rowSvg(at(8), W))![1]!.split(' ').map(q => Number(q.split(',')[0]))
    expect(Math.max(...last)).toBeLessThan(8 * seg + 0.06)
  }
})

test('the label is centred in the chevron', async () => {
  for (const W of [500, 900, 1400]) {
    for (let p = 1; p <= 8; p += 1) {
      const s = rowSvg(at(p), W)
      const e = pillEdges(s)!
      const t = pillText(s)!
      const inset = e.flat ? 0 : 1.5 + 5
      expect(Math.abs(t.x - (e.x0 + inset + e.x1) / 2)).toBeLessThan(0.11)
    }
  }
})

test('a long name stretches the chevron back as far as it needs; with no room at all only the number shows', async () => {
  const seg = 70
  // "5 Implement" needs about 109 px with its notch: one segment is not enough, so it reaches back into phase 4.
  const p5 = pillOf(4, '5 Implement', 5, seg)
  expect(p5.x1).toBe(5 * seg)
  expect(p5.x0).toBeLessThan(4 * seg)
  expect(p5.x0).toBeGreaterThan(3 * seg)
  expect(p5.label).toBe('5 Implement')
  // A name too long for two segments takes three, or more: there is no cap on the stretch back.
  const long = pillOf(6, '7 A much longer phase name', 7, 40)
  expect(long.x0).toBeLessThan(5 * 40)
  expect(long.label).toBe('7 A much longer phase name')
  // Phase 1 has nothing before it: a name that does not fit shows the number alone.
  expect(pillOf(0, '1 Recall', 1, 20)).toEqual({ x0: 0, x1: 20, label: '1' })
  // Phase 2 at a narrow bar: no room back to the bar's start either.
  expect(pillOf(1, '2 Research', 2, 14).label).toBe('2')
  // A name that fits its segment does not stretch.
  expect(pillOf(4, '5 Test', 5, 120)).toEqual({ x0: 480, x1: 600, label: '5 Test' })
  // In the drawing, the narrow row shows numbers.
  expect(rowSvg(at(2), 300)).toMatch(/class="pill"[^>]*\/><text[^>]*>2</)
})

test('the next phase has a ghost that strengthens from barely there to the median', async () => {
  const strength = (s: string) => num(/class="ghost" opacity="([\d.]+)"/.exec(s)![1]!)
  expect(Math.abs(strength(rowSvg({ ...base, progress: 0 }, 900)) - 0.05)).toBeLessThan(0.001)
  expect(Math.abs(strength(rowSvg({ ...base, progress: 0.5 }, 900)) - 0.3)).toBeLessThan(0.001)
  expect(Math.abs(strength(rowSvg({ ...base, progress: 1 }, 900)) - 0.55)).toBeLessThan(0.001)
  expect(Math.abs(strength(rowSvg({ ...base, progress: 3 }, 900)) - 0.55)).toBeLessThan(0.001)
  expect(Math.abs(strength(rowSvg({ ...base, progress: null }, 900)) - 0.12)).toBeLessThan(0.001)
  // It shows the next phase's name when it fits, else its number; none after phase 8 or between phases.
  expect(rowSvg(at(5), 1600)).toMatch(/class="ghost"[^]*>6 Review</)
  expect(rowSvg(at(5), 300)).toMatch(/class="ghost"[^]*?<text[^>]*>6</)
  expect(rowSvg(at(8), 900)).not.toContain('class="ghost"')
  expect(rowSvg({ ...base, cells: '◆◆◇◇◇◇◇◇', current: null, pill: 'between phases', next: '' }, 900)).not.toContain('class="ghost"')
})

test('every boundary not drawn by the chevron or the ghost has a tick, on the chevron arrow geometry', async () => {
  for (const W of [500, 900, 1600]) {
    const seg = layout(base, W).barW / 8
    for (let p = 1; p <= 8; p += 1) {
      const s = rowSvg(at(p), W)
      const e = pillEdges(s)!
      const got = ticks(s)
      for (const [a, b] of got) {
        expect(Math.abs(a - Math.round(a / seg) * seg)).toBeLessThan(0.06)
        expect(Math.abs(b - a - 5)).toBeLessThan(0.11)
      }
      const expected = [1, 2, 3, 4, 5, 6, 7].filter(k => !(k * seg >= e.x0 - 1 && k * seg <= e.x1 + 6) && !(p < 8 && k === p + 1))
      expect(got.map(([a]) => Math.round(a / seg))).toEqual(expected)
    }
  }
  const none = rowSvg({ ...base, cells: '◆◆◇◇◇◇◇◇', current: null, pill: 'between phases', next: '' }, 900)
  expect(ticks(none).length).toBe(7)
})

/** The tail's dot columns, one per column group: its x, fade, pulse band, delay and dot count. */
const columnsOf = (s: string) =>
  [...s.matchAll(/<g class="w (w\d)" fill-opacity="([\d.]+)" style="animation-delay:(-[\d.]+)s">((?:<rect[^>]*\/>)*)<\/g>/g)]
    .map(m => ({ band: m[1]!, fade: num(m[2]!), delay: num(m[3]!), dots: (m[4]!.match(/<rect/g) ?? []).length, x: num(/x="([\d.]+)"/.exec(m[4]!)![1]!) }))
    .sort((a, b) => a.x - b.x)
/** Mean dots per column over the columns with x in [from, to). */
const meanDots = (cols: ReturnType<typeof columnsOf>, from: number, to: number) => {
  const xs = new Map<number, number>()
  for (const c of cols) if (c.x >= from && c.x < to) xs.set(c.x, Math.max(xs.get(c.x) ?? 0, c.dots))
  return [...xs.values()].reduce((a, b) => a + b, 0) / Math.max(1, Math.round((to - from) / 3))
}

test('the tail is dense and bold right behind the chevron, thins further back, and pulses back from it', async () => {
  const s = rowSvg(at(8), 1400)
  const cols = columnsOf(s)
  const seg = layout(base, 1400).barW / 8
  expect(cols.length).toBeGreaterThan(30)
  // Fades fall going back from the chevron.
  for (let k = 1; k < cols.length; k += 1) expect(cols[k]!.fade).toBeGreaterThanOrEqual(cols[k - 1]!.fade)
  expect(cols[0]!.fade).toBeLessThan(0.4)
  expect(cols[cols.length - 1]!.fade).toBeGreaterThan(0.9)
  // More dots right behind the chevron than at the start.
  const pill = /class="pill" points="([\d.]+)/.exec(s)!
  const edge = num(pill[1]!)
  expect(meanDots(cols, edge - seg, edge)).toBeGreaterThan(4)
  expect(meanDots(cols, 0, seg)).toBeLessThan(2)
  // The pulse dims the far tail more than the dots right behind the chevron.
  expect(cols[cols.length - 1]!.band).toBe('w0')
  expect(cols[0]!.band).toBe('w2')
  expect(s).toMatch(/@keyframes pw0\{0%\{opacity:1\}22%,100%\{opacity:\.85\}\}/)
  // Delays are steady-state (negative, within one period) and differ along the tail: a travelling pulse.
  expect(cols.every(c => c.delay <= 0 && c.delay >= -2.4)).toBe(true)
  expect(new Set(cols.map(c => c.delay)).size).toBeGreaterThan(10)
  // Each column's delay follows its distance behind the chevron at 160 px/s, ragged by at most ±0.25 s.
  for (const c of cols) {
    const lag = (edge - c.x) / 160
    const off = (((-c.delay - (2.4 - (lag % 2.4))) % 2.4) + 3.6) % 2.4 - 1.2
    expect(Math.abs(off)).toBeLessThan(0.27)
  }
  expect(s).toMatch(/prefers-reduced-motion: reduce\)\{[^}]*\.w\{animation:none\}/)
})

test('later phases trail a longer tail', async () => {
  // Three segments behind the chevron, phase 8's tail is bolder than phase 5's, and keeps more dots
  // over everything two or more segments back.
  const seg = layout(base, 1400).barW / 8
  const tailOf = (p: number) => {
    const cols = columnsOf(rowSvg(at(p, { pill: String(p) }), 1400))
    const edge = (p - 1) * seg
    const at3 = cols.filter(c => c.x >= edge - 3 * seg && c.x < edge - 2.5 * seg)
    return {
      fade: at3.reduce((a, c) => a + c.fade, 0) / at3.length,
      far: meanDots(cols, edge - 4 * seg, edge - 2 * seg),
    }
  }
  expect(tailOf(8).fade).toBeGreaterThan(tailOf(5).fade + 0.05)
  expect(tailOf(8).far).toBeGreaterThan(tailOf(5).far)
})

test('the dots run right up to the chevron, with no gap before it', async () => {
  for (const W of [700, 1000, 1400]) {
    const seg = layout(base, W).barW / 8
    for (let p = 2; p <= 8; p += 1) {
      const s = rowSvg(at(p, { pill: String(p) }), W)
      const last = Math.max(...columnsOf(s).map(c => c.x))
      // The column nearest the chevron reaches into the previous phase's arrow tip.
      expect(last + 2).toBeGreaterThan((p - 1) * seg + 1.5)
    }
  }
})

test('each dot blinks on one of many rhythms, some fading almost out', async () => {
  const s = rowSvg(at(8), 1400)
  const classes = new Set([...s.matchAll(/<rect class="(t\d+)"/g)].map(m => m[1]))
  expect(classes.size).toBeGreaterThanOrEqual(10)
  expect(s).toContain('@keyframes ptx{0%,100%{opacity:1}40%,55%{opacity:.08}}')
  expect(s).toMatch(/prefers-reduced-motion: reduce\)\{\.t0,\.t1,[^}]*\.t11,\.w\{animation:none\}/)
})

test('labels get room: a name shows only with padding around it, never edge to edge', async () => {
  // "8 Compound" at 11 px bold is about 68 px; with 24 px of padding and its notch it needs about 99 px.
  const p = pillOf(7, '8 Compound', 8, 200)
  expect(p.x1 - p.x0).toBe(200)
  const tight = pillOf(7, '8 Compound', 8, 90)
  expect(tight.x1 - tight.x0).toBeGreaterThan(95)
  // The ghost drops to its number rather than squeezing its name.
  expect(rowSvg(at(7), 760)).toMatch(/class="ghost"[^]*?<text[^>]*>8</)
})

test('a fresh enter slides the chevron in; an old one, or phase 1, does not', async () => {
  const fresh = rowSvg(at(6, { enteredAgoMs: 0 }), 900)
  expect(fresh).toContain('<g class="slide"><polygon class="pill"')
  expect(fresh).toContain('@keyframes ps')
  expect(fresh).toContain('animation:ps 0.55s cubic-bezier(.2,.8,.2,1) 0.00s both')
  // A redraw 1.5 s later lands mid-slide via its negative delay.
  expect(rowSvg(at(6, { enteredAgoMs: 1500 }), 900)).toContain('-1.50s both')
  expect(rowSvg(at(6, { enteredAgoMs: 60_000 }), 900)).not.toContain('class="slide"')
  expect(rowSvg(at(6, { enteredAgoMs: null }), 900)).not.toContain('class="slide"')
  expect(rowSvg(at(1, { enteredAgoMs: 0 }), 900)).not.toContain('class="slide"')
})

test('between phases and done draw no chevron; their text leads the stats column; done sits green', async () => {
  const between = rowSvg({ ...base, cells: '◇◆◇◇◇◇◇◇', current: null, pill: 'between phases', next: '', color: 'gray', stats: 'ETA —' }, 900)
  expect(between).not.toContain('class="pill"')
  expect(between).toContain('>between phases · ETA —<')
  expect(between).toContain('data-mascot="thinking-dots"')
  const done = rowSvg({ ...base, cells: '◆◆◆◆◆◆◆◆', current: null, pill: 'done 3h0m', next: '', color: 'gray', stats: '', isDone: true }, 900)
  expect(done).toContain('fill="#5fbf8f"')
  expect(done).toContain('>done 3h0m<')
  expect(done).toContain('data-mascot="party"')
})

/** The done field's dots and sparks: x, y and the classes of each; one path per class pair holds many. */
const fieldOf = (s: string, group: 'dots done' | 'sparks') => {
  const g = new RegExp(`<g class="${group}"[^>]*>((?:<path[^>]*/>)*)</g>`).exec(s)
  if (g === null) return []
  return [...g[1]!.matchAll(/<path class="([^"]+)" d="([^"]+)"/g)].flatMap(m =>
    [...m[2]!.matchAll(/M([\d.]+) ([\d.]+)/g)].map(d => ({ classes: m[1]!.split(' '), x: num(d[1]!), y: num(d[2]!) })),
  )
}

test('done fills the whole bar at one density, no tail, no fade, no ticks, whatever was entered', async () => {
  for (const cells of ['◆◆◆◆◆◆◆◆', '◆◇◇◇◇◇◇◆']) {
    const input: RowInput = { ...base, cells, current: null, pill: 'done 3h0m', next: '', color: 'gray', stats: '', isDone: true }
    const s = rowSvg(input, 1400)
    const { barW } = layout(input, 1400)
    const seg = barW / 8
    const dots = fieldOf(s, 'dots done')
    // One field, not per-phase groups; no column fades, no pulse bands, no boundary ticks.
    expect(s).not.toContain('data-cell=')
    expect(s).not.toContain('fill-opacity=')
    expect(s).not.toContain('class="w ')
    expect(s).not.toContain('class="tick"')
    // Dots from the first column to the last.
    expect(Math.min(...dots.map(d => d.x))).toBeLessThan(4)
    expect(Math.max(...dots.map(d => d.x))).toBeGreaterThan(barW - 4)
    // The same density in every segment: about 4 of 5 rows per column, start and end alike.
    const perColumn = (from: number, to: number) => dots.filter(d => d.x >= from && d.x < to).length / ((to - from) / 3)
    for (let k = 0; k < 8; k += 1) {
      expect(perColumn(k * seg, (k + 1) * seg)).toBeGreaterThan(3.3)
      expect(perColumn(k * seg, (k + 1) * seg)).toBeLessThan(4.7)
    }
  }
})

test('done: every dot flashes on its own rhythm and start, and bright sparks pop all over the bar', async () => {
  const input: RowInput = { ...base, cells: '◆◆◆◆◆◆◆◆', current: null, pill: 'done 3h0m', next: '', color: 'gray', stats: '', isDone: true }
  const s = rowSvg(input, 1400)
  const { barW } = layout(input, 1400)
  const dots = fieldOf(s, 'dots done')
  const sparks = fieldOf(s, 'sparks')
  // Rhythm and start are two independent picks: many of each, and many combinations.
  expect(new Set(dots.map(d => d.classes[0])).size).toBeGreaterThanOrEqual(12)
  expect(new Set(dots.map(d => d.classes[1])).size).toBeGreaterThanOrEqual(16)
  expect(new Set(dots.map(d => d.classes.join(' '))).size).toBeGreaterThan(150)
  // Three flash shapes, a sharp one among them, each class on a beat of its own.
  expect(s).toContain('@keyframes pfa{0%,100%{opacity:.4}5%,12%{opacity:1}}')
  expect(s).toMatch(/\.f0\{animation:pfa 1\.3s linear infinite\}/)
  expect(s).toMatch(/\.d3\{animation-delay:-0\.92s\}/)
  // The delay classes come after the shorthands, so they win.
  expect(s.indexOf('.d0{')).toBeGreaterThan(s.indexOf('.s11{'))
  // Sparks: a bright, larger square over some dots, from nothing to full and back, spread across the bar.
  expect(sparks.length).toBeGreaterThan(dots.length * 0.1)
  expect(sparks.length).toBeLessThan(dots.length * 0.25)
  expect(sparks.every(k => k.classes[0] === 'sp' && /^s\d+$/.test(k.classes[1]!) && /^d\d+$/.test(k.classes[2]!))).toBe(true)
  expect(new Set(sparks.map(k => k.classes[1])).size).toBeGreaterThanOrEqual(12)
  expect(new Set(sparks.map(k => k.classes[2])).size).toBeGreaterThanOrEqual(16)
  expect(s).toContain('<g class="sparks" fill="#e6fff0">')
  expect(s).toMatch(/<path class="sp s\d+ d\d+" d="M[\d.]+ [\d.]+h3v3h-3z/)
  expect(s).toContain('.sp{opacity:0}')
  expect(s).toContain('@keyframes psk{0%,100%{opacity:0}3%,9%{opacity:1}}')
  const seg = barW / 8
  for (let k = 0; k < 8; k += 1) expect(sparks.filter(one => one.x >= k * seg && one.x < (k + 1) * seg).length).toBeGreaterThan(10)
  // Every beat stops under reduced motion, which leaves the dots lit and the sparks hidden.
  expect(s).toMatch(/prefers-reduced-motion: reduce\)\{\.f0,\.f1,[^}]*\.s11\{animation:none\}/)
  // The field is the done row's alone.
  expect(rowSvg(at(8), 1400)).not.toContain('class="sparks"')
  expect(rowSvg(at(8), 1400)).not.toContain('@keyframes pfa')
  expect(rowSvg({ ...base, cells: '◆◆◇◇◇◇◇◇', current: null, pill: 'between phases', next: '' }, 1400)).not.toContain('class="sparks"')
})

test('rowSvg escapes the title, labels and stats', async () => {
  const s = rowSvg({ ...base, title: 'a<b & "c"', pill: 'x>y', next: '6 <R>', stats: 'a & b' }, 1600)
  expect(s).toContain('a&lt;b &amp; &quot;c&quot;')
  expect(s).toContain('>x&gt;y<')
  expect(s).toContain('a &amp; b')
  expect(s).not.toContain('a<b')
  expect(s).not.toContain('a & b')
})

test('layout: the title is cut at 40 % of W, and the degrade order is stats, Clawd, then the title share', async () => {
  const wide = layout({ title: 'a very long ticket title that will not fit in the share it is given' }, 900)
  expect(wide.title.endsWith('…')).toBe(true)
  expect(wide.showStats && wide.showCrab).toBe(true)
  const order: string[] = []
  let last = { showStats: true, showCrab: true }
  for (let W = 900; W >= 180; W -= 10) {
    const l = layout(base, W)
    expect(l.barW).toBeGreaterThanOrEqual(BAR_MIN)
    if (last.showStats && !l.showStats) order.push('stats')
    if (last.showCrab && !l.showCrab) order.push('crab')
    expect(l.showCrab || !l.showStats).toBe(true)
    last = l
  }
  expect(order).toEqual(['stats', 'crab'])
  expect(layout(base, 180).W).toBe(180)
  expect(layout(base, 5000).W).toBe(1600)
})

test('rowSvg stays under the source cap at the widest row, and never draws past its width', async () => {
  expect(rowSvg(at(8), 1600).length).toBeLessThan(131072)
  expect(rowSvg({ ...base, cells: '◆◆◆◆◆◆◆◆', current: null, pill: 'done 15d7h', next: '', stats: '', isDone: true }, 1600).length).toBeLessThan(131072)
  for (let W = 1600; W >= 180; W -= 20) {
    const l = layout(base, W)
    expect(l.barX + l.barW + 10 + (l.showStats ? l.statsW : 0) + (l.showCrab ? 32 : 0)).toBeLessThanOrEqual(l.W)
  }
})

test('the mascot follows the phase: a prop per phase, thinking between phases, a party when done', async () => {
  const names = ['wizard-hat', 'magnifier', 'clipboard', 'flask', 'hammer', 'reading-glasses', 'rocket', 'checkered-flag']
  for (let p = 1; p <= 8; p += 1) {
    const s = rowSvg(at(p), 900)
    expect(s).toContain(`<g class="mascot" data-mascot="${names[p - 1]}"`)
    expect(s).toContain(`<g class="mz mz-${names[p - 1]} run">`)
    expect((s.match(/class="mascot"/g) ?? []).length).toBe(1)
    // Original pixel art only: no embedded images.
    expect(s).not.toContain('<image')
  }
  // Compound waves the checkered flag at the finish line.
  const flag = rowSvg(at(8), 900)
  expect(flag).toMatch(/<g class="flag">(<rect[^>]*fill="#1F1E1D"\/>.*){2}/)
  expect(flag).toContain('.mz-checkered-flag .flag{transform-origin:0 50%;animation:mwave')
  // Between phases and done stand still; done is tinted green.
  const done = rowSvg({ ...base, cells: '◆◆◆◆◆◆◆◆', current: null, pill: 'done 3h0m', next: '', isDone: true }, 900)
  expect(done).toContain('<g class="mz mz-party">')
  expect(done).toContain('fill="#5fbf8f"')
  expect(rowSvg({ ...base, cells: '◆◆◇◇◇◇◇◇', current: null, pill: 'between phases', next: '' }, 900)).toContain('<g class="mz mz-thinking-dots">')
  // The mascot fills the row's height: about 21 of its 22 px.
  expect(flag).toMatch(/data-mascot="checkered-flag" transform="translate\([\d.]+,[\d.]+\) scale\(0\.88\)"/)
  // Every state stays under the Svg source cap at the widest row.
  for (let p = 1; p <= 8; p += 1) expect(rowSvg(at(p), 1600).length).toBeLessThan(131072)
  // A row too narrow for it drops the mascot like it dropped the Clawd.
  expect(rowSvg(at(5), 180)).not.toContain('class="mascot"')
})
