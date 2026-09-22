/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS entrypoint. */
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { createBridge, parseIdentifier } = require("../bridge.js")

const TOKEN = "a".repeat(64)
function fixture() {
  const records = []
  const collection = {
    id: 7,
    key: "COLL0001",
    name: "Papers",
    parentKey: false,
  }
  function item(key, fields = {}) {
    const value = {
      key,
      id: records.length + 1,
      libraryID: 1,
      version: 2,
      deleted: false,
      fields: { title: "Paper", DOI: "", url: "", extra: "", ...fields },
      collections: [],
      isRegularItem: () => true,
      getField(name) {
        return this.fields[name] || ""
      },
      getCreators: () => [{ firstName: "Ada", lastName: "Lovelace" }],
      getCollections() {
        return this.collections
      },
      addToCollection(id) {
        if (!this.collections.includes(id)) this.collections.push(id)
      },
      async saveTx() {},
      async getBestAttachment() {
        return this.attachment || false
      },
    }
    records.push(value)
    return value
  }
  const Z = {
    Libraries: {
      userLibraryID: 1,
      get: () => ({ waitForDataLoad: async () => {} }),
    },
    Collections: {
      getByLibrary: () => [collection],
      getByLibraryAndKey: (_, key) =>
        key === collection.key ? collection : false,
      get: (id) => (id === 7 ? collection : false),
    },
    Items: {
      getAll: async () => records,
      getByLibraryAndKey: (_, key) =>
        records.find((value) => value.key === key),
    },
    Translate: {
      Search: class {
        setIdentifier(value) {
          this.identifier = value
        }
        async getTranslators() {
          return [{ translatorID: "native" }]
        }
        setTranslator() {}
        async translate({ libraryID, collections }) {
          assert.equal(libraryID, 1)
          const value = item("NEW00001", {
            DOI: this.identifier.DOI || "",
            extra: this.identifier.arXiv
              ? `arXiv: ${this.identifier.arXiv}`
              : "",
          })
          value.collections = collections
          return [value]
        }
      },
    },
    Attachments: {
      importFromURL: async ({ url, parentItemID }) => {
        const parent = records.find((value) => value.id === parentItemID)
        parent.attachment = {
          key: "PDF00001",
          attachmentContentType: "application/pdf",
          getFilePathAsync: async () => "/zotero/storage/PDF00001/paper.pdf",
        }
        assert.match(url, /^https:\/\/arxiv\.org\/pdf\//)
        return parent.attachment
      },
    },
  }
  const bridge = createBridge(Z, { token: () => TOKEN, instanceID: "instance" })
  const request = (path, data = {}, headers = {}) =>
    bridge.handle(path, {
      headers: {
        Host: "127.0.0.1:23119",
        Authorization: `Bearer ${TOKEN}`,
        ...headers,
      },
      data,
    })
  return { records, item, Z, bridge, request }
}

test("normalizes DOI and arXiv identifiers, rejecting URLs to other hosts", () => {
  assert.deepEqual(parseIdentifier("https://doi.org/10.1000/ABC"), {
    DOI: "10.1000/abc",
  })
  assert.deepEqual(parseIdentifier("https://arxiv.org/abs/2401.12345v2"), {
    arXiv: "2401.12345v2",
  })
  assert.deepEqual(parseIdentifier("arXiv:hep-th/9901001"), {
    arXiv: "hep-th/9901001",
  })
  assert.throws(() => parseIdentifier("https://evil.invalid/paper.pdf"))
})

test("denies incorrect token, browser origins, and non-loopback hosts before reading library", async () => {
  const { request } = fixture()
  for (const headers of [
    { Authorization: "Bearer invalid" },
    { Origin: "https://evil.invalid" },
    { Host: "evil.invalid:23119" },
    { "Sec-Fetch-Site": "same-origin" },
  ])
    assert.equal((await request("library", {}, headers))[0], 403)
  assert.equal((await request("health"))[0], 200)
})

test("serializes only regular personal-library items and existing collections", async () => {
  const { item, request } = fixture()
  item("ITEM0001").collections = [7]
  item("ITEM0002").libraryID = 9
  item("ITEM0003").deleted = true
  const [status, , body] = await request("library")
  assert.equal(status, 200)
  const library = JSON.parse(body)
  assert.equal(library.library_id, 1)
  assert.deepEqual(library.collections, [
    { key: "COLL0001", name: "Papers", parent_key: null },
  ])
  assert.equal(library.items.length, 1)
  assert.deepEqual(library.items[0].collections, ["COLL0001"])
  assert.deepEqual(library.items[0].authors, ["Ada Lovelace"])
})

test("reuses existing DOI record and adds the requested collection without duplicates", async () => {
  const { item, request, records } = fixture()
  item("ITEM0001", { DOI: "10.1000/ABC" })
  for (let i = 0; i < 2; i++) {
    const [status, , body] = await request("import", {
      identifier: "10.1000/abc",
      collection_key: "COLL0001",
    })
    assert.equal(status, 200)
    assert.equal(JSON.parse(body).key, "ITEM0001")
  }
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].collections, [7])
})

test("serializes concurrent imports to avoid duplicate native items", async () => {
  const { request, records } = fixture()
  const responses = await Promise.all(
    Array.from({ length: 3 }, () =>
      request("import", {
        identifier: "10.1000/abc",
        collection_key: "COLL0001",
      })
    )
  )
  assert.ok(responses.every((response) => response[0] === 200))
  assert.equal(records.length, 1)
})

test("rejects missing collection before creating an item", async () => {
  const { request, records } = fixture()
  assert.equal(
    (
      await request("import", {
        identifier: "10.1000/abc",
        collection_key: "MISSING1",
      })
    )[0],
    404
  )
  assert.equal(records.length, 0)
})

test("reuses arXiv records across versions", async () => {
  const { item, request, records } = fixture()
  item("ITEM0001", { extra: "arXiv: 2401.12345v1" })
  assert.equal(
    (
      await request("import", {
        identifier: "2401.12345v2",
        collection_key: "COLL0001",
      })
    )[0],
    200
  )
  assert.equal(records.length, 1)
})

test("attachment imports accept only the declared arXiv PDF and reuse existing PDFs", async () => {
  const { item, request } = fixture()
  item("ITEM0001")
  const data = {
    item_key: "ITEM0001",
    arxiv_id: "2401.12345",
    pdf_url: "http://127.0.0.1/private",
  }
  assert.equal((await request("attach-arxiv", data))[0], 400)
  data.pdf_url = "https://arxiv.org/pdf/2401.12345"
  const first = await request("attach-arxiv", data)
  assert.equal(first[0], 200)
  assert.deepEqual(JSON.parse(first[2]), {
    attachment_key: "PDF00001",
    path: "/zotero/storage/PDF00001/paper.pdf",
    text: null,
  })
  assert.deepEqual(await request("attach-arxiv", data), first)
})

test("resolves unavailable synced PDFs through Zotero storage and never accepts caller paths", async () => {
  const { item, request, Z } = fixture()
  let downloaded = false
  item("ITEM0001").attachment = {
    key: "PDF00001",
    attachmentContentType: "application/pdf",
    isStoredFileAttachment: () => true,
    getFilePathAsync: async () => (downloaded ? "/zotero/paper.pdf" : false),
  }
  Z.Sync = {
    Runner: {
      downloadFile: async () => {
        downloaded = true
      },
    },
  }
  const result = await request("attachment", {
    item_key: "ITEM0001",
    path: "/etc/passwd",
  })
  assert.equal(result[0], 200)
  assert.equal(JSON.parse(result[2]).path, "/zotero/paper.pdf")
})

test("missing linked PDFs do not trigger Zotero storage downloads", async () => {
  const { item, request, Z } = fixture()
  item("ITEM0001").attachment = {
    key: "PDF00001",
    attachmentContentType: "application/pdf",
    isStoredFileAttachment: () => false,
    getFilePathAsync: async () => false,
  }
  Z.Sync = {
    Runner: {
      downloadFile: async () => {
        throw new Error("Not a stored file attachment")
      },
    },
  }
  const result = await request("attachment", { item_key: "ITEM0001" })
  assert.equal(result[0], 200)
  assert.deepEqual(JSON.parse(result[2]), {
    attachment_key: "PDF00001",
    path: null,
    text: null,
  })
})

test("library includes nested collections with their parent keys", async () => {
  const { request, Z } = fixture()
  Z.Collections.getByLibrary = (_libraryID, recursive = false) => {
    const top = { key: "COLL0001", name: "Papers", parentKey: false }
    const nested = { key: "COLL0002", name: "Nested", parentKey: "COLL0001" }
    return recursive ? [top, nested] : [top]
  }
  const response = await request("library")
  assert.equal(response[0], 200)
  assert.deepEqual(JSON.parse(response[2]).collections, [
    { key: "COLL0001", name: "Papers", parent_key: null },
    { key: "COLL0002", name: "Nested", parent_key: "COLL0001" },
  ])
})

test("returns bounded text through Zotero's native attachment text API", async () => {
  const { item, request } = fixture()
  item("ITEM0001").attachment = {
    key: "PDF00001",
    attachmentContentType: "application/pdf",
    getFilePathAsync: async () => "/zotero/paper.pdf",
    get attachmentText() {
      return Promise.resolve("Paper text ".repeat(200001))
    },
  }
  const response = await request("attachment", { item_key: "ITEM0001" })
  assert.equal(response[0], 200)
  const result = JSON.parse(response[2])
  assert.equal(result.text.length, 2000000)
  assert.ok(result.text.startsWith("Paper text "))
  assert.equal(result.path, "/zotero/paper.pdf")
})

test("failed Zotero text extraction preserves a valid PDF response", async () => {
  const { item, request } = fixture()
  item("ITEM0001").attachment = {
    key: "PDF00001",
    attachmentContentType: "application/pdf",
    getFilePathAsync: async () => "/zotero/paper.pdf",
    get attachmentText() {
      return Promise.reject(new Error("PDF extraction failed"))
    },
  }
  const response = await request("attachment", { item_key: "ITEM0001" })
  assert.equal(response[0], 200)
  assert.deepEqual(JSON.parse(response[2]), {
    attachment_key: "PDF00001",
    path: "/zotero/paper.pdf",
    text: null,
  })
})

test("waits for native library data before reading items and collections", async () => {
  const { request, Z, item, records } = fixture()
  item("ITEM0001")
  const loaded = new Set()
  Z.Libraries.get = () => ({
    waitForDataLoad: async (type) => {
      loaded.add(type)
    },
  })
  Z.Items.getAll = async () => {
    if (!loaded.has("item")) throw new Error("Item data not loaded")
    return records
  }
  const getCollections = Z.Collections.getByLibrary
  Z.Collections.getByLibrary = (...args) => {
    if (!loaded.has("collection")) throw new Error("Collections not loaded")
    return getCollections(...args)
  }
  const response = await request("library")
  assert.equal(response[0], 200)
  assert.equal(JSON.parse(response[2]).items[0].key, "ITEM0001")
  assert.equal(JSON.parse(response[2]).collections[0].key, "COLL0001")
})
