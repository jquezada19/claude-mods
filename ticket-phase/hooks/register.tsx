import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { TicketPhaseReading, TicketPhaseTally } from '../types'
import type { RowColor } from './row'
import { ROW_H, rowSvg } from './row'
import {
  PHASES,
  aheadOf,
  cellsOf,
  etaOf,
  parseRows,
  statsOf,
  tierOf,
  tokensShort,
  until,
  walk,
} from './phases'

const TICK = 60_000
const READING = { plugin: 'ticket-phase', key: 'reading' } as const
const HIDDEN = { plugin: 'ticket-phase', key: 'hidden' } as const
const SINK_MTIME = { plugin: 'ticket-phase', key: 'sinkMtimeMs' } as const
const HIDE = 'hidden'
const DEFAULT_SINK = '~/.claude/metrics/ticket-phase-tokens.jsonl'
const DEFAULT_VAULT = '~/Documents/Obsidian Vault'

/** `~` at the front of a configured path stands for the home directory. */
export const expandHome = (path: string, home: string): string =>
  path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path

const pathsOf = async ($: EngineInterface, options: PluginOptions) => {
  const home = (await $.env.get('HOME')) ?? ''
  const sink = typeof options.sink === 'string' && options.sink !== '' ? options.sink : DEFAULT_SINK
  const vault =
    typeof options.vault === 'string' && options.vault !== '' ? options.vault : DEFAULT_VAULT

  return { sink: expandHome(sink, home), vault: expandHome(vault, home) }
}

const NOTE_PATH = { plugin: 'ticket-phase', key: 'notePath' } as const
/** Where a ticket's note may sit, first match wins; '' is the Work Items root. */
const FOLDERS = ['In Flight', 'In Testing', 'Backlog', ''] as const

const matches = (name: string, ticket: string): boolean =>
  name.startsWith(`${ticket} - `) && name.endsWith('.md')

/** The Work Item note for the ticket, searched in folder precedence; null when none. */
const findNote = async (
  $: EngineInterface,
  vault: string,
  ticket: string,
): Promise<string | null> => {
  const root = `${vault}/Work Items`
  const dirs: string[] = FOLDERS.map(one => (one === '' ? root : `${root}/${one}`))

  try {
    for (const sprint of await $.fs.list(`${root}/Done`)) {
      if (sprint.kind === 'dir') {
        dirs.push(`${root}/Done/${sprint.name}`)
      }
    }
  } catch {
    // No Done folder: nothing more to search.
  }

  for (const dir of dirs) {
    try {
      const hit = (await $.fs.list(dir)).find(
        one => one.kind === 'file' && matches(one.name, ticket),
      )

      if (hit !== undefined) {
        return `${dir}/${hit.name}`
      }
    } catch {
      // A folder that is not there is simply not searched.
    }
  }

  return null
}

/** The tier for the ticket from its note, with the path cached in $.state. */
const tierFor = async (
  $: EngineInterface,
  vault: string,
  ticket: string,
): Promise<{ tier: string; mtimeMs: number | null }> => {
  const { value: cached = null } = await $.state.get(NOTE_PATH)
  const base = cached === null ? '' : cached.slice(cached.lastIndexOf('/') + 1)
  let path = cached !== null && matches(base, ticket) ? cached : null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (path === null) {
      // A ticket with no note is looked for at most every NOTE_SEARCH_MS, whatever asks.
      const now = await $.clock.now()

      if (noteSearched !== null && noteSearched.ticket === ticket && now - noteSearched.at < NOTE_SEARCH_MS) {
        break
      }

      // claimed before the walk, so a refresh overlapping this one does not walk again
      const claim = { ticket, at: now }
      noteSearched = claim
      path = await findNote($, vault, ticket)

      if (path !== null && noteSearched === claim) {
        noteSearched = null
      }
    }

    if (path === null) {
      break
    }

    // The stat comes first: a write between the two calls then leaves an older
    // stamp behind, and the next tick re-reads rather than missing the change.
    const mtimeMs = await $.fs.stat(path).then(one => one.mtimeMs, () => null)

    try {
      const text = await $.fs.read(path)
      await $.state.set(NOTE_PATH, path)

      return { tier: tierOf(text) ?? '?', mtimeMs }
    } catch {
      // The note moved or was renamed: forget the path and look again once.
      path = null
    }
  }

  await $.state.set(NOTE_PATH, null)

  return { tier: '?', mtimeMs: null }
}

/** The most of the sink one refresh reads: under $.fs.read's 4 MiB, with room to spare. */
const SINK_READ_CAP = 3 * 1024 * 1024
/** A ticket with no Work Item note is looked for again this often, not every tick. */
const NOTE_SEARCH_MS = 10 * 60_000
/** Tallies of phases entered longer ago than this are pruned at session start. */
const TALLY_KEEP_MS = 30 * 86_400_000
/** When the note for a ticket was last looked for and not found. */
let noteSearched: { ticket: string; at: number } | null = null

const TALLY = 'tokens:'
/** The tally updates in flight, chained so they apply one at a time. */
let tallying: Promise<void> = Promise.resolve()

const isTally = (value: unknown): value is TicketPhaseTally =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as TicketPhaseTally).tokens === 'number' &&
  typeof (value as TicketPhaseTally).phase === 'number' &&
  typeof (value as TicketPhaseTally).enteredAt === 'number' &&
  typeof (value as TicketPhaseTally).enteredOrder === 'number' &&
  typeof (value as TicketPhaseTally).ticket === 'string'

/**
 * The tally that belongs to the reading's current phase: the stored one when
 * it is for the same ticket, phase and enter, else a fresh zero. Null when
 * there is no current phase.
 */
const tallyFor = async (
  $: EngineInterface,
  reading: TicketPhaseReading,
): Promise<TicketPhaseTally | null> => {
  const { state, ticket } = reading

  if (state.current === null || state.enteredAt === null || state.enteredOrder === null) {
    return null
  }

  const stored = await $.store.get(`${TALLY}${await $.session.id()}`)
  const same =
    isTally(stored) &&
    stored.ticket === ticket &&
    stored.phase === state.current &&
    stored.enteredAt === state.enteredAt &&
    stored.enteredOrder === state.enteredOrder

  return same
    ? stored
    : {
        ticket,
        phase: state.current,
        enteredAt: state.enteredAt,
        enteredOrder: state.enteredOrder,
        tokens: 0,
        fresh: 0,
      }
}

/**
 * Reads the sink, finds this session's ticket, and publishes its phase state,
 * the own-pace medians and the tier to draw. A sink that cannot be read clears
 * the reading, so nothing stale is drawn over it.
 */
const refresh = async ($: EngineInterface, options: PluginOptions): Promise<void> => {
  const { sink, vault } = await pathsOf($, options)
  const now = await $.clock.now()
  let text: string
  let sinkMtimeMs: number

  // The stat comes first (see tierFor): a write between the two calls is then
  // caught by the next tick instead of being acknowledged unread.
  let isPartial = false

  try {
    const st = await $.fs.stat(sink)
    sinkMtimeMs = st.mtimeMs

    if (st.size > SINK_READ_CAP) {
      // Past what one read may copy (4 MiB): the newest part, from its first whole row.
      // One byte more than the window: when that byte is a newline the window opens on a
      // whole row and keeps it; otherwise the first, cut row is dropped. Output the engine
      // cut short (a sink growing during the read) is not taken as the history.
      const r = await $.process.run(['tail', '-c', String(SINK_READ_CAP + 1), sink], { timeoutMs: 10_000 })

      if (r.exitCode !== 0 || r.isStdoutTruncated) {
        throw new Error('tail failed')
      }

      text = r.stdout.slice(r.stdout.indexOf('\n') + 1)
      isPartial = true
    } else {
      text = await $.fs.read(sink)
    }
  } catch {
    await $.state.set(READING, null)
    await $.state.set(SINK_MTIME, null)

    return
  }

  await $.state.set(SINK_MTIME, sinkMtimeMs)

  const { rows, skipped } = parseRows(text)
  const me = await $.session.id()
  const own = rows.filter(row => row.session === me)
  const mine = own[own.length - 1]

  if (mine === undefined) {
    await $.state.set(READING, null)

    return
  }

  const state = walk(rows.filter(row => row.ticket === mine.ticket))
  const note = await tierFor($, vault, mine.ticket)
  const reading: TicketPhaseReading = {
    ticket: mine.ticket,
    tier: note.tier,
    state,
    stats: statsOf(rows),
    skipped,
    sinkMtimeMs,
    noteMtimeMs: note.mtimeMs,
    at: now,
    ...(isPartial ? { isPartial: true as const } : {}),
  }
  await $.state.set(READING, reading)
  await $.state.set(HIDDEN, (await $.store.get(HIDE)) === true)
}

/** Whether the sink or the ticket's note changed since the reading was taken. */
const moved = async ($: EngineInterface, options: PluginOptions): Promise<boolean> => {
  const { value: reading } = await $.state.get(READING)
  const { value: known = null } = await $.state.get(SINK_MTIME)
  const { sink, vault } = await pathsOf($, options)

  try {
    // Unknown (never read, or the last read failed) counts as moved: the tick retries.
    if (known === null || (await $.fs.stat(sink)).mtimeMs !== known) {
      return true
    }
  } catch {
    return known !== null
  }

  if (reading === null || reading === undefined) {
    return false
  }

  const { value: notePath = null } = await $.state.get(NOTE_PATH)

  if (notePath === null) {
    // No note yet: look for one, so a note written after the first reading is noticed,
    // but not on every tick (it walks several folders): every NOTE_SEARCH_MS.
    const now = await $.clock.now()

    if (noteSearched !== null && noteSearched.ticket === reading.ticket && now - noteSearched.at < NOTE_SEARCH_MS) {
      return false
    }

    const claim = { ticket: reading.ticket, at: now }
    noteSearched = claim
    const found = (await findNote($, vault, reading.ticket)) !== null

    if (found && noteSearched === claim) {
      noteSearched = null
    }

    return found
  }

  try {
    return (await $.fs.stat(notePath)).mtimeMs !== reading.noteMtimeMs
  } catch {
    return true
  }
}

/** Tallies of phases entered more than TALLY_KEEP_MS ago: one store key per session that tracked a phase. */
const pruneTallies = async ($: EngineInterface): Promise<void> => {
  const now = await $.clock.now()

  for (const key of await $.store.keys()) {
    if (!key.startsWith(TALLY)) {
      continue
    }

    const value = await $.store.get(key)

    // By last activity: a phase can stay open for weeks while its session keeps counting.
    if (isTally(value) && now - (value.at ?? value.enteredAt) > TALLY_KEEP_MS) {
      await $.store.delete(key)
    }
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'phase',
      description:
        'Ticket phase band: /phase shows the phases, medians and token tally; /phase hide and /phase show turn the row off and on',
    })
    // An idle session follows another session's boundaries within a minute.
    $.clock.every(TICK, async () => {
      if (await moved($, options)) {
        await refresh($, options)
      }

      $.ui.invalidate('ui.render')
    })
    await refresh($, options)
    await pruneTallies($).catch(() => undefined)

    return next(e)
  })

  // The boundary lands in the same turn: the skill's own call moves the band.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const out = await next(e)
    const command = (e as { command?: unknown }).command

    if (typeof command === 'string' && command.includes('ticket-phase.sh')) {
      await refresh($, options).catch(() => undefined)
    }

    return out
  })

  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)

    if (e.agentId === undefined) {
      await refresh($, options)
    }

    return answer
  })

  // Every model step, this session's own and its subagents', lands on the open phase.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const usage = response.usage

    if (usage === null || usage === undefined) {
      return response
    }

    // fresh: what the step added (uncached input, output, cache writes). The cached context
    // read back on every step is in `spent` only, so a warm 200k context does not look like
    // 200k of work per step.
    const fresh = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    const spent = fresh + (usage.cache_read_input_tokens ?? 0)

    if (!Number.isFinite(spent)) {
      return response
    }

    // Steps can overlap (a subagent's beside the main loop's): the read-add-write
    // runs one at a time so neither overwrites the other's addition.
    tallying = tallying
      .then(async () => {
        const { value: reading } = await $.state.get(READING)

        if (reading === null || reading === undefined) {
          return
        }

        const tally = await tallyFor($, reading)

        if (tally !== null) {
          await $.store.set(`${TALLY}${await $.session.id()}`, {
            ...tally,
            tokens: tally.tokens + spent,
            at: await $.clock.now(),
            fresh: (tally.fresh ?? 0) + fresh,
          })
        }
      })
      .catch(() => undefined)
    await tallying

    return response
  })

  on('command.run', { command: 'phase' }, async ($, e) => {
    const args = e.args.trim()

    if (args === 'hide' || args === 'show') {
      await $.store.set(HIDE, args === 'hide')
      await $.state.set(HIDDEN, args === 'hide')

      return {
        text:
          args === 'hide'
            ? 'Phase row hidden; phases are still tracked. /phase show brings it back.'
            : 'Phase row shown.',
      }
    }

    await refresh($, options)
    const { value: reading } = await $.state.get(READING)

    if (reading === null || reading === undefined) {
      return {
        text: 'No phase row for this session: the band appears once /ticket runs ticket-phase.sh here.',
      }
    }

    const now = await $.clock.now()
    const { state, stats } = reading
    const { value: notePath = null } = await $.state.get(NOTE_PATH)
    const tally = await tallyFor($, reading)
    const lines = [`#${reading.ticket} · tier ${reading.tier}${notePath === null ? '' : ` · ${notePath}`}`]

    for (let p = 1; p <= 8; p += 1) {
      const info = state.phases[p]!
      const one = stats[p]!
      const when =
        p === state.current && state.enteredAt !== null
          ? `open ${until(now - state.enteredAt)}`
          : info.enters === 0
            ? 'not entered'
            : `${info.enters} in / ${info.exits} out${info.rounds > 1 ? ` · ${info.rounds} rounds` : ''}`
      const pace = one.median === null ? 'no median' : `med ${until(one.median)}`
      lines.push(
        `${p} ${PHASES[p]} · ${when} · ${pace} · ${one.pairs} pair${one.pairs === 1 ? '' : 's'} · ${one.tickets} ticket${one.tickets === 1 ? '' : 's'}`,
      )
    }

    const eta = state.isDone ? null : etaOf(state, stats, now)
    lines.push(
      state.isDone
        ? 'done'
        : eta === null
          ? `ETA needs pairs from 2 tickets for every phase ahead (${aheadOf(state).join(', ')})`
          : `ETA ~${until(eta)} from own medians`,
    )
    lines.push(
      tally === null
        ? 'tokens: none (no open phase)'
        : `tokens this phase: ${tokensShort(tally.fresh ?? 0)} new · ${tokensShort(tally.tokens)} processed (this session's steps, subagents included; processed adds the cached context read back each step)`,
    )
    lines.push(`${reading.skipped} row${reading.skipped === 1 ? '' : 's'} skipped`)
    if (reading.isPartial === true) {
      lines.push('history: the newest 3 MiB of the sink (it is past what one read may copy); older rows are left out of the medians')
    }

    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const beneath = await next(e)
    const { value: isHidden = false } = await $.state.get(HIDDEN)
    const { value: reading } = await $.state.get(READING)

    if (e.props.hasSurvey || isHidden || reading === null || reading === undefined) {
      return beneath
    }

    const now = await $.clock.now()
    const { state, stats } = reading
    const current = state.current
    const medianMs = current === null ? null : (stats[current]?.median ?? null)
    const elapsed = current === null || state.enteredAt === null ? 0 : now - state.enteredAt
    const color: RowColor =
      current === null || medianMs === null
        ? 'gray'
        : elapsed < medianMs
          ? 'green'
          : elapsed <= 2 * medianMs
            ? 'yellow'
            : 'red'
    const pill =
      current !== null
        ? `${current} ${PHASES[current]}`
        : state.isDone && state.firstEnterAt !== null && state.lastExitAt !== null
          ? `done ${until(state.lastExitAt - state.firstEnterAt)}`
          : 'between phases'
    const pace = current !== null ? ` ${until(elapsed)}/${medianMs === null ? '—' : until(medianMs)}` : ''
    const phase = `${pill}${pace}`
    const eta = state.isDone ? null : etaOf(state, stats, now)
    const left = state.isDone ? '' : eta === null ? ' · ETA —' : ` · ~${until(eta)} left`
    const rounds = Object.entries(state.phases)
      .filter(([, one]) => one.rounds >= 2)
      .map(([p, one]) => `R${p}×${one.rounds}`)
      .join(' ')
    const tally = await tallyFor($, reading)
    const tok = tally === null ? '' : ` · ${tokensShort(tally.fresh ?? 0)}`
    const tail = `${left}${tok}${rounds === '' ? '' : ` · ${rounds}`}`
    const title = `#${reading.ticket} ${reading.tier}`
    const cells = cellsOf(state)
    // One string for both surfaces: the terminal row, and the desktop drawing's alt.
    const text = `${title} ${cells} ${phase}${tail}`
    const { Box, Text } = $.ui.resolve(e)

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve({ ...e, surface: 'desktop' })
      const W = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      // The stats after the pill: the pace, then the ETA, tokens and rounds, as dim text.
      const statsText = `${pace.trim()}${tail}`.replace(/^ · /, '')
      const source = rowSvg(
        {
          title,
          cells,
          current,
          pill,
          next: current !== null && current < 8 ? `${current + 1} ${PHASES[current + 1]}` : '',
          color,
          stats: statsText,
          progress: current === null || medianMs === null || medianMs <= 0 ? null : elapsed / medianMs,
          enteredAgoMs: current === null || state.enteredAt === null ? null : elapsed,
          isDone: state.isDone,
        },
        W,
      )

      return (
        <Box flexDirection="column">
          {beneath}
          <Svg source={source} alt={text} width={W} height={ROW_H} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {beneath}
        <Box>
          <Text color={color} bold>
            {`${title} `}
          </Text>
          <Text color={color}>{cells}</Text>
          <Text color={color} bold>{` ${phase}`}</Text>
          <Text dimColor>{tail}</Text>
        </Box>
      </Box>
    )
  })
}
