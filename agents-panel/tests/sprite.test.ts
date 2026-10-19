import { expect, test } from 'claude-code/testing'

import { ACCENT, CLAWD_CSS, CLAWD_W, clawd } from '../hooks/sprite'

const COSTUMES = ['plain', 'pirate', 'detective', 'engineer', 'chef', 'codex', 'panda', 'gemini', 'grok', 'composer'] as const

for (const costume of COSTUMES) {
  test(`sprite: ${costume} is well-formed, has both leg groups, and only walks when asked`, async () => {
    const still = clawd(0, 0, costume)
    const walking = clawd(0, 0, costume, { isWalking: true })
    // Every <g> closes; every <rect> self-closes.
    expect((still.match(/<g\b/g) ?? []).length).toBe((still.match(/<\/g>/g) ?? []).length)
    expect(still).not.toMatch(/<rect[^>]*[^/]>/)
    expect(still).toContain('class="la"')
    expect(still).toContain('class="lb"')
    expect(still).toContain('class="bd"')
    expect(still).not.toContain(' run"')
    expect(walking).toContain(`class="c-${costume} run"`)
    expect(still.length).toBeLessThan(20000)
    expect(ACCENT[costume]).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })
}

test('sprite: dim, scale and tint reach the markup', async () => {
  expect(clawd(0, 0, 'plain', { dim: true })).toContain('opacity="0.45"')
  expect(clawd(4, 2, 'plain', { scale: 0.8 })).toContain('translate(4,2) scale(0.8)')
  expect(clawd(0, 0, 'plain', { tint: '#5fbf8f' })).toContain('fill="#5fbf8f"')
  expect(clawd(0, 0, 'plain')).not.toContain('#5fbf8f')
  expect(CLAWD_W).toBe(26)
  expect(CLAWD_CSS).toContain('prefers-reduced-motion')
})

test('sprite: codex is the Codex bot on its own grid, its cursor blinking only while it runs', async () => {
  const still = clawd(0, 0, 'codex')
  // One unit a cell, shifted five units right: the screen's top-left border cell.
  expect(still).toContain('<rect x="9" y="4" width="12" height="1" fill="#020619"/>')
  expect(still).toContain('<g class="cu"><rect x="14" y="10" width="4" height="1" fill="#9BF0F8"/></g>')
  expect(still).not.toContain('class="ey"')
  expect(clawd(0, 0, 'codex', { tint: '#5fbf8f' })).toContain('fill="#5fbf8f"')
  expect(CLAWD_CSS).toContain('.c-codex.run .cu{')
})

test('sprite: panda is the Kimi panda on the same grid, its eye shine blinking', async () => {
  const still = clawd(0, 0, 'panda')
  expect(still).toContain('<g class="ey"><rect x="10" y="6" width="1" height="1" fill="#F2F2EF"/><rect x="19" y="6" width="1" height="1" fill="#F2F2EF"/></g>')
  expect(still).toContain('fill="#F08A7E"')
  expect(still).toContain('class="la"')
  // Its black cells carry a tone dark mode lifts to slate, so the limbs stay visible; light mode keeps the black.
  expect(still).toContain('<rect class="pk" x="8" y="0" width="3" height="1" fill="#13202B"/>')
  expect(still).not.toMatch(/<rect class="pk"[^>]*fill="#F2F2EF"/)
  // The nose and eye patches sit on the white face and stay black.
  expect(still).toContain('<rect x="14" y="8" width="2" height="1" fill="#13202B"/>')
  expect(CLAWD_CSS).toMatch(/@media \(prefers-color-scheme: dark\)\{\.c-panda \.pk\{fill:#6B7584\}/)
  expect(clawd(0, 0, 'codex')).not.toContain('class="pk"')
})

test('sprite: gemini is the rainbow droplet, banded on its diagonal, its bands cycling only while it runs', async () => {
  const still = clawd(0, 0, 'gemini')
  // Row 6's body starts at column 6: diagonal 12, band 2 (yellow), shifted five units right.
  expect(still).toContain('<rect class="g2" x="11" y="6"')
  // The body's diagonals run 12-39: bands 2 to 6, then 0 as the cycle wraps.
  for (const i of [2, 3, 4, 5, 6, 0]) {
    expect(still).toContain(`class="g${i}"`)
  }
  expect(still).not.toContain('class="g1"')
  // No feet: the leg groups are there and empty, so nothing steps.
  expect(still).toContain('<g class="la"></g><g class="lb"></g>')
  expect(CLAWD_CSS).toContain('.c-gemini.run rect[class^="g"]{animation:crainbow')
  expect(CLAWD_CSS).toContain('.run rect,')
  expect(clawd(0, 0, 'gemini', { tint: '#5fbf8f' })).not.toContain('#FF3B30')
})

test('sprite: grok is the ball, black with white eyes in light mode and white with black eyes in dark', async () => {
  const still = clawd(0, 0, 'grok')
  // The ball's top row, five units right; its eyes blink in the eye group.
  expect(still).toContain('<rect class="kb" x="12" y="4" width="6" height="1" fill="#0B0B0B"/>')
  expect(still).toMatch(/<g class="ey"><rect class="ke"[^>]*fill="#F8F6F1"/)
  expect(still).toContain('class="kh"')
  expect(still).toContain('<g class="la"></g><g class="lb"></g>')
  expect(CLAWD_CSS).toContain('.c-grok .kb,.c-grok .kh{fill:#F8F8F6}.c-grok .ke{fill:#0B0B0B}')
  expect(CLAWD_CSS).toMatch(/@media \(prefers-color-scheme: dark\)\{[^@]*\.c-grok \.kb/)
})

test('sprite: composer is the cube, 24 wide and centred three units in, its boots stepping', async () => {
  const still = clawd(0, 0, 'composer')
  // The top edge: four cells from column 10, three units in.
  expect(still).toContain('<rect x="13" y="0" width="4" height="1" fill="#111111"/>')
  // Dot eyes on the light face.
  expect(still).toContain('<rect x="11" y="7" width="2" height="1" fill="#111111"/>')
  // Boots split at the middle column: the left boot's sole in la, the right one's in lb.
  expect(still).toMatch(/<g class="la"><rect x="7" y="22"[^]*<\/g><g class="lb"><rect x="16" y="22"/)
  expect(clawd(0, 0, 'composer', { tint: '#5fbf8f' })).toContain('fill="#5fbf8f"')
})
