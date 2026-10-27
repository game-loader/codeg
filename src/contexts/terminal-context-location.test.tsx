import { act, renderHook } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { TerminalProvider, useTerminalContext } from "./terminal-context"

const fixtures = vi.hoisted(() => ({
  api: {
    getSystemTerminalSettings: vi
      .fn()
      .mockResolvedValue({ default_shell: null }),
    terminalKill: vi.fn().mockResolvedValue(undefined),
  },
  platform: {
    getTransport: () => ({ subscribe: async () => () => {} }),
    getActiveRemoteConnectionId: () => null,
    isLocalDesktop: () => false,
  },
}))
vi.mock("@/contexts/backend-client-context", () => ({
  useOptionalBackendClient: () => null,
  useBackendApi: () => fixtures.api,
  useBackendPlatform: () => fixtures.platform,
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolderId: 1,
    activeFolder: { id: 1, path: "/old" },
  }),
}))
vi.mock("@/hooks/use-runtime-event-scope", () => ({
  useRuntimeEventScope: () => () => true,
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({ shortcuts: {} }),
}))

it("creates the selected worktree terminal correctly before active-folder context catches up, while retaining the legacy default", async () => {
  const hook = renderHook(useTerminalContext, { wrapper: TerminalProvider })
  const captured = hook.result.current.createTerminalInDirectory
  await act(async () => {
    await captured("/new/worktree", "Worktree", undefined, 2)
  })
  expect(hook.result.current.tabs[0]).toMatchObject({
    folderId: 2,
    workingDir: "/new/worktree",
    title: "Worktree",
  })
  expect(hook.result.current.isOpen).toBe(true)
  await act(async () => {
    await captured("/old")
  })
  expect(hook.result.current.tabs[1]).toMatchObject({
    folderId: 1,
    workingDir: "/old",
  })
})
