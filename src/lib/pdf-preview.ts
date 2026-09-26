import { downloadWorkspaceFile } from "@/lib/api"
import { splitAbsPath } from "@/lib/file-open-target"
import { isLocalDesktop } from "@/lib/platform"

export const PDF_PREVIEW_MAX_BYTES = 50_000_000
export const PDF_DATA_PREFIX = "data:application/pdf;base64,"

export function pdfBytes(content: string): Uint8Array {
  if (!content.startsWith(PDF_DATA_PREFIX)) {
    throw new Error("Invalid PDF data")
  }
  const binary = atob(content.slice(PDF_DATA_PREFIX.length))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Import only in the browser: PDF.js needs DOM APIs even at module load. */
export async function loadPdf(content: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const assets = `/pdfjs/${pdfjs.version}/`
  pdfjs.GlobalWorkerOptions.workerSrc = `${assets}pdf.worker.min.mjs`
  return pdfjs.getDocument({
    data: pdfBytes(content),
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
  })
}

export async function downloadPdf(
  path: string,
  content: string,
  name: string
): Promise<void> {
  if (isLocalDesktop()) {
    const { save } = await import("@tauri-apps/plugin-dialog")
    const savePath = await save({
      defaultPath: name,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    })
    if (!savePath) return
    const { invoke } = await import("@tauri-apps/api/core")
    // Validate before stripping the prefix. Never write an error message as PDF.
    pdfBytes(content)
    await invoke("save_binary_file", {
      path: savePath,
      dataBase64: content.slice(PDF_DATA_PREFIX.length),
    })
    return
  }
  const io = splitAbsPath(path)
  if (!io) throw new Error("Invalid PDF path")
  await downloadWorkspaceFile(io.rootPath, io.ioPath, name)
}
