import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import en from "@/i18n/messages/en.json"
import { PdfPreview } from "./pdf-preview"

const mocks = vi.hoisted(() => ({ load: vi.fn(), download: vi.fn() }))
vi.mock("@/lib/pdf-preview", () => ({
  loadPdf: mocks.load,
  downloadPdf: mocks.download,
  PDF_DATA_PREFIX: "data:application/pdf;base64,",
}))

const content = "data:application/pdf;base64,JVBERi0="
const tab = {
  id: "pdf",
  title: "paper.pdf",
  path: "/outside/paper.pdf",
  language: "pdf",
  content,
  loading: false,
} as FileWorkspaceTab

function view(overrides: Partial<FileWorkspaceTab> = {}) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <PdfPreview tab={{ ...tab, ...overrides } as FileWorkspaceTab} />
    </NextIntlClientProvider>
  )
}

function documentTask() {
  const cancel = vi.fn()
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
    }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel })),
    cleanup: vi.fn(),
  }
  const document = { numPages: 3, getPage: vi.fn(async () => page) }
  const task = {
    promise: Promise.resolve(document),
    destroy: vi.fn(async () => {}),
  }
  return { task, document, page, cancel }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe() {
        this.callback([{ contentRect: { width: 632 } }])
      }
      disconnect() {}
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

describe("PdfPreview", () => {
  it("renders pages, clamps page selection, zooms and downloads the original file", async () => {
    const { task, document, page, cancel } = documentTask()
    mocks.load.mockResolvedValue(task)
    render(view())
    await screen.findByRole("img", { name: "Page 1" })
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled()
    const scroll = screen.getByRole("img", { name: "Page 1" }).parentElement!
      .parentElement!.parentElement!
    scroll.scrollTop = 400
    fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    await screen.findByRole("img", { name: "Page 2" })
    expect(document.getPage).toHaveBeenLastCalledWith(2)
    expect(scroll.scrollTop).toBe(0)
    expect(cancel).toHaveBeenCalled()
    fireEvent.change(screen.getByRole("spinbutton", { name: "Page number" }), {
      target: { value: "999" },
    })
    await screen.findByRole("img", { name: "Page 3" })
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    await waitFor(() =>
      expect(page.render).toHaveBeenLastCalledWith(
        expect.objectContaining({ viewport: { width: 750, height: 1000 } })
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }))
    await waitFor(() =>
      expect(page.render).toHaveBeenLastCalledWith(
        expect.objectContaining({ viewport: { width: 600, height: 800 } })
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }))
    await waitFor(() =>
      expect(mocks.download).toHaveBeenCalledWith(
        tab.path,
        content,
        "paper.pdf"
      )
    )
  })

  it("releases the document and pending renderer when the view closes", async () => {
    const { task, cancel } = documentTask()
    mocks.load.mockResolvedValue(task)
    const rendered = render(view())
    await screen.findByRole("img", { name: "Page 1" })
    rendered.unmount()
    expect(task.destroy).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalled()
  })

  it("destroys a loading task that arrives after unmount", async () => {
    const { task } = documentTask()
    let resolve!: (value: unknown) => void
    mocks.load.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const rendered = render(view())
    rendered.unmount()
    await act(async () => resolve(task))
    expect(task.destroy).toHaveBeenCalledOnce()
  })

  it("reports corrupt PDFs, allows retry, and retains download access", async () => {
    const task = {
      promise: Promise.reject(new Error("Invalid PDF structure")),
      destroy: vi.fn(async () => {}),
    }
    mocks.load.mockResolvedValueOnce(task)
    render(view())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid PDF structure"
    )
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled()
    mocks.load.mockResolvedValueOnce(documentTask().task)
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await screen.findByRole("img", { name: "Page 1" })
  })

  it("shows a useful message for password-protected PDFs", async () => {
    const error = new Error("Password required")
    error.name = "PasswordException"
    mocks.load.mockRejectedValue(error)
    render(view())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "password-protected"
    )
  })

  it("shows file read errors without passing them to the PDF parser", () => {
    render(
      view({
        content: "Permission denied",
        saveError: "Permission denied",
        saveState: "error",
      })
    )
    expect(screen.getByRole("alert")).toHaveTextContent("Permission denied")
    expect(mocks.load).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeDisabled()
  })

  it("destroys the old document and displays freshly loaded bytes on reload", async () => {
    const first = documentTask()
    const second = documentTask()
    mocks.load
      .mockResolvedValueOnce(first.task)
      .mockResolvedValueOnce(second.task)
    const rendered = render(view())
    await screen.findByRole("img", { name: "Page 1" })
    rendered.rerender(view({ content: content + "AA==" }))
    await waitFor(() => expect(second.document.getPage).toHaveBeenCalledWith(1))
    expect(first.task.destroy).toHaveBeenCalledOnce()
  })
})
