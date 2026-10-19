#!/usr/bin/env python3
"""Builds a throwaway git repo that stresses the Repo diffs pane.

    python3 make_stress_repo.py <dir>     # creates <dir>/origin.git, <dir>/app, <dir>/app-rebase

<dir> must not exist, or must be a directory this script made earlier (it carries a
.stress-repo marker); anything else is refused, never deleted.

<dir>/app is a clone of a bare origin with develop and qa, and a branch per kind
of change the pane has to draw. It is left on feature/big-refactor with staged,
unstaged and untracked work on top. <dir>/app-rebase is a linked worktree
stopped part-way through a rebase with conflicts. Everything is fake and local;
nothing is pushed anywhere but the bare origin inside <dir>.
"""
import os
import random
import shutil
import subprocess
import sys

random.seed(1234)
MARKER = '.stress-repo'  # written on creation; only a directory carrying it is ever deleted


def git(cwd, *args, ok=(0,)):
    env = {**os.environ, 'GIT_AUTHOR_NAME': 'Stress Bot', 'GIT_AUTHOR_EMAIL': 'stress@example.invalid',
           'GIT_COMMITTER_NAME': 'Stress Bot', 'GIT_COMMITTER_EMAIL': 'stress@example.invalid'}
    r = subprocess.run(['git', '-c', 'init.defaultBranch=develop', '-c', 'core.autocrlf=false', *args],
                       cwd=cwd, env=env, capture_output=True, text=True)
    if r.returncode not in ok:
        sys.exit(f'git {" ".join(args)} failed in {cwd}: {r.stderr.strip()}')
    return r.stdout


def write(root, rel, text, mode=None):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path) or root, exist_ok=True)
    with open(path, 'w', newline='') as f:
        f.write(text)
    if mode:
        os.chmod(path, mode)


def write_bytes(root, rel, data):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path) or root, exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)


def ts_module(name, n, salt=0):
    lines = [f"// {name}: generated for the repo-diffs stress test", "import { EventEmitter } from 'events'", '']
    for i in range(n):
        lines.append(f"export function {name.replace('-', '_')}Step{i}(input: number): number {{")
        lines.append(f'  const scaled = input * {i + 1 + salt}')
        lines.append(f'  return scaled + {i * 7 % 13}')
        lines.append('}')
        lines.append('')
    return '\n'.join(lines)


def commit(cwd, msg):
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', msg, ok=(0, 1))


def edit_lines(root, rel, every=5, tag='changed'):
    path = os.path.join(root, rel)
    with open(path) as f:
        lines = f.read().split('\n')
    for i in range(0, len(lines), every):
        if lines[i].strip():
            lines[i] = lines[i] + f'  // {tag}'
    with open(path, 'w') as f:
        f.write('\n'.join(lines))


def main(out):
    if os.path.lexists(out):
        if not os.path.isdir(out) or os.path.islink(out) or not os.path.isfile(os.path.join(out, MARKER)):
            sys.exit(f'refusing to replace {out}: it exists and has no {MARKER} marker '
                     '(this script only deletes a directory it created; pick a new path)')
        shutil.rmtree(out)
    os.makedirs(out)
    write(out, MARKER, 'created by make_stress_repo.py; safe for it to delete and regenerate\n')
    origin = os.path.join(out, 'origin.git')
    app = os.path.join(out, 'app')
    git(out, 'init', '-q', '--bare', origin)
    git(out, 'clone', '-q', origin, app)
    git(app, 'checkout', '-q', '-b', 'develop')

    # ── develop: a believable tree, ~320 files
    modules = ['calendar', 'orders', 'events', 'profile', 'billing', 'push', 'auth', 'search', 'media', 'settings']
    for m in modules:
        for k in range(24):
            write(app, f'src/screens/{m}/components/{m.title()}Part{k}.tsx', ts_module(f'{m}-part{k}', 6))
        for k in range(6):
            write(app, f'src/store/{m}/actions/{m}Action{k}.ts', ts_module(f'{m}-action{k}', 4))
    write(app, 'README.md', '# Stress app\n\nFake repo for the repo-diffs pane.\n')
    write(app, 'docs/windows-notes.txt', 'line one\r\nline two\r\nline three\r\n')
    write(app, 'scripts/build.sh', '#!/bin/sh\necho build\n')
    write(app, 'src/huge/generated-table.ts', '\n'.join(f'export const ROW_{i} = {i}' for i in range(4000)) + '\n')
    write_bytes(app, 'assets/logo.png', bytes(random.getrandbits(8) for _ in range(4096)))
    write(app, 'config/target.json', '{"env": "test"}\n')
    os.symlink('target.json', os.path.join(app, 'config/current.json'))
    write(app, 'src/legacy/OldBillingBridge.ts', ts_module('old-billing', 10))
    write(app, 'src/legacy/OldPushBridge.ts', ts_module('old-push', 10))
    commit(app, 'chore: initial app')
    git(app, 'push', '-q', '-u', 'origin', 'develop')
    git(app, 'branch', '-q', 'qa')
    git(app, 'push', '-q', 'origin', 'qa')
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/develop')

    def branch(name, base='develop'):
        git(app, 'checkout', '-q', '-B', name, f'origin/{base}' if base in ('develop', 'qa') else base)

    # 1. small fix: three edits and one new file, two commits
    branch('feature/1234-calendar-ok-goes-back')
    edit_lines(app, 'src/screens/calendar/components/CalendarPart3.tsx', 9)
    edit_lines(app, 'src/store/calendar/actions/calendarAction1.ts', 7)
    commit(app, 'fix(calendar): OK on the alert goes back')
    edit_lines(app, 'src/screens/events/components/EventsPart0.tsx', 11)
    write(app, 'src/screens/calendar/test/CalendarDetailsScreen.test.tsx', ts_module('calendar-test', 12))
    commit(app, 'test(calendar): cover the alert')

    # 2. big refactor: 200+ files edited, some deleted and added, 30 commits
    branch('feature/big-refactor')
    files = [os.path.relpath(os.path.join(d, f), app) for d, _, fs in os.walk(os.path.join(app, 'src/screens')) for f in fs]
    random.shuffle(files)
    for c in range(30):
        for rel in files[c * 7:(c + 1) * 7]:
            edit_lines(app, rel, random.choice([3, 4, 6]), tag=f'refactor {c}')
        if c % 5 == 0:
            os.remove(os.path.join(app, files[-(c + 1)]))
            write(app, f'src/features/shared/hooks/useShared{c}.ts', ts_module(f'shared{c}', 8))
        commit(app, f'refactor: pass {c} over screens')

    # 3. renames and moves: whole folders, some renamed and edited
    branch('feature/renames-and-moves')
    for k in range(20):
        dst = f'src/features/billing/{"actions" if k < 6 else "components"}/Billing{k}.ts'
        os.makedirs(os.path.join(app, os.path.dirname(dst)), exist_ok=True)
        git(app, 'mv', f'src/store/billing/actions/billingAction{k}.ts' if k < 6 else f'src/screens/billing/components/BillingPart{k}.tsx', dst)
    edit_lines(app, 'src/features/billing/components/Billing7.ts', 3, tag='moved and edited')
    os.makedirs(os.path.join(app, 'src/archive'), exist_ok=True)
    git(app, 'mv', 'src/legacy', 'src/archive/legacy-bridges-kept-for-the-old-ios-build')
    commit(app, 'refactor(billing): move the billing store and screens into features')

    # 4. binary, mode and type changes
    branch('feature/binary-and-modes')
    write_bytes(app, 'assets/logo.png', bytes(random.getrandbits(8) for _ in range(6000)))
    write_bytes(app, 'assets/icons/new-badge.png', bytes(random.getrandbits(8) for _ in range(900)))
    os.chmod(os.path.join(app, 'scripts/build.sh'), 0o755)
    os.remove(os.path.join(app, 'config/current.json'))
    write(app, 'config/current.json', '{"env": "prod"}\n')
    commit(app, 'chore: new logo, executable build, real config file')

    # 5. huge diff: thousands of changed lines and a 3,000-character line
    branch('feature/huge-diff')
    write(app, 'src/huge/generated-table.ts', '\n'.join(f'export const ROW_{i} = {i * 2} // regenerated' for i in range(4000)) + '\n')
    write(app, 'src/huge/one-long-line.ts', 'export const BLOB = "' + 'abcdefghij' * 300 + '"\n')
    commit(app, 'chore: regenerate the table')

    # 6. whitespace only: line endings and indentation, no content change
    branch('feature/whitespace-only')
    write(app, 'docs/windows-notes.txt', 'line one\nline two\nline three\n')
    path = os.path.join(app, 'src/screens/profile/components/ProfilePart2.tsx')
    with open(path) as f:
        text = f.read()
    with open(path, 'w') as f:
        f.write(text.replace('  ', '    '))
    commit(app, 'style: LF and four-space indents')

    # 7. awkward paths: unicode, spaces, a tab, emoji, very deep, very long
    branch('feature/unicode-paths')
    write(app, 'src/i18n/café/naïve-résumé.ts', ts_module('cafe', 3))
    write(app, 'docs/Meeting Notes 2026-10-10.md', '# Notes\n\nSpaces in the name.\n')
    write(app, 'docs/tab\tin name.md', 'A tab in the file name.\n')
    write(app, 'assets/📦/package-emoji.json', '{"emoji": true}\n')
    deep = '/'.join(f'level{i}' for i in range(14))
    write(app, f'src/{deep}/DeeplyNestedComponentWithAnExceptionallyLongNameThatKeepsGoingAndGoing.tsx', ts_module('deep', 3))
    commit(app, 'feat(i18n): awkward paths')

    # 8. a qa hotfix: based on qa, not develop
    branch('hotfix/11333-location', base='qa')
    edit_lines(app, 'src/screens/push/components/PushPart4.tsx', 4, tag='hotfix')
    commit(app, 'fix(push): location notifications (hotfix)')

    # 9. no changes at all
    branch('feature/nothing-yet')

    # 10. conflicting with develop: edits the same lines develop will change
    branch('feature/conflicting')
    edit_lines(app, 'src/screens/orders/components/OrdersPart0.tsx', 2, tag='branch side')
    edit_lines(app, 'src/store/orders/actions/ordersAction0.ts', 2, tag='branch side')
    commit(app, 'feat(orders): reorder flow')

    # develop moves on after the branches fork, so merge-bases matter
    git(app, 'checkout', '-q', 'develop')
    edit_lines(app, 'src/screens/orders/components/OrdersPart0.tsx', 2, tag='develop side')
    edit_lines(app, 'src/store/orders/actions/ordersAction0.ts', 2, tag='develop side')
    edit_lines(app, 'src/screens/auth/components/AuthPart1.tsx', 5, tag='develop moved on')
    commit(app, 'feat(orders): develop changes the same lines')
    git(app, 'push', '-q', 'origin', 'develop')
    for b in ['feature/1234-calendar-ok-goes-back', 'feature/big-refactor', 'feature/renames-and-moves', 'feature/binary-and-modes',
              'feature/huge-diff', 'feature/whitespace-only', 'feature/unicode-paths', 'hotfix/11333-location',
              'feature/nothing-yet', 'feature/conflicting']:
        git(app, 'push', '-q', 'origin', b)
    git(app, 'fetch', '-q', 'origin')

    # a linked worktree stopped part-way through a rebase with conflicts
    rebase = os.path.join(out, 'app-rebase')
    git(app, 'worktree', 'add', '-q', rebase, 'feature/conflicting')
    git(rebase, 'rebase', 'origin/develop', ok=(0, 1))

    # 12–16 from the 2026-10-10 Codex review (A–E)
    # A: a branching deep tree the tree cannot join into one row
    branch('feature/stress-deep')
    for i in range(35):
        write(app, '/'.join(f'd{j}' for j in range(i + 1)) + '/keep.ts', 'base\n')
    commit(app, 'stress: branching deep tree')
    # B: 500 changed files (past the watcher's 400-path stat cap), in their own worktree
    branch('feature/stress-watch')
    for i in range(500):
        write(app, f'watch/f{i:03}.ts', 'base\n')
    commit(app, 'stress: 500 watched files')
    git(app, 'checkout', '-q', 'develop')  # a branch checked out here cannot get its own worktree
    watch = os.path.join(out, 'app-watch')
    git(app, 'worktree', 'add', '-q', watch, 'feature/stress-watch')
    for i in range(500):
        write(watch, f'watch/f{i:03}.ts', 'first edit\n')
    # C: a quoted (non-ASCII) rename, a file at the old path's folder, literal glob and control paths
    branch('feature/stress-paths')
    old = 'src/legacy/OldBillingBridge.ts'
    git(app, 'mv', old, 'src/新.ts')
    write(app, old + '/neighbour.ts', 'neighbour\n')
    for path in ['odd/*.ts', 'odd/line\nbreak.ts', 'odd/escape\x1b.ts', 'pages/[id]/index.tsx']:
        write(app, path, 'content\n')
    commit(app, 'stress: quoted rename and literal paths')
    # D: one 100k-character line (past the 90k draw cap) and a 5 MB file (past the 4 MB output cap)
    branch('feature/stress-limits')
    write(app, 'limits/single.ts', 'x' * 100_000 + '\n')
    write(app, 'limits/over4mb.ts', 'x' * 5_000_000 + '\n')
    commit(app, 'stress: diff limits')
    for b in ['feature/stress-deep', 'feature/stress-watch', 'feature/stress-paths', 'feature/stress-limits']:
        git(app, 'push', '-q', 'origin', b)
    git(app, 'fetch', '-q', 'origin')
    # E: a merge, a cherry-pick and a git am each stopped on a conflict, in their own worktrees
    merge = os.path.join(out, 'app-merge')
    git(app, 'worktree', 'add', '-q', '-b', 'feature/stress-merge', merge, 'origin/feature/conflicting')
    git(merge, 'merge', '--no-edit', 'origin/develop', ok=(1,))
    cherry = os.path.join(out, 'app-cherry')
    git(app, 'worktree', 'add', '-q', '-b', 'feature/stress-cherry', cherry, 'origin/develop')
    git(cherry, 'cherry-pick', 'origin/feature/conflicting', ok=(1,))
    patch = git(app, 'format-patch', '-1', '--stdout', 'origin/feature/conflicting')
    write(out, 'conflicting.patch', patch)
    am = os.path.join(out, 'app-am')
    git(app, 'worktree', 'add', '-q', '-b', 'feature/stress-am', am, 'origin/develop')
    git(am, 'am', '-3', os.path.join(out, 'conflicting.patch'), ok=(0, 1, 128))

    # 11. the main checkout: big refactor plus staged, unstaged and untracked work
    git(app, 'checkout', '-q', 'feature/big-refactor')
    edit_lines(app, 'src/screens/profile/components/ProfilePart5.tsx', 3, tag='staged')
    git(app, 'add', 'src/screens/profile/components/ProfilePart5.tsx')
    edit_lines(app, 'src/screens/profile/components/ProfilePart6.tsx', 3, tag='unstaged')
    write(app, 'src/screens/profile/components/ProfileDraft.tsx', ts_module('profile-draft', 5))
    write(app, 'notes/todo with spaces.md', '- untracked note\n')

    print(f'repo:     {app}  (on feature/big-refactor, with staged + unstaged + untracked work)')
    print(f'rebase:   {rebase}  (stopped mid-rebase with conflicts)')
    print(f'also:     {watch} (500 dirty files), {merge} / {cherry} / {am} (stopped merge, cherry-pick, am)')
    print('branches:', ', '.join(l.strip().lstrip('* ') for l in git(app, 'branch').splitlines()))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(os.path.abspath(sys.argv[1]))
