#!/usr/bin/env python3
"""Mutation control for the agents-panel mod: each rule broken in a scratch copy must make the suite fail.

Run: python3 tests/mutate.py [mutant-name ...]   (all mutants when none named). Exit 0 only when
every mutant is DETECTED; a mutant that breaks the module (every test failing) is INCONCLUSIVE, not a pass.
claude plugin test ignores this file (it runs *.test.ts[x] only)."""
import os, shutil, subprocess, sys, tempfile

# The mod's folder: the parent of tests/, unless MOD_DIR names another copy.
SRC = os.environ.get("MOD_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS = os.path.join("hooks", "agents.ts")
DRAW = os.path.join("hooks", "draw.ts")
SPRITE = os.path.join("hooks", "sprite.ts")
REGISTER = os.path.join("hooks", "register.tsx")
LAUNCHES = os.path.join("hooks", "launches.ts")
# The suite's size at the time of writing; a mutant that fails everything is the module breaking.
SUITE = 114

MUTANTS = [
    ("fallback-lifetime", AGENTS, 'const seen = turnId === undefined ? a.steps : (a.turns?.[turnId] ?? 0)', 'const seen = a.steps'),
    ("fallback-replaces", AGENTS, "          tokens: a.tokens + sum.tokens,\n          contextTokens: sum.context,", "          tokens: sum.tokens,\n          contextTokens: sum.context,"),
    ("fallback-not-marked", AGENTS, '          ...(turnId === undefined ? {} : { turns: noteTurn(a.turns, turnId, FELL_BACK) }),', '          ...{},'),
    ("late-began-ignored", AGENTS, '    (began === undefined || found.endedAt === undefined || began >= found.endedAt)', '    (began === undefined || found.endedAt === undefined || began >= 0)'),
    ("older-turn-resumes", AGENTS, '  const isNewTurn = turnId !== undefined && seen === undefined && turnId !== found.turnId', '  const isNewTurn = turnId !== undefined && turnId !== found.turnId'),
    ("began-at-end", REGISTER, '    const began = e.agentId === undefined ? 0 : await $.clock.now()', '    const began = e.agentId === undefined ? 0 : Number.MAX_SAFE_INTEGER'),
    ("turns-unbounded", AGENTS, '  const keys = Object.keys(rest).slice(-(TURNS_KEPT - 1))', '  const keys = Object.keys(rest)'),
    ("legacy-ignored", AGENTS, '  if (a.turns !== undefined || (turnSteps === undefined && fellBack === undefined)) {', "  if (a.turns !== undefined || a.id !== '\\u0000') {"),
    ("early-turns-not-held", REGISTER, '        : { turns: sum === null ? prev!.turns! : noteTurn(prev?.turns, turnId, (prev?.turns?.[turnId] ?? 0) + 1) }),', '        : {}),'),
    ("late-after-fallback-counts", AGENTS, '  if (seen === FELL_BACK) {', "  if (seen === FELL_BACK && id === '\\u0000') {"),
    ("early-turns-dropped", REGISTER, '              ...(kept.turns === undefined ? {} : { turns: kept.turns }),', '              ...{},'),
    ("check-counts-allow", AGENTS, "  if (i < 0 || decision === 'allow') {\n    return list\n  }\n\n  const a = list[i]!\n  const was", "  if (i < 0) {\n    return list\n  }\n\n  const a = list[i]!\n  const was"),
    ("ask-not-pending", AGENTS, "const pending = decision === 'ask' ? [...(a.pending ?? []).filter(one => one !== toolUseId), toolUseId] : a.pending", "const pending = a.pending"),
    ("call-done-ignored", REGISTER, "await queue($, list => applyCallDone(list, id, call))", "await queue($, list => list)"),
    ("detail-step-keeps-pending", AGENTS, "  const a = settled(list[i]!)\n  const tools", "  const a = list[i]!\n  const tools"),
    ("early-checks-dropped", REGISTER, "              ...(kept.checks === undefined ? {} : { checks: kept.checks }),\n", ""),
    ("step-keeps-awaiting", AGENTS, "    ...settled(withoutMissing(a)),\n    model: usage.model", "    ...withoutEngineStatus(withoutMissing(a)),\n    model: usage.model"),
    ("end-keeps-awaiting", AGENTS, "    ...settled(a),\n    status: reason === 'answer'", "    ...withoutEngineStatus(a),\n    status: reason === 'answer'"),
    ("badge-hidden", DRAW, "const awaiting = (row.pending ?? []).length > 0 ? ' · awaiting approval' : ''", "const awaiting = ''"),
    ("command-args-shown", AGENTS, "const shown = key === 'command' ? programOf(value)", "const shown = key === 'command' ? value"),
    ("url-query-shown", AGENTS, "key === 'url' ? urlShape(value)", "key === 'url' ? value"),
    ("detail-needs-usage", REGISTER, "if (sum === null && tools.length === 0 && stop !== 'max_tokens') {", "if (sum === null) {"),
    ("early-complete-dropped", REGISTER, "      return end === undefined\n        ? opened", "      return true\n        ? opened"),
    ("complete-not-kept", REGISTER, "kept[id] = { ...prev, ended: { reason, at, turnId, usage, answer: taskOf(answer) } }", "kept[id] = { ...prev }"),
    ("early-answer-unclipped", REGISTER, "answer: taskOf(answer) } }", "answer } }"),
    ("early-tools-dropped", REGISTER, "                ...(kept.tools === undefined ? {} : { tools: kept.tools }),\n", ""),
    ("resume-keeps-old-task", REGISTER, "            return { ...rest, ...task }", "            return reopenRow(a, at)"),
    ("open-uncapped", REGISTER, "[...live, a.id].slice(-OPEN_CAP)", "[...live, a.id]"),
    ("opens-kept-on-clear", REGISTER, "hasAutoOpened: false, open: [] }", "hasAutoOpened: false }"),
    ("panel-unserialized", REGISTER, "  panelChain = run.catch(() => undefined)", "  panelChain = Promise.resolve()"),
    ("tools-unbounded", AGENTS, "...uses.map(toolLine)].slice(-TOOLS_KEPT)", "...uses.map(toolLine)]"),
    ("cutoff-ignored", AGENTS, "...(stopReason === 'max_tokens' ? { isCutOff: true } : {})", "...{}"),
    ("answer-unclipped", AGENTS, "detail: { ...a.detail, answer: clip(answer, TEXT_KEPT) }", "detail: { ...a.detail, answer }"),
    ("task-not-kept", REGISTER, "      ...(e.prompt.trim() === '' ? {} : { detail: { task: taskOf(e.prompt) } }),\n", ""),
    ("details-open-all", REGISTER, "!opened.has(a.id) || a.detail === undefined", "opened.size === 0 || a.detail === undefined"),
    ("cut-stat-off", DRAW, "const cut = row.detail?.isCutOff === true ? ' · cut off' : ''", "const cut = ''"),
    ("early-answer-dropped", REGISTER, "run.id, end.answer ?? '')", "run.id, '')"),
    ("context-summed", AGENTS, "contextTokens: sum.context,\n    tokens: a.tokens + sum.tokens,", "contextTokens: a.contextTokens + sum.context,\n    tokens: a.tokens + sum.tokens,"),
    ("tokens-no-cache-write", AGENTS, "const tokens = i + o + r + w", "const tokens = i + o + r"),
    ("aborted-is-done", AGENTS, "status: reason === 'answer' ? 'done' : 'failed'", "status: reason === 'aborted' || reason === 'answer' ? 'done' : 'failed'"),
    ("step-revives", AGENTS, "const next: AgentRun = {\n    ...settled(withoutMissing(a)),\n    model: usage.model || model || a.model,", "const next: AgentRun = {\n    ...settled(withoutMissing(a)),\n    status: 'running',\n    model: usage.model || model || a.model,"),
    ("resume-any-turn", AGENTS, "    isFinished &&\n    isNewTurn &&", "    isFinished &&"),
    ("reopen-no-shift", AGENTS, "startedAt: at - (endedAt - a.startedAt)", "startedAt: a.startedAt"),
    ("parked-ignored", AGENTS, "const parked = PARKED.has(s) ? (s as NonNullable<AgentRun['engineStatus']>) : undefined", "const parked = undefined"),
    ("step-keeps-parked", AGENTS, "...settled(withoutMissing(a)),\n    model: usage.model", "...withoutMissing(a),\n    model: usage.model"),
    ("early-not-folded", REGISTER, "        ...(kept === undefined\n          ? {}", "        ...(true\n          ? {}"),
    ("resume-reason-ignored", REGISTER, "if (e.reason === 'clear' || e.reason === 'resume') {\n      await queue(", "if (e.reason === 'clear') {\n      await queue("),
    ("early-kept-on-clear", REGISTER, "      await $.state.set(EARLY, {})\n", ""),
    ("step-forgets-turn", AGENTS, '          turns: noteTurn(a.turns, turnId, (seen ?? 0) + 1),', '          turns: a.turns,'),
    ("complete-keeps-parked", AGENTS, "    ...settled(a),\n    status: reason === 'answer'", "    ...a,\n    status: reason === 'answer'"),
    ("spawn-resume-ignored", REGISTER, "if (resumedId !== undefined) {", "if (false) {"),
    ("clear-keeps-finished", REGISTER, "list.filter(a => a.status === 'running'))", "list)"),
    ("fallback-skipped", AGENTS, 'const sum = seen === 0 && usage !== null ? sumUsage(usage) : null', 'const sum = null'),
    ("fallback-over-steps", AGENTS, 'const sum = seen === 0 && usage !== null ? sumUsage(usage) : null', 'const sum = usage !== null ? sumUsage(usage) : null'),
    ("percent-any-model", AGENTS, "if (modelKey(row.model) !== modelKey(session.model)) {\n    return null\n  }", ""),
    ("list-failed-is-done", AGENTS, "return { ...settled(withoutMissing(a)), status: 'failed' as const, endedAt: at }", "return { ...settled(withoutMissing(a)), status: 'done' as const, endedAt: at }"),
    ("lost-failed-swapped", AGENTS, "status: a.steps > 0 ? ('failed' as const) : ('lost' as const)", "status: a.steps > 0 ? ('lost' as const) : ('failed' as const)"),
    ("missing-from-start", AGENTS, "if (at - a.missingSince >= MISSING_MS) {", "if (at - a.startedAt >= MISSING_MS) {"),
    ("cap-unbounded", AGENTS, "while (out.length > ROW_CAP) {", "while (false) {"),
    ("cap-drops-running", AGENTS, "const i = out.findIndex(a => a.status !== 'running')", "const i = 0"),
    ("xml-off", DRAW, "s.replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' })[c] ?? c)", "s"),
    ("crab-fit-off", DRAW, "Math.min(n, MAX_BAND, Math.max(1, Math.floor((W - 150) / 36)))", "Math.min(n, MAX_BAND)"),
    ("throttle-on-forced", REGISTER, "if (!force && at - last < RECONCILE_MS) {", "if (at - last < RECONCILE_MS) {"),
    ("reconcile-every-tick", REGISTER, "if (!force && at - last < RECONCILE_MS) {", "if (false) {"),
    ("ended-from-tick", REGISTER, "const at = await $.clock.now()\n      const usage = e.usage ?? null", "const { value: at = 0 } = await $.state.get(NOW)\n      const usage = e.usage ?? null"),
    ("spawn-answer-dropped", REGISTER, "    if (options.autoOpen !== false) {\n      await autoOpen($)\n    }\n\n    return started", "    if (options.autoOpen !== false) {\n      await autoOpen($)\n    }\n\n    return { model: started.model }"),
    ("row-on-deny", REGISTER, "if (started.deny !== undefined || started.agentId === undefined) {\n      return started\n    }", "if (started.agentId === undefined && started.deny === undefined) {\n      return started\n    }"),
    ("row-without-id", REGISTER, "if (started.deny !== undefined || started.agentId === undefined) {\n      return started\n    }", "if (started.deny !== undefined) {\n      return started\n    }"),
    ("autoopen-always", REGISTER, "if (p.hasAutoOpened) {\n    return\n  }", "if (false) {\n    return\n  }"),
    ("band-hides-beneath", REGISTER, "<Box flexDirection=\"column\">\n          {beneath}\n          <Box flexDirection=\"row\" alignItems=\"center\" gap={1}>", "<Box flexDirection=\"column\">\n          <Box flexDirection=\"row\" alignItems=\"center\" gap={1}>"),
    ("band-while-idle", REGISTER, "if (e.props.hasSurvey || running.length === 0) {\n      return beneath\n    }", "if (e.props.hasSurvey) {\n      return beneath\n    }"),
    ("autoopen-no-cas", REGISTER, "  if (!isSet) {\n    return\n  }\n\n  await $.ui.open({ id: PANE, title: 'Agents' })", "  await $.ui.open({ id: PANE, title: 'Agents' })"),
    ("reconcile-claim-late", REGISTER, "const { isSet } = await $.state.set(LAST_RECONCILE, at, { ifVersion: version })", "const isSet = true"),
    ("percent-divide-first", AGENTS, "Math.round((row.contextTokens * 100) / session.window)", "Math.round((row.contextTokens / session.window) * 100)"),
    ("modelkey-greedy", AGENTS, "replace(/\\[[^\\]]*\\]$/, '')", "replace(/\\[.*\\]$/, '')"),
    ("strip-uncapped", DRAW, "export const MAX_STRIP = 6", "export const MAX_STRIP = 12"),
    ("external-reconciled", AGENTS, "if (a.status !== 'running' || a.external !== undefined) {", "if (a.status !== 'running') {"),
    ("variant-unassigned", REGISTER, "        variant: list.filter(a => a.variant !== undefined).length,\n", ""),
    ("variant-not-drawn", DRAW, "  const costume = costumeOf(row.type, row.variant)\n", "  const costume = costumeOf(row.type)\n"),
    ("rotation-off", AGENTS, "return variant === undefined ? 'plain' : CLAWDS[variant % CLAWDS.length]!", "return 'plain'"),
    ("composer-off", AGENTS, "  if (type.startsWith('buddy:') && bare.startsWith('composer')) return 'composer'\n", ""),
    ("grid-fixed-offset", SPRITE, "const left = Math.floor((30 - width) / 2)", "const left = 5"),
    ("grok-off", AGENTS, "  if (type.startsWith('buddy:') && /^(cursor-)?grok/.test(bare)) return 'grok'\n", ""),
    ("gemini-off", AGENTS, "  if (type.startsWith('buddy:') && bare.startsWith('gemini')) return 'gemini'\n", ""),
    ("panda-off", AGENTS, "  if (type.startsWith('buddy:') && bare.startsWith('kimi')) return 'panda'\n", ""),
    ("deadline-ignored", REGISTER, "} else if (x.deadline !== null && at > x.deadline) {", "} else if (false) {"),
    ("meta-status-ignored", REGISTER, "return doneStatus(await $.fs.read(doneFile))", "return 'done'"),
    ("background-closed-on-result", REGISTER, "} else if (!isBackground) {", "} else if (!isBackground || e.command !== '\\u0000') {"),
    # error-is-done retired 2026-10-12: equivalent since the ghost-row guard fails every error without a task id
    # first; the foreground test still pins an errored call to failed through that guard.
    ("error-guard-off", REGISTER, "if (ran.deny !== undefined || (ran.isError === true && taskId === '')) {", "if (ran.deny !== undefined) {"),
    ("codex-in-subagent", REGISTER, ".filter(l => e.agentId === undefined || !l.type.startsWith('codex:'))", ""),
    ("auto-background-closed", REGISTER, "const isBackground = e.run_in_background === true || taskId !== ''", "const isBackground = e.run_in_background === true"),
    ("notification-ignored", REGISTER, "const ends = e.text.includes('<task-notification>') ? parseNotifications(e.text) : []", "const ends: { toolUseId: string; status: string }[] = []"),
    ("notification-over-meta", REGISTER, "const status = (await landed($, a.external.doneFile)) ?? (end.status === 'completed' ? 'done' : 'failed')", "const status = end.status === 'completed' ? 'done' : 'failed'"),
    ("notification-any-row", REGISTER, "!a.id.startsWith(`${end.toolUseId}:`)", "false"),
    ("unresolved-path-kept", LAUNCHES, "return s.includes('$') || s.includes('`') || !s.startsWith('/') ? null : s", "return s"),
    ("relay-default-model", LAUNCHES, ": /--repo\\b/.test(args) ? 'cursor' : RELAY_DEFAULT_MODEL", ": RELAY_DEFAULT_MODEL"),
    ("meta-uncut", DRAW, "export const cardType = (row: AgentRun): string => short(bareType(row.type), 48)", "export const cardType = (row: AgentRun): string => bareType(row.type)"),
    # 2026-10-10: Codex rows got no deadline and lost notifications left them running forever
    ("codex-no-default", LAUNCHES, "launch.type.startsWith('codex:') ? CODEX_DEFAULT_MS : 0", "0"),
    ("wrapper-ignored", LAUNCHES, "const wrap = wrapperTimeoutMs(command, at)", "const wrap = null"),
    ("wrapper-crosses-commands", LAUNCHES, "const segment = before.slice(cut + 1)", "const segment = before"),
    ("quoted-separator-cuts", LAUNCHES, "masked.lastIndexOf(c)", "before.lastIndexOf(c)"),
    ("stop-sweep-off", REGISTER, "      if (Array.isArray(live)) {", "      if (false) {"),
    ("stop-sweep-ignores-in-flight", REGISTER, "x.taskId === undefined || inFlight.has(x.taskId)", "x.taskId === undefined"),
    ("task-id-not-kept", REGISTER, "              ...(taskId !== '' ? { taskId } : {}),", ""),
    # 2026-10-12: the refused /agents threw before the clock started; help lookups counted as Codex agents
    ("clock-after-register", REGISTER, "    const started = await next(e)\n    // The clock first", "    const started = await next(e)\n    await $.command.register({ name: COMMAND, description: '' })\n    // The clock first"),
    ("help-is-a-run", LAUNCHES, "return READS_CLI.test(args) || NAMES_IT.test(head)", "return NAMES_IT.test(head)"),
    ("mention-is-a-run", LAUNCHES, "return READS_CLI.test(args) || NAMES_IT.test(head)", "return READS_CLI.test(args)"),
    ("help-flag-in-quotes", LAUNCHES, "const tail = masked.slice(end)", "const tail = command.slice(end)"),
    ("unknown-tokens-zero", AGENTS, "tokens: known.length === 0 ? null :", "tokens:"),
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
    r = subprocess.run(["claude", "plugin", "test", "."], cwd=d, capture_output=True, text=True, timeout=300)
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
