import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useAcademicEvents } from "./use-academic-events"
import { useAcademicStore } from "@/stores/academic-store"
import type { AcademicPaper } from "@/lib/academic"

const backend = vi.hoisted(() => {
  const handlers = new Set<(event: { paper_id: string }) => void>()
  const reconnects = new Set<() => void>()
  const transport = {
    call: vi.fn(),
    subscribe: vi.fn(
      async (
        _channel: string,
        handler: (event: { paper_id: string }) => void
      ) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      }
    ),
    onReconnect: (callback: () => void) => {
      reconnects.add(callback)
      return () => {
        reconnects.delete(callback)
      }
    },
  }
  return { handlers, reconnects, transport, active: transport }
})
vi.mock("@/lib/transport", () => ({ getTransport: () => backend.active }))
vi.mock("@/lib/platform", () => ({
  isLocalDesktop: () => false,
  subscribe: (...args: Parameters<typeof backend.transport.subscribe>) =>
    backend.transport.subscribe(...args),
}))

beforeEach(() => {
  backend.active = backend.transport
  vi.clearAllMocks()
  backend.transport.call.mockImplementation(async (command: string) => {
    if (command === "academic_paper_get")
      return { id: "paper", status: "ready" }
    if (command === "academic_library")
      return {
        library_id: 1,
        instance_id: "remote",
        items: [],
        collections: [],
      }
    return { agent_type: "codex", paired: true, bridge_port: 23119 }
  })
  useAcademicStore.getState().reset()
  useAcademicStore.setState({
    selectedPaper: { id: "paper", status: "cloning" } as AcademicPaper,
  })
})
afterEach(() => {
  expect(backend.handlers.size).toBe(0)
  expect(backend.reconnects.size).toBe(0)
})

it("shares remote event subscriptions and refreshes paper progress", async () => {
  const first = renderHook(useAcademicEvents)
  const second = renderHook(useAcademicEvents)
  await waitFor(() => expect(backend.handlers.size).toBe(1))
  await act(async () => {
    for (const handler of backend.handlers) handler({ paper_id: "paper" })
  })
  expect(useAcademicStore.getState().selectedPaper?.status).toBe("ready")
  first.unmount()
  expect(backend.handlers.size).toBe(1)
  second.unmount()
})
it("recovers missed paper progress and library updates after reconnect", async () => {
  const hook = renderHook(useAcademicEvents)
  await waitFor(() => expect(backend.reconnects.size).toBe(1))
  useAcademicStore.setState({
    selectedPaper: { id: "paper", status: "cloning" } as AcademicPaper,
  })
  await act(async () => {
    for (const reconnect of backend.reconnects) reconnect()
  })
  expect(useAcademicStore.getState().selectedPaper?.status).toBe("ready")
  expect(useAcademicStore.getState().library?.instance_id).toBe("remote")
  hook.unmount()
})
it("ignores events from a transport that no longer owns the workspace", async () => {
  const hook = renderHook(useAcademicEvents)
  await waitFor(() => expect(backend.handlers.size).toBe(1))
  backend.active = { ...backend.transport, call: vi.fn() }
  useAcademicStore.setState({
    selectedPaper: { id: "paper", status: "cloning" } as AcademicPaper,
  })
  await act(async () => {
    for (const handler of backend.handlers) handler({ paper_id: "paper" })
    for (const reconnect of backend.reconnects) reconnect()
  })
  expect(useAcademicStore.getState().selectedPaper?.status).toBe("cloning")
  expect(backend.active.call).not.toHaveBeenCalled()
  hook.unmount()
})

it("cleans up a delayed subscription after its last consumer unmounts", async () => {
  let complete!: (stop: () => void) => void
  const stop = vi.fn()
  backend.transport.subscribe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const hook = renderHook(useAcademicEvents)
  hook.unmount()
  await act(async () => {
    complete(stop)
  })
  expect(stop).toHaveBeenCalledOnce()
  expect(useAcademicStore.getState().selectedPaper?.status).toBe("cloning")
})
