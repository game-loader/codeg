import { beforeEach, describe, expect, it, vi } from "vitest"
import { openVideoPreview } from "./video-preview"

const mocks = vi.hoisted(() => ({
  remote: vi.fn(),
  shell: vi.fn(),
  connectionId: null as number | null,
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.remote }),
  getShellTransport: () => ({ call: mocks.shell }),
  getActiveRemoteConnectionId: () => mocks.connectionId,
  getServerBaseUrl: () => "https://codeg.example",
}))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.connectionId = null
  mocks.remote.mockResolvedValue({
    token: "remote",
    url: "/api/video-preview/remote",
  })
  mocks.shell.mockResolvedValue({
    token: "local",
    url: "http://127.0.0.1:9876/api/video-preview/local",
  })
})

describe("video preview transport", () => {
  it("uses a capability URL for web/iOS and passes special filenames through JSON", async () => {
    const preview = await openVideoPreview("/repo/视频 #1.mp4")
    expect(mocks.remote).toHaveBeenCalledWith("start_video_preview", {
      rootPath: "/repo",
      path: "视频 #1.mp4",
    })
    expect(preview.url).toBe("https://codeg.example/api/video-preview/remote")
    expect(mocks.shell).not.toHaveBeenCalled()
    await preview.release()
    expect(mocks.remote).toHaveBeenLastCalledWith("stop_video_preview", {
      token: "remote",
    })
  })

  it("relays remote desktop video through loopback and releases both capabilities", async () => {
    mocks.connectionId = 42
    const preview = await openVideoPreview("/repo/demo.mov")
    expect(mocks.shell).toHaveBeenCalledWith("relay_video_preview", {
      connectionId: 42,
      token: "remote",
    })
    expect(preview.url).toBe("http://127.0.0.1:9876/api/video-preview/local")
    mocks.connectionId = 99
    await preview.release()
    expect(mocks.remote).toHaveBeenLastCalledWith("stop_video_preview", {
      token: "remote",
    })
    expect(mocks.shell).toHaveBeenLastCalledWith("stop_video_preview", {
      token: "local",
    })
  })

  it("revokes the remote capability if the local relay fails", async () => {
    mocks.connectionId = 42
    mocks.shell.mockRejectedValue(new Error("relay failed"))
    await expect(openVideoPreview("/repo/demo.mp4")).rejects.toThrow(
      "relay failed"
    )
    expect(mocks.remote).toHaveBeenLastCalledWith("stop_video_preview", {
      token: "remote",
    })
  })
})
