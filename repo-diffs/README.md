# repo-diffs

A `/diffs` command and a **Repo diffs** pane that show branch diffs for the
project repos a session works in, outside the session's own working directory.
Built 2026-10-09 because sessions rooted in one folder see only that folder's
changes in the desktop app's built-in Diff pane, which is bound to the
session's cwd repo.

![Repo diffs pane: file tree on the left, the selected file's card with its hunks on the right, PR status and counts in the header](docs/pane.png)

## What it shows

- **Repos**: any repo containing a file this session changed with Edit, Write
  or NotebookEdit, plus, if you use a worktree-lease file at
  `~/.claude/leases/worktree/*/lease.json`, any worktree this session holds a
  lease on (read directly, matched by session id; optional). The
  session's own cwd repo is left out; the built-in pane covers it.
- **Baseline**: the merge-base of `HEAD` with the first of these that
  resolves: the ref picked in the header's base picker, the PR's
  `baseRefName` (as `origin/<name>`), `origin/develop`, `origin/main`,
  `origin/master`, then whatever `origin/HEAD` names (a `trunk` default
  branch included); else the lease's `base_oid`; else `HEAD`. A picked or PR
  base that is not fetched is said under the header (`Base: origin/qa not
  found locally (git fetch?)`) and the next candidate is used. Untracked files
  show the status letter `U` (`new` in the tree, `new file` on the card),
  never `?`.
- **Before there is anything to show**: `Looking for project repos…` while
  the first listing runs, then `No project repos yet` with a line on how a
  repo gets here and a `↻ refresh` button.
- **Layout**: a header, a toolbar, the file list and a stack of file cards.
  - **Header**, folded by default to one line:
    `▸ repo branch → base (PR base) ▾  PR #n open ✓ n  N files  +a  −r  keys  ● time ↻`
    (the base's tag reads `PR base`, `picked` or `claim`, and nothing for an
    automatic default; the compact PR reads e.g. `PR #42 open ✗ 1`, the
    failing count when any check fails, else pending, else passed). Repo tabs
    sit above it when there are several (keys `1`–`9` with the pane focused;
    a failed switch toasts why). Unfolding it (its chevron, or opening the
    base picker from `→ base ▾`) shows the full PR row, the failing checks and
    the picker; the compact PR text shows only while folded.
  - **Wide panes** (90+ columns): the file list is a pinned left column
    (26% of the pane, 24–40 columns) that stays in view and scrolls on its own
    under the wheel; the header, toolbar and cards stack to its right and
    scroll with the pane. Under 90 columns everything stacks, with one pinned
    `▸ Files N · n/N viewed  ‹ n/N ›` row (see v24).
  - **File list**: titled `▾ Files N · n/N viewed`; folders joined where they
    hold a single folder and no files, collapsible; each file has a status
    letter (A M D R T, `U` for untracked, `!` for a conflict) and its counts.
  - **Toolbar**: the scope pills and whitespace toggle on the left; `‹ n/m ›`
    file stepping, `↑` / `↓` change stepping, `▸ collapse all` and `options`
    on the right.
  - **Cards**: `▾` / `▸`, the status letter, the file name then its dim
    `dir/`, counts (`new file`, `conflict`), `viewed` / `✓ viewed` and
    `copy path`; then one diff block per hunk with an `⋯ N unmodified lines`
    row between them (click it, or `show full file`, for full context;
    `show changes only` goes back). No per-card diffstat bar.
- **Colours** follow the light/dark theme: the selected row uses the theme's
  `selectionBg`, bands and hover use `userMessageBackground(Hover)`.
- **Large or odd diffs**: the hunk text a drawing carries is budgeted at
  60,000 characters (`DIFF_CAP`): the selected file first, its last hunk that
  fits clipped to whole lines, then each other open file whole while it fits.
  A whole drawing is further bounded at 90,000 characters of text (the
  `ROOM_*` text bound). Paths are read with `-z`; CRLF is cleaned; a git
  failure keeps the last good listing and says `git busy, showing last good
  listing`; a diff that cannot load says why, with `Retry`.
- **Scope** (v3, 2026-10-09, after a GitHub-style diff viewer; `last turn` added in 0.3.0):
  four pills, lower case, `all · committed · uncommitted · last turn`.
  `all` (merge-base → working tree, plus untracked: the default),
  `committed` (merge-base → `HEAD`: what the PR shows), `uncommitted`
  (`HEAD` → working tree, plus untracked) or `last turn` (see 0.3.0).
- **Review comments** (v3, after a GitHub-style diff viewer): `+ comment` on each hunk's band
  opens a field labelled `Comment on line N` (`Comment on old line N` for a
  deleted line) with tags `must-fix · suggestion · nit · question`; the
  comment pins to the hunk's first added line (else its first deleted one).
  `Send to prompt` appends every comment to the prompt box as one markdown
  "Code review comments" block and clears them once the box took them; a
  refused fill keeps them. The tree and the card show a ✎ count.
- **Styling** (v3, after GitHub-style diff viewers; since revised): `−removed +added`
  with zeros dropped; the header's totals are chips (`+288` on the added
  tint, `−34` on the removed tint), with no five-block diffstat; a card leads
  with the file name and its `dir/` follows, dim. The refresh control reads
  `● 2:14 PM ↻` (the last refresh), `● updating ↻` or `● stale ↻`.
- **From delta** (v4, 2026-10-09): each hunk's row shows its line and git's
  function context (`L42 · in async function refreshOnce(`), a `⧉` that copies
  the absolute `path:line`, and `+ comment`; renames list once as `old → new`
  (`-M`, both paths passed to the patch); a rebase, merge, cherry-pick or
  revert stopped part-way shows `⚠ rebase in progress · N conflicts`, with
  unmerged files marked `!` (never the untracked `U`) and listed first under
  Conflicts; `↑ ↓` (keys `p` `n`) scroll hunk to hunk, `‹ ›` (keys `k` `j`)
  step files, and `→ cut` / `↩ wrap` (key `w`) toggles long-line wrapping.
  Letter keys pause while a comment is being typed.
  (now: the hunk band reads `▾ @@ -40,7 +40,9 @@ in async function
  refreshOnce(` with `copy line` and `+ comment` at its end, no `⧉`; the
  banner reads `⚠ rebase in progress · N conflicts to resolve`, or
  `⚠ unresolved conflicts · N conflicts to resolve` with no operation
  stopped; wrapping is a `wrap lines` pill on the options row, key `w`.)
  Reviewed 2026-10-10 by Codex (`model_reasoning_effort=high`) and Kimi K3
  (Grok and Gemini timed out at 900 s). Fixed from it: a rename's patch keeps
  only its own file section, the conflict scan is validated like the
  listings, the watcher sees operation markers come and go (`rebase --quit`),
  copy on a deletion copies its current-file line, a stopped `git am` is not
  called a rebase, and n/p move the cursor before any await. Kimi's "conflicted
  files show no diff" was refuted against a real rebase conflict (git prints
  marker hunks).
- **From gh** (v5, 2026-10-10): the header shows the branch's pull request,
  read with `gh pr view --json` in the repo's folder off the listing path
  (10 s timeout; re-read when branch@HEAD moves or the answer is 60 s old):
  `PR #42` (a link) · Open/Draft/Merged/Closed · `✗ failed ● pending ✓
  passed/total` · merge conflicts or mergeable · review state, where an empty
  decision reads "no review yet", never approval. Checks are grouped and
  de-duplicated as gh does (a re-run replaces the run it repeats); up to five
  failing checks are listed as links to their details. "No pull request for
  this branch" and "PR status unavailable: <gh's reason>" are said plainly.
  `hide files…` takes `gh pr diff --exclude`-style globs (`*` never crosses
  `/`; a pattern matches the whole path or the file's name), hides those files
  from the tree and totals (never a conflict), shows `N hidden · show all`, and
  is kept in the plugin store across sessions. Letter keys pause while the
  field is open. (now: the button is `hide…`; with saved patterns the list
  reads `Hiding <globs>` with `edit`, and `N hidden` with `show` /
  `Showing N hidden` with `hide again`.)
  Reviewed 2026-10-10 by Codex (`model_reasoning_effort=high`) and Kimi K3
  (Grok and Gemini skipped after timing out on both earlier rounds). Fixed
  from it: the commit comes from its own `rev-parse --verify HEAD` (a second
  `HEAD` after `--symbolic-full-name` prints the ref again, so the cache key
  never moved), a PR answer shows only for the branch@commit it was read for
  and a switch mid-call re-asks, gh is given the branch by name, cut-off gh
  output says so, exclude globs follow Go's `path.Match` (`^` negates, `!` is
  literal, `\` escapes, `?` is one whole character, a malformed pattern matches
  nothing), patterns with spaces are quoted, tab counts leave hidden files out,
  and an all-hidden tree says why it is empty.
- **From lazygit** (v6, 2026-10-10; `hooks/commits.ts` and `hooks/options.ts`
  were built by sub-agents, wired here):
  - **Base from the PR** (L1). The pane diffs against the PR's `baseRefName`
    (`origin/qa` for a qa hotfix), then develop/main/master. The header's
    `→ <base> ▾` opens a picker: auto, the PR base, origin/develop, origin/qa,
    origin/main, or any ref typed. A wanted base that is not fetched is
    reported ("origin/qa not found locally (git fetch?)"), and costs one extra
    listing per session, not one per PR re-read.
  - **Commits** (L2). `▸ Commits (N)` lists `base..HEAD` (200 max). Picking
    one shows only what it introduced (`git diff <first parent> <sha>`, or the
    empty tree for a root commit), with a `Viewing commit …` banner and `back
    to branch`. Comments written there stay with that commit.
  - **Context** (L3). `±N lines − +` (keys `l` `m`, 0 to 30) on the patch call
    only, always as an explicit `-U<n>`. (now: `− ±3 lines +` on the options
    row.)
  - **Whitespace** (L4). `␣` (key `i`) adds `-w` to the patch and the
    listing, so whitespace-only files leave the tree. (now: an
    `ignore whitespace` pill, key `i`, that reads `no whitespace` while on.)
  - **Keys** (L5). `?` (key `h`) shows the key legend, built from the same
    constants as the buttons. (now: a `keys` button, key `h`.)
  - Reviewed 2026-10-10 by Codex (`model_reasoning_effort=high`) and Kimi
    K3. Fixed from it:
    - A cached PR base counts only for the live branch and commit, so after a
      switch the old branch's target is never used.
    - A commit pick survives an older refresh that was already running.
    - The PR-base re-list remembers only the latest attempt per repo, so a
      retarget qa → main → qa still re-lists. It compares against the base
      in use, not a commit view's label.
    - The watched base ref comes from `git rev-parse --symbolic-full-name`
      (no `--end-of-options`, which rev-parse echoes back), and stays
      watched while a commit is shown.
    - The whitespace toggle moved to the always-visible scope row.
    - A typed base starting with `-` never reaches git.
- **From the UI review** (v7, 2026-10-10; a five-state screen check, ui-ux-pro-max and
  impeccable's audit/critique checklists, run by hand):
  - `clear…` asks first (`Clear N comments? This can't be undone.` with
    `Clear all` / `keep`); adding a comment drops a question left open.
  - `N hidden · show` reveals hidden files for now and keeps the saved
    patterns (`Showing N hidden · hide again`); it used to erase them.
  - A diff that failed to load has a `Retry` beside the error.
  - Controls name what they do (`⧉ copy path`, `− less` / `+ more`,
    `↑ prev change`, `‹ prev file`, `↻ refresh`, `? keys`, `✕ remove`):
    a desktop Button's label is its accessible name. (now: `copy path`,
    `−` / `+`, `↑` / `↓`, `‹` / `›`, `● <time> ↻`, `keys`, `✕ remove`.)
  - The comment mark is `✎`, a text glyph the theme colour reaches, not the
    💬 emoji; muted text is `inactive` alone, no longer also dimmed.
  - A comment shows tag, line and remove on top and its words below.
  Each change has a test that fails with it removed (mutation-checked).
- **Performance and narrow panes** (v8, 2026-10-10):
  - The tree draws its first 150 rows, then `N more rows · show 150 more ·
    show all`; the selected file is always drawn (after `⋯ N rows` when it
    sits further down). A 1,000-file branch went from 52 ms and ~8,900
    elements a redraw to 13 ms and ~1,500 in the harness.
  - Under 40 columns the tree indents one cell a level and leaves per-file
    counts to the card, commit rows drop their age, the key legend puts a
    label under its key, and the card's counts wrap under the path.
  - Rows that wrap use `columnGap`, so wrapped lines carry no blank row.
- **Contrast** (v9, 2026-10-10; measured against Claude Code's theme
  colours and a desktop screenshot, WCAG 4.5:1):
  - Selected rows (tree file, commit, conflict) draw their letter, counts,
    ✎ and age in the text colour: red/green/grey on the selection colour
    measured 2.98–3.52 in the terminal themes; text on it is 8.5–13.9.
  - Secondary controls dim only off the terminal (`canDim`): a terminal's
    faint text measured ~3.9 on white and ~4.3 on the dark band; the
    desktop's dim measured 9.7. Each on/off control also changes its label
    (● / ○, `[tag]`, `↩ wrap` / `→ cut`), so state survives undimmed.
    (now: a picked pill is the `secondary` variant and keeps its label; only
    the whitespace toggle, the comment tags (`[tag]`), the base picker's
    `● auto` / `● <ref>` and `✓ viewed` change their label.)
  - Left to the theme itself: `inactive` on the dark band (4.18) and the
    light colour-blind theme's `warning` (2.14 on white).
- **Labels** (v10, 2026-10-10): the comment field is named `Comment on
  line N` (it had only a placeholder; the tags row reads `Tag:`), and the
  compare-against picker has a `cancel`, as the hide field does.
- **Wording and the phone** (v11, 2026-10-10): plain (chromeless) controls
  read lower case (`cancel`, `keep`, `clear…`, `hide files…`, `show full
  file`); boxed ones keep sentence case (`Send to prompt`, `Retry`, `Clear
  all`). (now: `hide files…` is `hide…`.) `+ comment` shows only where a text field is drawn: on the phone it
  led to a composer that could not take text.
- **GitHub's Files changed** (v12–v15, 2026-10-10; reviewed by several outside models
  and a Codex review at `--effort high`):
  - Rounded `subtle` panels on header, file list and card (flat under 40
    columns); the list is titled `Files N · n / N viewed`; the card header
    carries the five-block diffstat; counts read `+1,001 −75`. (now: the
    list reads `▾ Files N · n/N viewed`; no card carries a diffstat bar.)
  - **Viewed** (`v`, `[ ] viewed`; now `viewed` / `✓ viewed`): marks the file, moves to the next
    unviewed one, folds a viewed file to `✓ Viewed · show diff`, shows `✓` in
    the tree. A mark holds while the file's listing entry (status, rename,
    counts) is unchanged, and is kept in the plugin store.
  - **Views** (`g`): by default each hunk is drawn as GitHub's tinted rows:
    runs of unchanged / added / removed lines, each run on GitHub's row tint
    with its numbers (new-file; old-file for removed) in GitHub's stronger
    gutter tint, the marker padded ` + `, the code in GitHub's token colours
    (`hooks/highlight.ts`, a line-by-line highlighter: keywords, functions
    and decorators, types, module paths after import / package / from /
    using, constants, strings and comments each their own colour, the
    scopes delta's syntect themes colour apart). Colours are GitHub's
    own (`GH_DARK` read off github.com 2026-10-10; `GH_LIGHT` from Primer),
    picked by the `theme` setting; the terminal keeps the theme's
    `diffAdded*` / `diffRemoved*` tints, having no alpha. `Text`, since a
    `Code` paints its own background and cannot carry the tint. `g` switches to syntax colours: each run a source
    `Code` with `startLine`, a one-cell tinted bar beside it. One band per hunk
    carries its `@@` range, function, copy and comment in both. (2026-10-10:
    replaced the engine's own `format: 'diff'` view, which on the desktop drew
    the text green with neither tint nor syntax colours.)
  - **Drawing size**: the desktop drops a whole pane drawing past its own
    bound and shows "nothing to show yet" (measured 2026-10-10: 1,639
    elements / 210k characters of JSON drew, 1,738 / 223k did not). Each render
    weighs what it draws and adds tree rows and file containers only while
    they fit `ROOM_REMOTE` (1,300 / 170k; the terminal holds 19,000 elements),
    the selected file always; what is left out is said, not paged. (now:
    `ROOM_REMOTE` is 1,600 nodes / 170k characters / 90k characters of text;
    the terminal 19,000 nodes / 90k text.)
  - Notes instead of "No text changes.": renamed without changes, now / no
    longer executable (mode), symlink replaced by a file.
  - Fixed from the reviews: keys no longer stay paused for a comment draft on
    another file (Kimi), a selected file's collapsed folders open (Codex C1),
    tree indent is capped at a third of the list (C2), an editor opened on
    another surface holds no keys on the phone (C3).
  - Refuted on the way: conflicted files show no diff (they show marker
    hunks, again), deep edits past six folders are lost (git finds the root),
    brackets break `pickSection` (it uses `includes`), CRLF reaches `Code`.
- **File containers** (v16, 2026-10-10): GitHub's stacked Files changed.
  Every changed file is its own framed container (the selected one ringed in
  the theme's `suggestion` accent), each with `▾ fold` / `▸ open`, its path
  (press to select), counts, diffstat, `[ ] viewed` and `⧉ copy path`.
  (now: bare `▾` / `▸`, the file name then dim `dir/`, counts, `viewed` /
  `✓ viewed`, `copy path`; no diffstat.) The
  shared diff options (context, wrap, numbers, prev/next change and file,
  `▸ collapse all` / `▾ expand all`) sit in one bar above them. A tree row or
  `j`/`k` selects the file and scrolls its container to the top. The first
  25 files are drawn (`show 25 more` / `show all`), plus the selected one
  wherever it sits. A non-selected diff over 1,000 changed lines waits for
  `load diff`, as GitHub's "Large diffs are not rendered by default". The
  ~90k-character drawing budget goes to the selected file first, then to each
  other open file whole while it fits (`show it` past that). (now: that diff
  budget is 60,000 characters, `DIFF_CAP`; 90k is the per-drawing text bound.) Other files'
  diffs load four git calls at a time into their own cache.
- **Sideways pan** (v17, 2026-10-12): in `→ cut` mode a hunk with a line over
  20 columns shows `‹ scroll ›` on its band; each press pans that block alone
  20 columns (`col N` shows where it starts), stopping where the widest line's
  last columns are still in view. No surface has a horizontal scroll box (Box
  `overflow` is only `visible | hidden`), so the mod drops leading columns
  itself; the +/− marker and line numbers stay put. `↩ wrap` hides the arrows.
  Keys `a` / `d` (toolbar `‹ scroll` / `scroll ›`) pan the change `n`/`p` last
  landed on, else the selected file's first; `h`/`l` were already the legend
  and less context. (now: "cut mode" is `wrap lines` off; the toolbar's
  `‹ scroll` / `scroll ›` sit on the options row.)
- **Simpler pane** (v18, 2026-10-14, after a 300-file change set): the
  header is one line (`▾ repo branch → base ▾ · N files +a −r ■■■■■ ? ● ↻ time`;
  the live dot and last refresh sit on the refresh button, "stale" or
  "updating" replace the time, and the listing source and scope descriptions
  moved into the `?` legend). The scope row keeps `All · Committed ·
  Uncommitted · ␣ whitespace` with no blurb under it. (now: the header line
  is `▸ repo branch → base (PR base) ▾  PR #n open ✓ n  N files  +a  −r
  keys  ● time ↻`, folded by default; the scope pills are
  `all · committed · uncommitted · last turn` plus `ignore whitespace`, on
  the toolbar.) The file list is titled
  `▾ Files N`, shows `· n viewed` only once a file is, and `hide…` opens the
  globs. Past 40 files a repo's **top folders start collapsed** (once per
  repo, the selected file's folder left open) so a big change set reads as
  folders to click into. The bar above the files holds only `‹ n/m ›`,
  `↑ k changes ↓`, `collapse all` and an `options` toggle; context, wrap,
  tinted/syntax and sideways pan live on the options row (their keys arm only
  while it shows). File cards lose the per-file five-block bar; the header
  keeps the totals'. **Every block folds on a chevron**: the header's detail
  (`hdr-fold`), the file list (`files-fold`: the diff then takes the whole
  width, wide panes included), Conflicts, each file (as before) and each hunk
  (`hunkfold:i`: the band with its range stays). Folds live in `shut`
  (`sec:header`, `sec:files`, `sec:conflicts`, `hunk:<file>#<i>`), the
  options row in `showOptions`, the seeded repos in `seeded`.
  Harness: five scenarios added (1 file, 3 files, a 300-file change set
  with seeded folders, everything collapsed, options open) and the audit now
  treats a cut Text root as clipping its token spans and skips the digit-only
  line-number gutter (both v12 artifacts: 945 flags over 77 renders of the
  previous build were all of those two kinds, 4 one-pixel wrap flags
  otherwise). v18 sweep: 1,080 renders (18 scenarios × 10 widths from 200 px
  × 2 themes × 3 font sizes), 20 flags, all the same 1–4 px wrap-mode token
  overflows the v17 build shows; the hook took at most 2.2 ms a drawing. Two
  found and fixed on the way: at 17–21 columns the hunk band's
  `‹ scroll › ⧉ copy + comment` cluster overflowed (it wraps now), and a
  folded hunk kept that row (hidden while shut). `harness/bundle-old.js` +
  `index-old.html` (ignored) hold a bundle of any earlier register for A/B
  sweeps; sweeps log to `~/.claude/metrics/repo-diffs-harness-sweeps.jsonl`.
- **Look** (v19, 2026-10-14, "still outdated" after v18): picked states are
  the surface's own filled pill (`variant="primary"`: the scope, `ignoring
  whitespace` (now `no whitespace`), `options`, `keys`, `wrap lines`, `syntax colours`); everything
  else is a plain dim word, lower case, no `●/○/␣/⧉/☐` glyphs. Secondary
  actions sit in a Box the desktop draws `display: none` and reveals under
  the pointer (`hover: { display: 'flex' }` inside the keyed card or hunk
  band): `copy path` on a card, `copy line · + comment` on a band; the
  terminal and the phone, which have no pointer, show them always. The
  header has no frame (spacing, not a box); the file list's and the other
  cards' frames are dim, the selected card's stays the accent. The refresh
  control is `● time ↻`. Harness: the painter draws dim borders and
  hover-reveal (`?reveal=1` shows every hidden control at rest), and
  `index.html?s=<scenario>&w=<px>&theme=&font=` loads one state, so headless
  Chrome can capture it (`harness/shots/`, ignored). Claude cannot be granted
  control of its own window, so the live pane is checked through the plugin
  test engine (the real pane, mounted) and these captures, never by clicking
  the app from a session.
- **After the seats** (v20, 2026-10-14): Codex (`model_reasoning_effort=high`,
  with the captures as images), an external model review and an impeccable
  critique (two isolated assessments: a
  design review scoring 28/40 on Nielsen's heuristics, and the detector,
  which found nothing real on the pane: its 82 padding flags are unresolved
  `calc(var(--cell))` in a static dump and its one contrast flag is the
  harness's own button style) converged, and these were adopted: context
  rows and every line number go regular and dim, changed rows stay bold (the
  v12 note that regular code reads thin on the tints still holds for them);
  a hunk's band and the `⋯ N unmodified lines` row lose their background, so
  only the card header is a band and bands never stack; the toolbar is drawn
  even with no file and carries the scope pills (`all · committed ·
  uncommitted · ignore whitespace`) on its left, navigation and `collapse
  all · options` on its right, which removes a row of chrome above the first
  hunk; picked states are the surface's `secondary` pill, `primary` is kept
  for `Send to prompt` alone, as the Button contract says; the file list
  takes a quarter of a wide pane (24–40 columns), not a third; a card's title
  leads with the file name, its folder after it in the quiet colour; the
  desktop's selected tree row is the quiet band with a bold name and keeps
  the status colours (the terminal keeps its selection colour and plain
  text); a modified file's `M` is quiet, the other letters keep theirs; the
  header's `■■■■■` bar is gone, the branch is dim, the live dot and time sit
  inside the refresh button; the file list's title always reads `· n/N
  viewed`; and the diff draws **two gutters, old then new** (a removed line
  numbers in the old file only, an added one in the new), since one column
  could not say which file a number counted. Not adopted: the `xs`/`sm`
  spacing steps (how the desktop resolves them is unverified), hiding the
  context-only `M` entirely, and a branch-wide next-change key (an idea for
  later). Impeccable's review-progress and persona notes are in
  `harness/shots/` next to the captures only as this README line.
- **Defined and reachable** (v21, 2026-10-14; goal: every block clearly
  defined, everything accessible): the header, the file list and
  every card are framed at full strength again (the selected card in the
  accent), the toolbar is its own band, and each hunk's band is a band except
  the first right under a card's header, so blocks read as blocks and bands
  never stack. Nothing is shown only under the pointer any more: `copy path`,
  `copy line` and `+ comment` are drawn always, dim, since a hover-only
  control has no keyboard path. The header starts **folded** to its first
  line, which then carries the PR as `PR #n · open · ✓ 8` (now without the
  dots: `PR #42 open ✗ 1`) (opening the base
  picker unfolds it; the stale warning and the "viewing commit · back to
  branch" band show folded or not); the failing checks are one line,
  `▸ 7 failing checks`, with the list behind it; the keys legend draws in two
  columns from 70 columns. Review reads as a queue: a viewed file's row goes
  dim, a collapsed folder shows `3/40`, a finished folder dims and shows `✓`,
  and once every file is viewed the stack says so and points at the waiting
  comments. The `3 changes` count left the toolbar (it competed with `n/m`;
  the chips `P ↑ N ↓` are the controls). The hotkey chips themselves stay:
  the desktop draws one per hotkey and every key is still wanted.
- **Impeccable audit** (v22, 2026-10-14; goal: pass the impeccable
  audit): the harness painter now writes resolved pixels
  instead of `calc(var(--cell) * n)`, so a dumped DOM carries sizes the
  detector can read. Real findings fixed: diff rows got a cell of air at
  their right edge (code touched the card's frame), context rows are regular
  weight but not dim (dim over GitHub's keyword colour fell to 4.2:1), and
  inactive text is never also dim. Two rules are ignored for the dumps only,
  with reasons in `.impeccable/config.json`: `cramped-padding` (a cell grid
  has no vertical inset short of a whole row) and `monotonous-spacing` (cells
  and rows, so 0 dominates by construction). `impeccable detect` over the
  three dumps exits 0; a `--no-config` run shows what the ignores cover
  (23 top/bottom-flush cells). The harness's own primary button is
  `#b5532f` so white on it clears 4.5:1 (the desktop draws its native one).
  Sweep after v22: 1,140 renders, **0 flags** (the row's right-edge cell
  also ended the 1–4 px wrap-mode overflows every earlier sweep carried).
- **Borrowed design language** (v23, 2026-10-14, from a reference dashboard: dark cards, one hairline, one warm accent on data, bold figures,
  muted labels, green delta chips, outlined pills, rows ending in a number):
  every card (the header, the file list, each file) is a slightly lighter
  fill (`userMessageBackground`) inside its hairline, with **no bands inside
  it**: the card header, the hunk bands and the toolbar are plain rows, and
  the inserts (legend, base picker, comments) use the hover colour so they
  still read as inserts. The totals are chips, `+288` on the added tint and
  `−34` on the removed tint, bold. On a wide pane each file row carries a
  six-cell share bar in the one accent (`#ff5a2c`, the reference's orange):
  the file's changed lines against the largest in the list, with the track
  in `subtle`; the terminal's plain selected row draws no bar (its colours
  measured under 4.5:1 on the selection). Picked pills stay outlined
  (`secondary`), as the reference's `Weekly ▾`. The accent never sits on a
  control. Not borrowed: the heatmap and the big figures (no font sizes here).
  Bars draw only where the list has 36 columns (below that they squeezed the
  names to nothing, 104 flags in the sweep); comment rows and the composer
  have no fill of their own (a must-fix tag in the error colour on the hover
  fill measured 4.3:1). After v23: detector 0 findings, 0 advisories; sweep
  1,140 renders, 0 flags.
- **Pinned row on narrow panes** (v24, 2026-10-15; the file list
  scrolled away with the page; then a pinned whole list covered most of a
  short pane): the stacked layout (under 90 columns) pins **one row** at the
  pane's scroll offset: `▸ Files 300 · 0/300 viewed` and `‹ n/N ›` file
  stepping (`pin-toggle`, `pin-prev`, `pin-next`; no hotkeys, `j`/`k` are the
  toolbar's). Its chevron opens the list beneath it in a window under half
  the body tall (8 rows at least); the wheel over the window scrolls the
  window's contents, over the diff it scrolls the pane. The window is drawn
  last, filled, over the stack, with a spacer holding its room at the top;
  the header scrolls with the page. The engine's `scroll.offset` is the last
  read, so a row of diff can show above the window mid-scroll; one row keeps
  that small. The harness's pointer row is now the body's first showing row,
  as the engine counts it (it had the page offset in it). Checked in the
  harness at 420 px: the row stays put through 1,680 px of scroll, opens to a
  9-row window, and four wheels over it move the list with the pane still.
- **Stress repo** (`harness/make_stress_repo.py <dir>`): a bare origin plus a
  clone with develop moving after branches fork, qa, and 19 branches (small
  fix, 30-commit refactor, renames, binary/mode/symlink, a 4,000-line diff,
  whitespace-only, unicode/tab/emoji paths, qa hotfix, empty, conflicting,
  branching deep tree, 500 dirty files, quoted renames and control-character
  paths, 100k-character line and 5 MB file), and worktrees stopped mid
  rebase, merge, cherry-pick and am. `harness/snapshot_stress.py <dir>`
  records each branch's git output for the harness (`stress:` scenarios,
  parsed by the mod's own parsers); `--range <repo> <base> <head> <name>`
  adds any range, e.g. a public PR. Gaps found: a default branch other than
  develop/main/master (cli/cli's `trunk`) is not picked up as the base.
  (now: fixed in 0.4.0, which falls back to whatever `origin/HEAD` names.)
- **Refresh**: after every Edit/Write/NotebookEdit, 400 ms after a burst of
  Bash calls goes quiet, on the `↻` button (key `r`), and when another
  session changes a repo: every 3 s the git dir's `HEAD`, `index`,
  `packed-refs`, branch ref and base ref are stat'ed, along with the
  rebase / merge / cherry-pick / revert markers (`rebase-merge`,
  `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`) coming and
  going, and every 15 s `git status` is compared, against a baseline taken
  around each refresh. A 15 s tick that finds nothing changed re-checks the
  PR (re-read only when its answer is 60 s old or branch@HEAD moved).
  Polling stops while the pane is closed. All git calls pass
  `--no-optional-locks`, so polling never takes `index.lock`.

## Opening

The pane opens by itself the first time the session has a repo to show (a
worktree claim or the first edit in a project repo), once per session: close
it and it stays closed until you run `/diffs`. In the terminal an unasked pane
is placed from 144 columns and otherwise waits until opened.

| Command | What it does |
| --- | --- |
| `/diffs` | Refresh and open the pane; replies `Repo diffs pane opened: N repo(s), M changed file(s).` |

## Checks

    claude plugin validate ~/.claude/mods/repo-diffs
    claude plugin test ~/.claude/mods/repo-diffs

The tests mock git and the ledger read (155 across 10 files as of 0.4.0,
counted 2026-10-19; 137 after v21; 87, each v3–v6 change with a mutation control
that fails when the fix is removed; earlier 14: tree and hunk logic, selection
and stepping, the stale-load race, stale listings on git failure, `-z` paths,
CRLF, oversized hunks, the Bash debounce, and the once-per-session auto-open).
v2 was reviewed by a three-model panel and Codex (`--effort high`) before
promotion. v3 (2026-10-09) was reviewed by Codex (`model_reasoning_effort=high`)
and Kimi K3; the Grok and Gemini seats timed out at 600 s. Fixed from it: send
removes only the comments it exported, a cache hit no longer cancels a reload
of the same file and the cache keys on the diff range, the watcher fingerprints
the mtimes of every path `git status` lists, baselines before the listing,
watches the base ref, retries failed repos and restarts its interval on each
refresh, git calls pass `--literal-pathspecs` and `diff.suppressBlankEmpty=false`,
empty hunk ranges hold no line, context-only hunks offer no comment, comments
carry their scope, the composer survives context expansion, hotkeys pause
while a comment is typed, and only a repo's first edit holds the tool's result.

## Layout harness

`harness/` paints the pane in a browser so layout can be checked at any width
without the desktop app (added 2026-10-10 after the card's path wrapped one
character per line beside the hotkey toolbar). `entry.tsx` runs the real
`ui.render` hook against fixture scenarios through a stand-in `$` (`shim.ts`
plays `claude-code`'s atoms) and draws the element tree as flexbox DOM, one
cell = the code font's advance, hotkeys as chips the way desktop draws them.
It approximates the desktop renderer; it is not it.

    harness/build.sh
    python3 -m http.server 8765 --bind 127.0.0.1 --directory ~/.claude/mods/repo-diffs/harness

In the page: scenario picker, width presets (240–2560 px), font 11/14/18,
theme, and `truncate-start` as observed on desktop (wraps) or ideal (trims).
From the console, `await sweep([320, 760, 1440])` returns, per width, what
`audit()` flags: sideways scroll, anything past the right edge, text wrapped
into a column under eight cells, buttons squeezed to nothing. 2026-10-10:
0 flags in 2,244 renders at 320 px and wider (both themes, both truncate
models, all scenarios, three font sizes); after v7, 0 in 2,448 (12 scenarios); after v8, 0 in 3,588 from 200 px
up (13 scenarios, incl. 1,000 files).

## 0.2.0 (2026-10-16)

- **Viewed follows content.** A viewed mark now covers both sides of the file's diff: the commit it starts from (`HEAD` resolved) and the file's content id on the new side (`git hash-object` for the working tree, `git rev-parse <rev>:<path>` for a committed range or a picked commit). The id is read for marked files and for the selected file as its diff loads, so a mark certifies the text the pane showed, not text another session wrote since. An edit that keeps the line counts but changes the text, or a rebase that moves the base, un-views the file. Marks saved by 0.1.x read as not viewed once. Known gaps: a symlink is hashed by its target's content, not its link text; a submodule path makes that repo's id read fail, which un-views its marked files (fails safe).
- **No polling while the pane is closed.** Each watch tick checks the pane is up and stops otherwise; the next edit or `/diffs` starts it again.
- **`/clear` and `/resume`** (a session end with reason `clear` or `resume`) let the pane open itself again on the next edit; `/branch` does not. The repos stay listed: their edits are on disk.

## 0.3.0 (2026-10-16)

- **`last turn` scope.** Lists only the files an `Edit`, `Write` or `NotebookEdit` changed in the latest main turn, subagents included, each with its whole diff against the base. Shell commands are not counted. An edit counts when it ran (not denied, not an error) and only for the turn it started in. Files are matched as git names them, so symlinked or aliased paths match. A new main turn starts the list over. A picked commit is ignored in this scope.
- `tests/mutate.py` (new): a clean baseline, then one mutant per guard, Wave 1's viewed and watch fixes included.

## 0.4.0 (2026-10-17)

- **Leases are read without python.** The ledger's folder is listed and each `lease.json` read through the engine, a symlinked lease folder included. A folder that cannot be listed keeps the leases from the last good read; one unreadable lease is skipped, never the rest.
- **Any default branch.** After develop, main and master, the base is whatever `origin/HEAD` names (a repo whose trunk is `trunk` gets its diff).
- **Symlinks and submodules no longer break viewed marks.** In the working tree a symlink is fingerprinted by its link text, as git stores it, so pointing it elsewhere un-views it even when both targets hold the same text. When a batch of ids fails (a submodule path), it is halved until the bad paths stand alone: one bad path costs about two calls per halving instead of one call per path, and only that path loses its mark. This closes the two known gaps listed under 0.2.0.
- **The last-turn list is bounded.** It holds 500 files; a turn that edits more says so in the scope. The turn's generation, its paths and the overflow flag change together in one update, so two edits landing at once cannot pass the cap and an edit from an older turn cannot join.
- A reload from 0.3.0 in the middle of a turn keeps that turn's list and its overflow flag.

