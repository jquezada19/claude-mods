#!/usr/bin/env python3
"""Records what git says about each branch of a stress repo, for the harness.

    python3 snapshot_stress.py <stress dir> [out.json]   # default out: stress.json beside this file
    python3 snapshot_stress.py --range <repo> <base> <head> <name>   # append one range (a public PR)

Runs the listing calls the mod makes (numstat, name-status, untracked, unmerged,
all -z, -M, --no-color) for every local branch of <stress dir>/app against its
merge-base with origin/develop (origin/qa for hotfix/*), plus the working
tree of the checked-out branch and of <stress dir>/app-rebase. Patches are kept
for the first files of each branch and its largest one. Read-only: no checkout.
The harness replays this through the mod's own parsers (hooks/git-parse.ts).
"""
import json
import os
import subprocess
import sys

FLAGS = ['--no-color', '--no-ext-diff', '-M']
PATCHES_PER_BRANCH = 10
PATCH_CAP = 400_000


def git(cwd, *args):
    r = subprocess.run(['git', '--no-optional-locks', '-c', 'diff.suppressBlankEmpty=false', '--literal-pathspecs', *args],
                       cwd=cwd, capture_output=True)
    return r.stdout.decode('utf-8', 'replace'), r.returncode


def entry(cwd, name, branch, base_ref, range_args, worktree):
    base, _ = git(cwd, 'merge-base', 'HEAD' if worktree else branch, base_ref)
    base = base.strip()
    rng = [base] if worktree else [base, branch]
    num, _ = git(cwd, 'diff', '--numstat', '-z', *FLAGS, *rng)
    stat, _ = git(cwd, 'diff', '--name-status', '-z', *FLAGS, *rng)
    untracked = git(cwd, 'ls-files', '--others', '--exclude-standard', '-z')[0] if worktree else ''
    unmerged = git(cwd, 'ls-files', '-u', '-z')[0] if worktree else ''
    # name-status -z: status, path (, new path for R/C)
    parts = [p for p in stat.split('\0') if p]
    paths, i = [], 0
    while i < len(parts):
        s = parts[i]
        if s[:1] in 'RC':
            paths.append((parts[i + 2], parts[i + 1])); i += 3
        else:
            paths.append((parts[i + 1], None)); i += 2
    sizes = []
    for p, old in paths:
        n, _ = git(cwd, 'diff', '--numstat', *FLAGS, *rng, '--', *( [old, p] if old else [p] ))
        try:
            a, d = n.split('\t')[:2]
            sizes.append((int(a) + int(d), p, old))
        except ValueError:
            sizes.append((0, p, old))
    keep = [x for x in sizes[:PATCHES_PER_BRANCH]]
    if sizes:
        big = max(sizes)
        if big not in keep:
            keep.append(big)
    patches = {}
    for _, p, old in keep:
        text, _ = git(cwd, 'diff', *FLAGS, '-U3', *rng, '--', *([old, p] if old else [p]))
        patches[p] = text[:PATCH_CAP]
    op = None
    gitdir, _ = git(cwd, 'rev-parse', '--absolute-git-dir')
    gd = gitdir.strip()
    for marker, op_name in [('rebase-merge', 'rebase'), ('MERGE_HEAD', 'merge'), ('CHERRY_PICK_HEAD', 'cherry-pick'), ('REVERT_HEAD', 'revert')]:
        if os.path.exists(os.path.join(gd, marker)):
            op = op_name
            break
    if op is None and os.path.isdir(os.path.join(gd, 'rebase-apply')):
        op = 'am' if os.path.exists(os.path.join(gd, 'rebase-apply', 'applying')) else 'rebase'
    log, _ = git(cwd, 'log', '--format=%H%x00%h%x00%P%x00%an%x00%at%x00%s', f'{base}..{"HEAD" if worktree else branch}', '-n', '200')
    commits = []
    for line in log.splitlines():
        f = line.split('\0')
        if len(f) == 6:
            commits.append({'sha': f[0], 'short': f[1], 'parents': f[2].split(), 'author': f[3], 'at': int(f[4]) * 1000, 'subject': f[5]})
    return {'name': name, 'root': cwd, 'branch': branch, 'baseLabel': base_ref, 'base': base, 'num': num, 'stat': stat,
            'untracked': untracked, 'unmerged': unmerged, 'patches': patches, 'op': op, 'commits': commits}


def main(stress, out):
    app = os.path.join(stress, 'app')
    current, _ = git(app, 'rev-parse', '--abbrev-ref', 'HEAD')
    current = current.strip()
    branches = [b for b in git(app, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')[0].split() if b not in ('develop', 'qa')]
    entries = []
    for b in branches:
        base = 'origin/qa' if b.startswith('hotfix/') else 'origin/develop'
        entries.append(entry(app, f'app · {b} (committed)', b, base, None, False))
    entries.append(entry(app, f'app · {current} (working tree)', current, 'origin/develop', None, True))
    for wt, label in [('app-rebase', 'mid-rebase with conflicts'), ('app-merge', 'mid-merge with conflicts'),
                      ('app-cherry', 'mid-cherry-pick with conflicts'), ('app-am', 'mid-am'), ('app-watch', '500 dirty files')]:
        d = os.path.join(stress, wt)
        if os.path.isdir(d):
            b = git(d, 'rev-parse', '--abbrev-ref', 'HEAD')[0].strip()
            entries.append(entry(d, f'{wt} · {label}', b, 'origin/develop', None, True))
    with open(out, 'w') as f:
        json.dump(entries, f)
    for e in entries:
        print(f"{e['name']}: {e['num'].count(chr(0)) and len([x for x in e['stat'].split(chr(0)) if x])} name-status fields, {len(e['patches'])} patches")
    print(f'wrote {out} ({os.path.getsize(out) // 1024} KB)')


def add_range(repo, base, head, name, out):
    """Appends one entry: <repo>'s <base>..<head>, e.g. a public PR's merge-base..head."""
    entries = json.load(open(out)) if os.path.exists(out) else []
    entries = [e for e in entries if e['name'] != name]
    e = entry(repo, name, head, base, None, False)
    entries.append(e)
    with open(out, 'w') as f:
        json.dump(entries, f)
    print(f"{name}: {len([x for x in e['stat'].split(chr(0)) if x])} name-status fields, {len(e['patches'])} patches -> {out}")


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    if len(sys.argv) == 6 and sys.argv[1] == '--range':
        # --range <repo> <base> <head> <name>
        add_range(os.path.abspath(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], os.path.join(here, 'stress.json'))
        sys.exit(0)
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    main(os.path.abspath(sys.argv[1]), sys.argv[2] if len(sys.argv) == 3 else os.path.join(here, 'stress.json'))
