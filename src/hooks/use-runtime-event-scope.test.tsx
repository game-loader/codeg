import { renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { BackendClientProvider } from "@/contexts/backend-client-context"
import { WorkspaceRuntimeVisibilityProvider } from "@/contexts/workspace-runtime-visibility-context"
import type { BackendClient } from "@/lib/backend/types"
import { useRuntimeEventScope } from "./use-runtime-event-scope"

function scope(visible: boolean, focused: boolean) {
  return renderHook(useRuntimeEventScope, {
    wrapper: ({ children }) => (
      <BackendClientProvider
        client={{ key: "remote:1" } as unknown as BackendClient}
      >
        <WorkspaceRuntimeVisibilityProvider
          value={{ managed: true, visible, focused }}
        >
          {children}
        </WorkspaceRuntimeVisibilityProvider>
      </BackendClientProvider>
    ),
  }).result
}

describe("retained runtime event ownership", () => {
  it("preserves standalone behavior and ignores hidden machine chords", () => {
    expect(renderHook(useRuntimeEventScope).result.current()).toBe(true)
    expect(scope(false, true).current()).toBe(false)
    expect(scope(true, false).current()).toBe(false)
    expect(scope(true, true).current()).toBe(true)
  })
  it("uses the explicit surface owner for native/iframe and terminal events", () => {
    const a = document.createElement("div")
    a.dataset.backendKey = "remote:1"
    const aTarget = document.createElement("iframe")
    a.append(aTarget)
    const b = document.createElement("div")
    b.dataset.backendKey = "remote:2"
    const bTarget = document.createElement("textarea")
    b.append(bTarget)
    expect(scope(true, false).current(aTarget)).toBe(true)
    expect(scope(true, true).current(bTarget)).toBe(false)
    expect(scope(false, true).current(aTarget)).toBe(false)
  })
})
