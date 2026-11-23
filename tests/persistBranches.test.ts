import { afterEach, expect, it, vi } from 'vitest'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { PersistOptions, StorageValue } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'

type State = { count: number; extra?: string }

type Stored = StorageValue<State> | null

function createStorage(initial: Stored | (() => Stored) = null) {
  return {
    getItem: vi.fn((_name: string): Stored =>
      typeof initial === 'function' ? initial() : initial,
    ),
    setItem: vi.fn((_name: string, _value: StorageValue<State>) => {}),
    removeItem: vi.fn((_name: string) => {}),
  }
}

function createPersistedStore(
  options: Omit<PersistOptions<State>, 'name'>,
  initialState: State = { count: 0 },
) {
  return createStore(
    persist((): State => initialState, {
      name: 'persist-branches',
      skipHydration: true,
      ...options,
    }),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

it('createJSONStorage returns undefined when getStorage throws', () => {
  const result = createJSONStorage<State>(() => {
    throw new Error('no storage')
  })
  expect(result).toBeUndefined()
})

it('createJSONStorage getItem returns null without running the reviver', () => {
  const reviver = vi.fn((_key: string, value: unknown) => value)
  const storage = createJSONStorage<State>(
    () => ({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    }),
    { reviver },
  )
  expect(storage?.getItem('x')).toBeNull()
  expect(reviver).not.toHaveBeenCalled()
})

it('warns and still updates state when the storage is unavailable', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = createStore(
    persist(
      (set): State & { inc: () => void } => ({
        count: 0,
        inc: () => set((s) => ({ count: s.count + 1 })),
      }),
      { name: 'no-storage', storage: undefined },
    ),
  )
  store.getState().inc()
  expect(store.getState().count).toBe(1)
  expect(warn).toHaveBeenCalledWith(
    "[zustand persist middleware] Unable to update item 'no-storage', the given storage is currently unavailable.",
  )
})

it('uses window.localStorage by default', () => {
  const store = createStore(
    persist((): State => ({ count: 0 }), {
      name: 'default-ls',
      skipHydration: true,
    }),
  )
  store.setState({ count: 3 })
  expect(JSON.parse(localStorage.getItem('default-ls') as string)).toEqual({
    state: { count: 3 },
    version: 0,
  })
})

it('getInitialState returns the initializer result', async () => {
  const storage = createStorage({ state: { count: 42 }, version: 0 })
  const store = createPersistedStore({ storage })
  await store.persist.rehydrate()
  expect(store.getState().count).toBe(42)
  expect(store.getInitialState()).toEqual({ count: 0 })
})

it('onRehydrateStorage receives the initial state on first hydration', async () => {
  const storage = createStorage(null)
  const onRehydrateStorage = vi.fn((_state: State) => {})
  const hydrate = vi.fn()
  const store = createPersistedStore({ storage, onRehydrateStorage })
  store.persist.onHydrate(hydrate)
  await store.persist.rehydrate()
  expect(onRehydrateStorage).toHaveBeenCalledWith({ count: 0 })
  expect(hydrate).toHaveBeenCalledWith({ count: 0 })
})

it('replaces the state with the merged result on hydration', async () => {
  const storage = createStorage({ state: { count: 5 }, version: 0 })
  const store = createPersistedStore(
    { storage, merge: () => ({ count: 5 }) },
    { count: 0, extra: 'x' },
  )
  await store.persist.rehydrate()
  expect(store.getState()).toEqual({ count: 5 })
})

it('logs an error on version mismatch without migrate', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const storage = createStorage({ state: { count: 9 }, version: 5 })
  const store = createPersistedStore({ storage })
  await store.persist.rehydrate()
  expect(error).toHaveBeenCalledWith(
    "State loaded from storage couldn't be migrated since no migrate function was provided",
  )
  expect(store.getState()).toEqual({ count: 0 })
})

it('writes the migrated state back to storage', async () => {
  const storage = createStorage({ state: { count: 9 }, version: 5 })
  const migrate = vi.fn((_state: unknown, _version: number): State => ({
    count: 7,
  }))
  const store = createPersistedStore({ storage, migrate, version: 1 })
  await store.persist.rehydrate()
  expect(migrate).toHaveBeenCalledWith({ count: 9 }, 5)
  expect(store.getState().count).toBe(7)
  expect(storage.setItem).toHaveBeenCalledWith('persist-branches', {
    state: { count: 7 },
    version: 1,
  })
})

it('passes read errors to the callback and resolves rehydrate', async () => {
  const failure = new Error('boom')
  const storage = createStorage(() => {
    throw failure
  })
  const after = vi.fn((_state?: State, _error?: unknown) => {})
  const store = createPersistedStore({
    storage,
    onRehydrateStorage: () => after,
  })
  await expect(store.persist.rehydrate()).resolves.toBeUndefined()
  expect(after).toHaveBeenCalledWith(undefined, failure)
  expect(store.persist.hasHydrated()).toBe(false)
})

it('resolves rehydrate on read errors without a callback', async () => {
  const storage = createStorage(() => {
    throw new Error('boom')
  })
  const store = createPersistedStore({ storage })
  await expect(store.persist.rehydrate()).resolves.toBeUndefined()
})

it('clearStorage removes the item and aborts in-flight hydration', async () => {
  const resolvers: Array<(value: Stored) => void> = []
  const storage = {
    getItem: vi.fn(
      (_name: string) =>
        new Promise<Stored>((resolve) => {
          resolvers.push(resolve)
        }),
    ),
    setItem: vi.fn((_name: string, _value: StorageValue<State>) => {}),
    removeItem: vi.fn((_name: string) => {}),
  }
  const after = vi.fn((_state?: State, _error?: unknown) => {})
  const store = createPersistedStore({
    storage,
    onRehydrateStorage: () => after,
  })

  const first = store.persist.rehydrate()
  store.persist.clearStorage()
  expect(storage.removeItem).toHaveBeenCalledWith('persist-branches')
  const second = store.persist.rehydrate()

  resolvers[1]!({ state: { count: 2 }, version: 0 })
  await second
  resolvers[0]!({ state: { count: 1 }, version: 0 })
  await first

  expect(store.getState().count).toBe(2)
  expect(after).toHaveBeenCalledTimes(1)
})

it('aborts the earlier of two concurrent rehydrations', async () => {
  const resolvers: Array<(value: Stored) => void> = []
  const storage = {
    getItem: vi.fn(
      (_name: string) =>
        new Promise<Stored>((resolve) => {
          resolvers.push(resolve)
        }),
    ),
    setItem: vi.fn((_name: string, _value: StorageValue<State>) => {}),
    removeItem: vi.fn((_name: string) => {}),
  }
  const store = createPersistedStore({ storage })
  const first = store.persist.rehydrate()
  const second = store.persist.rehydrate()
  resolvers[1]!({ state: { count: 2 }, version: 0 })
  await second
  resolvers[0]!({ state: { count: 1 }, version: 0 })
  await first
  expect(store.getState().count).toBe(2)
  expect(store.persist.hasHydrated()).toBe(true)
})

it('setOptions switches storage only when one is given', () => {
  const first = createStorage()
  const second = createStorage()
  const store = createPersistedStore({ storage: first })

  store.persist.setOptions({ version: 3 })
  store.setState({ count: 1 })
  expect(first.setItem).toHaveBeenCalledWith('persist-branches', {
    state: { count: 1 },
    version: 3,
  })

  store.persist.setOptions({ storage: second })
  store.setState({ count: 2 })
  expect(second.setItem).toHaveBeenCalledWith('persist-branches', {
    state: { count: 2 },
    version: 3,
  })
  expect(first.setItem).toHaveBeenCalledTimes(1)
})
