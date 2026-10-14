import * as platform from "@/lib/platform"
import * as transport from "@/lib/transport"
import type { BackendPlatform } from "./types"

/** Only standalone, single-backend consumers use these compatibility getters. */
export const defaultBackendPlatform: BackendPlatform = {
  isDesktop: () => platform.isDesktop(),
  isLocalDesktop: () => platform.isLocalDesktop(),
  isRemoteDesktopWindow: () => platform.isRemoteDesktopWindow(),
  subscribe: (event, handler) => platform.subscribe(event, handler),
  onTransportReconnect: (callback) => platform.onTransportReconnect(callback),
  onTransportReady: (callback) => platform.onTransportReady(callback),
  getEventStream: () => platform.getEventStream(),
  openUrl: (url) => platform.openUrl(url),
  openPath: (path) => platform.openPath(path),
  revealItemInDir: (path) => platform.revealItemInDir(path),
  openFileDialog: (options) => platform.openFileDialog(options),
  getCurrentWindow: () => platform.getCurrentWindow(),
  closeCurrentWindow: () => platform.closeCurrentWindow(),
  getTransport: () => transport.getTransport(),
  getActiveRemoteConnectionId: () => transport.getActiveRemoteConnectionId(),
  isRemoteDesktopMode: () => transport.isRemoteDesktopMode(),
  getServerBaseUrl: () => transport.getServerBaseUrl(),
  notifyRemoteDesktopUnauthorized: () =>
    transport.notifyRemoteDesktopUnauthorized(),
}
