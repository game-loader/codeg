import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import { MultiHostTabs, type WindowResourceTab } from "./multi-host-tabs"

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    (
      (namespace === "MultiHost"
        ? messages.MultiHost
        : messages.Folder.conversationCard) as Record<string, string>
    )[key],
}))
const tabs: WindowResourceTab[] = [
  {
    ref: {
      backendKey: "remote:1",
      kind: "conversation",
      id: "same-id",
      folderId: 1,
    },
    title: "Session",
    machineName: "A",
    status: "in_progress",
    isPinned: false,
  },
  {
    ref: {
      backendKey: "remote:2",
      kind: "file",
      id: "same-id",
      path: "/repo/file.ts",
    },
    title: "file.ts",
    machineName: "B",
    dirty: true,
  },
]

function setup() {
  const actions = {
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onPin: vi.fn(),
    onNewConversation: vi.fn(),
    onToggleMaximized: vi.fn(),
  }
  render(<MultiHostTabs tabs={tabs} selected={tabs[0].ref} {...actions} />)
  return actions
}

describe("unified window tabs", () => {
  it("selects, pins and closes the captured resource when two machines reuse IDs", () => {
    const actions = setup()
    const file = screen.getByRole("tab", { name: "file.ts B" })
    fireEvent.click(file)
    expect(actions.onSelect).toHaveBeenLastCalledWith(tabs[1].ref)
    fireEvent.doubleClick(screen.getByRole("tab", { name: "Session A" }))
    expect(actions.onPin).toHaveBeenLastCalledWith(tabs[0].ref)
    actions.onSelect.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Close · file.ts" }))
    expect(actions.onClose).toHaveBeenLastCalledWith(tabs[1].ref)
    expect(actions.onSelect).not.toHaveBeenCalled()
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Session A" }), {
      button: 1,
    })
    expect(actions.onClose).toHaveBeenLastCalledWith(tabs[0].ref)
  })

  it("navigates the unified strip by keyboard across machine and resource kinds", () => {
    const actions = setup()
    fireEvent.keyDown(screen.getByRole("tab", { name: "Session A" }), {
      key: "ArrowRight",
    })
    expect(actions.onSelect).toHaveBeenLastCalledWith(tabs[1].ref)
    expect(screen.getByRole("tab", { name: "file.ts B" })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole("tab", { name: "file.ts B" }), {
      key: "Home",
    })
    expect(actions.onSelect).toHaveBeenLastCalledWith(tabs[0].ref)
    actions.onSelect.mockClear()
    fireEvent.keyDown(screen.getByRole("button", { name: "Close · Session" }), {
      key: "Enter",
    })
    expect(actions.onSelect).not.toHaveBeenCalled()
  })

  it("keeps new conversation and pane maximize actions in the single strip", () => {
    const actions = setup()
    expect(screen.getAllByRole("tablist")).toHaveLength(1)
    fireEvent.click(
      screen.getByRole("button", {
        name: messages.Folder.conversationCard.newConversation,
      })
    )
    expect(actions.onNewConversation).toHaveBeenCalledOnce()
    expect(actions.onNewConversation).toHaveBeenCalledWith()
    fireEvent.click(
      screen.getByRole("button", {
        name: messages.Folder.conversationCard.maximize,
      })
    )
    expect(actions.onToggleMaximized).toHaveBeenCalledOnce()
  })
})
