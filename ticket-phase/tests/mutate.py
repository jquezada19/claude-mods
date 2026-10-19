#!/usr/bin/env python3
"""Mutation control for the ticket-phase mod: each rule broken in a scratch copy must make the suite fail.

Run: python3 tests/mutate.py [mutant-name ...]   (all mutants when none named). Exit 0 only when every
mutant is DETECTED; a mutant that breaks the module (every test failing) is INCONCLUSIVE, not a pass.
claude plugin test ignores this file (it runs *.test.ts[x] only)."""
import os, shutil, subprocess, sys, tempfile

# The mod root: the parent of tests/, unless TICKET_PHASE_ROOT points elsewhere.
SRC = os.environ.get("TICKET_PHASE_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PHASES = os.path.join("hooks", "phases.ts")
REGISTER = os.path.join("hooks", "register.tsx")
ROW = os.path.join("hooks", "row.ts")
# The suite's size at the time of writing; a mutant that fails everything is the module breaking.
SUITE = 91
MUTANTS = [
    ("sink-cap-off", REGISTER, "if (st.size > SINK_READ_CAP) {", "if (st.size > SINK_READ_CAP * 1000) {"),
    ("partial-line-kept", REGISTER, "text = r.stdout.slice(r.stdout.indexOf('\\n') + 1)", "text = r.stdout"),
    ("prune-off", REGISTER, 'if (isTally(value) && now - (value.at ?? value.enteredAt) > TALLY_KEEP_MS) {', 'if (isTally(value) && now - (value.at ?? value.enteredAt) > TALLY_KEEP_MS * 1000) {'),
    ("prune-everything", REGISTER, 'if (isTally(value) && now - (value.at ?? value.enteredAt) > TALLY_KEEP_MS) {', 'if (isTally(value) && now - (value.at ?? value.enteredAt) > -1) {'),
    ("note-search-every-lookup", REGISTER, '      if (noteSearched !== null && noteSearched.ticket === ticket && now - noteSearched.at < NOTE_SEARCH_MS) {', '      if (noteSearched !== null && now < 0) {'),
    ("prune-ignores-activity", REGISTER, 'if (isTally(value) && now - (value.at ?? value.enteredAt) > TALLY_KEEP_MS) {', 'if (isTally(value) && now - value.enteredAt > TALLY_KEEP_MS) {'),
    ("tail-truncation-accepted", REGISTER, 'if (r.exitCode !== 0 || r.isStdoutTruncated) {', 'if (r.exitCode !== 0) {'),
    ("tail-no-extra-byte", REGISTER, 'String(SINK_READ_CAP + 1)', 'String(SINK_READ_CAP)'),
    ("order-global", PHASES, '    const order = (ties.get(at) ?? 0) + 1\n    ties.set(at, order)', '    const order = rows.length + skipped + 1'),
    ("tally-activity-unstamped", REGISTER, '            at: await $.clock.now(),\n', ''),
    ("search-claimed-late", REGISTER, '      const claim = { ticket, at: now }\n      noteSearched = claim\n      path = await findNote($, vault, ticket)\n', '      const claim = { ticket, at: now }\n      path = await findNote($, vault, ticket)\n      noteSearched = path === null ? claim : noteSearched\n'),
    ("band-shows-processed", REGISTER, "` · ${tokensShort(tally.fresh ?? 0)}`", "` · ${tokensShort(tally.tokens)}`"),
    ("fresh-counts-reads", REGISTER, "fresh: (tally.fresh ?? 0) + fresh,", "fresh: (tally.fresh ?? 0) + spent,"),
    ("median-to-mean", PHASES,
     "return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2",
     "return values.reduce((a, b) => a + b, 0) / values.length"),
    ("eta-ticket-gate", PHASES, "one.tickets < 2", "one.tickets < 1"),
    ("eta-clamp", PHASES,
     "Math.max(0, one.median - (now - state.enteredAt))",
     "one.median - (now - state.enteredAt)"),
    ("pair-fifo", PHASES, "const [entered] = index >= 0 ? stack.splice(index, 1) : []", "const [entered] = stack.splice(0, 1)"),
    ("pair-any-session", PHASES, "if (stack[i]!.session === row.session) {", "if (false) {"),
    ("resume-is-round", PHASES, "if (info.open.length > 0) {\n        if (!info.open.includes(row.session)) {", "if (false) {\n        if (!info.open.includes(row.session)) {"),
    ("skipped-exit-ahead", PHASES,
     "out += entered ? '◆' : '◇'\n    } else if (p === state.current)",
     "out += '◇'\n    } else if (p === state.current)"),
    ("implicit-close", PHASES, "if (q !== row.phase && other.open.length > 0) {", "if (false) {"),
    ("done-needs-close", PHASES, "lastEvent === 'exit' && last.closed > 0", "lastEvent === 'exit'"),
    ("orphan-moves-exit", PHASES,
     "info.exits += 1\n\n    if (info.open.length === 0) {\n      continue\n    }",
     "info.exits += 1\n    lastExitAt = row.at\n\n    if (info.open.length === 0) {\n      continue\n    }"),
    ("round-on-exit-only", PHASES, "if (info.left > 0) {\n        info.rounds += 1", "if (info.closed > 0) {\n        info.rounds += 1"),
    ("ahead-from-highest", PHASES, "const from = state.current ?? state.lastPhase ?? 0", "const from = state.current ?? LAST_PHASE"),
    ("tokens-no-carry", PHASES, "if (k < 1000) {\n    return `${k}k`", "if (k < 1001) {\n    return `${k}k`"),
    ("tick-never", REGISTER, "if (await moved($, options)) {", "if ((await moved($, options)) && options.mutantNever === 'x') {"),
    ("tick-always", REGISTER, "if (await moved($, options)) {", "if ((await moved($, options)) || options.mutantNever === undefined) {"),
    ("read-before-stat", REGISTER,
     "    } else {\n      text = await $.fs.read(sink)\n    }",
     "    } else {\n      text = await $.fs.read(sink)\n      sinkMtimeMs = (await $.fs.stat(sink)).mtimeMs\n    }"),
    ("tally-ignores-order", REGISTER, "stored.enteredOrder === state.enteredOrder", "true"),
    ("note-cache-by-substring", REGISTER, "let path = cached !== null && matches(base, ticket) ? cached : null", "let path = cached !== null && cached.includes(`/${ticket} - `) ? cached : null"),
    ("late-note-ignored", REGISTER, "const found = (await findNote($, vault, reading.ticket)) !== null", "const found = false"),
    ("alt-not-text", REGISTER, "<Svg source={source} alt={text} width={W} height={ROW_H} />", "<Svg source={source} alt={title} width={W} height={ROW_H} />"),
    ("segments-swapped", ROW, "if (cell !== '◆') {", "if (cell !== '◇') {"),
    ("row-xml-off", ROW, "s.replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c] ?? c)", "s"),
    ("pill-stretches-forward", ROW, "const back = x1 - roomFor(pill, false)\n\n  if (back >= 0) {\n    return { x0: back, x1, label: pill }", "const back = x1 - roomFor(pill, false)\n\n  if (back >= 0) {\n    return { x0: own, x1: own + roomFor(pill, false), label: pill }"),
    ("no-number-fallback", ROW, "return { x0: own, x1, label: String(current) }", "return { x0: own, x1, label: pill }"),
    ("label-off-centre", ROW, "label((pill.x0 + inset + pill.x1) / 2, pill.label, '#ffffff')", "label(pill.x0 + inset + 10, pill.label, '#ffffff')"),
    ("stats-col-sized-by-stats", ROW, "? Math.round(textWidth(STATS_REF, 12.5)) + 10", "? Math.round(textWidth(input.stats ?? STATS_REF, 12.5)) + 10"),
    ("ghost-static", ROW, "GHOST_MIN + (GHOST_MAX - GHOST_MIN) * Math.max(0, Math.min(1, input.progress))", "GHOST_MAX"),
    ("ghost-always-name", ROW, "roomFor(next, isFlat) <= seg ? next : next.split(' ')[0] ?? next", "next"),
    ("tail-no-fade", ROW, "const fade = 0.2 + 0.8 * falloff", "const fade = 1"),
    ("tail-reach-fixed", ROW, "const reachFor = (index: number): number => 1.4 + 0.45 * index", "const reachFor = (index: number): number => 2.2"),
    ("tail-stops-before-arrow", ROW, "c * CELL + 1 < x0 + seg + ARROW;", "c * CELL + 1 < x0 + seg - CELL;"),
    ("twinkle-few", ROW, "dots.push(`<rect class=\"t${Math.floor(noise(r + 31, c) * TWINKLES.length)}\"", "dots.push(`<rect class=\"t${Math.floor(noise(r + 31, c) * 4)}\""),
    ("mascot-one-for-all", ROW, "(String(input.current) as MascotKey)", "('5' as MascotKey)"),
    ("flag-still", os.path.join("hooks", "mascot.ts"), "'.mz-checkered-flag .flag{transform-origin:0 50%;animation:mwave .7s ease-in-out infinite}' +", "''  +"),
    ("tail-density-flat", ROW, "const density = 0.06 + 0.9 * falloff", "const density = 0.6"),
    ("tail-pulse-one-band", ROW, "const band = behind < 1 ? 'w0' : behind < 2.5 ? 'w1' : 'w2'", "const band = 'w2'"),
    ("label-no-bold-allowance", ROW, "textWidth(label, 11) * BOLD + PAD", "textWidth(label, 11) + 14"),
    ("tail-pulse-in-step", ROW, "const lag = (anchor - x) / PULSE_SPEED", "const lag = 0"),
    ("slide-always", ROW, "input.enteredAgoMs < SLIDE_WINDOW_MS && at > 0", "at > 0"),
    ("ghost-progress-dropped", REGISTER, "progress: current === null || medianMs === null || medianMs <= 0 ? null : elapsed / medianMs,", "progress: null,"),
    ("last-pointed", ROW, "const right = isLast ? [[x1, 0], [x1, BAR_H]] : [[x1, 0], [x1 + ARROW, m], [x1, BAR_H]]", "const right = [[x1, 0], [x1 + ARROW, m], [x1, BAR_H]]"),
    ("no-notch", ROW, "const left = isFirst ? [[x0, BAR_H], [x0, 0]] : [[x0 + GAP, BAR_H], [x0 + GAP + ARROW, m], [x0 + GAP, 0]]", "const left = [[x0, BAR_H], [x0, 0]]"),
    ("done-keeps-tail", ROW, "const { clips, parts } = input.isDone\n    ? { clips: [], parts: [field(l.barW, color)] }", "const { clips, parts } = false\n    ? { clips: [], parts: [field(l.barW, color)] }"),
    ("done-keeps-ticks", ROW, "if (input.isDone) {\n      // A full bar is one field: no boundaries.\n      break\n    }", ""),
    ("done-sparse", ROW, "const DONE_DENSITY = 0.8", "const DONE_DENSITY = 0.5"),
    ("done-no-sparks", ROW, "const DONE_SPARKS = 0.16", "const DONE_SPARKS = 0"),
    ("done-one-start", ROW, "const d = Math.floor(noise(c + 53, r + 7) * STARTS.length)", "const d = 0"),
    ("done-delays-lose", ROW, "SPARKS.map((dur, k) => `.s${k}{animation:psk ${dur}s linear infinite}`).join('') +\n  STARTS.map((delay, j) => `.d${j}{animation-delay:-${delay}s}`).join('') +", "STARTS.map((delay, j) => `.d${j}{animation-delay:-${delay}s}`).join('') +\n  SPARKS.map((dur, k) => `.s${k}{animation:psk ${dur}s linear infinite}`).join('') +"),
    ("done-bar-fixed", ROW, "const doneText = input.isDone === true ?", "const doneText = false ?"),
    ("tick-centred-on-boundary", ROW, "points=\"${x.toFixed(1)},3 ${(x + ARROW).toFixed(1)},${BAR_H / 2} ${x.toFixed(1)},${BAR_H - 3}\"", "points=\"${(x - ARROW / 2).toFixed(1)},3 ${(x + ARROW / 2).toFixed(1)},${BAR_H / 2} ${(x - ARROW / 2).toFixed(1)},${BAR_H - 3}\""),
]
unknown = set(sys.argv[1:]) - {m[0] for m in MUTANTS}
if unknown:
    print(f"unknown mutant(s): {', '.join(sorted(unknown))} — nothing run; known: {', '.join(m[0] for m in MUTANTS)}")
    sys.exit(2)
# A clean run first: a mutant can only be judged against a suite that passes as it is.
_b = subprocess.run(["claude", "plugin", "test", "."], cwd=SRC, capture_output=True, text=True, timeout=300)
_bo = _b.stdout + _b.stderr
_bf = [l for l in _bo.splitlines() if l.strip().endswith(" fail")]
_bp = [l for l in _bo.splitlines() if l.strip().endswith(" pass")]
if _b.returncode != 0 or not _bf or int(_bf[-1].split()[0]) != 0 or not _bp or int(_bp[-1].split()[0]) == 0:
    print("baseline: the clean suite does not pass; no mutant can be judged"); sys.exit(1)
print(f"baseline: {int(_bp[-1].split()[0])} pass, 0 fail")
ran = 0
bad = 0
for name, file, old, new in [m for m in MUTANTS if m[0] in set(sys.argv[1:]) or not sys.argv[1:]]:
    d = tempfile.mkdtemp(prefix="mutant-")
    shutil.copytree(SRC, d, dirs_exist_ok=True)
    shutil.rmtree(os.path.join(d, ".claude-plugin", "types"), ignore_errors=True)
    p = os.path.join(d, file)
    s = open(p).read()
    ran += 1
    if old not in s:
        print(f"mutant[{name}]: pattern not found — update the mutant list"); bad += 1; continue
    open(p, "w").write(s.replace(old, new, 1))
    r = subprocess.run(["claude", "plugin", "test", "."], cwd=d, capture_output=True, text=True, timeout=180)
    out = r.stdout + r.stderr
    fails = [l for l in out.splitlines() if l.strip().endswith(" fail")]
    passes = [l for l in out.splitlines() if l.strip().endswith(" pass")]
    n_fail = int(fails[-1].split()[0]) if fails else -1
    n_pass = int(passes[-1].split()[0]) if passes else -1
    verdict = "DETECTED" if n_fail > 0 and n_pass > 0 and "did not load" not in out else ("NOT DETECTED" if n_fail == 0 else "INCONCLUSIVE (module broke)")
    if verdict != "DETECTED": bad += 1
    print(f"mutant[{name}]: {n_fail} fail / {n_pass} pass → {verdict}")
    shutil.rmtree(d, ignore_errors=True)
if ran == 0:
    print("no mutants ran — not a pass"); sys.exit(1)
sys.exit(1 if bad else 0)
