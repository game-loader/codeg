import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { AcademicPage } from "./academic-page"
import { AcademicSidebar } from "./academic-sidebar"
import { AcademicContextBar } from "./academic-context-bar"
import { useAcademicStore } from "@/stores/academic-store"

const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({ getTransport: () => transport }))
vi.mock("@/lib/platform", () => ({ isLocalDesktop: () => false }))
vi.mock("./use-academic-events", () => ({ useAcademicEvents: () => {} }))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: [] }),
}))
vi.mock("@/contexts/tab-context", () => ({ useTabActions: () => ({}) }))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ routeId: "academic", setRoute: vi.fn() }),
  useOptionalWorkbenchRoute: () => ({ setRoute: vi.fn() }),
}))

beforeEach(() => {
  useAcademicStore.getState().reset()
  transport.call.mockImplementation(async (command: string) => {
    if (command === "academic_settings_get")
      return { agent_type: "codex", bridge_port: 23119, paired: false }
    if (command === "academic_library")
      return {
        library_id: 1,
        instance_id: "server-zotero",
        collections: [],
        items: [
          {
            key: "REMOTE01",
            title: "Remote paper",
            authors: [],
            collections: [],
          },
        ],
      }
    if (command === "academic_conversation_paper")
      return { id: "paper", title: "Remote paper" }
  })
})
function wrap(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}
it("shows library and pairing settings in a server workspace", async () => {
  render(wrap(<AcademicPage />))
  expect(await screen.findByText("Remote paper")).toBeVisible()
  expect(screen.getByRole("button", { name: "Save and connect" })).toBeVisible()
})
it("expands the remote library from the academic sidebar", async () => {
  render(wrap(<AcademicSidebar />))
  fireEvent.click(screen.getByRole("button", { name: "Academic" }))
  expect(await screen.findByText("Remote paper")).toBeVisible()
})
it("loads the associated paper for a remote conversation", async () => {
  render(wrap(<AcademicContextBar conversationId={42} />))
  expect(
    await screen.findByRole("button", { name: /Remote paper/ })
  ).toBeVisible()
})

it("does not apply an import result after leaving its workspace page", async () => {
  let finish!: (item: { key: string }) => void
  transport.call.mockImplementation(async (command: string) => {
    if (command === "academic_settings_get")
      return { agent_type: "codex", bridge_port: 23119, paired: true }
    if (command === "academic_library")
      return {
        library_id: 1,
        instance_id: "server-zotero",
        items: [],
        collections: [
          { key: "COLLECTION", name: "Research", parent_key: null },
        ],
      }
    if (command === "academic_import")
      return new Promise((resolve) => {
        finish = resolve
      })
  })
  const page = render(wrap(<AcademicPage />))
  await screen.findByText("Research")
  fireEvent.click(screen.getByRole("button", { name: "Add paper" }))
  fireEvent.change(screen.getByPlaceholderText("arXiv:2401.12345 / DOI"), {
    target: { value: "arXiv:2401.12345" },
  })
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "COLLECTION" },
  })
  fireEvent.submit(
    screen.getByPlaceholderText("arXiv:2401.12345 / DOI").closest("form")!
  )
  page.unmount()
  useAcademicStore.getState().reset()
  await act(async () => {
    finish({ key: "OLDITEM" })
  })
  expect(useAcademicStore.getState().selectedItemKey).toBeNull()
  expect(useAcademicStore.getState().library).toBeNull()
})

it("does not restore settings from an unmounted pairing form", async () => {
  let finish!: (settings: unknown) => void
  const original = transport.call.getMockImplementation()!
  transport.call.mockImplementation((command: string) =>
    command === "academic_settings_set"
      ? new Promise((resolve) => {
          finish = resolve
        })
      : original(command)
  )
  const page = render(wrap(<AcademicPage />))
  await screen.findByText("Remote paper")
  fireEvent.change(screen.getByLabelText("Pairing token"), {
    target: { value: "test-token" },
  })
  fireEvent.submit(screen.getByLabelText("Pairing token").closest("form")!)
  page.unmount()
  useAcademicStore.getState().reset()
  await act(async () => {
    finish({ agent_type: "codex", bridge_port: 23119, paired: true })
  })
  expect(useAcademicStore.getState().settings).toBeNull()
  expect(useAcademicStore.getState().library).toBeNull()
})
