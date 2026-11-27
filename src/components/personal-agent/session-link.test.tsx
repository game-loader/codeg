import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BackendClientProvider } from "@/contexts/backend-client-context"
import type { BackendClient } from "@/lib/backend/types"

const api = vi.hoisted(() => ({
  personalAgentConversationTarget: vi.fn(),
}))
const nav = vi.hoisted(() => ({
  openConversations: vi.fn(),
  openTab: vi.fn(),
}))
const toasts = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock("@/lib/api", () => api)
vi.mock("sonner", () => ({ toast: toasts }))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: nav.openConversations }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: nav.openTab }),
}))

import { useSessionLinkOpener } from "./session-link"

afterEach(() => vi.clearAllMocks())

describe("a session link in a reply", () => {
  it("opens its conversation as a tab, in its project with its agent", async () => {
    api.personalAgentConversationTarget.mockResolvedValue({
      conversation_id: 88,
      folder_id: 3,
      agent_type: "claude_code",
      title: "Refactor parser",
    })
    const { result } = renderHook(() => useSessionLinkOpener())
    result.current(88)
    expect(api.personalAgentConversationTarget).toHaveBeenCalledWith(88)
    await waitFor(() =>
      expect(nav.openTab).toHaveBeenCalledWith(
        3,
        88,
        "claude_code",
        false,
        "Refactor parser"
      )
    )
    expect(nav.openConversations).toHaveBeenCalled()
  })

  it("resolves the same conversation id against each workspace's backend", async () => {
    function makeWorkspace(id: 1 | 2) {
      const resolveTarget = vi.fn().mockResolvedValue({
        conversation_id: 88,
        folder_id: id,
        agent_type: "claude_code",
        title: `Host ${id}`,
      })
      const client = {
        key: `remote:${id}`,
        api: { personalAgentConversationTarget: resolveTarget },
      } as unknown as BackendClient
      const hook = renderHook(() => useSessionLinkOpener(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <BackendClientProvider client={client}>
            {children}
          </BackendClientProvider>
        ),
      })
      return { resolveTarget, open: hook.result.current }
    }
    const first = makeWorkspace(1)
    const second = makeWorkspace(2)
    first.open(88)
    second.open(88)
    expect(first.resolveTarget).toHaveBeenCalledExactlyOnceWith(88)
    expect(second.resolveTarget).toHaveBeenCalledExactlyOnceWith(88)
    expect(api.personalAgentConversationTarget).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(nav.openTab).toHaveBeenCalledWith(
        1,
        88,
        "claude_code",
        false,
        "Host 1"
      )
      expect(nav.openTab).toHaveBeenCalledWith(
        2,
        88,
        "claude_code",
        false,
        "Host 2"
      )
    })
  })

  it("says why when there is no such conversation", async () => {
    api.personalAgentConversationTarget.mockRejectedValue(
      new Error("no conversation #9")
    )
    const { result } = renderHook(() => useSessionLinkOpener())
    result.current(9)
    await waitFor(() => expect(toasts.error).toHaveBeenCalled())
    expect(nav.openTab).not.toHaveBeenCalled()
  })
})
