import {
  create,
  type StateCreator,
  type UseBoundStore,
  type StoreApi,
} from "zustand"

/** Cancellation of a store generation, rather than a backend request failure. */
export class StaleStoreRequest extends Error {
  constructor() {
    super("Backend store generation is no longer active")
    this.name = "StaleStoreRequest"
  }
}

export function isStaleStoreRequest(error: unknown): boolean {
  return error instanceof StaleStoreRequest
}

/** Owns requests, timers and subscriptions without depending on React. */
export function createStoreScope() {
  let disposed = false
  let epoch = 0
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const cleanups = new Set<() => void>()
  const active = (generation: number) => !disposed && epoch === generation

  function invalidate() {
    epoch++
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }

  function bindApi<T extends object>(api: T, guardGeneration = true): T {
    return new Proxy({} as T, {
      get(_target, key) {
        return (...args: unknown[]) => {
          const generation = epoch
          if (!active(generation))
            return Promise.reject(new StaleStoreRequest())
          const fn = Reflect.get(api, key) as (...args: unknown[]) => unknown
          const result = fn.apply(api, args)
          if (!guardGeneration) return result
          return Promise.resolve(result).then(
            (result) => {
              if (!active(generation)) throw new StaleStoreRequest()
              return result
            },
            (error: unknown) => {
              if (!active(generation)) throw new StaleStoreRequest()
              throw error
            }
          )
        }
      },
    })
  }

  function createScopedStore<T>(
    initializer: StateCreator<T>
  ): UseBoundStore<StoreApi<T>> {
    const store = create<T>()((set, get, api) => {
      const guardedSet = ((...args: unknown[]) => {
        if (!disposed) Reflect.apply(set, undefined, args)
      }) as typeof set
      const state = initializer(guardedSet, get, api)
      // Actions retained by an unmounted view must not mutate a disposed runtime.
      const guardFunctions = (value: object): object =>
        Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            typeof entry === "function"
              ? (...args: unknown[]) => (disposed ? undefined : entry(...args))
              : key === "actions" && entry && typeof entry === "object"
                ? guardFunctions(entry)
                : entry,
          ])
        )
      return guardFunctions(state as object) as T
    })
    const setState = store.setState
    store.setState = ((...args: Parameters<typeof setState>) => {
      if (!disposed) Reflect.apply(setState, undefined, args)
    }) as typeof setState
    return store
  }

  return {
    create: createScopedStore,
    bindApi,
    active,
    assertCurrent(generation: number) {
      if (!active(generation)) throw new StaleStoreRequest()
    },
    get epoch() {
      return epoch
    },
    get disposed() {
      return disposed
    },
    invalidate,
    setTimeout(
      callback: () => void,
      delay: number
    ): ReturnType<typeof setTimeout> {
      const generation = epoch
      if (!active(generation))
        return 0 as unknown as ReturnType<typeof setTimeout>
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (active(generation)) callback()
      }, delay)
      timers.add(timer)
      return timer
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      clearTimeout(timer)
      timers.delete(timer)
    },
    onDispose(cleanup: () => void) {
      if (disposed) cleanup()
      else cleanups.add(cleanup)
      return () => cleanups.delete(cleanup)
    },
    dispose() {
      if (disposed) return
      try {
        for (const cleanup of cleanups) cleanup()
      } finally {
        disposed = true
        invalidate()
        cleanups.clear()
      }
    },
  }
}
