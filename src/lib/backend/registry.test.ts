import { describe, expect, it, vi } from "vitest"
import { BackendRegistry, type BackendLifetime } from "./registry"
import { FencedTransport } from "./fenced-transport"
import type { RemoteWorkspaceConnection } from "@/lib/types"
import type { Transport } from "@/lib/transport/types"

function connection(
  id: number,
  name = `Machine ${id}`
): RemoteWorkspaceConnection {
  return {
    id,
    name,
    base_url: `http://machine-${id}:3080`,
    token: `private-${id}`,
    headers: [],
    sort_order: id,
    created_at: "2026-10-11T00:00:00Z",
    updated_at: "2026-10-11T00:00:00Z",
  }
}

describe("window backend registry", () => {
  it("keeps two machines independent and retains the unchanged runtimes", () => {
    const factory = vi.fn(() => ({ dispose: vi.fn() }))
    const registry = new BackendRegistry(factory)
    registry.syncRemoteConnections([connection(1), connection(2)])
    const a = registry.get("remote:1")!
    const b = registry.get("remote:2")!
    registry.syncRemoteConnections([connection(1, "Renamed"), connection(2)])
    expect(registry.get("remote:1")).toBe(a)
    expect(registry.get("remote:2")).toBe(b)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(a.dispose).not.toHaveBeenCalled()
    expect(registry.descriptor("remote:1")?.name).toBe("Renamed")
    expect(JSON.stringify(registry.getSnapshot())).not.toContain("private-")
  })

  it("retains a runtime for effective header equivalence but replaces it for changed repeated values", () => {
    const registry = new BackendRegistry(() => ({ dispose: vi.fn() }))
    const a = {
      ...connection(1),
      headers: [
        { name: "X-Route", value: "A" },
        { name: "X-Trace", value: "1" },
        { name: "X-Route", value: "B" },
      ],
    }
    registry.syncRemoteConnections([a])
    const runtime = registry.get("remote:1")!
    registry.syncRemoteConnections([
      {
        ...a,
        name: "Renamed",
        headers: [
          { name: "x-trace", value: "1" },
          { name: "x-route", value: "A" },
          { name: "x-route", value: "B" },
        ],
      },
    ])
    expect(registry.get("remote:1")).toBe(runtime)
    expect(runtime.dispose).not.toHaveBeenCalled()
    registry.syncRemoteConnections([
      {
        ...a,
        headers: [
          { name: "x-route", value: "B" },
          { name: "x-route", value: "A" },
          { name: "x-trace", value: "1" },
        ],
      },
    ])
    expect(registry.get("remote:1")).not.toBe(runtime)
    expect(runtime.dispose).toHaveBeenCalledOnce()
    registry.dispose()
  })

  it("reflects saved machine reorder without replacing either runtime", () => {
    const factory = vi.fn(() => ({ dispose: vi.fn() }))
    const registry = new BackendRegistry(factory)
    registry.upsert({ key: "local", name: "Local", connection: null })
    registry.syncRemoteConnections([connection(1), connection(2)])
    const a = registry.get("remote:1")!
    const b = registry.get("remote:2")!
    registry.syncRemoteConnections([connection(2), connection(1)])
    expect(registry.getSnapshot().map((host) => host.key)).toEqual([
      "local",
      "remote:2",
      "remote:1",
    ])
    expect(registry.get("remote:1")).toBe(a)
    expect(registry.get("remote:2")).toBe(b)
    expect(factory).toHaveBeenCalledTimes(3)
    expect(a.dispose).not.toHaveBeenCalled()
    expect(b.dispose).not.toHaveBeenCalled()
    registry.dispose()
  })

  it("retires only the edited endpoint and rejects its delayed events", () => {
    const lifetimes: BackendLifetime[] = []
    const registry = new BackendRegistry((_target, lifetime) => {
      lifetimes.push(lifetime)
      return { dispose: vi.fn() }
    })
    registry.syncRemoteConnections([connection(1), connection(2)])
    const a = registry.get("remote:1")!
    const b = registry.get("remote:2")!
    registry.upsert({
      key: "remote:1",
      name: "Moved",
      connection: { ...connection(1), base_url: "http://replacement:3080" },
    })
    expect(a.dispose).toHaveBeenCalledOnce()
    expect(b.dispose).not.toHaveBeenCalled()
    expect(lifetimes[0].isCurrent()).toBe(false)
    lifetimes[0].setStatus("unauthorized")
    expect(registry.descriptor("remote:1")?.status).toBe("connecting")
    lifetimes[1].setStatus("connected")
    expect(registry.descriptor("remote:2")?.status).toBe("connected")
  })

  it("an authentication error only affects its own machine", () => {
    const lifetimes: BackendLifetime[] = []
    const registry = new BackendRegistry((_target, lifetime) => {
      lifetimes.push(lifetime)
      return { dispose: vi.fn() }
    })
    registry.syncRemoteConnections([connection(1), connection(2)])
    lifetimes[0].setStatus("unauthorized")
    lifetimes[1].setStatus("connected")
    expect(registry.descriptor("remote:1")?.status).toBe("unauthorized")
    expect(registry.descriptor("remote:2")?.status).toBe("connected")
  })

  it("removes a saved connection without touching local or another machine", () => {
    const registry = new BackendRegistry(() => ({ dispose: vi.fn() }))
    const local = registry.upsert({
      key: "local",
      name: "Local",
      connection: null,
    })
    registry.syncRemoteConnections([connection(1), connection(2)])
    const removed = registry.get("remote:1")!
    const retained = registry.get("remote:2")!
    registry.syncRemoteConnections([connection(2)])
    expect(removed.dispose).toHaveBeenCalledOnce()
    expect(local.dispose).not.toHaveBeenCalled()
    expect(retained.dispose).not.toHaveBeenCalled()
    expect(registry.getSnapshot().map((host) => host.key)).toEqual([
      "local",
      "remote:2",
    ])
    registry.dispose()
    registry.dispose()
    expect(local.dispose).toHaveBeenCalledOnce()
    expect(retained.dispose).toHaveBeenCalledOnce()
  })
})

describe("fixed generation transport", () => {
  it("rejects A's old pending response after replacing A while B stays valid", async () => {
    let resolve!: (value: unknown) => void
    const lifetimes: BackendLifetime[] = []
    const registry = new BackendRegistry((_target, lifetime) => {
      lifetimes.push(lifetime)
      return { dispose: vi.fn() }
    })
    registry.syncRemoteConnections([connection(1), connection(2)])
    const innerA: Transport = {
      call: <T>() =>
        new Promise<T>((done) => {
          resolve = (value) => done(value as T)
        }),
      subscribe: vi.fn(),
      isDesktop: () => false,
    }
    const innerB: Transport = {
      call: vi.fn().mockResolvedValue({ id: 1, path: "/repo" }),
      subscribe: vi.fn(),
      isDesktop: () => false,
    }
    const a = new FencedTransport(innerA, lifetimes[0])
    const b = new FencedTransport(innerB, lifetimes[1])
    const pending = a.call("get_folder", { id: 1 })
    registry.upsert({
      key: "remote:1",
      name: "New endpoint",
      connection: { ...connection(1), token: "new-private" },
    })
    resolve({ id: 1, path: "/repo" })
    await expect(pending).rejects.toMatchObject({ code: "backend_retired" })
    await expect(b.call("get_folder", { id: 1 })).resolves.toEqual({
      id: 1,
      path: "/repo",
    })
    expect(b.eventStream).toBeUndefined()
  })

  it("filters old subscribed events and cleans a subscription that resolves late", async () => {
    const lifetimes: BackendLifetime[] = []
    const registry = new BackendRegistry((_target, lifetime) => {
      lifetimes.push(lifetime)
      return { dispose: vi.fn() }
    })
    registry.syncRemoteConnections([connection(1)])
    let callback!: (payload: unknown) => void
    let finish!: (unsubscribe: () => void) => void
    const dispose = vi.fn()
    const inner: Transport = {
      call: vi.fn(),
      subscribe: vi.fn((_event, handler) => {
        callback = handler
        return new Promise<() => void>((resolve) => {
          finish = resolve
        })
      }),
      isDesktop: () => false,
    }
    const transport = new FencedTransport(inner, lifetimes[0])
    const handler = vi.fn()
    const pending = transport.subscribe("folder://changed", handler)
    registry.remove("remote:1")
    callback({ id: 1 })
    finish(dispose)
    await expect(pending).rejects.toMatchObject({ code: "backend_retired" })
    expect(handler).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
