import { describe, expect, it } from "vitest"
import type { BackendClient } from "./types"
import { getBackendEventScope, scopePanelId } from "./resource-identity"

describe("document-wide panel identity", () => {
  it("separates equal panel names in retained machines and keeps legacy IDs", () => {
    expect(scopePanelId("workspace-panel-group", "remote:1")).not.toBe(
      scopePanelId("workspace-panel-group", "remote:2")
    )
    expect(scopePanelId("workspace-panel-group", "local")).not.toBe(
      scopePanelId("workspace-panel-group", "remote:1")
    )
    expect(scopePanelId("workspace-panel-group")).toBe("workspace-panel-group")
  })
  it("separates transient event targets across client generations, even with the same backend key", () => {
    const a = { key: "remote:1" } as unknown as BackendClient
    const replacement = { key: "remote:1" } as unknown as BackendClient
    expect(getBackendEventScope(a)).toBe(getBackendEventScope(a))
    expect(getBackendEventScope(a)).not.toBe(getBackendEventScope(replacement))
    expect(getBackendEventScope(null)).toBeUndefined()
  })
})
