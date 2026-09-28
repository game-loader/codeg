import { splitAbsPath } from "@/lib/file-open-target"
import {
  getActiveRemoteConnectionId,
  getServerBaseUrl,
  getShellTransport,
  getTransport,
} from "@/lib/transport"

interface VideoSession {
  token: string
  url: string
}

/** Capture transports before awaiting: a late cleanup must release the
 * capability on the host that issued it, even if the user changed connection. */
export async function openVideoPreview(path: string) {
  const io = splitAbsPath(path)
  if (!io) throw new Error("Invalid video path")
  const transport = getTransport()
  const shell = getShellTransport()
  const connectionId = getActiveRemoteConnectionId()
  const baseUrl = getServerBaseUrl()
  const session = await transport.call<VideoSession>("start_video_preview", {
    rootPath: io.rootPath,
    path: io.ioPath,
  })
  let relay: VideoSession | undefined
  try {
    if (connectionId !== null) {
      relay = await shell.call<VideoSession>("relay_video_preview", {
        connectionId,
        token: session.token,
      })
    }
  } catch (error) {
    await transport
      .call("stop_video_preview", { token: session.token })
      .catch(() => {})
    throw error
  }
  const url = relay?.url ?? session.url
  return {
    url: url.startsWith("/") ? `${baseUrl}${url}` : url,
    async release() {
      await Promise.allSettled([
        transport.call("stop_video_preview", { token: session.token }),
        ...(relay
          ? [shell.call("stop_video_preview", { token: relay.token })]
          : []),
      ])
    },
  }
}
