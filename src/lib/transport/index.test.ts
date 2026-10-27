import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Module from "node:module"
import {
  __resetTransportForTests,
  configureRemoteDesktopTransport,
  getActiveRemoteConnectionId,
  getActiveRemoteTransportConfig,
  getTransport,
  invalidateRemoteDesktopTransport,
} from "./index"
import type { RemoteTransportConfig, Transport } from "./types"

let created: Transport[]

beforeEach(() => {
  created = []
  // Production loads transports through CommonJS require. Vitest's ESM mocks
  // cannot intercept it, so stub only that native loader entry for this suite.
  const loader = Module as unknown as {
    _load: (request: string, ...args: unknown[]) => unknown
  }
  const originalLoad = loader._load.bind(Module)
  const remoteModule = {
    RemoteDesktopTransport: class {
      call = vi.fn()
      subscribe = vi.fn()
      isDesktop = () => true
      destroy = vi.fn()
      constructor() {
        created.push(this)
      }
    },
  }
  vi.spyOn(loader, "_load").mockImplementation((request, ...args) =>
    request === "./remote-desktop-transport"
      ? remoteModule
      : originalLoad(request, ...args)
  )
})

afterEach(() => {
  __resetTransportForTests()
  vi.restoreAllMocks()
})

function config(revision = "revision-a"): RemoteTransportConfig {
  return {
    id: 1,
    name: "A",
    baseUrl: "http://a.test",
    token: "token-a",
    configRevision: revision,
    windowInstanceId: "window-a",
    onUnauthorized: vi.fn(),
  }
}

describe("legacy remote transport ownership", () => {
  it("returns a snapshot of the configured revision, window and callbacks", () => {
    const a = config()
    configureRemoteDesktopTransport(a)
    const captured = getActiveRemoteTransportConfig()!
    a.configRevision = "mutated"
    expect(getActiveRemoteTransportConfig()?.configRevision).toBe("revision-a")
    const b = config("revision-b")
    b.windowInstanceId = "window-b"
    configureRemoteDesktopTransport(b)
    expect(captured.configRevision).toBe("revision-a")
    expect(captured.windowInstanceId).toBe("window-a")
    captured.onUnauthorized?.()
    expect(a.onUnauthorized).toHaveBeenCalledOnce()
    expect(b.onUnauthorized).not.toHaveBeenCalled()
    expect(getActiveRemoteTransportConfig()?.configRevision).toBe("revision-b")
    expect(created[0].destroy).toHaveBeenCalledOnce()
  })

  it("blocks compatibility lookups when retired instead of returning the shell", () => {
    configureRemoteDesktopTransport(config())
    expect(getTransport()).toBe(created[0])
    invalidateRemoteDesktopTransport()
    expect(getActiveRemoteConnectionId()).toBe(1)
    expect(() => getTransport()).toThrow(/close and reopen/)
    expect(() => getActiveRemoteTransportConfig()).toThrow(/close and reopen/)
    expect(created[0].destroy).toHaveBeenCalledOnce()
  })
})
