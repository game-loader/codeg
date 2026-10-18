import { cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { useFileDropGuard } from "./use-file-drop-guard"

function dragData(types: string[]): DataTransfer {
  return {
    types,
    files: [],
    items: [],
    getData: () => "",
  } as unknown as DataTransfer
}

function fireDrag(type: "dragover" | "drop", dataTransfer: DataTransfer) {
  const event = new Event(type, { cancelable: true }) as DragEvent
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer })
  window.dispatchEvent(event)
  return event
}

afterEach(cleanup)

describe("useFileDropGuard", () => {
  it("keeps a dropped file drag from navigating the window", () => {
    renderHook(() => useFileDropGuard())
    expect(fireDrag("dragover", dragData(["Files"])).defaultPrevented).toBe(
      true
    )
    expect(fireDrag("drop", dragData(["Files"])).defaultPrevented).toBe(true)
  })

  it("also accepts a typeless hover so WebKit still delivers the drop", () => {
    renderHook(() => useFileDropGuard())
    expect(fireDrag("dragover", dragData([])).defaultPrevented).toBe(true)
  })

  it("leaves text drags to their own handlers", () => {
    renderHook(() => useFileDropGuard())
    expect(
      fireDrag("dragover", dragData(["text/plain"])).defaultPrevented
    ).toBe(false)
    expect(fireDrag("drop", dragData(["text/plain"])).defaultPrevented).toBe(
      false
    )
  })

  it("stops listening on unmount", () => {
    const { unmount } = renderHook(() => useFileDropGuard())
    unmount()
    expect(fireDrag("dragover", dragData(["Files"])).defaultPrevented).toBe(
      false
    )
  })
})
