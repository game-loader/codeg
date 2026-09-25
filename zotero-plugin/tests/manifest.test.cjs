/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS entrypoint. */
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const root = path.resolve(__dirname, "..")
const readJSON = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, name), "utf8"))

test("manifest declares every applications.zotero field Zotero 10 requires", () => {
  const { id, update_url, strict_max_version } =
    readJSON("manifest.json").applications.zotero
  // Zotero 10 reports the XPI as invalid when any of these is missing.
  assert.ok(id)
  assert.ok(strict_max_version)
  assert.equal(new URL(update_url).protocol, "https:")
})

test("update_url serves this plugin's update manifest from the repository", () => {
  const { id, update_url } = readJSON("manifest.json").applications.zotero
  assert.ok(update_url.endsWith("/zotero-plugin/updates.json"))
  assert.ok(Array.isArray(readJSON("updates.json").addons[id].updates))
})
