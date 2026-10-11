import { describe, expect, it } from "vitest"
import {
  emptyWindowLayout,
  isBackendKey,
  readWindowLayout,
  reconcileWindowDestination,
  sanitizeWindowLayout,
  saveWindowLayout,
  windowResourceKey,
} from "./window-layout"

describe("multi-host window layout", () => {
  it("distinguishes equal conversation and file IDs on different machines", () => {
    const a = {
      backendKey: "remote:1" as const,
      kind: "file" as const,
      id: "file:/repo/a",
      path: "/repo/a",
    }
    const b = { ...a, backendKey: "remote:2" as const }
    expect(windowResourceKey(a)).not.toBe(windowResourceKey(b))
    const layout = {
      ...emptyWindowLayout(),
      primary: "remote:1" as const,
      secondary: "remote:2" as const,
      split: "horizontal" as const,
      files: [a, b],
    }
    saveWindowLayout(layout, "test:multi-host")
    expect(readWindowLayout("test:multi-host")).toEqual(layout)
    localStorage.removeItem("test:multi-host")
  })

  it("strips tokens and rejects malformed host/selection data", () => {
    const layout = sanitizeWindowLayout({
      ...emptyWindowLayout(),
      primary: "remote:0",
      secondary: "remote:1",
      split: "horizontal",
      token: "secret",
      files: [
        {
          backendKey: "remote:1",
          kind: "file",
          id: "a",
          path: "/repo/a",
          token: "secret",
        },
      ],
      selected: {
        backendKey: "remote:1",
        kind: "conversation",
        id: "1",
        folderId: "bad",
      },
    })
    expect(layout.primary).toBe("local")
    expect(layout.selected).toBeNull()
    expect(JSON.stringify(layout)).not.toContain("secret")
    expect(isBackendKey("remote:01")).toBe(false)
    expect(isBackendKey("remote:9007199254740992")).toBe(false)
  })

  it("invalidates restored resources only for a moved server", () => {
    const a = {
      backendKey: "remote:1" as const,
      kind: "file" as const,
      id: "a",
      path: "/repo/a",
    }
    const b = { ...a, backendKey: "remote:2" as const }
    const before = {
      ...emptyWindowLayout(),
      files: [a, b],
      selected: a,
      destinations: { "remote:1": "http://old" },
    }
    const after = reconcileWindowDestination(before, "remote:1", "http://new")
    expect(after.files).toEqual([b])
    expect(after.selected).toBeNull()
    expect(after.destinations["remote:1"]).toBe("http://new")
  })
})
