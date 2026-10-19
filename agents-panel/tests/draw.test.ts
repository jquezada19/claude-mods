import { expect, test } from 'claude-code/testing'

import type { AgentRun } from '../types'
import {
  BAND_H,
  CARD_H,
  bandCrabCount,
  bandSvg,
  bandText,
  cardAlt,
  cardMeta,
  cardStats,
  cardSvg,
  fitText,
  headerSvg,
  headerText,
  stripSvg,
  textWidth,
  xml,
} from '../hooks/draw'

const T0 = 1_000_000
const row = (id: string, over: Partial<AgentRun> = {}): AgentRun => ({
  id,
  type: 'general-purpose',
  description: `task ${id}`,
  model: 'claude-opus-5-5',
  status: 'running',
  startedAt: T0,
  contextTokens: 0,
  tokens: 0,
  steps: 0,
  ...over,
})
const SESSION = { model: 'claude-opus-5-5', window: 200_000 }

test('xml escapes the four characters and nothing else', async () => {
  expect(xml('a<b && c="d">')).toBe('a&lt;b &amp;&amp; c=&quot;d&quot;&gt;')
  expect(xml('plain · text')).toBe('plain · text')
})

test('textWidth and fitText are deterministic and cut with an ellipsis', async () => {
  expect(textWidth('', 13)).toBe(0)
  expect(textWidth('iii', 10)).toBeLessThan(textWidth('WWW', 10))
  expect(fitText('short', 13, 1000)).toBe('short')
  const cut = fitText('a rather long description of a task', 13, 60)
  expect(cut.endsWith('…')).toBe(true)
  expect(textWidth(cut, 13)).toBeLessThanOrEqual(60)
})

test('card text: stats, meta and alt, with a lost row showing dashes', async () => {
  const a = row('a', { contextTokens: 82_000, tokens: 196_000, effort: 'high', endedAt: T0 + 19_000, status: 'done' })
  expect(cardStats(a, T0 + 99_000, SESSION)).toBe('ctx 41% · 82k · 196k · 0:19')
  expect(cardStats({ ...a, model: 'claude-sonnet-5-5' }, T0 + 99_000, SESSION)).toBe('ctx 82k · 196k · 0:19')
  expect(cardStats(row('l', { status: 'lost', endedAt: T0 + 60_000 }), T0 + 99_000, SESSION)).toBe('— · — · 1:00')
  expect(cardMeta(a)).toBe('general-purpose · Opus 5.5 · high')
  expect(cardMeta(row('b', { type: 'codex:codex-rescue' }))).toBe('codex-rescue · Opus 5.5')
  const kimi = row('k', { type: 'buddy:kimi-k3-high', model: 'kimi-k3-high', external: { doneFile: null, deadline: null } })
  expect(cardStats(kimi, T0 + 5_000, SESSION)).toBe('— · — · 0:05')
  expect(cardMeta(kimi)).toBe('kimi-k3-high · kimi-k3-high')
  expect(cardAlt(a, T0 + 99_000, SESSION)).toBe('task a: general-purpose · Opus 5.5 · high, done, ctx 41% · 82k · 196k · 0:19')
  // A running row the engine reports waiting, idle or pending says so after its time.
  const parked = row('w', { contextTokens: 82_000, tokens: 196_000, engineStatus: 'waiting' })
  expect(cardStats(parked, T0 + 19_000, SESSION)).toBe('ctx 41% · 82k · 196k · 0:19 · waiting')
  // A run cut off at the output limit says so without opening the card.
  const cut = row('c', { contextTokens: 82_000, tokens: 196_000, status: 'done', endedAt: T0 + 19_000, detail: { isCutOff: true } })
  expect(cardStats(cut, T0 + 99_000, SESSION)).toBe('ctx 41% · 82k · 196k · 0:19 · cut off')
  // Permission asks and denials, and a card waiting on an approval.
  const asked = row('p', { contextTokens: 82_000, tokens: 196_000, checks: { asked: 2, denied: 1 }, pending: ['c1'] })
  expect(cardStats(asked, T0 + 19_000, SESSION)).toBe('ctx 41% · 82k · 196k · 0:19 · 2 asked · 1 denied · awaiting approval')
  expect(cardStats(row('q', { checks: { asked: 1, denied: 0 } }), T0 + 5_000, null)).toBe('ctx 0 · 0 · 0:05 · 1 asked')
})

test('header and band text', async () => {
  expect(headerText({ agents: 3, tokens: 412_000, time: 134_000 })).toBe('3 agents · 412k · 2:14')
  const running = [row('a', { tokens: 400_000 }), row('b', { tokens: 12_000, startedAt: T0 + 60_000 })]
  expect(bandText(running, T0 + 134_000)).toBe('2 running · 412k · 2:14')
  // 2026-10-12: a lone background Codex run read `1 running · 0 · 0:00`; its tokens are unknown, not 0
  const codex = row('c', { type: 'codex:exec', model: 'codex', external: { doneFile: null, deadline: null } })
  expect(bandText([codex], T0 + 134_000)).toBe('1 running · — · 2:14')
  expect(headerText({ agents: 1, tokens: null, time: 5_000 })).toBe('1 agent · — · 0:05')
  expect(headerSvg(600, { agents: 1, tokens: null, time: 5_000 })).toContain('>—</text>')
  // a known figure beside an external row still shows
  expect(bandText([codex, running[0]!], T0 + 134_000)).toBe('2 running · 400k · 2:14')
})

test('bandCrabCount fits the width: one at 180, six at 1600, never more than running', async () => {
  expect(bandCrabCount(180, 8)).toBe(1)
  expect(bandCrabCount(400, 8)).toBe(6)
  expect(bandCrabCount(1600, 8)).toBe(6)
  expect(bandCrabCount(1600, 2)).toBe(2)
  expect(bandCrabCount(180, 0)).toBe(0)
})

test('svg builders: escaped text, sizes, Clawd classes, the +n overflow, and the size cap', async () => {
  const a = row('a', { description: 'fix a<b && c', type: 'Explore' })
  const card = cardSvg(600, a, T0 + 1000, SESSION)
  expect(card.startsWith('<svg')).toBe(true)
  expect(card).toContain('height="66"')
  expect(card).toContain('fix a&lt;b &amp;&amp; c')
  expect(card).not.toContain('a<b')
  expect(card).toContain('class="c-pirate run"')
  expect(cardSvg(600, { ...a, status: 'done' }, T0, SESSION)).toContain('class="c-pirate"')
  expect(CARD_H).toBe(66)
  const head = headerSvg(600, { agents: 2, tokens: 1000, time: 1000 })
  expect(head).toContain('2')
  expect(head).toContain('1k')
  const eight = Array.from({ length: 8 }, (_, i) => row(`r${i}`))
  const band = bandSvg(400, eight, T0 + 1000)
  expect((band.match(/class="c-plain run"/g) ?? []).length).toBe(6)
  expect(band).toContain('+2')
  expect(band).toContain('height="22"')
  expect(BAND_H).toBe(22)
  expect(bandSvg(1600, eight, T0).length).toBeLessThan(131072)
  expect(bandSvg(180, eight, T0)).toContain('+7')
  const strip = stripSvg(600, Array.from({ length: 15 }, (_, i) => row(`s${i}`)), { agents: 15, tokens: 0, time: 0 })
  expect((strip.match(/class="c-plain/g) ?? []).length).toBe(6)
  expect(strip).toContain('+9')
})

test('review: every Svg stays under the 131072-character cap, and the card escapes its meta line', async () => {
  const detectives = Array.from({ length: 12 }, (_, i) => row(`d${i}`, { type: 'codex:codex-rescue' }))
  expect(stripSvg(900, detectives, { agents: 12, tokens: 0, time: 0 }).length).toBeLessThan(131072)
  expect(bandSvg(1600, detectives.slice(0, 8), T0).length).toBeLessThan(131072)
  const huge = row('h', { type: 'x'.repeat(131072), model: 'm'.repeat(5000), effort: 'e'.repeat(5000), description: 'd'.repeat(200000) })
  expect(cardSvg(900, huge, T0, SESSION).length).toBeLessThan(131072)
  const meta = cardSvg(600, row('m', { type: 'a<b', model: 'claude-x&y', effort: '"high"' }), T0, SESSION)
  expect(meta).toContain('a&lt;b')
  expect(meta).toContain('x&amp;y')
  expect(meta).toContain('&quot;high&quot;')
  expect(meta).not.toContain('"high"<')
})
