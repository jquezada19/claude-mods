/**
 * Pixel Clawd sprites for the mods' desktop drawings: the Claude Code mascot,
 * a flat clay slab with two dark eyes, two side nubs for arms and four stubby
 * legs, on a 22 x 16 cell grid (one <rect> per cell, 1.5 units a cell).
 * Groups: `bd` body + costume, `ey` the eyes, `la`/`lb` the two leg pairs,
 * `sp` the sparkles, and a named group per prop. The motion is pure CSS so a
 * redraw never moves a pixel. `codex`, `panda`, `gemini`, `grok` and `composer`
 * are not Clawds: the Codex bot, the Kimi panda, the Gemini droplet, the Grok ball
 * and the Composer cube, each drawn on its own finer grid inside the same box.
 */
export type Costume = 'plain' | 'pirate' | 'detective' | 'engineer' | 'chef' | 'codex' | 'panda' | 'gemini' | 'grok' | 'composer'

export const CLAWD_W = 26
export const CLAWD_SCALE = 1.1

/** The brand clay for the body; a costume's accent colors its hat and prop. */
export const CLAY = '#E0805A'
const SHADE = '#C4603F'
const LIGHT = '#F2A684'
const INK = '#1F1E1D'
const WHITE = '#F8F6F1'
const UNIT = 1.5

export const ACCENT: Record<Costume, string> = {
  plain: '#E0805A',
  pirate: '#1D9E75',
  detective: '#D85A30',
  engineer: '#BA7517',
  chef: '#378ADD',
  codex: '#4273E9',
  panda: '#7DB343',
  gemini: '#4C8DF6',
  grok: '#8A8A8E',
  composer: '#A0A0A6',
}

/** Units a cell, where a costume draws on a grid other than the Clawd's. */
const UNITS: Partial<Record<Costume, number>> = { codex: 1, panda: 1, gemini: 1, grok: 1, composer: 1 }

/** `tone` classes the rect itself, so the theme CSS can recolor it. */
type Fill = (x: number, y: number, w: number, h: number, color: string, cls?: string, tone?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: readonly string[], map: Record<string, string>, cls?: string): void => {
  rows.forEach((row, dy) => {
    ;[...row].forEach((ch, dx) => {
      const color = map[ch]

      if (color !== undefined) {
        f(x + dx, y + dy, 1, 1, color, cls)
      }
    })
  })
}

// Cell layout: arms at columns 0-2 and 17-19, body at 3-16 (14 wide) on rows
// 5-13 (9 tall), hats above on rows 0-4, legs on rows 14-15. A raised right
// arm sits three rows higher and its prop reaches columns 18-21.
const BODY_X = 3
const BODY_Y = 5

/** The bare Clawd: slab with a light brow and a dark base, eyes, smile, arms, legs. */
const clawdBody = (f: Fill, body: string, raisedArm = false, armCls?: string): void => {
  stamp(
    f,
    BODY_X,
    BODY_Y,
    [
      'llllllllllllll',
      'bbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbb',
      'bbbbbbbbbbbbbb',
      'ssssssssssssss',
    ],
    { l: LIGHT, b: body, s: SHADE },
  )
  // Eyes: two 2 x 1 dark bars, in their own group so they can blink.
  f(BODY_X + 2, BODY_Y + 3, 2, 1, INK, 'ey')
  f(BODY_X + 10, BODY_Y + 3, 2, 1, INK, 'ey')
  // Smile: two corners and a bottom edge, the pack's happy mouth.
  f(BODY_X + 5, BODY_Y + 5, 1, 1, WHITE)
  f(BODY_X + 8, BODY_Y + 5, 1, 1, WHITE)
  f(BODY_X + 6, BODY_Y + 6, 2, 1, WHITE)
  // Arms: 3 x 3 nubs at the sides; the right one lifts to hold a prop.
  f(0, BODY_Y + 5, 3, 3, body)
  f(0, BODY_Y + 7, 3, 1, SHADE)
  f(17, BODY_Y + (raisedArm ? 2 : 5), 3, 3, body, armCls)
  f(17, BODY_Y + (raisedArm ? 4 : 7), 3, 1, SHADE, armCls)
  // Legs: 1 x 2 stubs with a dark foot; `la` steps while `lb` plants, then the other way.
  for (const [col, cls] of [
    [1, 'la'],
    [4, 'lb'],
    [9, 'la'],
    [12, 'lb'],
  ] as const) {
    f(BODY_X + col, BODY_Y + 9, 1, 1, body, cls)
    f(BODY_X + col, BODY_Y + 10, 1, 1, SHADE, cls)
  }
}

// The Codex bot from its sprite sheet: a cloud head whose screen reads `>_`, a body
// with a small `>_` on the chest, side nubs and two feet, on a 20 x 24 grid at one
// unit a cell. `U` is the screen's cursor; rows 22-23 are the feet.
const CODEX = [
  '....KKK.KKKK.KKK....',
  '...KLLLKLLLLKLLLK...',
  '..KLLLLLLLLLLLLLLK..',
  '.KBLLLLLLLLLLLLLLBK.',
  'KBBBKKKKKKKKKKKKBBBK',
  'KBBKSSSSSSSSSSSSKBBK',
  'KBBKSCSSSSSSSSSSKBBK',
  'KBBKSSCSSSSSSSSSKBBK',
  '.KBKSSSCSSSSSSSSKBK.',
  'KBBKSSCSSSSSSSSSKBBK',
  'KBBKSCSSSUUUUSSSKBBK',
  'KBBKSSSSSSSSSSSSKBBK',
  '.KBBKKKKKKKKKKKKBBK.',
  '..KBBBBBBBBBBBBBBK..',
  '...KKKKKKKKKKKKKK...',
  '....KBBBBBBBBBBK....',
  '.KBBKBBCBBBBBBBKBBK.',
  '.KBBKBBBCBCCBBBKBBK.',
  '.KBBKBBCBBBBBBBKBBK.',
  '..KKKBBBBBBBBBBKKK..',
  '....KBBBBBBBBBBK....',
  '....KBBBKKKKBBBK....',
  '....KBBBK..KBBBK....',
  '....KKKKK..KKKKK....',
]

// The Kimi panda from its sprite sheet, standing: ears, eye patches with a shine
// (`E`, which blinks), pink cheeks, black arms and shoulders, a white belly, two feet.
// `K` is the black dark mode lifts to slate; `N`, the patches and nose on the white
// face, stays black.
const PANDA = [
  '...KKK........KKK...',
  '..KKKKKKKKKKKKKKKK..',
  '..KKKWWWWWWWWWWKKK..',
  '..KWWWWWWWWWWWWWWK..',
  '.KWWWWWWWWWWWWWWWWK.',
  '.KWWNNNWWWWWWNNNWWK.',
  '.KWNNENWWWWWWNENNWK.',
  '.KWNNNWWWWWWWWNNNWK.',
  '.KWPWWWWWNNWWWWWPWK.',
  '.KWWWWWWWWWWWWWWWWK.',
  '..KWWWWWWWWWWWWWWK..',
  '...KKWWWWWWWWWWKK...',
  '..KKKKKKKKKKKKKKKK..',
  '.KKKKKKKKKKKKKKKKKK.',
  'KKKKKKWWWWWWWWKKKKKK',
  'KKKKKWWWWWWWWWWKKKKK',
  'KKK.KWWWWWWWWWWK.KKK',
  '.KK.KWWWWWWWWWWK.KK.',
  '....KWWWWWWWWWWK....',
  '....KGWWWWWWWWGK....',
  '....KKGGWWWWGGKK....',
  '....KKKKKKKKKKKK....',
  '....KKKK....KKKK....',
  '....KKKK....KKKK....',
]

// The Gemini droplet from its sprite sheet: a rainbow drop, its tip up and right, with
// closed happy eyes and a smile. Its body cells (`B`) take a rainbow band by their
// diagonal, numbered `0`-`6`; the bands cycle while it runs. No feet: it bobs.
const RAINBOW = ['#FF3B30', '#FF9500', '#FFD60A', '#34C759', '#00C7E6', '#1E6FFF', '#C03BF5']
const GEMINI = [
  '....................',
  '...............KK...',
  '.............KKBK...',
  '...........KKBBBK...',
  '........KKKBBBBBK...',
  '......KKBBBBBBBBK...',
  '.....KBBBBBBBBBBBK..',
  '....KBBBBBBBBBBBBK..',
  '...KBBBBBBBBBBBBBK..',
  '..KBBBBBBBBBBBBBBBK.',
  '..KBBBBBBBBBBBBBBBK.',
  '.KBBBBFFBBBBFFBBBBK.',
  '.KBBBFBBFBBFBBFBBBK.',
  '.KBBBBBBBBBBBBBBBBK.',
  '.KBBFBBBBBBBBBBFBBK.',
  '.KBBBFBBBBBBBBFBBBK.',
  '.KBBBBFFFFFFFFBBBBK.',
  '.KBBBBBBBBBBBBBBBBK.',
  '.KBBBBBBBBBBBBBBBBK.',
  '.KBBBBBBBBBBBBBBBBK.',
  '.KBBBBBBBBBBBBBBBBK.',
  '..KBBBBBBBBBBBBBBK..',
  '...KKBBBBBBBBBBKK...',
  '.....KKKKKKKKKK.....',
].map((row, y) => row.replace(/B/g, (_, x: number) => `${Math.floor((x + y) / 5) % RAINBOW.length}`))

// The Grok ball from its two sprites: a ball with two slanted pill eyes looking up and
// right. Light mode draws the black ball with white eyes and a grey sheen on its left
// rim (`H`); dark mode, through the tone classes, the white ball with black eyes.
// The eyes (`E`) blink; no feet: it bobs.
const GROK = [
  '....................',
  '....................',
  '....................',
  '....................',
  '.......BBBBBB.......',
  '.....BHHBBBBBBB.....',
  '...BBHHHBBBBBBBBB...',
  '..BHHHBBBBBBBBBBBB..',
  '..BHHBBBBBBBBEEBBB..',
  '.BHHBBBBBBBBBBEEBBB.',
  '.BHBBBBBBEEBBBEEBBB.',
  'BBBBBBBBBEEBBBBEEBBB',
  'BBBBBBBBBBEEBBBEEBBB',
  'BHBBBBBBBBEEBBBBBBBB',
  'BHBBBBBBBBBEEBBBBBBB',
  'BHHBBBBBBBBBBBBBBBBB',
  'BHHBBBBBBBBBBBBBBBBB',
  '.HHBBBBBBBBBBBBBBBB.',
  '.BHHBBBBBBBBBBBBBBB.',
  '..BHHBBBBBBBBBBBBB..',
  '..BHHHBBBBBBBBBBBB..',
  '...BBHHHBBBBBBBBB...',
  '.....BHHBBBBBBB.....',
  '.......BBBBBB.......',
]

// The Composer cube from its sprite: a grey hexagonal cube, its top cap split light
// and dark, a light front face with dot eyes, blush (`b`) and a smile, dark side faces
// (`D`, `X`), light lower faces (`L`, `P`), one fist waving, one arm down, and boots.
// Wider than the rest: 24 columns.
const COMPOSER = [
  '..........KKKK..........',
  '........KKMMDDKK........',
  '.KK...KKMMMMDDDDKK......',
  'KMMKKKMMMMMMDDDDDDKK....',
  'KMMKMMMMMMMMDDDDDDDDK...',
  '.KDKWWWWWWWWWWWWWWWWK...',
  '.KDKWWWWWWWWWWWWWWWWK...',
  '..KKDWWWKKWWWWKKWWWXK...',
  '...KDDWWKKWWWWKKWWXXK...',
  '...KDDDbWWWWWWWWbXXXKK..',
  '...KDDDDWWKWWKWWXXXXKDK.',
  '...KDDDDDWWKKWWXXXXXKDK.',
  '...KDDDDDDWWWWXXXXXXKMMK',
  '...KLLLLLLLLPPPPPPPPKMMK',
  '....KKLLLLLLPPPPPPKK.KK.',
  '......KKLLLLPPPPKK......',
  '........KKLLPPKK........',
  '.......KDKKKKKKDK.......',
  '.......KDK....KDK.......',
  '.......KDK....KDK.......',
  '.....KKKDK....KDKKK.....',
  '....KMMDDDK..KDDDMMK....',
  '....KDDDDDK..KDDDDDK....',
  '....KKKKKKK..KKKKKKK....',
]

/**
 * A 24-row sprite at one unit a cell, one <rect> per run of a color so the larger
 * grid stays small, centred where a Clawd's body sits (a 20-wide one five units in). `U` cells go to
 * the blinking cursor group, `E` to the blinking eyes; rows 22-23 are the feet, the
 * left stepping with `la`, the right with `lb`, unless the sprite has none.
 */
const gridSprite = (
  f: Fill,
  rows: readonly string[],
  color: Record<string, string>,
  tones: Record<string, string> = {},
  hasFeet = true,
): void => {
  const width = rows[0]?.length ?? 0
  const left = Math.floor((30 - width) / 2)

  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x]!
      let end = x + 1

      while (row[end] === ch) {
        end += 1
      }

      if (ch !== '.') {
        f(left + x, y, end - x, 1, color[ch]!, ch === 'U' ? 'cu' : ch === 'E' ? 'ey' : hasFeet && y >= 22 ? (x < width / 2 ? 'la' : 'lb') : 'bd', tones[ch])
      }

      x = end
    }
  })
}

/** Four coloured sparks around the head that twinkle while Clawd works. */
const sparkles = (f: Fill): void => {
  f(1, 2, 1, 1, '#5EF2C4', 'sp')
  f(2, 1, 1, 1, '#5EF2C4', 'sp')
  f(18, 1, 1, 1, '#9B5CF6', 'sp')
  f(20, 3, 1, 1, '#FFE85C', 'sp')
}

const COSTUMES: Record<Costume, (f: Fill, accent: string, body: string) => void> = {
  plain: (f, _accent, body) => {
    clawdBody(f, body)
    sparkles(f)
  },
  // Pirate: red bandana with a tail over the brow, an eye patch, a cutlass in the raised arm that fences.
  pirate: (f, accent, body) => {
    clawdBody(f, body, true, 'it')
    stamp(f, BODY_X, BODY_Y - 1, ['rrrrrrrrrrrrrr', 'rrrrrrrrrrrrrr'], { r: '#D13C38' })
    f(1, BODY_Y, 2, 1, '#D13C38')
    f(0, BODY_Y + 1, 2, 1, '#D13C38')
    // Patch over the right eye, strap across the head.
    f(BODY_X + 9, BODY_Y + 2, 4, 3, INK)
    f(BODY_X, BODY_Y + 1, 14, 1, INK)
    stamp(f, 18, 0, ['...w', '..ww', '.ww.', '.w..', 'ww..', 'g...'], { w: '#D5D8DE', g: accent }, 'it')
  },
  // Detective: a deerstalker with ear flaps, a magnifier in the raised arm that sweeps and glints.
  detective: (f, accent, body) => {
    clawdBody(f, body, true, 'it')
    stamp(
      f,
      1,
      1,
      ['......hhhhhhhh......', '....hhhhhhhhhhhh....', 'ff.hhhhhhhhhhhhhh.ff', 'ffhhhhhhhhhhhhhhhhff'],
      { h: '#8B5A2B', f: '#A97142' },
    )
    f(BODY_X, BODY_Y, 14, 1, '#5A3A1C')
    f(BODY_X + 4, 2, 6, 1, accent)
    stamp(f, 17, 0, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(18, 1, 3, 3, 'rgba(169,214,245,.6)', 'it')
    f(18, 1, 1, 1, WHITE, 'gl')
    f(19, 5, 1, 2, '#8B5A2B', 'it')
  },
  // Engineer: a yellow hard hat with a brim, a wrench in the raised arm that turns.
  engineer: (f, accent, body) => {
    clawdBody(f, body, true, 'it')
    stamp(
      f,
      1,
      1,
      ['.....yyyyyyyyyy.....', '...yyylyyyyyyyyyy...', '...yyylyyyyyyyyyy...', 'bbbbbbbbbbbbbbbbbbbb'],
      { y: '#F5C542', l: '#FBE08A', b: '#C99A1E' },
    )
    f(BODY_X + 5, 1, 4, 1, accent)
    stamp(f, 18, 0, ['s.s', 'sss', '.s.', '.s.', '.s.', '.s.'], { s: '#8E929A' }, 'it')
  },
  // Chef: a tall white toque with a band, a pan in the raised arm that tilts while the egg flips.
  chef: (f, accent, body) => {
    clawdBody(f, body, true, 'pan')
    stamp(
      f,
      BODY_X,
      0,
      ['..wwwwwwwwww..', '.wwwwwwwwwwww.', '.wwwwwwwwwwww.', '..wwwwwwwwww..', '...bbbbbbbb...'],
      { w: WHITE, b: accent },
    )
    f(17, 5, 5, 1, '#4A4A48', 'pan')
    f(21, 6, 1, 1, '#4A4A48', 'pan')
    f(18, 4, 3, 1, '#F5B731', 'egg')
  },
  codex: (f, _accent, body) =>
    gridSprite(f, CODEX, { K: '#020619', L: '#6095F7', B: body === CLAY ? ACCENT.codex : body, S: '#192657', C: '#9BF0F8', U: '#9BF0F8' }),
  panda: (f, _accent, body) =>
    gridSprite(f, PANDA, { K: '#13202B', N: '#13202B', W: body === CLAY ? '#F2F2EF' : body, G: '#C9CBCB', P: '#F08A7E', E: '#F2F2EF' }, { K: 'pk' }),
  gemini: (f, _accent, body) =>
    gridSprite(
      f,
      GEMINI,
      { K: '#111111', F: '#111111', ...Object.fromEntries(RAINBOW.map((c, i) => [`${i}`, body === CLAY ? c : body])) },
      Object.fromEntries(RAINBOW.map((_, i) => [`${i}`, `g${i}`])),
      false,
    ),
  grok: (f, _accent, body) =>
    gridSprite(f, GROK, { B: body === CLAY ? '#0B0B0B' : body, H: '#3A3A3A', E: '#F8F6F1' }, { B: 'kb', H: 'kh', E: 'ke' }, false),
  composer: (f, _accent, body) =>
    gridSprite(f, COMPOSER, {
      K: '#111111',
      W: body === CLAY ? '#F1F1F1' : body,
      L: '#C4C4C4',
      P: '#D9D9D9',
      M: '#8E8E8E',
      D: '#6A6A6A',
      X: '#4E4E4E',
      b: '#B5B5B5',
    }),
}

/**
 * Pure CSS motion, run by the compositor; in dark mode the panda gets a one-cell
 * slate black, since its black limbs and ears would vanish into the background;
 * the Grok ball turns white with black eyes; the Gemini droplet's rainbow bands
 * cycle while it runs. Every costume walks (legs step out of
 * phase, the body bobs), blinks every few seconds, and the plain one's sparkles
 * twinkle; each prop adds its own motion. Reduced motion stops all of it.
 */
export const CLAWD_CSS = `<style>
.run .la{animation:cstep .5s steps(1) infinite}.run .lb{animation:cstep .5s steps(1) infinite -.25s}
.run .bd{animation:cbob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
.ey{transform-box:fill-box;transform-origin:50% 50%;animation:cblink 4s steps(1) infinite}
.sp{opacity:0}.run .sp{animation:ctwinkle 1.2s steps(1) infinite}
@keyframes cstep{50%{transform:translateY(-1.5px)}}@keyframes cbob{50%{transform:translateY(1.5px)}}
@keyframes cblink{0%,92%,100%{transform:scaleY(1)}94%,98%{transform:scaleY(.2)}}
@keyframes ctwinkle{0%,49%{opacity:1}50%,100%{opacity:0}}
.c-pirate.run .it{transform-origin:0 100%;animation:cfence .5s ease-in-out infinite}
@keyframes cfence{50%{transform:rotate(28deg)}}
.c-detective.run .it{animation:csweep 1s steps(1) infinite}.c-detective.run .gl{animation:cglint 1s steps(1) infinite -.5s}
@keyframes csweep{25%{transform:translate(-1.5px,1.5px)}50%{transform:translate(-3px,3px)}75%{transform:translate(-1.5px,1.5px)}}
@keyframes cglint{50%{opacity:.15}}
.c-engineer.run .it{transform-origin:50% 100%;animation:cturn .5s ease-in-out infinite}
@keyframes cturn{50%{transform:rotate(-30deg)}}
.c-chef.run .pan{transform-origin:0 50%;animation:ctilt 1s ease-in-out infinite}.c-chef.run .egg{animation:cflip 1s ease-in-out infinite}
@keyframes ctilt{20%,40%{transform:rotate(-12deg)}}@keyframes cflip{30%{transform:translateY(-6px) scaleY(-1)}60%{transform:translateY(0)}}
.c-codex.run .cu{animation:ccursor 1s steps(1) infinite}
@keyframes ccursor{50%{opacity:0}}
@media (prefers-color-scheme: dark){.c-panda .pk{fill:#6B7584}.c-grok .kb,.c-grok .kh{fill:#F8F8F6}.c-grok .ke{fill:#0B0B0B}}
.c-gemini.run rect[class^="g"]{animation:crainbow 1.4s step-end infinite}.c-gemini .g1{animation-delay:-.2s}.c-gemini .g2{animation-delay:-.4s}.c-gemini .g3{animation-delay:-.6s}.c-gemini .g4{animation-delay:-.8s}.c-gemini .g5{animation-delay:-1s}.c-gemini .g6{animation-delay:-1.2s}
@keyframes crainbow{0%{fill:#FF3B30}14.29%{fill:#FF9500}28.57%{fill:#FFD60A}42.86%{fill:#34C759}57.14%{fill:#00C7E6}71.43%{fill:#1E6FFF}85.71%{fill:#C03BF5}100%{fill:#FF3B30}}
@media (prefers-reduced-motion: reduce){.run,.run g,.run rect,.ey{animation:none!important}}
</style>`

/**
 * One Clawd as an SVG `<g>` fragment at (x, y). `dim` fades it, `isWalking` adds
 * the `run` class the CSS keys on, `tint` recolors the body (a finished ticket
 * sits green). Eyes, sparkles and props nest inside `bd` so they ride the bob;
 * legs stay outside.
 */
export const clawd = (
  x: number,
  y: number,
  costume: Costume,
  opts: { dim?: boolean; isWalking?: boolean; scale?: number; tint?: string } = {},
): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const unit = UNITS[costume] ?? UNIT
  const f: Fill = (cx, cy, w, h, color, cls = 'bd', tone) => {
    const list = groups.get(cls) ?? []
    list.push(`<rect${tone === undefined ? '' : ` class="${tone}"`} x="${cx * unit}" y="${cy * unit}" width="${w * unit}" height="${h * unit}" fill="${color}"/>`)
    groups.set(cls, list)
  }
  COSTUMES[costume](f, ACCENT[costume], opts.tint ?? CLAY)
  const group = (cls: string): string => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb' && k !== 'sp')
  const sparks = (groups.get('sp') ?? []).map((r, i) => `<g class="sp" style="animation-delay:-${i * 0.3}s">${r}</g>`).join('')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}${sparks}</g>`
  const scale = opts.scale ?? CLAWD_SCALE

  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${opts.dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${opts.isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}
