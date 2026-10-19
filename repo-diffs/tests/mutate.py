#!/usr/bin/env python3
"""Mutation control for the repo-diffs mod: each rule broken in a scratch copy must make the suite fail.

Run: python3 tests/mutate.py [mutant-name ...]   (all mutants when none named). A clean baseline runs
first; a mutant counts as DETECTED only when some tests fail and the module still loaded (some pass).
claude plugin test ignores this file (it runs *.test.ts[x] only)."""
import os, shutil, subprocess, sys, tempfile

# the mod root is the parent of tests/; REPO_DIFFS_SRC overrides it
SRC = os.environ.get("REPO_DIFFS_SRC") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTER = os.path.join("hooks", "register.tsx")
MUTANTS = [
    ("leases-unreadable-empties", REGISTER, "    entries = await $.fs.list(dir)\n  } catch {\n    return null\n  }", "    entries = await $.fs.list(dir)\n  } catch {\n    return new Map()\n  }"),
    ("lease-any-session", REGISTER, "if (l.session_id === sid && typeof l.worktree === 'string') {", "if (typeof l.worktree === 'string') {"),
    ("origin-head-ignored", REGISTER, "const remoteDefault = head && head.exitCode === 0 ? head.stdout.trim() : ''", "const remoteDefault = head && head.exitCode === 42 ? head.stdout.trim() : ''"),
    ("symlink-followed", REGISTER, '    chunk.forEach((p, k) => (isLink[k] ? links : plain).push(p))', '    chunk.forEach(p => plain.push(p))'),
    ("one-bad-path-drops-all", REGISTER, '    if (batch.length === 1) return\n', '    return\n'),
    ("turn-cap-off", REGISTER, 'if (cur.paths.length >= LAST_TURN_CAP) return', 'if (cur.paths.length >= LAST_TURN_CAP * 1000) return'),
    ("turn-full-kept", REGISTER, 'await update($, turnEdits, t => ({ gen: (t?.gen ?? 0) + 1, paths: [], isFull: false }))', 'await update($, turnEdits, t => ({ gen: (t?.gen ?? 0) + 1, paths: [], isFull: t?.isFull ?? false }))'),
    ("lease-link-skipped", REGISTER, "if (entry.kind !== 'dir' && entry.isLink !== true) continue", "if (entry.kind !== 'dir') continue"),
    ("turn-cap-race", REGISTER, 'if (cur.paths.length >= LAST_TURN_CAP) return cur.isFull ? cur : { ...cur, isFull: true }', 'if (cur.paths.length >= LAST_TURN_CAP + 1) return cur.isFull ? cur : { ...cur, isFull: true }'),
    ("bisect-off", REGISTER, '    await hashAll(batch.slice(0, half))\n    await hashAll(batch.slice(half))', '    for (const p of batch) await hashAll([p])'),
    ("legacy-not-carried", REGISTER, '    if (Array.isArray(oldPaths) && oldPaths.length > 0) {', '    if (Array.isArray(oldPaths) && oldPaths.length > 1e9) {'),
    ("stamp-no-blob", REGISTER, "|${f.side ?? ''}|${f.blob ?? ''}`", "|${f.side ?? ''}`"),
    ("stamp-no-side", REGISTER, "|${f.side ?? ''}|${f.blob ?? ''}`", "|${f.blob ?? ''}`"),
    ("mark-hashes-disk", REGISTER, "const id = f.blob ?? (f.status === 'D'", "const id = (f.status === 'D'"),
    ("selected-not-hashed", REGISTER, "  await noteSelectedBlob($)\n  await loadDiff($, true)", "  await loadDiff($, true)"),
    ("watch-ignores-closed-pane", REGISTER, "  if (!(await isPaneUp($))) {\n    watchTimer?.cancel()", "  if (!(await isPaneUp($)) && watchTicks < 0) {\n    watchTimer?.cancel()"),
    ("clear-no-rearm", REGISTER, "if (e.reason === 'clear' || e.reason === 'resume') await update($, autoOpened, () => false)", "if (e.reason === 'logout') await update($, autoOpened, () => false)"),
    ("turn-unfiltered", REGISTER, "    if (scope === 'turn') {", "    if (scope === 'turn' && files.length < 0) {"),
    ("denied-edit-recorded", REGISTER, 'if (edited !== undefined && result.deny === undefined && result.isError !== true) {', 'if (edited !== undefined && result.isError !== true) {'),
    ("errored-edit-recorded", REGISTER, 'if (edited !== undefined && result.deny === undefined && result.isError !== true) {', 'if (edited !== undefined && result.deny === undefined) {'),
    ("straggler-recorded", REGISTER, 'if (cur.gen !== gen || cur.paths.includes(key)) return cur', 'if (cur.paths.includes(key)) return cur'),
    ("raw-path-key", REGISTER, "      const key = await gitKeyOf($, edited)", "      const key = edited"),
    ("commit-in-turn", REGISTER, "const commit = view.commit && scope !== 'turn' ?", "const commit = view.commit ?"),
    ("subagent-turn-resets", REGISTER, '    if (e.agentId === undefined) {\n      await update($, turnEdits', "    if (e.agentId === undefined || e.text !== '\\u0000') {\n      await update($, turnEdits"),
    ("turn-never-resets", REGISTER, 't => ({ gen: (t?.gen ?? 0) + 1, paths: [], isFull: false })', 't => ({ gen: (t?.gen ?? 0) + 1, paths: t?.paths ?? [], isFull: false })'),
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
