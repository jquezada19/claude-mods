/**
 * The row's mascot: the pixel Clawd (a clay slab with two dark eyes, side nubs for arms and
 * four stubby legs) holding a prop for the phase. Original pixel art on a 25 x 16 cell grid,
 * one <rect> per cell run; all motion is CSS, so a redraw never moves a pixel, and reduced
 * motion stops it.
 *
 * Cell layout: arms at columns 0-2 and 17-19, body at 3-16 on rows 5-13, hats on rows 0-4,
 * legs on rows 14-15. A raised right arm sits three rows higher; props reach columns 17-24.
 */

export type MascotKey = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | 'between' | 'done'

const CLAY = '#E0805A'
const SHADE = '#C4603F'
const LIGHT = '#F2A684'
const INK = '#1F1E1D'
const WHITE = '#F8F6F1'
const DONE_BODY = '#5fbf8f'
const DONE_SHADE = '#3f9f6f'
const DONE_LIGHT = '#8fd9b3'
const UNIT = 1.5
const COLS = 25
const ROWS = 16
const BODY_X = 3
const BODY_Y = 5
/** How the cell grid is drawn: this scale makes it 21 px tall in the 22 px row. */
const SCALE = 0.88

/** The mascot's box in the row, px. */
export const MASCOT_W = Math.ceil(COLS * UNIT * SCALE)
export const MASCOT_H = Math.ceil(ROWS * UNIT * SCALE)

/** What each mascot is, for the alt text and the tests. */
export const MASCOT_NAMES: Record<MascotKey, string> = {
  '1': 'wizard-hat',
  '2': 'magnifier',
  '3': 'clipboard',
  '4': 'flask',
  '5': 'hammer',
  '6': 'reading-glasses',
  '7': 'rocket',
  '8': 'checkered-flag',
  between: 'thinking-dots',
  done: 'party',
}

type Cells = Map<string, string[]>

/** One cell grid in groups: `put` adds a run of cells to a group, `stamp` a picture from rows of characters. */
const grid = () => {
  const groups: Cells = new Map()
  const put = (x: number, y: number, w: number, h: number, color: string, group = 'bd'): void => {
    const list = groups.get(group) ?? []
    // Ink outlines on props turn light in dark mode (`ik`); the eyes and the flag's squares stay dark.
    const tone = color === INK && group !== 'ey' && !group.startsWith('flag') ? ' class="ik"' : ''
    list.push(`<rect${tone} x="${x * UNIT}" y="${y * UNIT}" width="${w * UNIT}" height="${h * UNIT}" fill="${color}"/>`)
    groups.set(group, list)
  }
  const stamp = (x: number, y: number, rows: readonly string[], map: Record<string, string>, group = 'bd'): void => {
    rows.forEach((row, dy) => {
      let dx = 0

      while (dx < row.length) {
        const ch = row[dx]!
        const color = map[ch]
        let end = dx + 1

        while (end < row.length && row[end] === ch) {
          end += 1
        }

        if (color !== undefined) {
          put(x + dx, y + dy, end - dx, 1, color, group)
        }

        dx = end
      }
    })
  }

  return { groups, put, stamp }
}

/** The bare Clawd: slab with a light brow and a dark base, eyes, smile, arms, legs. */
const body = (g: ReturnType<typeof grid>, isDone: boolean, raisedArm: boolean): void => {
  const [b, s, l] = isDone ? [DONE_BODY, DONE_SHADE, DONE_LIGHT] : [CLAY, SHADE, LIGHT]
  g.stamp(BODY_X, BODY_Y, ['llllllllllllll', ...Array<string>(7).fill('bbbbbbbbbbbbbb'), 'ssssssssssssss'], { l, b, s })
  // Eyes: two 2 x 1 dark bars, their own group so they can blink (and scan, reading).
  g.put(BODY_X + 2, BODY_Y + 3, 2, 1, INK, 'ey')
  g.put(BODY_X + 10, BODY_Y + 3, 2, 1, INK, 'ey')
  // Smile.
  g.put(BODY_X + 5, BODY_Y + 5, 1, 1, WHITE)
  g.put(BODY_X + 8, BODY_Y + 5, 1, 1, WHITE)
  g.put(BODY_X + 6, BODY_Y + 6, 2, 1, WHITE)
  // Arms: 3 x 3 nubs at the sides; the right one lifts to hold a prop.
  g.put(0, BODY_Y + 5, 3, 3, b)
  g.put(0, BODY_Y + 7, 3, 1, s)
  g.put(17, BODY_Y + (raisedArm ? 2 : 5), 3, 3, b, raisedArm ? 'arm' : 'bd')
  g.put(17, BODY_Y + (raisedArm ? 4 : 7), 3, 1, s, raisedArm ? 'arm' : 'bd')
  // Legs: `la` steps while `lb` plants, then the other way.
  for (const [col, group] of [[1, 'la'], [4, 'lb'], [9, 'la'], [12, 'lb']] as const) {
    g.put(BODY_X + col, BODY_Y + 9, 1, 1, b, group)
    g.put(BODY_X + col, BODY_Y + 10, 1, 1, s, group)
  }
}

/** Each phase's prop, drawn over the body. Returns whether the right arm is raised to hold it. */
const PROPS: Record<MascotKey, { raised: boolean; draw: (g: ReturnType<typeof grid>) => void }> = {
  // Recall: a wizard hat with a gold star, and two sparkles.
  '1': {
    raised: false,
    draw: g => {
      g.stamp(4, 0, ['       pp   ', '      ppl   ', '    pppypp  ', '   ppppppp  ', ' dddddddddd '], { p: '#8A60D6', l: '#B99AEF', y: '#F2C14E', d: '#5A3699' }, 'hat')
      g.stamp(17, 1, [' y ', 'ywy', ' y '], { y: '#F2C14E', w: WHITE }, 'sp')
      g.put(2, 2, 1, 1, '#8A60D6', 'sp2')
    },
  },
  // Research: a magnifier held up, sweeping.
  '2': {
    raised: true,
    draw: g => {
      g.stamp(18, 1, [' kkk ', 'kcwwk', 'kcwck', 'kccck', ' kkk ', ' nk  ', ' nn  ', ' nn  '], { k: INK, c: '#9DD2E8', w: WHITE, n: '#9A6A3A' }, 'it')
    },
  },
  // Plan: a clipboard whose three items tick off in turn.
  '3': {
    raised: true,
    draw: g => {
      g.stamp(18, 1, ['  kk  ', 'bwkkwb', 'bwwwnb', 'bwwwwb', 'bwwwnb', 'bwwwwb', 'bwwwnb', 'bwwwwb', 'bbbbbb'], { k: INK, b: '#AD7845', w: WHITE, n: '#8A8A8A' }, 'it')
      for (const [y, group] of [[3, 'tk1'], [5, 'tk2'], [7, 'tk3']] as const) {
        g.stamp(19, y, ['g g', ' gg'], { g: '#27834C' }, group)
      }
    },
  },
  // Test: a flask of green liquid, bubbles rising out of it.
  '4': {
    raised: true,
    draw: g => {
      g.stamp(18, 2, [' gggg ', '  cw  ', '  cw  ', ' kcck ', 'kqqqqk', 'kqwqqk', 'kqqqqk', ' kkkk '], { g: '#A8B5BE', k: INK, c: '#BFE3F2', q: '#5CCB8A', w: WHITE }, 'it')
      g.put(20, 4, 1, 1, '#5CCB8A', 'bu1')
      g.put(21, 3, 1, 1, '#5CCB8A', 'bu2')
      g.put(22, 8, 1, 1, WHITE, 'foam')
    },
  },
  // Implement: a hammer tapping, a spark at each tap.
  '5': {
    raised: true,
    draw: g => {
      g.stamp(16, 3, ['llllk', 'kkkkk', '  nn ', '  nn ', '  nn ', '  nn ', '  nn '], { l: '#A8B5BE', k: '#56626D', n: '#AD7845' }, 'it')
      g.stamp(21, 8, [' lll', ' kk ', 'kkkk'], { l: '#A8B5BE', k: INK }, 'anvil')
      g.put(23, 7, 1, 1, '#E9B63D', 'sp')
      g.put(24, 6, 1, 1, '#E9B63D', 'sp2')
    },
  },
  // Review: reading glasses with light lenses; the eyes, drawn over them, scan the lines.
  '6': {
    raised: false,
    draw: g => {
      g.stamp(BODY_X, BODY_Y + 1, [' kkkkk   kkkkk ', 'kkccckkkkkccckk', ' kccck   kccck ', ' kkkkk   kkkkk '], { k: INK, c: '#DCEFF7' }, 'gl')
    },
  },
  // Ship: a rocket on the pad beside, launching and coming round again.
  '7': {
    raised: false,
    draw: g => {
      g.stamp(19, 5, ['  r  ', ' rwr ', ' www ', ' wbw ', ' www ', 'rwwwr', 'rkwkr'], { r: '#D95650', w: WHITE, b: '#4C8DF6', k: '#A8B5BE' }, 'rk')
      g.stamp(20, 12, ['oyo', ' y ', ' o '], { o: '#EF843A', y: '#FFE08A' }, 'fl')
      g.put(18, 14, 2, 1, '#A8B5BE', 'sm1')
      g.put(22, 14, 2, 1, '#A8B5BE', 'sm2')
      g.put(18, 15, 6, 1, '#8A8A8A')
    },
  },
  // Compound: the checkered flag at the finish line, waving.
  '8': {
    raised: true,
    draw: g => {
      g.put(19, 0, 1, 8, INK, 'pole')
      g.stamp(20, 0, ['kwkwk', 'wkwkw', 'kwkwk', 'wkwkw'], { k: INK, w: WHITE }, 'flag')
    },
  },
  // Between phases: thinking dots above the head.
  between: {
    raised: false,
    draw: g => {
      g.put(6, 2, 2, 2, '#8A8A8A', 'd1')
      g.put(10, 2, 2, 2, '#8A8A8A', 'd2')
      g.put(14, 2, 2, 2, '#8A8A8A', 'd3')
    },
  },
  // Done: a party hat and confetti.
  done: {
    raised: false,
    draw: g => {
      g.stamp(6, 0, ['   y   ', '   r   ', '  rbr  ', '  ryr  ', ' bbbbb '], { y: '#F2C14E', r: '#E56761', b: '#4C8DF6' }, 'hat')
      g.put(1, 1, 1, 2, '#4C8DF6', 'cf1')
      g.put(17, 0, 2, 1, '#E9B63D', 'cf2')
      g.put(22, 2, 1, 2, '#E56761', 'cf3')
      g.put(14, 1, 1, 1, '#8A60D6', 'cf4')
    },
  },
}

/**
 * Motion: legs step and the body bobs while a phase is open; eyes blink; each prop moves its
 * own way (the flag waves, the rocket launches, the ticks tick, the bubbles rise).
 */
export const MASCOT_CSS =
  '.mz g{transform-box:fill-box}' +
  '.mz.run .la{animation:mstep .9s steps(1) infinite}.mz.run .lb{animation:mstep .9s steps(1) infinite -.45s}.mz.run .bd{animation:mbob .9s steps(1) infinite}' +
  '.mz .ey{transform-origin:50% 50%;animation:mblink 4s steps(1) infinite}' +
  '.mz-wizard-hat .sp,.mz-wizard-hat .sp2{animation:mtw 2.4s steps(1) infinite}.mz-wizard-hat .sp2{animation-delay:-1.2s}' +
  '.mz-magnifier .it{transform-origin:30% 100%;animation:msweep 2.4s steps(1) infinite}' +
  '.mz-clipboard .tk1,.mz-clipboard .tk2,.mz-clipboard .tk3{animation:mtick 3.6s steps(1) infinite}.mz-clipboard .tk2{animation-name:mtick2}.mz-clipboard .tk3{animation-name:mtick3}' +
  '.mz-flask .bu1{animation:mbub 1.8s steps(1) infinite}.mz-flask .bu2{animation:mbub 1.8s steps(1) infinite -.9s}.mz-flask .foam{animation:mfoam 1.8s steps(1) infinite}' +
  '.mz-hammer.run .bd,.mz-rocket.run .bd{animation:none}' +
  '.mz-hammer .it{transform-origin:60% 100%;animation:mtap 1.5s steps(1) infinite}.mz-hammer .arm{animation:mgrip 1.5s steps(1) infinite}.mz-hammer .sp,.mz-hammer .sp2{animation:mimpact 1.5s steps(1) infinite}.mz-hammer .sp2{animation-name:mimpact2}' +
  '.mz-reading-glasses .scan{animation:mscan 3.2s steps(1) infinite}' +
  '.mz-rocket .rk{animation:mlaunch 3.6s steps(1) infinite}.mz-rocket .fl{transform-origin:50% 0;animation:mflick .24s steps(1) infinite}.mz-rocket .sm1,.mz-rocket .sm2{animation:msmoke 3.6s steps(1) infinite}.mz-rocket .sm2{animation-name:msmoke2}' +
  '.mz-checkered-flag .flag{transform-origin:0 50%;animation:mwave .7s ease-in-out infinite}' +
  '.mz-thinking-dots .d1,.mz-thinking-dots .d2,.mz-thinking-dots .d3{animation:mdot 2.4s steps(1) infinite}.mz-thinking-dots .d2{animation-delay:-1.6s}.mz-thinking-dots .d3{animation-delay:-.8s}' +
  '.mz-party .cf1,.mz-party .cf2,.mz-party .cf3,.mz-party .cf4{animation:mconfetti 3.2s steps(1) infinite}.mz-party .cf2{animation-delay:-.8s}.mz-party .cf3{animation-delay:-1.6s}.mz-party .cf4{animation-delay:-2.4s}' +
  '@keyframes mstep{0%,39%,70%,100%{transform:translateY(0)}40%,69%{transform:translateY(-1.5px)}}@keyframes mbob{0%,39%,70%,100%{transform:translateY(0)}40%,69%{transform:translateY(1.5px)}}' +
  '@keyframes mblink{0%,92%,100%{transform:scaleY(1)}94%,98%{transform:scaleY(.2)}}' +
  '@keyframes mtw{0%,24%,70%,100%{opacity:0}25%,69%{opacity:1}}' +
  '@keyframes msweep{0%,19%,80%,100%{transform:translate(0,0)}20%,39%{transform:translate(-1.5px,1.5px)}40%,59%{transform:translate(0,1.5px)}60%,79%{transform:translate(1.5px,0)}}' +
  '@keyframes mtick{0%,14%{opacity:0}15%,100%{opacity:1}}@keyframes mtick2{0%,34%{opacity:0}35%,100%{opacity:1}}@keyframes mtick3{0%,54%{opacity:0}55%,100%{opacity:1}}' +
  '@keyframes mbub{0%,19%{transform:translateY(0);opacity:0}20%,39%{transform:translateY(-1.5px);opacity:1}40%,59%{transform:translateY(-3px);opacity:1}60%,79%{transform:translateY(-4.5px);opacity:1}80%,100%{transform:translateY(-4.5px);opacity:0}}' +
  '@keyframes mfoam{0%,49%{opacity:1}50%,100%{opacity:0}}' +
  '@keyframes mtap{0%,14%,80%,100%{transform:rotate(0)}15%,29%{transform:rotate(-12deg)}30%,39%{transform:rotate(-20deg)}40%,49%{transform:translateY(1.5px) rotate(35deg)}50%,59%{transform:rotate(12deg)}60%,79%{transform:rotate(-5deg)}}' +
  '@keyframes mgrip{0%,39%,60%,100%{transform:translateY(0)}40%,59%{transform:translateY(1.5px)}}' +
  '@keyframes mimpact{0%,39%,55%,100%{opacity:0}40%,54%{opacity:1}}@keyframes mimpact2{0%,44%,60%,100%{opacity:0}45%,59%{opacity:1}}' +
  '@keyframes mscan{0%,19%,90%,100%{transform:translateX(0)}20%,44%{transform:translateX(-.75px)}45%,69%{transform:translateX(0)}70%,89%{transform:translateX(.75px)}}' +
  '@keyframes mlaunch{0%,11%,92%,100%{transform:translateY(0);opacity:1}12%,23%{transform:translateY(1.5px);opacity:1}24%,31%{transform:translateY(0);opacity:1}32%,39%{transform:translateY(-1.5px);opacity:1}40%,47%{transform:translateY(-4.5px);opacity:1}48%,55%{transform:translateY(-9px);opacity:1}56%,63%{transform:translateY(-15px);opacity:1}64%,71%{transform:translateY(-21px);opacity:1}72%,91%{transform:translateY(-24px);opacity:0}}' +
  '@keyframes mflick{0%,49%{transform:scaleY(.65)}50%,100%{transform:scaleY(1)}}' +
  '@keyframes msmoke{0%,23%,48%,100%{transform:translateX(0);opacity:0}24%,35%{transform:translateX(0);opacity:1}36%,47%{transform:translateX(-1.5px);opacity:.5}}@keyframes msmoke2{0%,23%,48%,100%{transform:translateX(0);opacity:0}24%,35%{transform:translateX(0);opacity:1}36%,47%{transform:translateX(1.5px);opacity:.5}}' +
  '@keyframes mwave{0%,100%{transform:skewY(0) scaleX(1)}50%{transform:skewY(12deg) scaleX(.85)}}' +
  '@keyframes mdot{0%,32%{transform:translateY(-1.5px);opacity:1}33%,100%{transform:translateY(0);opacity:.35}}' +
  '@keyframes mconfetti{0%,19%{transform:translate(0,0);opacity:1}20%,39%{transform:translate(1.5px,1.5px);opacity:1}40%,59%{transform:translate(0,3px);opacity:1}60%,79%{transform:translate(1.5px,4.5px);opacity:.6}80%,100%{transform:translate(0,6px);opacity:0}}' +
  '@media (prefers-color-scheme: dark){.mz .ik{fill:#D9D6CF}}' +
  '@media (prefers-reduced-motion: reduce){.mz,.mz g,.mz rect{animation:none!important}}'

/**
 * The mascot for a row state as an SVG `<g>` at (x, y): its prop, the body, and whether it
 * walks (only while a phase is open). Props over the body draw after it.
 */
export const mascot = (key: MascotKey, x: number, y: number, opts: { isWalking: boolean; isDone: boolean }): string => {
  const g = grid()
  const prop = PROPS[key]
  body(g, opts.isDone, prop.raised)
  prop.draw(g)
  // Nest independent motions: launch carries exhaust, blink rides scan, the flag rides its pole.
  const group = (name: string): string => {
    if (!g.groups.has(name)) return ''
    const children = name === 'rk' ? ['fl'] : name === 'pole' ? ['flag'] : []
    const svg = `<g class="${name}">${g.groups.get(name)!.join('')}${children.map(group).join('')}</g>`
    return name === 'ey' && key === '6' ? `<g class="scan">${svg}</g>` : svg
  }
  // Legs outside the bobbing body; everything else rides the bob.
  // The eyes draw last, so they show through a prop's lenses.
  const nested = new Set(['bd', 'la', 'lb', 'ey', 'fl', 'flag'])
  const riders = [...g.groups.keys()].filter(name => !nested.has(name)).concat(g.groups.has('ey') ? ['ey'] : [])
  const bodyGroup = `<g class="bd">${(g.groups.get('bd') ?? []).join('')}${riders.map(group).join('')}</g>`

  return (
    `<g class="mascot" data-mascot="${MASCOT_NAMES[key]}" transform="translate(${x},${y}) scale(${SCALE})" shape-rendering="crispEdges">` +
    `<g class="mz mz-${MASCOT_NAMES[key]}${opts.isWalking ? ' run' : ''}">${bodyGroup}${group('la')}${group('lb')}</g></g>`
  )
}
