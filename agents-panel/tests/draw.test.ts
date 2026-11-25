import { expect, test } from 'claude-code/testing'

import type { AgentRun } from '../types'
import { BAND_H, CARD_BAR_H, CARD_FLAT_H, CARD_GAP, bandCrabCount, bandSvg, bandText, cardAlt, cardHeight, cardMeta, cardReadout, cardStats, cardSvg, fitText, headerHeight, headerSvg, headerText, stripSvg, textWidth, usageEntries, xml, cardsWithin, hasDetail, CARD_FOOT_H, finishedGroups, finishedSvg, finishedHeight, finishedAlt, groupLine, wrapText, MAX_GROUPS } from '../hooks/draw'

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

test('card text: labelled figures, meta and alt; no dashes for what is unknown', async () => {
  const a = row('a', { contextTokens: 82_000, tokens: 196_000, effort: 'high', endedAt: T0 + 19_000, status: 'done' })
  expect(cardStats(a, T0 + 99_000, SESSION)).toBe('196k tokens · ctx 41% · 0:19 elapsed')
  expect(cardStats({ ...a, model: 'claude-sonnet-5-5' }, T0 + 99_000, SESSION)).toBe('196k tokens · 0:19 elapsed')
  expect(cardStats(row('l', { status: 'lost', endedAt: T0 + 60_000 }), T0 + 99_000, SESSION)).toBe('No report received · 1:00 elapsed')
  expect(cardMeta(a)).toBe('general-purpose · Opus 5.5 · high')
  // an agent type the engine never bounds is cut at 48 characters, so one card stays under the Svg cap
  const long = cardMeta(row('long', { type: `plugin:${'t'.repeat(100)}` })).split(' · ')[0]!
  expect(long.length).toBe(48)
  expect(long.endsWith('…')).toBe(true)
  expect(cardMeta(row('b', { type: 'codex:codex-rescue' }))).toBe('codex-rescue · Opus 5.5')
  // a Codex relay shows Codex's model and effort, not its own relay model's
  expect(cardMeta(row('c', { type: 'codex:codex-rescue', effort: 'medium', codex: { model: 'gpt-6.2-astra', effort: 'high' } }))).toBe('codex-rescue · gpt-6.2-astra · high')
  const kimi = row('k', { type: 'buddy:kimi-k3-high', model: 'kimi-k3-high', external: { doneFile: null, deadline: null } })
  expect(cardStats(kimi, T0 + 5_000, SESSION)).toBe('0:05 elapsed')
  // an external seat's type only repeats its model, and `agy-` only says what the pill does
  expect(cardMeta(kimi)).toBe('kimi-k3-high')
  expect(cardMeta({ ...kimi, model: 'agy-gemini-4-neon-high' })).toBe('gemini-4-neon-high')
  expect(cardMeta({ ...kimi, type: 'codex:exec', model: 'gpt-6.2-sol', effort: 'low' })).toBe('gpt-6.2-sol · low')
  expect(cardAlt(a, T0 + 99_000, SESSION)).toBe('task a: Claude · general-purpose · Opus 5.5 · high, done, 196k tokens · ctx 41% · 0:19 elapsed')
  // A running row the engine reports waiting, idle or pending says so as its state word.
  const parked = row('w', { contextTokens: 82_000, tokens: 196_000, engineStatus: 'waiting' })
  expect(cardStats(parked, T0 + 19_000, SESSION)).toBe('Context window · 41% · 82k · 196k total · 0:19')
  expect(cardAlt(parked, T0 + 19_000, SESSION)).toContain(', waiting, ')
  // A run cut off at the output limit says so without opening the card.
  const cut = row('c', { contextTokens: 82_000, tokens: 196_000, status: 'done', endedAt: T0 + 19_000, detail: { isCutOff: true } })
  expect(cardStats(cut, T0 + 99_000, SESSION)).toBe('196k tokens · ctx 41% · 0:19 elapsed · cut off')
  // Permission asks and denials, and a card waiting on an approval.
  const asked = row('p', { contextTokens: 82_000, tokens: 196_000, checks: { asked: 2, denied: 1 }, pending: ['c1'] })
  expect(cardStats(asked, T0 + 19_000, SESSION)).toBe('Context window · 41% · 82k · 196k total · 0:19 · 2 asked · 1 denied')
  expect(cardAlt(asked, T0 + 19_000, SESSION)).toContain(', awaiting approval, ')
  expect(cardStats(row('q', { checks: { asked: 1, denied: 0 } }), T0 + 5_000, null)).toBe('0:05 elapsed · 1 asked')
})

test('header and band text', async () => {
  expect(headerText({ agents: 3, tokens: 412_000, time: 134_000 })).toBe('3 agents · 412k · 2:14')
  const running = [row('a', { tokens: 400_000 }), row('b', { tokens: 12_000, startedAt: T0 + 60_000 })]
  expect(bandText(running, T0 + 134_000)).toBe('2 running · 412k · 2:14')
  // 2026-10-12: a lone background Codex run read `1 running · 0 · 0:00`; its tokens are unknown, not 0
  const codex = row('c', { type: 'codex:exec', model: 'codex', external: { doneFile: null, deadline: null } })
  // nothing reported yet is said in words on the tile and left out of a line of figures: no dash stands in for a number
  expect(bandText([codex], T0 + 134_000)).toBe('1 running · 2:14')
  expect(headerText({ agents: 1, tokens: null, time: 5_000 })).toBe('1 agent · 0:05')
  const quiet = headerSvg(600, { agents: 1, tokens: null, time: 5_000 })
  expect(quiet).toContain('>Not reported</text>')
  expect(quiet).not.toContain('—')
  expect(headerText({ agents: 2, tokens: 1500, time: 5_000 })).toBe('2 agents · 2k · 0:05')
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
  // a subagent before its first request has no bar: the short card, plus the gap beneath it
  expect(card).toContain(`height="${CARD_FLAT_H + CARD_GAP}"`)
  expect(card).toContain('fix a&lt;b &amp;&amp; c')
  expect(card).not.toContain('a<b')
  expect(card).toContain('class="c-pirate run"')
  expect(cardSvg(600, { ...a, status: 'done' }, T0, SESSION)).toContain('class="c-pirate"')
  expect([CARD_BAR_H, CARD_FLAT_H, CARD_GAP]).toEqual([72, 60, 8])
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

const seat = (over: Partial<AgentRun> = {}, external: Partial<NonNullable<AgentRun['external']>> = {}): AgentRun =>
  row('s', { type: 'buddy:grok-4.7-high-fast', model: 'grok-4.7-high-fast', external: { doneFile: null, deadline: null, ...external }, ...over })

test('an external seat reads its timeout while it runs: budget, then soon at 80%, then reached; the bar follows it', async () => {
  const s = seat({}, { capMs: 900_000 })
  expect(cardReadout(s, T0 + 74_000, SESSION)).toEqual({ label: 'Timeout budget', value: '1:14 / 15:00', ratio: 74_000 / 900_000, isWarn: false })
  expect(cardReadout(s, T0 + 719_000, SESSION).label).toBe('Timeout budget')
  expect(cardReadout(s, T0 + 720_000, SESSION)).toMatchObject({ label: 'Timeout soon', ratio: 0.8, isWarn: true })
  expect(cardReadout(s, T0 + 960_000, SESSION)).toMatchObject({ label: 'Timeout reached', value: '16:00 / 15:00', ratio: 1, isWarn: true })
  // no timeout known: elapsed time alone, and no bar
  expect(cardReadout(seat(), T0 + 74_000, SESSION)).toEqual({ label: '', value: '1:14 elapsed', ratio: null, isWarn: false })
  expect(cardHeight(s, T0 + 74_000, SESSION)).toBe(CARD_BAR_H + CARD_GAP)
  expect(cardHeight(seat(), T0 + 74_000, SESSION)).toBe(CARD_FLAT_H + CARD_GAP)
  const svg = cardSvg(560, s, T0 + 74_000, SESSION)
  expect(svg).toContain('>Timeout budget<')
  expect(svg).toContain('>1:14 / 15:00<')
  expect(svg).toContain('class="bf"')
  // the tick where it turns amber: 80% of the bar (56 + round(492 * 0.8))
  expect(svg).toContain('class="tk" x="450"')
  expect(cardSvg(560, s, T0 + 800_000, SESSION)).toContain('class="bw"')
  // just started: the bar still shows where it begins
  expect(cardSvg(560, s, T0, SESSION)).toContain('class="bf" x="56" y="60" width="3"')
})

test('a subagent near the end of its context window is flagged the way a seat near its timeout is; every bar is one colour', async () => {
  const sub = (contextTokens: number): AgentRun => ({ id: 'x', type: 'Plan', description: 'plan', model: 'claude-opus-5-5', status: 'running', startedAt: T0, contextTokens, tokens: 300_000, steps: 4, window: 200_000 })
  expect(cardReadout(sub(64_000), T0 + 71_000, SESSION)).toMatchObject({ label: 'Context window', ratio: 0.32, isWarn: false })
  expect(cardReadout(sub(160_000), T0 + 71_000, SESSION)).toMatchObject({ label: 'Context nearly full', ratio: 0.8, isWarn: true })
  const calm = cardSvg(560, sub(64_000), T0 + 71_000, SESSION)
  const full = cardSvg(560, sub(182_000), T0 + 71_000, SESSION)
  // the same blue fill and the same 80% tick as a timeout bar: the costume colours the mascot, not the meter
  expect(calm).toContain('class="bf" x="56" y="60"')
  expect(calm).toContain('class="tk" x="450"')
  expect(calm).toContain('class="live st-run"')
  expect(full).toContain('class="bw" x="56" y="60"')
  expect(full).toContain('class="st-warn" x="56" y="53"')
  expect(full).toContain('>Context nearly full<')
  expect(full).toContain('class="live st-warn"')
})

test('an external seat that ended shows what it used and how it ended, with no bar', async () => {
  const done = seat({ status: 'done', endedAt: T0 + 36_000, tokens: 32_398 }, { capMs: 600_000, tokens: 32_398, exit: 0 })
  expect(cardStats(done, T0 + 99_000, SESSION)).toBe('32k tokens · 0:36 elapsed')
  expect(cardReadout(done, T0 + 99_000, SESSION).ratio).toBe(null)
  expect(cardHeight(done, T0 + 99_000, SESSION)).toBe(CARD_FLAT_H + CARD_GAP)
  const svg = cardSvg(560, done, T0 + 99_000, SESSION)
  expect(svg).toContain('>Done<')
  expect(svg).toContain('class="st-ok"')
  expect(svg).not.toContain('class="bf"')
  expect(svg).not.toContain('—')
  // before its tokens are read: the time alone
  expect(cardStats(seat({ status: 'done', endedAt: T0 + 36_000 }), T0 + 99_000, SESSION)).toBe('0:36 elapsed')
  // the launcher's own timeout is said as that, any other exit by its code
  const timedOut = seat({ status: 'failed', endedAt: T0 + 900_000 }, { exit: 124 })
  expect(cardSvg(560, timedOut, T0 + 999_000, SESSION)).toContain('>Timed out<')
  expect(cardStats(timedOut, T0 + 999_000, SESSION)).toBe('15:00 elapsed')
  expect(cardStats(seat({ status: 'failed', endedAt: T0 + 5_000 }, { exit: 70 }), T0 + 9_000, SESSION)).toBe('Exit 70 · 0:05 elapsed')
  expect(cardStats(seat({ status: 'lost', endedAt: T0 + 5_000 }), T0 + 9_000, SESSION)).toBe('No report received · 0:05 elapsed')
})

test('the pill names whose model runs the row', async () => {
  const pill = (r: AgentRun): string => /class="pt-(\w+)"[^>]*>([^<]+)</.exec(cardSvg(560, r, T0, SESSION))!.slice(1).join(':')
  expect(pill(row('a'))).toBe('claude:Claude')
  expect(pill(seat())).toBe('cursor:Cursor')
  expect(pill(seat({ type: 'buddy:agy-gemini-4-neon-high', model: 'agy-gemini-4-neon-high' }))).toBe('antigravity:Antigravity')
  expect(pill(seat({ type: 'codex:exec', model: 'gpt-6.2-sol' }))).toBe('codex:Codex')
  expect(pill(row('r', { type: 'codex:codex-rescue' }))).toBe('codex:Codex')
  // a narrow pane keeps the pill and the state, and gives up the model before either
  const narrow = cardSvg(240, seat({ model: 'deepseek-v41-flash-1017-medium' }), T0, SESSION)
  expect(narrow).toContain('>Cursor<')
  expect(narrow).toContain('>Running<')
})

test('cardsWithin: the cards that fit the budget in order, never fewer than one', async () => {
  expect(cardsWithin([10, 10, 10], 25)).toBe(2)
  expect(cardsWithin([10, 10, 10], 30)).toBe(3)
  expect(cardsWithin([40, 10], 25)).toBe(1)
  expect(cardsWithin([], 25)).toBe(0)
})

test('the usage strip: Codex limits as percent, the ledger as tokens today, nothing from another day', async () => {
  const at = new Date(2026, 10, 24, 20, 0, 0).getTime()
  const day = new Date(2026, 10, 24).getTime()
  const usage = { day, codex: { primary: 20, secondary: 37 }, cursor: 182_000, antigravity: 87_000 }
  expect(usageEntries(usage, at)).toEqual([
    ['Codex limit', '5h 20% · 7d 37%'],
    ['Cursor today', '182k tokens'],
    ['Antigravity today', '87k tokens'],
  ])
  // 2026-11-24: a 5h window read at 23% stayed 23% after its reset time passed. Past it the old figure is gone
  // and no new one has been read, so the window says `reset`: 0% would be a number nobody measured
  const read = { day, codex: { primary: 23, secondary: 38, primaryResetsAt: at + 60_000, secondaryResetsAt: at + 3_600_000 } }
  expect(usageEntries(read, at)).toEqual([['Codex limit', '5h 23% · 7d 38%']])
  expect(usageEntries(read, at + 60_000)).toEqual([['Codex limit', '5h reset · 7d 38%']])
  expect(usageEntries(read, at + 3_600_000)).toEqual([['Codex limit', '5h reset · 7d reset']])
  // each window is named by its own length, not its place: 5h and 7d only when the log says so or says nothing
  expect(usageEntries({ day, codex: { primary: 5, secondary: 9, primaryMinutes: 10080, secondaryMinutes: 43200 } }, at)).toEqual([['Codex limit', '7d 5% · 30d 9%']])
  expect(usageEntries({ day, codex: { primary: 5, secondary: 9, primaryMinutes: 180, secondaryMinutes: 90 } }, at)).toEqual([['Codex limit', '3h 5% · 90m 9%']])
  // past midnight a Codex reading with a reset still ahead is still the account's; the day's ledger tokens are not today's
  const rolled = { day, codex: { primary: 20, secondary: 37, primaryResetsAt: at + 1000, secondaryResetsAt: at + 3 * 86_400_000 }, cursor: 9_000 }
  expect(usageEntries(rolled, at + 86_400_000)).toEqual([['Codex limit', '5h reset · 7d 37%']])
  expect(usageEntries(rolled, at + 4 * 86_400_000)).toEqual([])
  // a plan with one window draws that window alone
  expect(usageEntries({ day, codex: { primary: 93, primaryMinutes: 10080 } }, at)).toEqual([['Codex limit', '7d 93%']])
  // a vendor no seat ran on today has no entry; a figure read yesterday is not today's
  expect(usageEntries({ day, cursor: 0, antigravity: 5_000 }, at)).toEqual([['Antigravity today', '5k tokens']])
  expect(usageEntries(usage, at + 86_400_000)).toEqual([])
  expect(usageEntries(null, at)).toEqual([])
  const t = { agents: 1, tokens: 1000, time: 1000 }
  expect(headerHeight(600, null, at)).toBe(44)
  expect(headerHeight(600, usage, at)).toBe(71)
  // under 540 wide the entries stack, one a line
  expect(headerHeight(400, usage, at)).toBe(71 + 32)
  const head = headerSvg(600, t, usage, at)
  expect(head).toContain('height="71"')
  expect(head).toContain('Codex limit · ')
  expect(head).toContain('>5h 20% · 7d 37%<')
  expect(headerSvg(600, t, null, at)).toContain('height="44"')
  expect(headerText(t, usage, at)).toBe('1 agent · 1k · 0:01 · Codex limit 5h 20% · 7d 37% · Cursor today 182k tokens · Antigravity today 87k tokens')
})

const ext = (id: string, model: string, over: Partial<AgentRun> = {}): AgentRun =>
  row(id, { type: model.startsWith('gpt') ? 'codex:exec' : `buddy:${model}`, model, status: 'done', external: { doneFile: null, deadline: null }, ...over })

test('finished rows group by vendor and model; a run that did not finish well keeps its own card', async () => {
  // newest first, as the pane lists them
  const rows = [
    ext('s3', 'gpt-6.2-sol', { effort: 'low', startedAt: T0 + 60_000, endedAt: T0 + 74_000 }),
    ext('g', 'grok-4.7-medium-fast', { startedAt: T0, endedAt: T0 + 172_000, tokens: 26_094, external: { doneFile: null, deadline: null, tokens: 26_094 } }),
    ext('bad', 'gpt-6.2-sol', { effort: 'low', status: 'failed', startedAt: T0, endedAt: T0 + 5_000, external: { doneFile: null, deadline: null, exit: 1 } }),
    ext('s2', 'gpt-6.2-sol', { effort: 'low', startedAt: T0 + 40_000, endedAt: T0 + 56_000 }),
    ext('a', 'gpt-6.2-astra', { effort: 'high', startedAt: T0, endedAt: T0 + 190_000, tokens: 53_000, external: { doneFile: null, deadline: null, tokens: 53_000 } }),
    ext('s1', 'gpt-6.2-sol', { effort: 'low', startedAt: T0 + 20_000, endedAt: T0 + 32_000 }),
    row('lost', { status: 'lost', endedAt: T0 + 60_000 }),
  ]
  const { groups, attention } = finishedGroups(rows, T0 + 200_000)
  expect(attention.map(a => a.id)).toEqual(['bad', 'lost'])
  // ordered by the newest run in each group; three ephemeral sol runs are one row with no token figure
  expect(groups.map(g => groupLine(g))).toEqual([
    'Codex · gpt-6.2-sol · low · 3 done · 0:42',
    'Cursor · grok-4.7-medium-fast · 1 done · 26k · 2:52',
    'Codex · gpt-6.2-astra · high · 1 done · 53k · 3:10',
  ])
  // two subagents of one type on two models are two rows
  const subs = finishedGroups([row('x', { status: 'done', endedAt: T0 + 1000 }), row('y', { status: 'done', model: 'claude-sonnet-5-5', endedAt: T0 + 2000 })], T0 + 9000)
  expect(subs.groups.length).toBe(2)
  expect(subs.attention).toEqual([])
})

test('the finished summary draws one outlined block of rows: a pill, the model, the count, tokens and time', async () => {
  const { groups } = finishedGroups(
    [ext('s1', 'gpt-6.2-sol', { effort: 'low', endedAt: T0 + 12_000 }), ext('a', 'gpt-6.2-astra', { effort: 'high', endedAt: T0 + 190_000, tokens: 53_000, external: { doneFile: null, deadline: null, tokens: 53_000 } })],
    T0 + 200_000,
  )
  const s = finishedSvg(600, groups)
  expect(s).toContain(`height="${finishedHeight(groups.length)}"`)
  expect(finishedHeight(2)).toBe(2 * 36 + CARD_GAP)
  expect(s).toContain('>Codex<')
  expect(s).toContain('>gpt-6.2-sol · low<')
  expect(s).toContain('>1 done<')
  expect(s).toContain('>53k<')
  expect(s).toContain('>3:10<')
  // one hairline between two rows, none under the last
  expect(s.match(/class="ln"/g)?.length).toBe(1)
  expect(s).not.toContain('—')
  expect(finishedAlt(groups)).toBe('Finished: Codex · gpt-6.2-sol · low · 1 done · 0:12; Codex · gpt-6.2-astra · high · 1 done · 53k · 3:10')
  // past MAX_GROUPS the rest are one counted row, and the block stays far under the Svg cap
  const many = finishedGroups(
    Array.from({ length: 40 }, (_, i) => row(`m${i}`, { type: `kind-${i}`, status: 'done', endedAt: T0 + i })),
    T0 + 99,
  ).groups
  const big = finishedSvg(600, many)
  expect(big).toContain(`>+${40 - MAX_GROUPS} more kinds · ${40 - MAX_GROUPS} done<`)
  expect(big).toContain(`height="${finishedHeight(MAX_GROUPS + 1)}"`)
  expect(big.length).toBeLessThan(40_000)
})

test('wrapText breaks at words inside the width and cuts the last line it may use', async () => {
  const lines = wrapText('one two three four five six seven eight nine ten eleven twelve', 11, 80, 3)
  expect(lines.length).toBe(3)
  expect(lines.every(l => textWidth(l, 11) <= 80)).toBe(true)
  expect(lines[2]!.endsWith('…')).toBe(true)
  expect(wrapText('short', 11, 80, 3)).toEqual(['short'])
  // a word wider than the line is cut, not left to run out of the card
  expect(wrapText('x'.repeat(200), 11, 80, 2).every(l => textWidth(l, 11) <= 80)).toBe(true)
})

test('an opened card draws its details inside its own outline, wrapped to the card', async () => {
  const a = row('d', {
    status: 'done',
    tokens: 9000,
    endedAt: T0 + 19_000,
    detail: { task: 'Read-only research on the PUBLIC GitHub repo meta/astryx (an MIT design system). Goal: extract concrete, numeric design rules I can apply by hand to a small hand-drawn SVG side panel', tools: ['Bash cd', 'Read draw.ts'], answer: 'Done.' },
  })
  const shut = cardSvg(600, a, T0 + 99_000, SESSION)
  const open = cardSvg(600, a, T0 + 99_000, SESSION, true)
  expect(shut).not.toContain('Read draw.ts')
  expect(open).toContain('Read draw.ts')
  expect(open).toContain('Answer: Done.')
  const h = cardHeight(a, T0 + 99_000, SESSION, 600, true)
  expect(h).toBeGreaterThan(cardHeight(a, T0 + 99_000, SESSION))
  expect(open).toContain(`height="${h}"`)
  // the outline holds the details: its height is the card's less the gap under it
  expect(open).toContain(`height="${h - CARD_GAP - 1}" rx="12"`)
  // every task line fits between the text column and the card's right edge
  const taskLines = [...open.matchAll(/<text class="s" x="56" y="\d+"[^>]*>([^<]*)<\/text>/g)].map(m => m[1]!)
  expect(taskLines.length).toBeGreaterThan(1)
  expect(taskLines.every(l => textWidth(l, 11) <= 600 - 12 - 56)).toBe(true)
  // a card with details keeps a strip for its toggle inside the outline, shut or open, and the gap is above the outline:
  // the outline's bottom edge is the drawing's, which is what the pane anchors the toggle to
  expect(hasDetail(a)).toBe(true)
  expect(cardHeight(a, T0 + 99_000, SESSION)).toBe(CARD_FLAT_H + CARD_FOOT_H + CARD_GAP)
  expect(shut).toContain(`<g transform="translate(0 ${CARD_GAP})"><rect class="cd" x="0.5" y="0.5" width="599" height="${CARD_FLAT_H + CARD_FOOT_H - 1}" rx="12"/>`)
  expect(shut).toContain(`<line class="ln" x1="56" y1="${CARD_FLAT_H + 0.5}"`)
  expect(hasDetail(row('e', { status: 'done', endedAt: T0 + 1000 }))).toBe(false)
  // a card with nothing to show opens to nothing more
  expect(cardHeight(row('e', { status: 'done', endedAt: T0 + 1000 }), T0 + 9000, SESSION, 600, true)).toBe(CARD_FLAT_H + CARD_GAP)
})
