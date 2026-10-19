// stands in for the engine's 'claude-code' module: atoms live in $.__state
export const atom = (ref: { key: string }, initial: unknown) => ({ ref, initial })
export async function read($: any, a: any) {
  return $.__state.has(a.ref.key) ? $.__state.get(a.ref.key) : a.initial
}
export async function update($: any, a: any, fn: (v: any) => any) {
  const cur = $.__state.has(a.ref.key) ? $.__state.get(a.ref.key) : a.initial
  $.__state.set(a.ref.key, fn(cur))
  $.__rerender?.()
}
