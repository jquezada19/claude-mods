#!/usr/bin/env python3
"""Mutation control for the cache-status mod: each rule broken in a scratch copy must make the suite fail.

Run: python3 tests/mutate.py [mutant-name ...]   (all mutants when none named). Exit 0 only when every
mutant is DETECTED; a mutant that breaks the module (every test failing) is INCONCLUSIVE, not a pass.
claude plugin test ignores this file (it runs *.test.ts[x] only)."""
import os, shutil, subprocess, sys, tempfile

# The mod's folder: the parent of tests/, unless MOD_DIR names another copy.
SRC = os.environ.get("MOD_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MUTANTS = [
    ("offer-every-lapse", "        if (!wasOffered) {", "        if (!wasOffered || prompt > 0) {"),
    ("offer-fixed-size", "kind === 'lapse' && !isGuardOn && prompt >= bigTokens", "kind === 'lapse' && !isGuardOn && prompt >= 150_000"),
    ("offer-with-guard-on", "kind === 'lapse' && !isGuardOn && prompt >= bigTokens", "kind === 'lapse' && prompt >= bigTokens"),
    ("offer-any-size", "kind === 'lapse' && !isGuardOn && prompt >= bigTokens", "kind === 'lapse' && !isGuardOn"),
    ("offer-kept-on-clear", "      await $.state.set(OFFERED, null)\n", ""),
    ("guard-asks-commands", "e.command !== undefined || ", ""),
    ("long-prompt-dropped", "if (!isFilled && e.text.length > DROP_CAP) {", "if (false) {"),
    ("resume-keeps-timer", "if (e.reason === 'clear' || e.reason === 'resume') {", "if (e.reason === 'clear') {"),
    ("restart-window", "seen?.isExpired === true || gap >= prevTtl", "true"),
    ("judged-by-new-ttl", "gap >= prevTtl", "gap >= ttlMs"),
    ("boundary-strict", "gap >= prevTtl", "gap > prevTtl"),
    ("expired-not-lapse", "seen?.isExpired === true || gap >= prevTtl", "gap >= prevTtl"),
    ("miss-under-assumed", "prevBasis === 'assumed'\n          ? null\n          : 'miss'", "false\n          ? null\n          : 'miss'"),
    ("miss-never", "prevBasis === 'assumed'\n          ? null\n          : 'miss'", "true\n          ? null\n          : 'miss'"),
    ("config-ignored", "const configured = await configuredTtl($)\n    const observed", "const configured = null\n    const observed"),
    ("setting-over-env", "  const fromEnv = ttlOf(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))\n\n  if (fromEnv !== null) {", "  const fromEnv = ttlOf(await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'))\n\n  if (false) {"),
    ("force-5m-ignored", "if ((await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1') {", "if (false) {"),
    ("enable-1h-first", "  if ((await $.env.get('ENABLE_PROMPT_CACHING_1H')) === '1') {\n    return { ttlMs: LONG_TTL, basis: 'env' }\n  }\n\n  return null", "  return null"),
    ("observed-ignored", "observed !== null\n        ? { ttlMs: observed, basis: 'observed' }", "false\n        ? { ttlMs: observed, basis: 'observed' }"),
    ("engine-ignored", "if (reported !== null && e.agent_id === undefined) {", "if (false) {"),
    ("engine-any-model", "engine.model === usage.model ? engine.ttlMs : null", "true ? engine.ttlMs : null"),
    ("engine-takes-subagent", "if (reported !== null && e.agent_id === undefined) {", "if (reported !== null) {"),
    ("engine-kept-on-clear", "      await $.state.set(ENGINE, null)\n", ""),
    ("observed-not-carried", "const known = seen?.ttlBasis === 'observed' ?", "const known = false ?"),
    ("split-seen-constant", "split_seen: split !== null,", "split_seen: false,"),
    ("compaction-keeps-expired", "const { isExpired: _wasExpired, ...rest } = seen", "const rest = seen"),
    ("assumed-unlabelled", "${seen.ttlBasis === 'assumed' ? ' (assumed)' : ''}", ""),
    ("expired-is-warm", "seen.isCached === false || seen.isExpired === true || left <= 0", "seen.isCached === false || left <= 0"),
    ("guard-ignores-expired", "const isLapsed = left <= 0 || seen.isExpired === true", "const isLapsed = left <= 0"),
    ("written-share", "written / prompt > RESTART_WRITTEN_SHARE", "true"),
    ("restart-floor", "prompt > RESTART_MIN_TOKENS &&", "true &&"),
    ("model-switch", "isSameModel &&", "true &&"),
    ("compaction-refresh", "promptTokens: tokensAfter ?? 0,", "promptTokens: seen.promptTokens,"),
    ("guard-gate", "!isLapsed || outgoing < bigTokens", "false"),
    ("guard-origin", "(kind !== 'composer' && kind !== 'bridge')", "false"),
    ("clear-reset", "if (e.reason === 'clear' || e.reason === 'resume') {", "if (e.reason === 'resume') {"),
    ("resume-seed", "idle !== undefined", "idle === undefined"),
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
for name, old, new in [m for m in MUTANTS if m[0] in set(sys.argv[1:]) or not sys.argv[1:]]:
    d = tempfile.mkdtemp(prefix="mutant-")
    shutil.copytree(SRC, d, dirs_exist_ok=True)
    shutil.rmtree(os.path.join(d, ".claude-plugin", "types"), ignore_errors=True)
    p = os.path.join(d, "hooks", "register.tsx")
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
