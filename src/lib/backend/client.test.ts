import { afterEach, describe, expect, it, vi } from "vitest"
import { createBackendClient } from "./client"
import { expandHomePath } from "@/lib/file-open-target"
import type { Transport } from "@/lib/transport"
import type { BackendClient } from "./types"

afterEach(() => vi.unstubAllGlobals())

function transport() {
  return {
    call: vi.fn<Transport["call"]>(async () => undefined as never),
    subscribe: vi.fn<Transport["subscribe"]>(async () => () => {}),
    isDesktop: () => true,
    onReconnect: vi.fn(() => () => {}),
  }
}

function client(id: number, target = transport(), shell = transport()) {
  return {
    target,
    shell,
    client: createBackendClient({
      key: `remote:${id}`,
      name: `Host ${id}`,
      transport: { ...target, call: target.call as Transport["call"] },
      shellTransport: { ...shell, call: shell.call as Transport["call"] },
      remoteConnectionId: id,
      baseUrl: `http://host-${id}.test`,
      token: `test-${id}`,
      desktop: true,
      windowInstanceId: "test-window",
      configRevision: `revision-${id}`,
    }),
  }
}

describe("fixed backend clients", () => {
  it("keeps helper caches separate for the same home-relative path", async () => {
    const a = client(1)
    const b = client(2)
    a.target.call.mockResolvedValue("/home/a")
    b.target.call.mockResolvedValue("/home/b")
    await expect(expandHomePath("~/notes", a.client.api)).resolves.toBe(
      "/home/a/notes"
    )
    await expect(expandHomePath("~/notes", b.client.api)).resolves.toBe(
      "/home/b/notes"
    )
    expect(a.target.call).toHaveBeenCalledTimes(1)
    expect(b.target.call).toHaveBeenCalledTimes(1)
  })

  it("binds HTTP upload origins, tokens, and authentication failures", async () => {
    const failuresA = vi.fn()
    const failuresB = vi.fn()
    const target = transport()
    const a = createBackendClient({
      key: "remote:1",
      name: "A",
      transport: { ...target, call: target.call as Transport["call"] },
      remoteConnectionId: 1,
      baseUrl: "http://a.test",
      token: "token-a",
      desktop: false,
      onUnauthorized: failuresA,
    })
    const b = createBackendClient({
      key: "remote:2",
      name: "B",
      transport: { ...target, call: target.call as Transport["call"] },
      remoteConnectionId: 2,
      baseUrl: "http://b.test",
      token: "token-b",
      desktop: false,
      onUnauthorized: failuresB,
    })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ path: "/uploads/file.txt" }))
      )
    vi.stubGlobal("fetch", fetch)
    const file = new File(["data"], "file.txt")
    await expect(a.api.uploadAttachment(file)).rejects.toThrow("Unauthorized")
    await expect(b.api.uploadAttachment(file)).resolves.toMatchObject({
      path: "/uploads/file.txt",
    })
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://a.test/api/upload_attachment",
      expect.objectContaining({ headers: { Authorization: "Bearer token-a" } })
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://b.test/api/upload_attachment",
      expect.objectContaining({ headers: { Authorization: "Bearer token-b" } })
    )
    expect(failuresA).toHaveBeenCalledTimes(1)
    expect(failuresB).not.toHaveBeenCalled()
  })
  it("routes identical paths and folder IDs independently", async () => {
    const a = client(1)
    const b = client(2)
    await Promise.all([
      a.client.api.openFolder("/repo"),
      b.client.api.openFolder("/repo"),
      a.client.api.getFolder(1),
      b.client.api.getFolder(1),
    ])
    for (const backend of [a, b]) {
      expect(backend.target.call).toHaveBeenCalledWith("open_folder", {
        path: "/repo",
      })
      expect(backend.target.call).toHaveBeenCalledWith("get_folder", {
        folderId: 1,
      })
    }
    expect(a.shell.call).not.toHaveBeenCalled()
    expect(b.shell.call).not.toHaveBeenCalled()
  })

  it("keeps an upload and its subsequent prompt on A after B is selected", async () => {
    const a = client(1)
    const b = client(2)
    let selected: BackendClient = a.client
    let finish!: (buffer: ArrayBuffer) => void
    const file = new File(["image"], "image.png", { type: "image/png" })
    Object.defineProperty(file, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve
        }),
    })
    a.shell.call.mockResolvedValue({ path: "/uploads/image.png" })
    const captured = selected.api
    const pending = (async () => {
      const uploaded = await captured.uploadAttachment(file, "session-1")
      await captured.acpPrompt(
        "connection-1",
        [
          {
            type: "resource_link",
            uri: `file://${uploaded.path}`,
            name: "image.png",
          },
        ],
        1,
        1
      )
    })()
    selected = b.client
    await selected.api.openFolder("/repo")
    finish(new Uint8Array([1, 2, 3]).buffer)
    await pending
    expect(a.shell.call).toHaveBeenCalledWith(
      "remote_upload_attachment",
      expect.objectContaining({ connectionId: 1, configRevision: "revision-1" })
    )
    expect(a.target.call).toHaveBeenCalledWith(
      "acp_prompt",
      expect.objectContaining({ folderId: 1, conversationId: 1 })
    )
    expect(b.target.call).toHaveBeenCalledTimes(1)
    expect(b.shell.call).not.toHaveBeenCalled()
  })

  it("binds event subscriptions and local popup targets separately", async () => {
    const a = client(1)
    const b = client(2)
    const handleA = vi.fn()
    const handleB = vi.fn()
    await a.client.platform.subscribe("terminal://output", handleA)
    await b.client.platform.subscribe("terminal://output", handleB)
    await Promise.all([
      a.client.api.openCommitWindow(1),
      b.client.api.openCommitWindow(1),
    ])
    expect(a.target.subscribe).toHaveBeenCalledWith(
      "terminal://output",
      handleA
    )
    expect(b.target.subscribe).toHaveBeenCalledWith(
      "terminal://output",
      handleB
    )
    expect(a.shell.call).toHaveBeenCalledWith(
      "open_commit_window",
      expect.objectContaining({
        folderId: 1,
        remoteConnectionId: 1,
        configRevision: "revision-1",
      })
    )
    expect(b.shell.call).toHaveBeenCalledWith(
      "open_commit_window",
      expect.objectContaining({
        folderId: 1,
        remoteConnectionId: 2,
        configRevision: "revision-2",
      })
    )
  })

  it("carries the initiating revision into every native operation window", async () => {
    const a = client(1)
    await Promise.all([
      a.client.api.openCommitWindow(1),
      a.client.api.openMergeWindow(1, "merge"),
      a.client.api.openStashWindow(1),
      a.client.api.openPushWindow(1),
      a.client.api.openSettingsWindow("general"),
      a.client.api.openImportSessionsWindow({ focusPath: "/repo" }),
      a.client.api.openProjectBootWindow(),
    ])
    expect(a.shell.call).toHaveBeenCalledTimes(7)
    for (const [, args] of a.shell.call.mock.calls) {
      expect(args).toMatchObject({
        remoteConnectionId: 1,
        configRevision: "revision-1",
      })
    }
  })

  it.each(["file", "local path"])(
    "reports a desktop %s attachment 401 only to its initiating client",
    async (kind) => {
      const a = client(1)
      const b = client(2)
      const onA = vi.fn()
      const onB = vi.fn()
      const apiA = createBackendClient({
        ...a.client,
        shellTransport: { ...a.shell, call: a.shell.call as Transport["call"] },
        remoteConnectionId: 1,
        desktop: true,
        configRevision: "revision-1",
        onUnauthorized: onA,
      }).api
      createBackendClient({
        ...b.client,
        shellTransport: { ...b.shell, call: b.shell.call as Transport["call"] },
        remoteConnectionId: 2,
        onUnauthorized: onB,
      })
      const authError = { code: "authentication_failed", message: "HTTP 401" }
      a.shell.call.mockImplementation(async (command) => {
        if (command === "read_local_file_for_upload") {
          return {
            fileName: "file.txt",
            mimeType: null,
            size: 1,
            dataBase64: "YQ==",
          } as never
        }
        throw authError
      })
      const file = new File(["data"], "file.txt")
      Object.defineProperty(file, "arrayBuffer", {
        value: async () => new Uint8Array([1]).buffer,
      })
      await expect(
        kind === "file"
          ? apiA.uploadAttachment(file)
          : apiA.uploadLocalPathToRemote("/local/file.txt")
      ).rejects.toEqual(authError)
      expect(onA).toHaveBeenCalledOnce()
      expect(onB).not.toHaveBeenCalled()
      expect(b.shell.call).not.toHaveBeenCalled()
    }
  )

  it("keeps academic settings and selection on the same backend", async () => {
    const a = client(1)
    const b = client(2)
    let finish!: (value: unknown) => void
    a.target.call.mockImplementationOnce(
      () =>
        new Promise<never>((resolve) => {
          finish = resolve as (value: unknown) => void
        })
    )
    const pending = a.client.api.academicSelect("ITEM")
    await b.client.api.academicPaperGet("paper-1")
    finish({ agent_type: "codex" })
    await pending
    expect(a.target.call).toHaveBeenLastCalledWith(
      "academic_select",
      expect.objectContaining({ itemKey: "ITEM" }),
      { timeoutMs: 190_000 }
    )
    expect(b.target.call).toHaveBeenCalledTimes(1)
  })

  it("filters transfer progress by machine and window", async () => {
    const a = client(1)
    let emit!: (value: unknown) => void
    a.shell.subscribe.mockImplementation(async (_event, handler) => {
      emit = handler as (value: unknown) => void
      return () => {}
    })
    const receive = vi.fn()
    await a.client.api.listenWorkspaceTransferProgress(receive)
    const progress = {
      transferId: "same-id",
      direction: "upload",
      loaded: 1,
      total: 2,
      state: "running",
    }
    emit({ ...progress, connectionId: 2, windowInstanceId: "test-window" })
    emit({ ...progress, connectionId: 1, windowInstanceId: "another-window" })
    emit({ ...progress, connectionId: 1, windowInstanceId: "test-window" })
    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive).toHaveBeenCalledWith({
      ...progress,
      connectionId: 1,
      windowInstanceId: "test-window",
    })
    await a.client.api.cancelWorkspaceTransfer("same-id")
    expect(a.shell.call).toHaveBeenCalledWith(
      "remote_cancel_workspace_transfer",
      {
        transferId: "same-id",
        connectionId: 1,
        windowInstanceId: "test-window",
      }
    )
  })
  it("forwards direct proxy configuration rejection only to the initiating client's callback", async () => {
    const a = client(1)
    const b = client(2)
    const changedA = vi.fn()
    const changedB = vi.fn()
    const authA = vi.fn()
    const apiA = createBackendClient({
      ...a.client,
      remoteConnectionId: 1,
      shellTransport: { ...a.shell, call: a.shell.call as Transport["call"] },
      desktop: true,
      onConfigurationChanged: changedA,
      onUnauthorized: authA,
    }).api
    createBackendClient({
      ...b.client,
      remoteConnectionId: 2,
      shellTransport: { ...b.shell, call: b.shell.call as Transport["call"] },
      onConfigurationChanged: changedB,
    })
    const error = {
      code: "configuration_invalid",
      message:
        "Remote connection configuration changed; close and reopen this window.",
    }
    a.shell.call.mockRejectedValueOnce(error)
    const file = new File(["A"], "a.txt")
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new ArrayBuffer(1),
    })
    await expect(apiA.uploadAttachment(file)).rejects.toEqual(error)
    expect(changedA).toHaveBeenCalledOnce()
    expect(changedB).not.toHaveBeenCalled()
    expect(authA).not.toHaveBeenCalled()
  })
})
