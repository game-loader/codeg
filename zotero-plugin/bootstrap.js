/* eslint-disable @typescript-eslint/no-unused-vars -- Zotero invokes these global lifecycle hooks. */
/* global Zotero, Services, Components, APP_SHUTDOWN */
const { classes: Cc, interfaces: Ci } = Components
var bridgeScope
var registeredEndpoints = new Map()
var menuWindows = new Set()
const prefPrefix = "extensions.codegAcademicBridge."
const menuID = "codeg-academic-bridge-menu"

function randomToken() {
  const random = Cc["@mozilla.org/security/random-generator;1"]
    .getService(Ci.nsIRandomGenerator)
    .generateRandomBytes(32)
  return Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

function getToken() {
  let token = Zotero.Prefs.get(`${prefPrefix}token`, true)
  if (!token) {
    token = randomToken()
    Zotero.Prefs.set(`${prefPrefix}token`, token, true)
  }
  return token
}

function addMenu(window) {
  const document = window.document
  const tools = document.getElementById("menu_ToolsPopup")
  if (!tools || document.getElementById(menuID)) return
  const menu = document.createXULElement("menu")
  menu.id = menuID
  menu.setAttribute("label", "Codeg Academic")
  const popup = document.createXULElement("menupopup")
  const copy = document.createXULElement("menuitem")
  copy.setAttribute("label", "Copy pairing token")
  copy.addEventListener("command", () => {
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(getToken())
    const port = Zotero.Prefs.get("httpServer.port") || 23119
    Services.prompt.alert(
      window,
      "Codeg Academic",
      `Pairing token copied. Paste it into Codeg Academic settings.\nLocal bridge port: ${port}`
    )
  })
  const reset = document.createXULElement("menuitem")
  reset.setAttribute("label", "Reset pairing token")
  reset.addEventListener("command", () => {
    if (
      !Services.prompt.confirm(
        window,
        "Codeg Academic",
        "Disconnect paired applications and generate a new token?"
      )
    )
      return
    Zotero.Prefs.set(`${prefPrefix}token`, randomToken(), true)
    Services.prompt.alert(
      window,
      "Codeg Academic",
      "Pairing token reset. Copy the new token to pair Codeg again."
    )
  })
  popup.append(copy, reset)
  menu.append(popup)
  tools.append(menu)
  menuWindows.add(window)
}

async function startup({ rootURI }) {
  await Zotero.initializationPromise
  // Zotero's own HTTP server binds to loopback. We add endpoints to its existing
  // listener instead of opening another socket or enabling browser CORS.
  bridgeScope = { Zotero }
  Services.scriptloader.loadSubScript(`${rootURI}bridge.js`, bridgeScope)
  let instanceID = Zotero.Prefs.get(`${prefPrefix}instanceID`, true)
  if (!instanceID) {
    instanceID = Services.uuid.generateUUID().toString().replace(/[{}]/g, "")
    Zotero.Prefs.set(`${prefPrefix}instanceID`, instanceID, true)
  }
  const bridge = bridgeScope.CodegBridge.createBridge(Zotero, {
    token: getToken,
    instanceID,
  })
  // Generate during startup so every endpoint immediately requires pairing.
  getToken()
  for (const route of bridgeScope.CodegBridge.routes) {
    const path = `/codeg/v1/${route}`
    function Endpoint() {}
    Endpoint.prototype = {
      supportedMethods: ["POST"],
      supportedDataTypes: ["application/json"],
      permitBookmarklet: false,
      init: async function (request) {
        return bridge.handle(route, request)
      },
    }
    Zotero.Server.Endpoints[path] = Endpoint
    registeredEndpoints.set(path, Endpoint)
  }
  for (const window of Zotero.getMainWindows()) addMenu(window)
}

function onMainWindowLoad({ window }) {
  addMenu(window)
}

function onMainWindowUnload({ window }) {
  window.document.getElementById(menuID)?.remove()
  menuWindows.delete(window)
}

function shutdown(_data, reason) {
  if (reason === APP_SHUTDOWN) return
  for (const [path, endpoint] of registeredEndpoints) {
    if (Zotero.Server.Endpoints[path] === endpoint)
      delete Zotero.Server.Endpoints[path]
  }
  registeredEndpoints.clear()
  for (const window of menuWindows)
    window.document.getElementById(menuID)?.remove()
  menuWindows.clear()
  bridgeScope = undefined
}

function install() {}
function uninstall() {}
