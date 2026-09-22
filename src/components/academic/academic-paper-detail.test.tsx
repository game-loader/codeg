import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { AcademicPaperDetail } from "./academic-paper-detail"
import {
  academicOpenTarget,
  academicPrepare,
  type AcademicPaper,
} from "@/lib/academic"
import { openAcademicConversation } from "@/lib/academic-conversation"

const spies = vi.hoisted(() => ({
  openConversations: vi.fn(),
  openTab: vi.fn(),
  local: true,
}))
vi.mock("@/lib/platform", () => ({
  isLocalDesktop: () => spies.local,
  openPath: vi.fn(),
  openUrl: vi.fn(),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: spies.openConversations }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: spies.openTab }),
}))
vi.mock("@/lib/academic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/academic")>()),
  academicOpenTarget: vi.fn(),
  academicPrepare: vi.fn(),
  academicCancel: vi.fn(),
}))
vi.mock("@/lib/academic-conversation", () => ({
  openAcademicConversation: vi.fn(),
}))

const paper: AcademicPaper = {
  id: "paper-1",
  item_key: "ZOTERO01",
  library_id: 1,
  title: "Attention paper",
  authors: ["Researcher"],
  abstract_text: "An abstract",
  doi: null,
  arxiv_id: "1706.03762",
  pdf_path: null,
  text_path: "/research/paper.txt",
  context_path: "/research/context.md",
  repo_url: "https://github.com/example/paper",
  repo_path: "/research/repo",
  folder_id: 5,
  status: "ready",
  error: null,
  analysis: null,
  analysis_conversation_id: null,
  candidates: [],
  repo_candidates: [],
  conversations: [],
}

function renderPaper(overrides: Partial<AcademicPaper> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcademicPaperDetail paper={{ ...paper, ...overrides }} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  spies.local = true
  vi.clearAllMocks()
  vi.mocked(academicOpenTarget).mockResolvedValue({
    paper_id: paper.id,
    agent_type: "codex",
    folder_id: 5,
    working_dir: "/research/repo",
  })
  vi.mocked(openAcademicConversation).mockResolvedValue(undefined)
})

describe("paper research entry", () => {
  it("opens the repository research draft before navigating to conversations", async () => {
    renderPaper()
    fireEvent.click(screen.getByRole("button", { name: "Start asking" }))
    await waitFor(() => expect(spies.openConversations).toHaveBeenCalledOnce())
    expect(academicOpenTarget).toHaveBeenCalledWith("paper-1", false)
    expect(openAcademicConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        paper_id: "paper-1",
        working_dir: "/research/repo",
      })
    )
  })

  it("offers a paper-only conversation while repository preparation is running", async () => {
    renderPaper({ status: "cloning", repo_path: null })
    expect(screen.getByRole("button", { name: "Start asking" })).toBeDisabled()
    fireEvent.click(
      screen.getByRole("button", { name: "Ask about the paper only" })
    )
    await waitFor(() =>
      expect(academicOpenTarget).toHaveBeenCalledWith("paper-1", true)
    )
  })

  it("keeps the detail open and translates an unsent-draft conflict", async () => {
    vi.mocked(openAcademicConversation).mockRejectedValueOnce(
      new Error("academicDraftConflict")
    )
    renderPaper()
    fireEvent.click(screen.getByRole("button", { name: "Start asking" }))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "already has an unsent draft"
      )
    )
    expect(spies.openConversations).not.toHaveBeenCalled()
  })

  it("opens analysis using its own folder and agent rather than the cloned repository", () => {
    renderPaper({
      analysis_conversation_id: 9,
      conversations: [
        { id: 9, folder_id: 22, agent_type: "claude_code", title: "Analysis" },
      ],
    })
    fireEvent.click(
      screen.getByRole("button", {
        name: "View analysis and permission requests",
      })
    )
    expect(spies.openTab).toHaveBeenCalledWith(
      22,
      9,
      "claude_code",
      true,
      "Research analysis"
    )
  })

  it("submits the chosen verified repository without guessing a default", async () => {
    renderPaper({
      status: "needs_repo",
      repo_path: null,
      repo_candidates: [
        {
          url: "https://github.com/author/official",
          evidence_quote: "Our code is available here",
          source_url: "https://author.example/project",
          license: null,
        },
      ],
    })
    expect(screen.getByRole("button", { name: "Start asking" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Use this repository" }))
    await waitFor(() =>
      expect(academicPrepare).toHaveBeenCalledWith(
        "paper-1",
        undefined,
        "https://github.com/author/official"
      )
    )
  })
})

it("shows remote PDF and repository paths without offering local file actions", () => {
  spies.local = false
  renderPaper({ pdf_path: "/server/zotero/paper.pdf" })
  expect(screen.queryByRole("button", { name: "Open PDF" })).toBeNull()
  expect(screen.queryByRole("button", { name: "/research/repo" })).toBeNull()
  expect(screen.getByText("/server/zotero/paper.pdf")).toBeVisible()
  expect(screen.getByText("/research/repo")).toBeVisible()
})
