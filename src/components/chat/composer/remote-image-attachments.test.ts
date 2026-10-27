import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import type { DragEvent as ReactDragEvent } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

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
  getActiveRemoteConnectionId: () => runtime.remoteId,
  getTransport: () => ({ call: runtime.call }),
  openFileDialog: vi.fn(),
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => runtime.desktop,
  getActiveRemoteConnectionId: () => runtime.remoteId,
  getServerBaseUrl: () => window.location.origin,
  getActiveRemoteTransportConfig: () =>
    runtime.remoteId === null
      ? null
      : {
          id: runtime.remoteId,
          name: "Remote",
          baseUrl: window.location.origin,
          token: "test-token",
          configRevision: "test-revision",
          windowInstanceId: "test-window",
        },
  notifyRemoteDesktopUnauthorized: vi.fn(),
  getTransport: () => ({ call: runtime.call }),
  getShellTransport: () => ({ call: runtime.call }),
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
  useTranslations: () => (key: string, params?: { limit?: number }) =>
    params?.limit === undefined ? key : `${key}:${params.limit}`,
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

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
    expect(uploadLocalPathToRemote).toHaveBeenCalledWith(
      localPath,
      "session",
      expect.objectContaining({
        id: expect.any(String),
        onProgress: expect.any(Function),
      })
    )
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

  it("allows 200 MiB files and rejects files above the client ceiling", async () => {
    const { result } = setup()
    const accepted = new File(["data"], "large.pdf", {
      type: "application/pdf",
    })
    const rejected = new File(["data"], "too-large.pdf", {
      type: "application/pdf",
    })
    // File size metadata drives the preflight; avoid allocating 400 MiB in CI.
    Object.defineProperty(accepted, "size", { value: 200 * 1024 * 1024 })
    Object.defineProperty(rejected, "size", { value: 200 * 1024 * 1024 + 1 })
    await act(async () => {
      await result.current.appendFilesFromInput([accepted, rejected])
    })
    expect(uploadAttachment).toHaveBeenCalledTimes(1)
    expect(uploadAttachment).toHaveBeenCalledWith(
      accepted,
      "session",
      expect.objectContaining({
        id: expect.any(String),
        onProgress: expect.any(Function),
      })
    )
    expect(toast.error).toHaveBeenCalledWith("attachUploadTooLarge:200")
  })

  it("shows the server's configured limit when an upload is rejected", async () => {
    const { result } = setup()
    vi.mocked(uploadAttachment).mockRejectedValue({
      code: "io_error",
      message: "Upload exceeds the maximum allowed size",
      i18n_key: "errors.upload.tooLarge",
      i18n_params: { limit: String(20 * 1024 * 1024) },
    })
    await act(async () => {
      await result.current.appendFilesFromInput([
        new File(["data"], "report.pdf", { type: "application/pdf" }),
      ])
    })
    expect(toast.error).toHaveBeenCalledWith("attachUploadTooLarge:20")
  })

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
      expect(uploadAttachment).toHaveBeenCalledWith(
        file,
        "session",
        expect.objectContaining({
          id: expect.any(String),
          onProgress: expect.any(Function),
        })
      )
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

/** Plain-object stand-in for the drag data WebKit hands a drop target. */
function dragData(init: {
  types?: string[]
  files?: File[]
  data?: Record<string, string>
}): DataTransfer {
  return {
    types: init.types ?? [],
    files: init.files ?? [],
    items: [],
    getData: (type: string) => init.data?.[type] ?? "",
  } as unknown as DataTransfer
}

function dropEvent(dataTransfer: DataTransfer, position = { x: 0, y: 0 }) {
  return {
    dataTransfer,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientX: position.x,
    clientY: position.y,
  } as unknown as DragEvent
}

describe("composer drop affordance", () => {
  afterEach(() => {
    cleanup()
    nativeEvents.clear()
    vi.restoreAllMocks()
  })

  it("shows the hint for a typeless WebKit hover", () => {
    runtime.desktop = true
    runtime.remoteId = null
    const { result } = renderHook(() =>
      useComposerAttachments({
        editorRef: { current: null },
        promptCapabilities: { image: true, embedded_context: true },
        attachmentTabId: "session",
      })
    )
    act(() => {
      result.current.containerDragProps.onDragOver({
        dataTransfer: dragData({ types: [] }),
        preventDefault: vi.fn(),
      } as unknown as ReactDragEvent<HTMLElement>)
    })
    expect(result.current.isDragActive).toBe(true)
  })

  it("routes a native drop to the only visible composer even off-target", async () => {
    runtime.desktop = true
    runtime.remoteId = 42
    const localPath = "C:/Pictures/product.png"
    vi.mocked(uploadLocalPathToRemote).mockResolvedValue({
      path: "/srv/codeg/uploads/session/product.png",
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
      // The reported point is nowhere near the composer. With a single visible
      // composer there is nothing to disambiguate, so the drop still lands.
      act(() => {
        nativeEvents.get("tauri://drag-drop")!({
          payload: { paths: [localPath], position: { x: 900, y: 900 } },
        })
      })
      await waitFor(() =>
        expect(result.current.imageAttachments).toHaveLength(1)
      )
      expect(uploadLocalPathToRemote).toHaveBeenCalledWith(
        localPath,
        "session",
        expect.objectContaining({
          id: expect.any(String),
          onProgress: expect.any(Function),
        })
      )
    } finally {
      host.remove()
    }
  })

  it("consumes an editor-level file drop and attaches its uri-list path", async () => {
    runtime.desktop = true
    runtime.remoteId = 42
    const localPath = "/Users/me/photo.png"
    vi.mocked(uploadLocalPathToRemote).mockResolvedValue({
      path: "/srv/codeg/uploads/session/photo.png",
      name: "photo.png",
      size: 3,
      mimeType: "image/png",
    })
    vi.mocked(readLocalFileBase64).mockResolvedValue("QUJD")
    const { result } = renderHook(() =>
      useComposerAttachments({
        editorRef: { current: null },
        promptCapabilities: { image: true, embedded_context: true },
        attachmentTabId: "session",
      })
    )
    const event = dropEvent(
      dragData({
        types: ["Files", "text/uri-list"],
        files: [new File(["x"], "photo.png", { type: "image/png" })],
        data: { "text/uri-list": `file://${localPath}` },
      })
    )
    let consumed = false
    act(() => {
      consumed = result.current.handleEditorDrop(event)
    })
    expect(consumed).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    await waitFor(() => expect(result.current.imageAttachments).toHaveLength(1))
    expect(uploadLocalPathToRemote).toHaveBeenCalledWith(
      localPath,
      "session",
      expect.objectContaining({
        id: expect.any(String),
        onProgress: expect.any(Function),
      })
    )
  })
})

describe("attachment upload progress", () => {
  afterEach(() => {
    cleanup()
    nativeEvents.clear()
    vi.restoreAllMocks()
  })

  function hook() {
    return renderHook(() =>
      useComposerAttachments({
        editorRef: { current: null },
        promptCapabilities: { image: true, embedded_context: true },
        attachmentTabId: "session",
      })
    )
  }

  it("shows a chip per file upload and clears it when the upload lands", async () => {
    runtime.desktop = false
    runtime.remoteId = null
    let report!: (loaded: number, total: number) => void
    let finish!: (value: {
      path: string
      name: string
      size: number
      mimeType: string | null
    }) => void
    vi.mocked(uploadAttachment).mockImplementationOnce(
      (_file, _sid, progress) => {
        report = (loaded, total) => progress?.onProgress?.(loaded, total)
        return new Promise((resolve) => {
          finish = resolve
        })
      }
    )

    const { result } = hook()
    const file = new File(["data"], "report.pdf", { type: "application/pdf" })
    let pending!: Promise<void>
    act(() => {
      pending = result.current.appendFilesFromInput([file])
    })

    await waitFor(() => expect(result.current.pendingUploads).toHaveLength(1))
    expect(result.current.pendingUploads[0]).toMatchObject({
      name: "report.pdf",
      loaded: 0,
      total: file.size,
    })
    expect(result.current.hasPendingFileUploads).toBe(true)

    act(() => report(2, file.size))
    await waitFor(() => expect(result.current.pendingUploads[0].loaded).toBe(2))

    await act(async () => {
      finish({
        path: "/srv/uploads/report.pdf",
        name: "report.pdf",
        size: file.size,
        mimeType: "application/pdf",
      })
      await pending
    })
    await waitFor(() => expect(result.current.pendingUploads).toHaveLength(0))
    expect(result.current.hasPendingFileUploads).toBe(false)
  })

  it("clears the chip when the upload fails", async () => {
    runtime.desktop = false
    runtime.remoteId = null
    let fail!: (reason: unknown) => void
    vi.mocked(uploadAttachment).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        })
    )

    const { result } = hook()
    const file = new File(["data"], "x.bin", { type: "" })
    let pending!: Promise<void>
    act(() => {
      pending = result.current.appendFilesFromInput([file])
    })
    await waitFor(() => expect(result.current.pendingUploads).toHaveLength(1))
    await act(async () => {
      fail(new Error("boom"))
      await pending
    })
    await waitFor(() => expect(result.current.pendingUploads).toHaveLength(0))
    expect(toast.error).toHaveBeenCalledWith("attachUploadFailed")
  })

  it("reports byte progress on an uploading image thumbnail", async () => {
    runtime.desktop = false
    runtime.remoteId = null
    let report!: (loaded: number, total: number) => void
    let finish!: (value: {
      path: string
      name: string
      size: number
      mimeType: string | null
    }) => void
    vi.mocked(uploadAttachment).mockImplementationOnce(
      (_file, _sid, progress) => {
        report = (loaded, total) => progress?.onProgress?.(loaded, total)
        return new Promise((resolve) => {
          finish = resolve
        })
      }
    )

    const { result } = hook()
    act(() => {
      void result.current.appendFilesFromInput([imageFile()])
    })
    await waitFor(() => expect(result.current.imageAttachments).toHaveLength(1))
    act(() => report(25, 100))
    await waitFor(() =>
      expect(result.current.imageAttachments[0].uploadProgress).toBe(0.25)
    )
    await act(async () => {
      finish({
        path: "/srv/uploads/photo.png",
        name: "photo.png",
        size: 100,
        mimeType: "image/png",
      })
    })
    await waitFor(() => expect(result.current.hasUploadingImage).toBe(false))
    // The file-upload chip list stays empty: images render in the thumbnail
    // strip instead of getting a second progress chip.
    expect(result.current.pendingUploads).toHaveLength(0)
  })
})
