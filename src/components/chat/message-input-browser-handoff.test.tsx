import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { Editor } from "@tiptap/core"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  BackendClientProvider,
  useBackendClient,
} from "@/contexts/backend-client-context"
import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import { getBackendEventScope } from "@/lib/backend/resource-identity"
import type { BackendClient, BackendKey } from "@/lib/backend/types"
import type { BrowserTabState, PageHandoff } from "@/lib/browser/types"
import {
  ATTACH_PAGE_TO_SESSION_EVENT,
  emitAttachPageToSession,
  type AttachPageToSessionDetail,
} from "@/lib/session-attachment-events"
import type {
  RichComposerHandle,
  RichComposerProps,
} from "./composer/rich-composer"

const native = vi.hoisted(() => ({
  capture: vi.fn(),
  pick: vi.fn(),
  console: vi.fn(),
  activeTabId: "host-remote%3A1:conv-1-codex-42",
}))
const editors = new Map<BackendClient, Editor>()

vi.mock("@/lib/browser/browser-api", () => ({
  browserPageCapture: native.capture,
  browserPickElement: native.pick,
  browserPageConsole: native.console,
  browserPickCancel: vi.fn(async () => {}),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (
    selector: (state: {
      tabs: Array<{ id: string; kind: string }>
      activeTabId: string
    }) => unknown
  ) =>
    selector({
      tabs: [{ id: native.activeTabId, kind: "conversation" }],
      activeTabId: native.activeTabId,
    }),
}))
vi.mock("@/lib/browser/browser-tab-store", () => ({
  useBrowserConsoleErrors: () => true,
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: { send_message: "enter", newline_in_message: "shift+enter" },
  }),
}))
vi.mock("@/hooks/use-agent-skills", () => ({ useAgentSkills: () => [] }))
vi.mock("@/hooks/use-built-in-experts", () => ({ useBuiltInExperts: () => [] }))
vi.mock("@/hooks/use-built-in-science", () => ({ useBuiltInScience: () => [] }))
vi.mock("@/hooks/use-enabled-skill-ids", () => ({
  useEnabledSkillIds: () => ({ enabledIds: new Set(), ready: false }),
}))
vi.mock("./composer/use-reference-search", () => ({
  useReferenceSearch: () => async () => [],
}))
vi.mock("./conversation-context-bar", () => ({
  ConversationContextBar: () => null,
  ConversationFolderBranchPicker: () => null,
  useConversationFolderBranchPickerVisible: () => false,
}))
vi.mock("./composer-context-usage", () => ({
  ComposerContextUsage: () => null,
}))
vi.mock("./composer-connection-status", () => ({
  ComposerConnectionStatus: () => null,
}))
vi.mock("@/components/shared/server-file-browser-dialog", () => ({
  ServerFileBrowserDialog: () => null,
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => false }))
vi.mock("@/hooks/use-open-file-target", () => ({
  useOpenFileTarget: () => async () => {},
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// Control the composer lifecycle while keeping a real Tiptap document and the
// real MessageInput listener/attachment engine, including remote image uploads.
vi.mock("./composer/rich-composer", async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import("react")
  const { EditorContent, useEditor } = await import("@tiptap/react")
  const { buildComposerExtensions } = await import("./composer/editor-config")
  const { serializeDocToText } = await import("./composer/to-prompt-blocks")
  return {
    RichComposer: forwardRef<RichComposerHandle, RichComposerProps>(
      function ControlledRichComposer(props, ref) {
        const client = useBackendClient()
        const { onChange, onReady } = props
        const editor = useEditor({
          extensions: buildComposerExtensions(),
          onUpdate: ({ editor }) =>
            onChange?.(serializeDocToText(editor.state.doc)),
        })
        useImperativeHandle(
          ref,
          () => ({
            getEditor: () => editor,
            getJSON: () => editor!.getJSON(),
            getText: () => serializeDocToText(editor!.state.doc),
            isEmpty: () => editor?.isEmpty ?? true,
            setText: (text) => editor?.commands.setContent(text),
            setDoc: (doc) => editor?.commands.setContent(doc),
            clear: () => editor?.commands.clearContent(),
            focus: () => editor?.commands.focus(),
            focusAtCoords: () => editor?.commands.focus(),
            insertTextAtCursor: (text) => editor?.commands.insertContent(text),
            insertReference: (attrs) => editor?.commands.insertReference(attrs),
          }),
          [editor]
        )
        useEffect(() => {
          if (!editor) return
          editors.set(client, editor)
          onReady?.()
          return () => {
            editors.delete(client)
          }
        }, [client, editor, onReady])
        return <EditorContent editor={editor} />
      }
    ),
  }
})

import { BrowserSendToChatControl } from "../browser/browser-page-handoff"
import {
  BrowserScreenshotMarkupHost,
  openScreenshotMarkup,
  resetScreenshotMarkupForTests,
} from "../browser/browser-screenshot-markup"
import { MessageInput } from "./message-input"

// The persisted canonical IDs emitted by the owning tab stores, reused when a
// same-backend runtime rehydrates the same folder/agent/conversation triple.
const TAB_A = "host-remote%3A1:conv-1-codex-42"
const TAB_B = "host-remote%3A2:conv-1-codex-42"
const browserTab = {
  id: "browser:native-page",
  kind: "browser",
} as BrowserWorkspaceTab
const browserState = { tabId: "native-page" } as BrowserTabState
const capture: NonNullable<PageHandoff["image"]> = {
  mime: "image/png",
  data: "AAAA",
  width: 800,
  height: 500,
  url: "https://example.com/private-page",
  region: { x: 0, y: 0, width: 800, height: 500 },
  clipped: false,
}

function handoff(): PageHandoff {
  return {
    cancelled: false,
    count: 1,
    label: "Private page",
    text: "Private page content from the initiating runtime",
    url: capture.url,
    image: capture,
  }
}

function client(key: BackendKey) {
  const upload = vi.fn(async () => ({ path: "/uploads/screenshot.png" }))
  const value = {
    key,
    api: { uploadAttachment: upload },
    platform: { getActiveRemoteConnectionId: () => Number(key.split(":")[1]) },
  } as unknown as BackendClient
  return { value, upload }
}

function runtime(client: BackendClient, children: ReactNode) {
  return (
    <BackendClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={enMessages}>
        {children}
      </NextIntlClientProvider>
    </BackendClientProvider>
  )
}

function composer(client: BackendClient, tabId = TAB_A, embedded = false) {
  return render(
    runtime(
      client,
      <MessageInput
        attachmentTabId={tabId}
        onSend={vi.fn()}
        promptCapabilities={{
          image: true,
          audio: false,
          embedded_context: embedded,
        }}
      />
    )
  )
}

function sender(client: BackendClient) {
  return render(
    runtime(
      client,
      <BrowserSendToChatControl tab={browserTab} state={browserState} />
    )
  )
}

function host(client: BackendClient) {
  return render(runtime(client, <BrowserScreenshotMarkupHost />))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

async function choose(name: string) {
  const trigger = screen.getByRole("button", { name: "Send to chat" })
  for (const type of ["pointerdown", "pointerup", "click"]) {
    fireEvent(trigger, new MouseEvent(type, { bubbles: true, button: 0 }))
  }
  await settle()
  fireEvent.click(screen.getByRole("menuitem", { name }))
  await settle()
}

async function open(client: BackendClient) {
  act(() =>
    openScreenshotMarkup({
      capture,
      text: handoff().text,
      uri: capture.url,
      conversationTabId: TAB_A,
      backendScope: getBackendEventScope(client),
    })
  )
  await settle()
}

const seen: AttachPageToSessionDetail[] = []
const observe = (event: Event) => {
  seen.push((event as CustomEvent<AttachPageToSessionDetail>).detail)
}

beforeEach(() => {
  seen.length = 0
  native.activeTabId = TAB_A
  native.capture.mockReset()
  native.pick.mockReset()
  native.console.mockReset().mockResolvedValue(handoff())
  resetScreenshotMarkupForTests()
  window.addEventListener(ATTACH_PAGE_TO_SESSION_EVENT, observe)
  // Native capture pixels and canvas encoding are controlled; no webview or
  // native decoder is available in jsdom.
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null
      set src(_value: string) {
        setTimeout(() => this.onload?.(), 0)
      }
    }
  )
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      new Proxy(
        {},
        { get: () => () => {}, set: () => true }
      ) as CanvasRenderingContext2D
  )
})

afterEach(() => {
  cleanup()
  resetScreenshotMarkupForTests()
  window.removeEventListener(ATTACH_PAGE_TO_SESSION_EVENT, observe)
  editors.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("MessageInput receives browser handoffs in the initiating generation", () => {
  it.each([false, true])(
    "rejects delayed native capture after same-key/same-tab replacement (embedded=%s)",
    async (embedded) => {
      const oldA = client("remote:1")
      const newA = client("remote:1")
      const b = client("remote:2")
      const oldComposer = composer(oldA.value, TAB_A, embedded)
      composer(b.value, TAB_B, embedded)
      const bEditor = editors.get(b.value)!
      act(() => {
        bEditor.commands.insertContent("B's existing draft")
      })
      const bDraft = bEditor.getJSON()
      const control = sender(oldA.value)
      const delayed = deferred<PageHandoff>()
      native.capture.mockReturnValueOnce(delayed.promise)
      await choose("Send a screenshot")
      oldComposer.unmount()
      control.unmount()
      composer(newA.value, TAB_A, embedded)
      expect(getBackendEventScope(newA.value)).not.toBe(
        getBackendEventScope(oldA.value)
      )

      await act(async () => {
        delayed.resolve(handoff())
      })
      await settle()
      expect(seen).toHaveLength(1)
      expect(editors.get(newA.value)!.isEmpty).toBe(true)
      expect(editors.get(b.value)).toBe(bEditor)
      expect(bEditor.getJSON()).toEqual(bDraft)
      expect(newA.upload).not.toHaveBeenCalled()
      expect(b.upload).not.toHaveBeenCalled()
      expect(seen[0].accepted).not.toBe(true)
      expect(seen[0].backendScope).toBe(getBackendEventScope(oldA.value))

      // The same receiving boundary accepts an ordinary current-A delivery
      // and actually calls its own remote upload API. B remains untouched.
      sender(newA.value)
      native.capture.mockResolvedValueOnce(handoff())
      await choose("Send a screenshot")
      await waitFor(() => expect(newA.upload).toHaveBeenCalledTimes(1))
      expect(seen[1].accepted).toBe(true)
      expect(editors.get(newA.value)!.isEmpty).toBe(false)
      expect(bEditor.getJSON()).toEqual(bDraft)
      expect(b.upload).not.toHaveBeenCalled()
      expect(oldA.upload).not.toHaveBeenCalled()
    }
  )

  it.each(["Pick an element…", "Send the 1 console error"])(
    "captures the scope and target before awaiting %s",
    async (action) => {
      const oldA = client("remote:1")
      const newA = client("remote:1")
      const delayed = deferred<PageHandoff>()
      composer(newA.value)
      const control = sender(oldA.value)
      if (action.startsWith("Pick"))
        native.pick.mockReturnValueOnce(delayed.promise)
      else
        native.console
          .mockResolvedValueOnce(handoff())
          .mockReturnValueOnce(delayed.promise)
      await choose(action)
      native.activeTabId = "another-conversation"
      control.rerender(
        runtime(
          newA.value,
          <BrowserSendToChatControl tab={browserTab} state={browserState} />
        )
      )
      await act(async () => {
        delayed.resolve(handoff())
      })
      expect(seen[0].tabId).toBe(TAB_A)
      expect(seen[0].backendScope).toBe(getBackendEventScope(oldA.value))
      expect(seen[0].accepted).not.toBe(true)
      expect(editors.get(newA.value)!.isEmpty).toBe(true)
      expect(newA.upload).not.toHaveBeenCalled()
    }
  )

  it("rejects unstamped and foreign-generation events even with the same tab ID", () => {
    const a = client("remote:1")
    const b = client("remote:2")
    composer(a.value)
    let accepted = true
    for (const backendScope of [undefined, getBackendEventScope(b.value)]) {
      act(() => {
        accepted = emitAttachPageToSession({
          tabId: TAB_A,
          backendScope,
          label: "Page",
          text: "Foreign page",
          uri: capture.url,
        })
      })
      expect(accepted).toBe(false)
    }
    expect(editors.get(a.value)!.isEmpty).toBe(true)
    expect(a.upload).not.toHaveBeenCalled()
  })
})

describe("screenshot markup generation ownership", () => {
  it("renders in only the owning host and carries that scope to MessageInput", async () => {
    const oldA = client("remote:1")
    const newA = client("remote:1")
    const b = client("remote:2")
    composer(newA.value)
    composer(b.value, TAB_B)
    host(oldA.value)
    const bHost = host(b.value)
    sender(oldA.value)
    native.capture.mockResolvedValueOnce(handoff())
    await choose("Mark up a screenshot…")
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1)
    // Cleanup of another runtime must leave A's request alone.
    bHost.unmount()
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }))
    await settle()
    expect(seen[0].backendScope).toBe(getBackendEventScope(oldA.value))
    expect(seen[0].accepted).not.toBe(true)
    expect(editors.get(newA.value)!.isEmpty).toBe(true)
    expect(newA.upload).not.toHaveBeenCalled()
    expect(b.upload).not.toHaveBeenCalled()
    host(newA.value)
    await open(newA.value)
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }))
    await waitFor(() => expect(newA.upload).toHaveBeenCalledTimes(1))
    expect(seen[1].backendScope).toBe(getBackendEventScope(newA.value))
    expect(seen[1].accepted).toBe(true)
    expect(b.upload).not.toHaveBeenCalled()
  })

  it("cleans up the retired owner's pending request so B and replacement A can capture", async () => {
    const oldA = client("remote:1")
    const newA = client("remote:1")
    const b = client("remote:2")
    const oldHost = host(oldA.value)
    host(b.value)
    await open(oldA.value)
    oldHost.unmount()
    expect(screen.queryByRole("dialog")).toBeNull()
    await open(b.value)
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    host(newA.value)
    await open(newA.value)
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    expect(seen).toHaveLength(0)
  })

  it.each([false, true])(
    "does not park capture pixels after the old host unmounts (sender unmounted=%s)",
    async (unmountSender) => {
      const oldA = client("remote:1")
      const newA = client("remote:1")
      const b = client("remote:2")
      const oldHost = host(oldA.value)
      host(b.value)
      const control = sender(oldA.value)
      const delayed = deferred<PageHandoff>()
      native.capture.mockReturnValueOnce(delayed.promise)
      await choose("Mark up a screenshot…")
      // One variant keeps the sender mounted: the host's active scope must
      // forbid a late global pending request independently of sender liveness.
      oldHost.unmount()
      if (unmountSender) control.unmount()
      host(newA.value)
      await act(async () => {
        delayed.resolve(handoff())
      })
      await settle()
      expect(screen.queryByRole("dialog")).toBeNull()
      await open(b.value)
      expect(screen.getAllByRole("dialog")).toHaveLength(1)
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
      await open(newA.value)
      expect(screen.getAllByRole("dialog")).toHaveLength(1)
      expect(seen).toHaveLength(0)
    }
  )

  it("drops a retiring host's delayed encoding without closing B's later request", async () => {
    const oldA = client("remote:1")
    const newA = client("remote:1")
    const b = client("remote:2")
    const oldHost = host(oldA.value)
    host(b.value)
    await open(oldA.value)
    const encoding = deferred<Blob>()
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => {
        void encoding.promise.then(callback)
      }
    )
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "getBoundingClientRect"
    ).mockReturnValue({ left: 0, top: 0, width: 800, height: 500 } as DOMRect)
    const canvas = screen.getByRole("img", { name: "Mark up the screenshot" })
    for (const [type, x, y] of [
      ["pointerdown", 100, 100],
      ["pointerup", 300, 200],
    ] as const) {
      fireEvent(
        canvas,
        new MouseEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y,
        })
      )
    }
    expect(screen.getByText("1 mark")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }))
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledTimes(1)
    oldHost.unmount()
    composer(newA.value)
    host(newA.value)
    await open(b.value)
    await act(async () => {
      encoding.resolve(new Blob(["pixels"], { type: "image/png" }))
    })
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    expect(seen).toHaveLength(0)
    expect(editors.get(newA.value)!.isEmpty).toBe(true)
    expect(newA.upload).not.toHaveBeenCalled()
    expect(b.upload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await open(newA.value)
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
  })
})
