import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { DragEvent as ReactDragEvent } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  acpPrompt,
  submitSessionFeedback,
  uploadAttachment,
  uploadLocalPathToRemote,
  workTaskRetry,
} from "@/lib/api"
import { readFileBase64 as readLocalFileBase64 } from "@/lib/tauri"
import { openFileDialog } from "@/lib/platform"
import { buildFileUri } from "@/lib/reference-link"
import {
  extractUserImagesFromDraft,
  extractUserResourcesFromDraft,
} from "@/lib/prompt-draft"

import { useComposerAttachments } from "./use-composer-attachments"

const runtime = vi.hoisted(() => ({
  desktop: false,
  remoteId: null as number | null,
  call: vi.fn(async () => undefined),
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => runtime.desktop,
  openFileDialog: vi.fn(),
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => runtime.desktop,
  getActiveRemoteConnectionId: () => runtime.remoteId,
  getTransport: () => ({ call: runtime.call }),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  uploadAttachment: vi.fn(),
  uploadLocalPathToRemote: vi.fn(),
}))
vi.mock("@/lib/tauri", () => ({ readFileBase64: vi.fn() }))
type NativeDrop = {
  payload: { paths: string[]; position: { x: number; y: number } }
}
const nativeEvents = vi.hoisted(
  () => new Map<string, (event: NativeDrop) => void>()
)
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    listen: async (event: string, handler: (event: NativeDrop) => void) => {
      nativeEvents.set(event, handler)
      return () => {
        nativeEvents.delete(event)
      }
    },
  }),
}))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Real PNG bytes through FileReader and the composer; only the upload's network
// boundary is mocked. The server renames the file to prove that sends use its
// returned path, never a guessed path on the client machine.
function imageFile(index = 0) {
  const binary = atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII="
  )
  return new File(
    [Uint8Array.from(binary, (char) => char.charCodeAt(0))],
    "photo " + index + ".png",
    { type: "image/png" }
  )
}

function remotePath(name: string) {
  return "/srv/codeg/uploads/session/renamed " + name
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uploadAttachment).mockImplementation(async (file) => ({
    path: remotePath(file.name),
    name: "renamed " + file.name,
    size: file.size,
    mimeType: file.type,
  }))
})
afterEach(() => {
  cleanup()
  nativeEvents.clear()
  vi.restoreAllMocks()
})

it("uploads native desktop drops and exposes only the remote original path", async () => {
  runtime.desktop = true
  runtime.remoteId = 42
  const localPath = "C:/Pictures/product.png"
  const serverPath = "/srv/codeg/uploads/session/product.png"
  vi.mocked(uploadLocalPathToRemote).mockResolvedValue({
    path: serverPath,
    name: "product.png",
    size: 3,
    mimeType: "image/png",
  })
  vi.mocked(readLocalFileBase64).mockResolvedValue("QUJD")
  const host = document.createElement("div")
  document.body.appendChild(host)
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  vi.spyOn(document, "elementFromPoint").mockReturnValue(host)
  try {
    const { result } = renderHook(() =>
      useComposerAttachments({
        editorRef: { current: null },
        containerRef: { current: host },
        promptCapabilities: { image: true, embedded_context: true },
        attachmentTabId: "session",
      })
    )
    await waitFor(() =>
      expect(nativeEvents.has("tauri://drag-drop")).toBe(true)
    )
    act(() => {
      nativeEvents.get("tauri://drag-drop")!({
        payload: { paths: [localPath], position: { x: 10, y: 10 } },
      })
    })
    await waitFor(() => expect(result.current.imageAttachments).toHaveLength(1))
    expect(uploadLocalPathToRemote).toHaveBeenCalledWith(localPath, "session")
    expect(readLocalFileBase64).toHaveBeenCalledWith(
      localPath,
      expect.any(Number)
    )
    await acpPrompt("connection", result.current.imagePromptBlocks())
    expect(runtime.call).toHaveBeenCalledWith(
      "acp_prompt",
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: "image",
            data: "",
            uri: buildFileUri(serverPath),
          }),
          expect.objectContaining({
            type: "resource_link",
            uri: buildFileUri(serverPath),
          }),
        ],
      })
    )
    expect(JSON.stringify(runtime.call.mock.calls)).not.toContain(localPath)
  } finally {
    host.remove()
  }
})

describe.each(["web", "remote desktop"])("%s image attachments", (mode) => {
  beforeEach(() => {
    runtime.desktop = mode === "remote desktop"
    runtime.remoteId = runtime.desktop ? 42 : null
  })

  function setup() {
    return renderHook(() =>
      useComposerAttachments({
        editorRef: { current: null },
        promptCapabilities: { image: true, embedded_context: true },
        attachmentTabId: "session",
      })
    )
  }

  it("sends all four dropped images with their server-side original paths", async () => {
    const { result } = setup()
    const files = Array.from({ length: 4 }, (_, index) => imageFile(index))
    expect(result.current.showNativePaperclip).toBe(false)
    act(() => {
      result.current.containerDragProps.onDrop({
        dataTransfer: { types: ["Files"], files },
        preventDefault: vi.fn(),
      } as unknown as ReactDragEvent<HTMLElement>)
    })
    await waitFor(() => {
      expect(result.current.imageAttachments).toHaveLength(4)
      expect(result.current.hasUploadingImage).toBe(false)
    })
    for (const file of files) {
      expect(uploadAttachment).toHaveBeenCalledWith(file, "session")
    }
    const draft = result.current.imagePromptBlocks()
    await acpPrompt("connection", draft)
    const sent = vi.mocked(runtime.call).mock.calls[0] as unknown as [
      string,
      { blocks: Array<{ type: string; uri?: string; data?: string }> },
    ]
    expect(sent[0]).toBe("acp_prompt")
    expect(sent[1].blocks).toHaveLength(8)
    for (let i = 0; i < 4; i++) {
      const uri = buildFileUri(remotePath(files[i].name))
      expect(sent[1].blocks[i * 2]).toMatchObject({
        type: "image",
        data: "",
        uri,
      })
      expect(sent[1].blocks[i * 2 + 1]).toMatchObject({
        type: "resource_link",
        uri,
      })
    }
    const display = { blocks: draft, displayText: "Process the images" }
    const images = extractUserImagesFromDraft(display)
    expect(images).toHaveLength(4)
    expect(images.every((image) => image.data.length > 0)).toBe(true)
    // The sender's optimistic display already knows about the same originals
    // that the server and the adapter will put in the persisted transcript.
    expect(extractUserResourcesFromDraft(display).map((r) => r.uri)).toEqual(
      files.map((file) => buildFileUri(remotePath(file.name)))
    )
  })

  it("uses the remote upload picker and includes the resulting file reference", async () => {
    const { result } = setup()
    const file = imageFile()
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {})
    await act(async () => {
      await result.current.handleUploadLocalFiles()
    })
    expect(openFileDialog).not.toHaveBeenCalled()
    const chosenInput = click.mock.contexts[0] as HTMLInputElement
    expect(chosenInput?.type).toBe("file")
    Object.defineProperty(chosenInput, "files", { value: [file] })
    await act(async () => {
      chosenInput!.dispatchEvent(new Event("change"))
    })
    await waitFor(() => {
      expect(result.current.imageAttachments).toHaveLength(1)
      expect(result.current.hasUploadingImage).toBe(false)
    })
    await acpPrompt("connection", result.current.imagePromptBlocks())
    expect(runtime.call).toHaveBeenCalledWith(
      "acp_prompt",
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: "image",
            data: "",
            uri: buildFileUri(remotePath(file.name)),
          }),
          expect.objectContaining({
            type: "resource_link",
            uri: buildFileUri(remotePath(file.name)),
          }),
        ],
      })
    )
  })

  it("keeps sends gated until the server supplies the attachment path", async () => {
    const file = imageFile()
    let finishUpload!: (
      value: Awaited<ReturnType<typeof uploadAttachment>>
    ) => void
    vi.mocked(uploadAttachment).mockReturnValueOnce(
      new Promise((resolve) => {
        finishUpload = resolve
      })
    )
    const { result } = setup()
    let pending!: Promise<void>
    act(() => {
      pending = result.current.appendFilesFromInput([file])
    })
    await waitFor(() => expect(result.current.hasUploadingImage).toBe(true))
    expect(result.current.imageAttachments[0].uri).toBeNull()
    await act(async () => {
      finishUpload({
        path: remotePath(file.name),
        name: file.name,
        size: file.size,
        mimeType: file.type,
      })
      await pending
    })
    expect(result.current.hasUploadingImage).toBe(false)
    expect(result.current.imageAttachments[0].uri).toBe(
      buildFileUri(remotePath(file.name))
    )
  })

  it("preserves remote originals in live feedback and task retries", async () => {
    const { result } = setup()
    const file = imageFile()
    await act(async () => {
      await result.current.appendFilesFromInput([file])
    })
    const blocks = result.current.imagePromptBlocks()
    await submitSessionFeedback("connection", "process the original", blocks)
    await workTaskRetry(9, "process the original", blocks)
    for (const command of ["submit_session_feedback", "work_task_retry"]) {
      expect(runtime.call).toHaveBeenCalledWith(
        command,
        expect.objectContaining({
          blocks: [
            expect.objectContaining({
              type: "image",
              data: "",
              uri: buildFileUri(remotePath(file.name)),
            }),
            expect.objectContaining({
              type: "resource_link",
              uri: buildFileUri(remotePath(file.name)),
            }),
          ],
        })
      )
    }
  })
})
