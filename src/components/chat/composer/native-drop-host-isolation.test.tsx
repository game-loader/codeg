import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TauriEvent } from "@tauri-apps/api/event"
import { BackendClientProvider } from "@/contexts/backend-client-context"
import { createBackendClient } from "@/lib/backend/client"
import type { Transport } from "@/lib/transport/types"
import { useComposerAttachments } from "./use-composer-attachments"
import { pointWithinElement } from "./attachment-files"

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  shell: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (command === "read_local_file_for_upload")
      return {
        fileName: "a.txt",
        size: 1,
        mimeType: "text/plain",
        dataBase64: "QQ==",
      }
    if (command === "remote_upload_attachment")
      return { path: `/uploads/${args.connectionId}/a.txt` }
    throw new Error(`Unexpected shell command ${command}`)
  }),
}))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    listen: async (
      event: string,
      callback: (event: { payload: unknown }) => void
    ) => {
      const listeners = native.listeners.get(event) ?? new Set()
      listeners.add(callback)
      native.listeners.set(event, listeners)
      return () => listeners.delete(callback)
    },
  }),
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => true,
  getActiveRemoteConnectionId: () => null,
  getServerBaseUrl: () => "",
  getTransport: () => {
    throw new Error("Unexpected legacy transport")
  },
  getShellTransport: () => {
    throw new Error("Unexpected legacy shell")
  },
}))

beforeEach(async () => {
  native.listeners.clear()
  native.shell.mockClear()
  localStorage.clear()
  vi.stubGlobal("devicePixelRatio", 2)
  await import("@tauri-apps/api/webview")
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
  Reflect.deleteProperty(document, "elementFromPoint")
  vi.unstubAllGlobals()
})

function panes() {
  const a = document.createElement("div")
  const b = document.createElement("div")
  const aChild = document.createElement("span")
  const bChild = document.createElement("span")
  a.append(aChild)
  b.append(bChild)
  document.body.append(a, b)
  a.getBoundingClientRect = () => new DOMRect(0, 180, 320, 80)
  b.getBoundingClientRect = () => new DOMRect(0, 360, 320, 80)
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (_x: number, y: number) => (y < 300 ? aChild : bChild),
  })
  return { a, b }
}

it("uses exactly one CSS point for a physical native drop across vertically split machines", () => {
  const { a, b } = panes()
  // Physical (80,400) is CSS (40,200) on A. Trying the unscaled point also
  // hits B's visible composer and would leak the file into its upload path.
  expect(pointWithinElement({ x: 80, y: 400 }, a)).toBe(true)
  expect(pointWithinElement({ x: 80, y: 400 }, b)).toBe(false)
  expect(pointWithinElement({ x: 80, y: 800 }, b)).toBe(true)
})

it("uploads a shared native drop through only the actual target's fixed attachment engine", async () => {
  const { a, b } = panes()
  for (const [id, host] of [
    [1, a],
    [2, b],
  ] as const) {
    const client = createBackendClient({
      key: `remote:${id}`,
      name: String(id),
      remoteConnectionId: id,
      desktop: true,
      transport: {
        call: vi.fn(),
        subscribe: vi.fn(),
        isDesktop: () => true,
      } as unknown as Transport,
      shellTransport: {
        call: native.shell,
        isDesktop: () => true,
      } as unknown as Transport,
    })
    const editorRef = { current: null }
    const containerRef = { current: host }
    renderHook(
      () =>
        useComposerAttachments({
          editorRef,
          containerRef,
          promptCapabilities: { image: false, embedded_context: false },
          attachmentTabId: "same-tab",
        }),
      {
        wrapper: ({ children }) => (
          <BackendClientProvider client={client}>
            {children}
          </BackendClientProvider>
        ),
      }
    )
    await waitFor(() =>
      expect(native.listeners.get(TauriEvent.DRAG_DROP)?.size).toBe(id)
    )
  }
  await waitFor(() =>
    expect(native.listeners.get(TauriEvent.DRAG_DROP)?.size).toBe(2)
  )
  const drop = (y: number) => {
    for (const listener of native.listeners.get(TauriEvent.DRAG_DROP) ?? [])
      listener({
        payload: { paths: ["/private/a.txt"], position: { x: 80, y } },
      })
  }
  act(() => drop(400))
  await waitFor(() =>
    expect(
      native.shell.mock.calls.filter(
        ([command]) => command === "remote_upload_attachment"
      )
    ).toHaveLength(1)
  )
  expect(native.shell).toHaveBeenCalledWith(
    "remote_upload_attachment",
    expect.objectContaining({ connectionId: 1 })
  )
  act(() => drop(800))
  await waitFor(() =>
    expect(
      native.shell.mock.calls.filter(
        ([command]) => command === "remote_upload_attachment"
      )
    ).toHaveLength(2)
  )
  expect(native.shell).toHaveBeenCalledWith(
    "remote_upload_attachment",
    expect.objectContaining({ connectionId: 2 })
  )
})
