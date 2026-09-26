import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  local: false,
  getDocument: vi.fn(),
  options: { workerSrc: "" },
  download: vi.fn(),
  save: vi.fn(),
  invoke: vi.fn(),
}))
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  version: "test-version",
  GlobalWorkerOptions: mocks.options,
  getDocument: mocks.getDocument,
}))
vi.mock("@/lib/platform", () => ({ isLocalDesktop: () => mocks.local }))
vi.mock("@/lib/api", () => ({ downloadWorkspaceFile: mocks.download }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }))

import { downloadPdf, loadPdf, pdfBytes, PDF_DATA_PREFIX } from "./pdf-preview"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.local = false
})

describe("PDF loading and saving", () => {
  it("passes raw bytes to PDF.js and keeps worker, fonts and decoders on the same local version", async () => {
    await loadPdf(PDF_DATA_PREFIX + "JVBERi0=")
    expect(mocks.options.workerSrc).toBe(
      "/pdfjs/test-version/pdf.worker.min.mjs"
    )
    expect(mocks.getDocument).toHaveBeenCalledWith({
      data: new Uint8Array([37, 80, 68, 70, 45]),
      cMapUrl: "/pdfjs/test-version/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/test-version/standard_fonts/",
      wasmUrl: "/pdfjs/test-version/wasm/",
      iccUrl: "/pdfjs/test-version/iccs/",
    })
  })

  it("rejects error messages and malformed base64 instead of treating them as a document", () => {
    expect(() => pdfBytes("File not found")).toThrow("Invalid PDF data")
    expect(() => pdfBytes(PDF_DATA_PREFIX + "!!!")).toThrow()
  })

  it("uses the remote/web streaming download with the actual file directory", async () => {
    await downloadPdf(
      "/outside/paper.pdf",
      PDF_DATA_PREFIX + "JVBERi0=",
      "paper.pdf"
    )
    expect(mocks.download).toHaveBeenCalledWith(
      "/outside",
      "paper.pdf",
      "paper.pdf"
    )
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it("saves the loaded bytes to the local desktop path selected by the user", async () => {
    mocks.local = true
    mocks.save.mockResolvedValue("/downloads/paper.pdf")
    await downloadPdf(
      "/outside/paper.pdf",
      PDF_DATA_PREFIX + "JVBERi0=",
      "paper.pdf"
    )
    expect(mocks.invoke).toHaveBeenCalledWith("save_binary_file", {
      path: "/downloads/paper.pdf",
      dataBase64: "JVBERi0=",
    })
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it("does not write when the desktop save dialog is cancelled", async () => {
    mocks.local = true
    mocks.save.mockResolvedValue(null)
    await downloadPdf(
      "/outside/paper.pdf",
      PDF_DATA_PREFIX + "JVBERi0=",
      "paper.pdf"
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
