import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import en from "@/i18n/messages/en.json"
import { VideoPreview } from "./video-preview"

const mocks = vi.hoisted(() => ({ open: vi.fn(), release: vi.fn() }))
vi.mock("@/lib/video-preview", () => ({ openVideoPreview: mocks.open }))

const tab = {
  id: "video",
  path: "/repo/demo.mp4",
  title: "demo.mp4",
  language: "video",
  content: "",
  loading: false,
} as FileWorkspaceTab
const url = "http://127.0.0.1:1234/api/video-preview/token"
function view(revision = 0) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <VideoPreview tab={{ ...tab, previewRevision: revision }} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.open.mockResolvedValue({ url, release: mocks.release })
  mocks.release.mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("VideoPreview", () => {
  it("provides iOS inline controls without autoplay or preloading the entire video", async () => {
    const rendered = render(view())
    const video = screen.getByLabelText("Video player: demo.mp4")
    await waitFor(() => expect(video).toHaveAttribute("src", url))
    expect(video).toHaveAttribute("controls")
    expect(video).toHaveAttribute("playsinline")
    expect(video).toHaveAttribute("preload", "metadata")
    expect(video).not.toHaveAttribute("autoplay")
    fireEvent.loadedMetadata(video)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    rendered.unmount()
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it("releases a capability that arrives after the drawer closes", async () => {
    let resolve!: (value: unknown) => void
    mocks.open.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const rendered = render(view())
    rendered.unmount()
    await act(async () => resolve({ url, release: mocks.release }))
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it("explains unsupported codecs and obtains a fresh capability on retry", async () => {
    render(view())
    const video = screen.getByLabelText("Video player: demo.mp4")
    await waitFor(() => expect(video).toHaveAttribute("src", url))
    Object.defineProperty(video, "error", {
      value: { code: 4 },
      configurable: true,
    })
    fireEvent.error(video)
    expect(screen.getByRole("alert")).toHaveTextContent("H.264")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2))
    expect(mocks.release).toHaveBeenCalledOnce()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("shows request errors and reloads changed files without retaining the old stream", async () => {
    mocks.open.mockRejectedValueOnce(new Error("File missing"))
    const rendered = render(view())
    expect(await screen.findByRole("alert")).toHaveTextContent("File missing")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() =>
      expect(screen.getByLabelText("Video player: demo.mp4")).toHaveAttribute(
        "src",
        url
      )
    )
    rendered.rerender(view(1))
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(3))
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
