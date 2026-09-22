/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS entrypoint. */
const { test } = require("node:test")
const assert = require("node:assert/strict")
const vm = require("node:vm")
const fs = require("node:fs")
const path = require("node:path")
const root = path.resolve(__dirname, "..")

test("bootstrap requires a persisted pairing secret, preserves instance identity, and removes endpoints on disable", async () => {
  const prefs = new Map()
  const Zotero = {
    initializationPromise: Promise.resolve(),
    Prefs: {
      get: (key) => prefs.get(key),
      set: (key, value) => prefs.set(key, value),
    },
    Server: { Endpoints: {} },
    getMainWindows: () => [],
  }
  const context = vm.createContext({
    Zotero,
    APP_SHUTDOWN: 2,
    Components: {
      interfaces: { nsIRandomGenerator: {} },
      classes: {
        "@mozilla.org/security/random-generator;1": {
          getService: () => ({
            generateRandomBytes: (length) => new Uint8Array(length).fill(42),
          }),
        },
      },
    },
    Services: {
      uuid: { generateUUID: () => ({ toString: () => "{stable-instance}" }) },
      scriptloader: {
        loadSubScript: (url, scope) => {
          vm.runInNewContext(fs.readFileSync(url, "utf8"), scope)
        },
      },
    },
  })
  vm.runInContext(
    fs.readFileSync(path.join(root, "bootstrap.js"), "utf8"),
    context
  )
  await context.startup({ rootURI: `${root}/` })
  const endpoint = new Zotero.Server.Endpoints["/codeg/v1/health"]()
  assert.equal(
    (
      await endpoint.init({ headers: { Host: "localhost:23119" }, data: {} })
    )[0],
    403
  )
  const token = prefs.get("extensions.codegAcademicBridge.token")
  assert.equal(token.length, 64)
  const request = {
    headers: { Host: "localhost:23119", Authorization: `Bearer ${token}` },
    data: {},
  }
  assert.deepEqual(JSON.parse((await endpoint.init(request))[2]), {
    version: 1,
    instance_id: "stable-instance",
  })
  prefs.set("extensions.codegAcademicBridge.token", "b".repeat(64))
  assert.equal((await endpoint.init(request))[0], 403)
  context.shutdown({}, 1)
  assert.equal(Object.keys(Zotero.Server.Endpoints).length, 0)
  await context.startup({ rootURI: `${root}/` })
  request.headers.Authorization = `Bearer ${"b".repeat(64)}`
  const restarted = new Zotero.Server.Endpoints["/codeg/v1/health"]()
  assert.equal(
    JSON.parse((await restarted.init(request))[2]).instance_id,
    "stable-instance"
  )
})
