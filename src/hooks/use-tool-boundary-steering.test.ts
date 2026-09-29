import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EventEnvelope } from "@/lib/types"
import type { QueuedMessage } from "./use-message-queue"
import { useToolBoundarySteering } from "./use-tool-boundary-steering"

let handler: (event: EventEnvelope) => void
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpEvent: (next: typeof handler) => {
    handler = next
  },
}))

const item = (id: string): QueuedMessage => ({
  id,
  draft: { displayText: id, blocks: [{ type: "text", text: id }] },
  modeId: null,
})
function event(id: string, status = "completed", connection = "c1") {
  return {
    type: "tool_call_update",
    tool_call_id: id,
    status,
    connection_id: connection,
  } as EventEnvelope
}
const defaults = {
  enabled: true,
  connectionId: "c1",
  editingItemId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("tool-boundary steering", () => {
  it("sends existing items in order only after a tool completes", async () => {
    const onSteer = vi.fn(async () => true)
    renderHook(() =>
      useToolBoundarySteering({
        ...defaults,
        getQueueItems: () => [item("a"), item("b")],
        onSteer,
      })
    )
    await act(async () => {
      handler(event("t0", "in_progress"))
      handler(event("t0", "completed", "another-connection"))
    })
    expect(onSteer).not.toHaveBeenCalled()
    await act(async () => {
      handler(event("t1"))
    })
    expect(onSteer.mock.calls).toEqual([["a"], ["b"]])
    await act(async () => {
      handler(event("t1"))
    })
    expect(onSteer).toHaveBeenCalledTimes(2)
  })

  it("does not double-send while awaiting delivery or include later drafts", async () => {
    let settle!: (ok: boolean) => void
    const onSteer = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        })
    )
    const queue = [item("a")]
    renderHook(() =>
      useToolBoundarySteering({
        ...defaults,
        getQueueItems: () => queue,
        onSteer,
      })
    )
    act(() => {
      handler(event("t1"))
    })
    queue.push(item("b"))
    act(() => {
      handler(event("t2"))
    })
    expect(onSteer).toHaveBeenCalledTimes(1)
    await act(async () => {
      settle(true)
    })
    expect(onSteer).toHaveBeenCalledTimes(1)
  })

  it("leaves rejected messages for ordinary queue delivery", async () => {
    const onSteer = vi.fn(async () => false)
    const queue = [item("a"), item("b")]
    renderHook(() =>
      useToolBoundarySteering({
        ...defaults,
        getQueueItems: () => queue,
        onSteer,
      })
    )
    await act(async () => {
      handler(event("t1", "failed"))
    })
    expect(onSteer.mock.calls).toEqual([["a"]])
    expect(queue.map((q) => q.id)).toEqual(["a", "b"])
  })

  it("keeps an edited head in place without sending later items past it", async () => {
    const onSteer = vi.fn(async () => true)
    renderHook(() =>
      useToolBoundarySteering({
        ...defaults,
        editingItemId: "a",
        getQueueItems: () => [item("a"), item("b")],
        onSteer,
      })
    )
    await act(async () => {
      handler(event("t1"))
    })
    expect(onSteer).not.toHaveBeenCalled()
  })

  it("does not continue a batch into another turn", async () => {
    let settle!: (ok: boolean) => void
    const onSteer = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        })
    )
    renderHook(() =>
      useToolBoundarySteering({
        ...defaults,
        getQueueItems: () => [item("a"), item("b")],
        onSteer,
      })
    )
    act(() => {
      handler(event("t1"))
    })
    act(() => {
      handler({ type: "turn_complete", connection_id: "c1" } as EventEnvelope)
    })
    await act(async () => {
      settle(true)
    })
    expect(onSteer.mock.calls).toEqual([["a"]])
  })

  it("keeps the existing queue behavior on sessions without native steering", async () => {
    const onSteer = vi.fn(async () => true)
    renderHook(() =>
      useToolBoundarySteering({
        ...defaults,
        enabled: false,
        getQueueItems: () => [item("a")],
        onSteer,
      })
    )
    await act(async () => {
      handler(event("t1"))
    })
    expect(onSteer).not.toHaveBeenCalled()
  })
})
