import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  academicImport,
  academicLibrary,
  academicPaperGet,
  academicSelect,
} from "./academic"
import { WebTransport } from "./transport/web-transport"
import { RemoteDesktopTransport } from "./transport/remote-desktop-transport"
import type { Transport } from "./transport/types"

const state = vi.hoisted(() => ({
  active: null as Transport | null,
  invoke: vi.fn(),
}))
vi.mock("./transport", () => ({ getTransport: () => state.active }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: state.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }))
const settings = { agent_type: "codex", bridge_port: 23119, paired: true }
const operations = [
  {
    command: "academic_library",
    run: () => academicLibrary(),
    duration: 185_000,
    deadline: 190_000,
  },
  {
    command: "academic_select",
    run: () => academicSelect("ITEM"),
    duration: 185_000,
    deadline: 190_000,
  },
  {
    command: "academic_import",
    run: () => academicImport("arXiv:2401.12345", "COLLECTION"),
    duration: 275_000,
    deadline: 280_000,
  },
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => {
  state.active?.destroy?.()
  state.active = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("academic bridge deadlines", () => {
  it.each(operations)(
    "lets web $command complete within the backend bridge deadline",
    async ({ run, duration }) => {
      state.active = new WebTransport("http://workspace.test")
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, options: RequestInit) => {
          if (url.endsWith("academic_settings_get"))
            return Promise.resolve(new Response(JSON.stringify(settings)))
          return new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(
              () => resolve(new Response(JSON.stringify({ success: true }))),
              duration
            )
            options.signal!.addEventListener("abort", () => {
              clearTimeout(timer)
              reject(new DOMException("Timed out", "AbortError"))
            })
          })
        })
      )
      const result = run().then(
        (value) => value,
        (error) => error
      )
      await vi.advanceTimersByTimeAsync(duration)
      expect(await result).toEqual({ success: true })
    }
  )

  it.each(operations)(
    "forwards the $command deadline through the remote desktop proxy",
    async ({ command, run, deadline }) => {
      state.active = new RemoteDesktopTransport({
        id: 9,
        name: "Research",
        baseUrl: "http://workspace.test",
        token: "codeg-test-token",
        windowInstanceId: "academic-test",
      })
      state.invoke.mockImplementation(
        async (_command: string, args: Record<string, unknown>) =>
          args.command === "academic_settings_get"
            ? settings
            : { success: true }
      )
      await expect(run()).resolves.toEqual({ success: true })
      expect(state.invoke).toHaveBeenCalledWith(
        "remote_http_call",
        expect.objectContaining({
          command,
          connectionId: 9,
          timeoutMs: deadline,
        })
      )
    }
  )

  it("keeps the normal web deadline for fast database lookups", async () => {
    state.active = new WebTransport("http://workspace.test")
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener("abort", () =>
              reject(new DOMException("Timed out", "AbortError"))
            )
          })
      )
    )
    const result = academicPaperGet("paper").then(
      (value) => value,
      (error) => error
    )
    await vi.advanceTimersByTimeAsync(60_001)
    expect(await result).toEqual(new Error("Request timed out"))
  })
})
