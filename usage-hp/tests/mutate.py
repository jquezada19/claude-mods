#!/usr/bin/env python3
"""Mutation control for the usage-hp mod: each rule broken in a scratch copy must make the suite fail.

Run: python3 tests/mutate.py [mutant-name ...]   (all mutants when none named). A clean baseline runs
first; a mutant counts as DETECTED only when some tests fail and the module still loaded (some pass).
claude plugin test ignores this file (it runs *.test.ts[x] only)."""
import os, shutil, subprocess, sys, tempfile

# The mod folder: the parent of tests/, or USAGE_HP_DIR when set.
SRC = os.environ.get("USAGE_HP_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTER = os.path.join("hooks", "register.tsx")
MUTANTS = [
    ("collapsed-draws-all", REGISTER, "      const { Text } = $.ui.resolve(e)\n\n      return <Text dimColor>♥ HP</Text>\n    }\n", "      return next(e)\n    }\n"),
    ("narrow-ignored", REGISTER, "e.props.bodyColumns < NARROW_COLUMNS ? CELLS / 2 : CELLS", "false ? CELLS / 2 : CELLS"),
    ("narrow-bar-full-gap", REGISTER, "<Text dimColor>{'░'.repeat(n - full - ghost)}</Text>", "<Text dimColor>{'░'.repeat(CELLS - full - ghost)}</Text>"),
    ("measure-ignored", REGISTER, "if (e.changed.includes('rateLimits')) {", "if (e.changed.includes('rateLimits') && e.changed.length < 0) {"),
    ("measure-on-anything", REGISTER, "if (e.changed.includes('rateLimits')) {", "if (e.changed.length > 0) {"),
    ("refresh-unqueued", REGISTER, "  inTurn($, () => refresh($, cause, isRead))", "  refresh($, cause, isRead)"),
    ("chain-poisoned", REGISTER, "  refreshing = run.catch(() => undefined)", "  refreshing = run"),
    ("turn-end-bypasses-queue", REGISTER, "      await synced($)\n      await queueRefresh($, 'turn')", "      await synced($)\n      await refresh($, 'turn')"),
    ("ledger-off-chain", REGISTER, "      await inTurn($, async () => {\n        const { value: isSeen = false }", "      await (async () => {\n        const { value: isSeen = false }"),
    ("held-measure-reread", REGISTER, "      if (!isHeld) {", "      if (!isHeld || held.length >= 0) {"),
    ("quiet-ignores-budget", REGISTER, "now - cached.at < OTHERS_TTL && cached.ident === ident", "now - cached.at < OTHERS_TTL"),
    ("quiet-ignores-month", REGISTER, "stored.limitUsd, monthOf(now)])", "stored.limitUsd])"),
    ("quiet-not-shared", REGISTER, "          quietRange = { at: now, ident, budget: freshRange($, now).catch(() => null) }", "          const got = await freshRange($, now).catch(() => null)\n          quietRange = { at: now, ident, budget: Promise.resolve(got) }"),
    ("quiet-cache-forever", REGISTER, "const isCurrent = cached !== null && now - cached.at < OTHERS_TTL", "const isCurrent = cached !== null && now - cached.at >= 0"),
    ("quiet-cache-off", REGISTER, "const isCurrent = cached !== null && now - cached.at < OTHERS_TTL", "const isCurrent = cached !== null && now - cached.at < 0"),
    ("fable-header-misnamed", REGISTER, "const FABLE_HEADER = 'anthropic-ratelimit-unified-7d_oi'", "const FABLE_HEADER = 'anthropic-ratelimit-unified-7d'"),
    ("fable-share-as-percent", REGISTER, "percentUsed: Math.min(100, Math.round(share * 1000) / 10),", "percentUsed: Math.min(100, share),"),
    ("fable-bad-figure-kept", REGISTER, "  if (!Number.isFinite(share) || share < 0) {\n    return null", "  if (share < 0) {\n    return null"),
    ("fable-any-host", REGISTER, "if (next.origin.plugin === 'engine' || ANTHROPIC_API.test(e.url)) {", "if (next.origin.plugin !== '' || ANTHROPIC_API.test(e.url)) {"),
    ("fable-not-merged", REGISTER, "    ...(fable === null || usage.rateLimits.some(", "    ...(fable === null || fable !== null || usage.rateLimits.some("),
    ("fable-engine-row-doubled", REGISTER, "one.kind === FABLE_KIND || one.kind === ENGINE_FABLE_KIND)", "one.kind === FABLE_KIND)"),
    ("fable-before-engine-windows", REGISTER, "    ...usage.rateLimits.map(one => ({ ...one })),\n    ...(fable === null", "    ...(fable === null ? [] : [{ ...fable }]),\n    ...usage.rateLimits.map(one => ({ ...one })),\n    ...(fable !== null"),
    ("fable-in-held-compare", REGISTER, "const held = (reading?.windows ?? []).filter(one => one.kind !== FABLE_KIND)", "const held = reading?.windows ?? []"),
    ("fable-label", REGISTER, "[FABLE_KIND]: 'FB',", "[FABLE_KIND]: 'FABLE',"),
    ("fable-latches-seat", REGISTER, "const isSeen = wasSeen || usage.rateLimits.length > 0", "const isSeen = wasSeen || windows.length > 0"),
    ("fable-never-over", REGISTER, "    cause !== 'start' &&\n    heldFable?.resetsAt !== undefined &&", "    cause === 'never' &&\n    heldFable?.resetsAt !== undefined &&"),
    ("fable-reset-forgotten", REGISTER, "...(window.resetsAt === undefined && held?.resetsAt !== undefined ? { resetsAt: held.resetsAt } : {}),", "...{},"),
    ("fable-reset-unbounded", REGISTER, "reset > 0 && reset * 1000 <= 8.64e15", "reset > 0"),
    ("week-pace-hourly", REGISTER, "(isWeekly(one.kind) && resetIn !== null", "(false && resetIn !== null"),
    ("week-pace-from-day-one", REGISTER, "elapsed < WEEK_PACE_MIN || percentUsed <= 0", "elapsed < 0 || percentUsed <= 0"),
    ("week-pace-ignores-reset", REGISTER, "  return emptyIn >= resetIn\n    ? ' · lasts past reset'\n    : ` · empty in ~${until(emptyIn)} at this week's pace`", "  return emptyIn < 0\n    ? ' · lasts past reset'\n    : ` · empty in ~${until(emptyIn)} at this week's pace`"),
    ("week-pace-fable-left-out", REGISTER, "kind.startsWith('seven_day')", "kind === 'seven_day'"),
    ("off-elsewhere-ignored", REGISTER, "      if (!isStored(stored)) {\n        budget = null", "      if (!isStored(stored)) {\n        budget = budget"),
]
unknown = set(sys.argv[1:]) - {m[0] for m in MUTANTS}
if unknown:
    print(f"unknown mutant(s): {', '.join(sorted(unknown))} — nothing run; known: {', '.join(m[0] for m in MUTANTS)}")
    sys.exit(2)

def run(cwd):
    r = subprocess.run(["claude", "plugin", "test", "."], cwd=cwd, capture_output=True, text=True, timeout=300)
    out = r.stdout + r.stderr
    fails = [l for l in out.splitlines() if l.strip().endswith(" fail")]
    passes = [l for l in out.splitlines() if l.strip().endswith(" pass")]
    return r.returncode, out, (int(fails[-1].split()[0]) if fails else -1), (int(passes[-1].split()[0]) if passes else -1)

code, _, bf, bp = run(SRC)
if code != 0 or bf != 0 or bp <= 0:
    print("baseline: the clean suite does not pass; no mutant can be judged"); sys.exit(1)
print(f"baseline: {bp} pass, 0 fail")
ran = bad = 0
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
    _, out, n_fail, n_pass = run(d)
    verdict = "DETECTED" if n_fail > 0 and n_pass > 0 and "did not load" not in out else ("NOT DETECTED" if n_fail == 0 else "INCONCLUSIVE (module broke)")
    if verdict != "DETECTED": bad += 1
    print(f"mutant[{name}]: {n_fail} fail / {n_pass} pass → {verdict}")
    shutil.rmtree(d, ignore_errors=True)
if ran == 0:
    print("no mutants ran — not a pass"); sys.exit(1)
sys.exit(1 if bad else 0)
