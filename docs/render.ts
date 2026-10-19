// Renders the README pictures from the mods' own drawing code, so a picture can
// never drift from what the desktop app shows. Run docs/render.sh after any
// change to a sprite, a row layout or a color; it rewrites <mod>/docs/*.svg.
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { AgentRun } from '../agents-panel/types'
import { costumeOf, totals } from '../agents-panel/hooks/agents'
import { bandSvg, cardSvg, headerSvg, stripSvg } from '../agents-panel/hooks/draw'
import type { Costume } from '../agents-panel/hooks/sprite'
import { CLAWD_CSS, clawd } from '../agents-panel/hooks/sprite'
import type { MascotKey } from '../ticket-phase/hooks/mascot'
import { MASCOT_CSS, MASCOT_NAMES, MASCOT_W, mascot } from '../ticket-phase/hooks/mascot'
import type { RowInput } from '../ticket-phase/hooks/row'
import { ROW_H, rowSvg } from '../ticket-phase/hooks/row'
import { FILLS, barSvg, heartSvg } from '../usage-hp/hooks/register'

const ROOT = process.argv[2]!
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const MONO = "ui-monospace,'SF Mono',Menlo,monospace"
/** Label and dim text that follow the viewer's light or dark scheme. */
const TEXT_CSS =
  '<style>.lb{fill:#1f1f1f}.dm{fill:#6b6b68}' +
  '@media (prefers-color-scheme: dark){.lb{fill:#ececec}.dm{fill:#a8a8a4}}</style>'

/**
 * An SVG's dark rules sit in `@media (prefers-color-scheme: dark){…}`, which an
 * <img> resolves against the OS, not GitHub's theme: a dark OS on a light
 * GitHub would draw light text on white. So each picture is written twice,
 * the scheme baked in, and the README picks one with <picture>.
 */
const DARK = '@media (prefers-color-scheme: dark){'
const bake = (svg: string, isDark: boolean): string => {
  let out = ''
  let at = 0
  for (let i = svg.indexOf(DARK); i >= 0; i = svg.indexOf(DARK, at)) {
    let depth = 1
    let j = i + DARK.length
    for (; depth > 0; j++) depth += svg[j] === '{' ? 1 : svg[j] === '}' ? -1 : 0
    out += svg.slice(at, i) + (isDark ? svg.slice(i + DARK.length, j - 1) : '')
    at = j
  }
  return out + svg.slice(at)
}
const write = (rel: string, svg: string): void => {
  const path = join(ROOT, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${bake(svg, false)}\n`)
  writeFileSync(path.replace(/\.svg$/, '-dark.svg'), `${bake(svg, true)}\n`)
  console.log(`wrote ${rel} and its -dark twin`)
}
/** One picture made of whole SVG documents stacked at the given offsets. */
const stack = (W: number, H: number, parts: [number, number, string][], extra = ''): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${extra}` +
  parts.map(([x, y, s]) => s.replace(/^<svg /, `<svg x="${x}" y="${y}" `)).join('') +
  '</svg>'
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── agents-panel ───────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 9, 19, 15, 0)
const run = (id: string, over: Partial<AgentRun>): AgentRun => ({
  id,
  type: 'general-purpose',
  description: id,
  model: 'claude-opus-5-5',
  status: 'running',
  startedAt: NOW - 60_000,
  contextTokens: 0,
  tokens: 0,
  steps: 4,
  ...over,
})
const SESSION = { model: 'claude-opus-5-5', window: 200_000 }
const agents: AgentRun[] = [
  run('Find where the band row is drawn', { type: 'Explore', model: 'claude-haiku-5-5', startedAt: NOW - 134_000, contextTokens: 41_000, tokens: 118_000 }),
  run('Plan the settings migration', { type: 'Plan', effort: 'high', startedAt: NOW - 71_000, contextTokens: 64_000, tokens: 152_000 }),
  run('Second-opinion review of the diff', { type: 'codex:codex-rescue', model: 'gpt-5.4', startedAt: NOW - 48_000, contextTokens: 0, tokens: 0, steps: 0 }),
  run('Audit README example rows', { variant: 2, status: 'done', startedAt: NOW - 400_000, endedAt: NOW - 210_000, contextTokens: 82_000, tokens: 196_000 }),
  run('Check the cache countdown', { type: 'claude-code-guide', model: 'claude-sonnet-5-5', status: 'failed', startedAt: NOW - 500_000, endedAt: NOW - 470_000, contextTokens: 12_000, tokens: 30_000 }),
]
const running = agents.filter(a => a.status === 'running')
write('agents-panel/docs/band.svg', bandSvg(560, running, NOW))

const W = 420
const t = totals(agents, NOW)
const cards = agents.map((a, i): [number, number, string] => [0, 52 + i * 70, cardSvg(W, a, NOW, SESSION)])
write('agents-panel/docs/pane.svg', stack(W, 52 + agents.length * 70, [[0, 0, headerSvg(W, t)], ...cards]))
write('agents-panel/docs/pane-collapsed.svg', stripSvg(W, agents, t))

const COSTUMES: [Costume, string][] = [
  ['plain', 'plain'],
  ['pirate', 'pirate'],
  ['detective', 'detective'],
  ['engineer', 'engineer'],
  ['chef', 'chef'],
  ['codex', 'Codex'],
  ['panda', 'Kimi'],
  ['gemini', 'Gemini'],
  ['grok', 'Grok'],
  ['composer', 'Composer'],
]
const CELL = 64
write(
  'agents-panel/docs/costumes.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="${COSTUMES.length * CELL}" height="58" viewBox="0 0 ${COSTUMES.length * CELL} 58">${TEXT_CSS}${CLAWD_CSS}` +
    COSTUMES.map(([c, label], i) => {
      const x = i * CELL
      return (
        clawd(x + (CELL - 26 * 1.1) / 2, 2, c, { isWalking: true }) +
        `<text class="dm" x="${x + CELL / 2}" y="52" text-anchor="middle" font-family="${FONT}" font-size="11">${esc(label)}</text>`
      )
    }).join('') +
    '</svg>',
)
// The labels above say which agent types wear which costume; keep them true.
for (const [type, want] of [['Explore', 'pirate'], ['Plan', 'engineer'], ['claude-code-guide', 'chef'], ['codex:codex-rescue', 'codex'], ['buddy:kimi-k3', 'panda'], ['buddy:gemini-3', 'gemini'], ['buddy:grok-5', 'grok'], ['buddy:composer-2', 'composer']] as const) {
  if (costumeOf(type) !== want) throw new Error(`costumeOf(${type}) is ${costumeOf(type)}, not ${want}: fix the costume labels`)
}

// ── ticket-phase ───────────────────────────────────────────────────────────
const phase: RowInput = {
  title: '#12345 full',
  cells: '◆◆◆◆◈◇◇◇',
  current: 5,
  pill: '5 Implement',
  next: '6 Review',
  color: 'green',
  stats: '23m/41m · ~2h10m left · 184k · R6×2',
  progress: 0.56,
  enteredAgoMs: 23 * 60_000,
  isDone: false,
}
const RW = 760
write('ticket-phase/docs/row.svg', rowSvg(phase, RW))
write('ticket-phase/docs/row-slow.svg', rowSvg({ ...phase, color: 'yellow', stats: '52m/41m · ~1h52m left · 231k · R6×2', progress: 1.27 }, RW))
write('ticket-phase/docs/row-done.svg', rowSvg({ ...phase, cells: '◆◆◆◆◆◆◆◆', current: null, pill: 'done 3h0m', next: '', stats: '', progress: null, enteredAgoMs: null, isDone: true }, RW))

const KEYS: MascotKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', 'between', 'done']
const MCELL = 96
write(
  'ticket-phase/docs/mascots.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="${KEYS.length * MCELL}" height="56" viewBox="0 0 ${KEYS.length * MCELL} 56">${TEXT_CSS}<style>${MASCOT_CSS}</style>` +
    KEYS.map((k, i) => {
      const x = i * MCELL
      return (
        mascot(k, x + (MCELL - MASCOT_W) / 2, 4, { isWalking: k !== 'done', isDone: k === 'done' }) +
        `<text class="dm" x="${x + MCELL / 2}" y="50" text-anchor="middle" font-family="${FONT}" font-size="10">${esc(k.length === 1 ? `${k} ${MASCOT_NAMES[k]}` : MASCOT_NAMES[k])}</text>`
      )
    }).join('') +
    '</svg>',
)

// ── usage-hp ───────────────────────────────────────────────────────────────
// The desktop row is a heart and a bar the mod draws as SVG, between text the
// app sets in its monospace face; that text is set here the same way, with the
// mod's own rules: 5H/7D on a subscription, SPEND alone on a capped seat, the
// color by what is left (over 50 green, over 20 yellow), a quarter-heart per
// 25%, a cell per 5%, and the shared footer line beneath.
type Bar = { label: string; left: number; range?: [number, number]; detail: string }
type Footer = { lead: string; dim: string }
const CH = 7.8
const UW = 720
const usageRows = (bars: Bar[], footer: Footer): string => {
  const width = Math.max(...bars.map(b => b.label.length))
  const colorOf = (left: number): keyof typeof FILLS => (left > 50 ? 'green' : left > 20 ? 'yellow' : 'red')
  const rows = bars.map((b, i): string => {
    const y = i * 22
    const fill = FILLS[colorOf(b.left)]
    const quarters = Math.max(1, Math.min(4, Math.ceil(b.left / 25)))
    let full = Math.max(1, Math.round((b.left / 100) * 20))
    let ghost = 0
    let percent = `${Math.round(b.left)}%`.padStart(4)
    if (b.range !== undefined) {
      full = Math.min(19, Math.floor((b.range[0] / 100) * 20))
      ghost = Math.max(1, Math.ceil((b.range[1] / 100) * 20) - full)
      percent = `${Math.floor(b.range[0])}–${Math.ceil(b.range[1])}%`
    }
    const label = ` ${b.label.padEnd(width)}  `
    const barX = 14 + label.length * CH
    return (
      heartSvg(quarters, fill).replace(/^<svg /, `<svg x="0" y="${y + 3}" `) +
      `<text x="14" y="${y + 15}" font-family="${MONO}" font-size="13" font-weight="700" fill="${fill}" xml:space="preserve">${esc(label)}</text>` +
      barSvg(full, fill, ghost).replace(/^<svg /, `<svg x="${barX}" y="${y + 6}" `) +
      `<text x="${barX + 139}" y="${y + 15}" font-family="${MONO}" font-size="13" xml:space="preserve"><tspan font-weight="700" fill="${fill}">${esc(` ${percent}`)}</tspan><tspan fill="${fill}"> left</tspan><tspan class="dm">${esc(b.detail)}</tspan></text>`
    )
  })
  const fy = bars.length * 22
  const indent = 14 + (width + 3) * CH
  rows.push(
    `<text x="${indent}" y="${fy + 15}" font-family="${MONO}" font-size="13" xml:space="preserve"><tspan class="lb" font-weight="700">${esc(footer.lead)}</tspan><tspan class="dm">${esc(footer.dim)}</tspan></text>`,
  )
  const H = fy + 22
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${UW}" height="${H}" viewBox="0 0 ${UW} ${H}">${TEXT_CSS}${rows.join('')}</svg>`
}
write(
  'usage-hp/docs/subscription.svg',
  usageRows(
    [
      { label: '5H', left: 62, detail: ' · resets in 2h 14m · lasts past reset' },
      { label: '7D', left: 34, detail: ' · resets in 4d · empty in ~2d 9h at this pace' },
    ],
    { lead: '$0.30 this session', dim: '' },
  ),
)
write(
  'usage-hp/docs/spend.svg',
  usageRows(
    [{ label: 'SPEND', left: 82, range: [82, 85], detail: ' · $246–255 left of $300' }],
    { lead: '$0.27 this session (~$0.26 billed)', dim: ' · lasts past reset · resets in 12d · synced 5d 2h ago (Oct 14 08:43)' },
  ),
)

void ROW_H
