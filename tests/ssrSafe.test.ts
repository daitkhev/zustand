import { expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { ssrSafe } from 'zustand/middleware/ssrSafe'

// To avoid include react deps on vanilla version
vi.mock('react', () => ({}))

type State = { count: number; inc: () => void }

it('defaults to non-SSR when window is defined (jsdom)', () => {
  const store = createStore<State>()(
    ssrSafe((set) => ({
      count: 0,
      inc: () => set((s) => ({ count: s.count + 1 })),
    })),
  )
  store.getState().inc()
  expect(store.getState().count).toBe(1)
  store.setState({ count: 5 })
  expect(store.getState().count).toBe(5)
})

it('passes set, get and api through unchanged when isSSR is false', () => {
  const config = vi.fn(() => ({ count: 0, inc: () => {} }))
  const store = createStore<State>()(ssrSafe(config, false))
  expect(config).toHaveBeenCalledTimes(1)
  const [set, get, api] = config.mock.calls[0] as unknown as [
    unknown,
    unknown,
    unknown,
  ]
  expect(set).toBe(store.setState)
  expect(get).toBe(store.getState)
  expect(api).toBe(store)
})

it('throws on setState when isSSR is true', () => {
  const store = createStore<State>()(
    ssrSafe(() => ({ count: 0, inc: () => {} }), true),
  )
  expect(() => store.setState({ count: 1 })).toThrow(
    'Cannot set state of Zustand store in SSR',
  )
  expect(store.getState().count).toBe(0)
})

it('throws when the config calls set in SSR mode', () => {
  const store = createStore<State>()(
    ssrSafe(
      (set) => ({
        count: 0,
        inc: () => set((s) => ({ count: s.count + 1 })),
      }),
      true,
    ),
  )
  expect(() => store.getState().inc()).toThrow(
    'Cannot set state of Zustand store in SSR',
  )
  expect(store.getState().count).toBe(0)
})

it('replaces api.setState and passes the same function to config in SSR mode', () => {
  const config = vi.fn(() => ({ count: 0, inc: () => {} }))
  const store = createStore<State>()(ssrSafe(config, true))
  const [set] = config.mock.calls[0] as unknown as [unknown]
  expect(set).toBe(store.setState)
})
