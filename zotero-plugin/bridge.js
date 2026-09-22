/* global module */
// Loaded into a private bootstrap scope by Zotero, and directly by Node tests.
var CodegBridge = (() => {
  const routes = ["health", "library", "import", "attachment", "attach-arxiv"]
  const arxivPattern = /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]+\/\d{7})(?:v\d+)?$/i

  class BridgeError extends Error {
    constructor(status, message) {
      super(message)
      this.status = status
    }
  }

  function parseIdentifier(input) {
    if (typeof input !== "string" || input.length > 512) {
      throw new BridgeError(400, "Expected a DOI or arXiv identifier")
    }
    let value = input.trim()
    value = value.replace(/^https:\/\/(?:dx\.)?doi\.org\//i, "")
    value = value.replace(/^doi:\s*/i, "")
    if (/^10\.\d{4,9}\/\S+$/i.test(value)) {
      return { DOI: value.toLowerCase() }
    }
    value = value.replace(/^https:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "")
    value = value.replace(/^arxiv:\s*/i, "").replace(/\.pdf$/i, "")
    if (arxivPattern.test(value)) return { arXiv: value.toLowerCase() }
    throw new BridgeError(400, "Expected a DOI or arXiv identifier")
  }

  function sameToken(actual, expected) {
    if (!expected || expected.length < 32 || typeof actual !== "string")
      return false
    let mismatch = actual.length ^ expected.length
    for (let i = 0; i < expected.length; i++) {
      mismatch |= (actual.charCodeAt(i) || 0) ^ expected.charCodeAt(i)
    }
    return mismatch === 0
  }

  function validateRequest(request, token) {
    const headers = Object.fromEntries(
      Object.entries(request.headers || {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ])
    )
    if (
      headers.origin !== undefined ||
      headers["sec-fetch-site"] !== undefined
    ) {
      throw new BridgeError(403, "Browser requests are not supported")
    }
    if (
      !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(
        headers.host || ""
      )
    ) {
      throw new BridgeError(403, "A loopback host is required")
    }
    if (!sameToken(headers.authorization, `Bearer ${token || ""}`) || !token) {
      throw new BridgeError(403, "Pairing required")
    }
  }

  function createBridge(Zotero, options) {
    // Import and attachment operations must be serialized across requests. Otherwise
    // concurrent requests can both pass deduplication before either saves its item.
    let mutation = Promise.resolve()
    const libraryID = () => Zotero.Libraries.userLibraryID
    const field = (item, name) => item.getField(name) || ""

    function isPaper(item) {
      return (
        item &&
        item.libraryID === libraryID() &&
        !item.deleted &&
        item.isRegularItem()
      )
    }

    function serialize(item) {
      return {
        key: item.key,
        title: field(item, "title"),
        abstract_text: field(item, "abstractNote"),
        authors: item
          .getCreators()
          .map((creator) =>
            [creator.firstName, creator.lastName].filter(Boolean).join(" ")
          )
          .filter(Boolean),
        doi: field(item, "DOI") || null,
        url: field(item, "url") || null,
        extra: field(item, "extra"),
        collections: item
          .getCollections()
          .map((id) => Zotero.Collections.get(id)?.key)
          .filter(Boolean),
        version: item.version || 0,
      }
    }

    async function papers() {
      return (await Zotero.Items.getAll(libraryID(), true, false)).filter(
        isPaper
      )
    }

    async function getItem(key) {
      if (typeof key !== "string" || !/^[A-Z0-9]{8}$/.test(key)) {
        throw new BridgeError(400, "Invalid Zotero item key")
      }
      const item = await Zotero.Items.getByLibraryAndKey(libraryID(), key)
      if (!isPaper(item))
        throw new BridgeError(404, "Personal-library item not found")
      return item
    }

    function arxivID(item) {
      const extra = field(item, "extra").match(/(?:^|\n)arXiv:\s*([^\s]+)/i)
      const url = field(item, "url").match(
        /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+)/i
      )
      const value = extra?.[1] || url?.[1] || ""
      return value
        .replace(/\.pdf$/i, "")
        .replace(/v\d+$/i, "")
        .toLowerCase()
    }

    async function importItem(data) {
      const identifier = parseIdentifier(data.identifier)
      if (
        typeof data.collection_key !== "string" ||
        !/^[A-Z0-9]{8}$/.test(data.collection_key)
      ) {
        throw new BridgeError(400, "An existing collection key is required")
      }
      const collection = await Zotero.Collections.getByLibraryAndKey(
        libraryID(),
        data.collection_key
      )
      if (!collection || collection.deleted)
        throw new BridgeError(404, "Collection not found")
      const existing = (await papers()).find((item) =>
        identifier.DOI
          ? field(item, "DOI").trim().toLowerCase() === identifier.DOI
          : arxivID(item) === identifier.arXiv.replace(/v\d+$/, "")
      )
      if (existing) {
        existing.addToCollection(collection.id)
        await existing.saveTx()
        return serialize(existing)
      }
      const translate = new Zotero.Translate.Search()
      translate.setIdentifier(identifier)
      const translators = await translate.getTranslators()
      if (!translators.length)
        throw new BridgeError(422, "No Zotero translator found for identifier")
      translate.setTranslator(translators)
      const imported = await translate.translate({
        libraryID: libraryID(),
        collections: [collection.id],
        saveAttachments: true,
      })
      const item = imported.find(isPaper)
      if (!item)
        throw new BridgeError(422, "Zotero could not import this identifier")
      return serialize(item)
    }

    async function attachment(item) {
      const pdf = await item.getBestAttachment()
      if (!pdf || pdf.attachmentContentType !== "application/pdf") {
        return { attachment_key: null, path: null, text: null }
      }
      let path = await pdf.getFilePathAsync()
      if (
        !path &&
        pdf.isStoredFileAttachment() &&
        Zotero.Sync?.Runner?.downloadFile
      ) {
        await Zotero.Sync.Runner.downloadFile(pdf)
        path = await pdf.getFilePathAsync()
      }
      // Zotero resolves its own cache or extracts text through its PDF worker.
      // Keep extraction optional: a broken PDF must not hide a valid attachment.
      let text = null
      try {
        const content = await pdf.attachmentText
        if (typeof content === "string" && content.trim()) {
          text = content.slice(0, 2_000_000)
        }
      } catch (error) {
        Zotero.logError?.(error)
      }
      return { attachment_key: pdf.key, path: path || null, text }
    }

    async function attachArxiv(data) {
      const identifier = parseIdentifier(data.arxiv_id)
      if (!identifier.arXiv)
        throw new BridgeError(400, "Expected an arXiv identifier")
      const url = `https://arxiv.org/pdf/${identifier.arXiv}`
      if (data.pdf_url !== url && data.pdf_url !== `${url}.pdf`) {
        throw new BridgeError(400, "PDF URL must match the arXiv identifier")
      }
      const item = await getItem(data.item_key)
      const current = await attachment(item)
      if (current.path) return current
      // A known synced attachment may be temporarily unavailable: do not create a
      // second attachment that hides the sync problem.
      if (current.attachment_key) return current
      await Zotero.Attachments.importFromURL({
        url,
        parentItemID: item.id,
        contentType: "application/pdf",
        title: `arXiv ${identifier.arXiv}`,
      })
      return attachment(item)
    }

    async function dispatch(route, data) {
      if (route !== "health") {
        const library = Zotero.Libraries.get(libraryID())
        await library.waitForDataLoad("collection")
        await library.waitForDataLoad("item")
      }
      switch (route) {
        case "health":
          return { version: 1, instance_id: options.instanceID }
        case "library": {
          const collections = await Zotero.Collections.getByLibrary(
            libraryID(),
            true
          )
          return {
            library_id: libraryID(),
            instance_id: options.instanceID,
            collections: collections
              .filter((value) => !value.deleted)
              .map((value) => ({
                key: value.key,
                name: value.name,
                parent_key: value.parentKey || null,
              })),
            items: (await papers()).map(serialize),
          }
        }
        case "import":
          return importItem(data)
        case "attachment":
          return attachment(await getItem(data.item_key))
        case "attach-arxiv":
          return attachArxiv(data)
        default:
          throw new BridgeError(404, "Unknown endpoint")
      }
    }

    return {
      async handle(route, request) {
        try {
          validateRequest(request, options.token())
          if (!routes.includes(route))
            throw new BridgeError(404, "Unknown endpoint")
          const data = request.data || {}
          if (typeof data !== "object" || Array.isArray(data))
            throw new BridgeError(400, "Expected JSON object")
          let result
          if (
            route === "import" ||
            route === "attach-arxiv" ||
            route === "attachment"
          ) {
            const work = mutation.then(() => dispatch(route, data))
            mutation = work.catch(() => {})
            result = await work
          } else {
            result = await dispatch(route, data)
          }
          return [200, "application/json", JSON.stringify(result)]
        } catch (error) {
          if (!(error instanceof BridgeError)) Zotero.logError?.(error)
          return [
            error.status || 500,
            "application/json",
            JSON.stringify({
              error:
                error instanceof BridgeError
                  ? error.message
                  : "Zotero operation failed; see Zotero debug output",
            }),
          ]
        }
      },
    }
  }

  return { createBridge, parseIdentifier, routes }
})()

if (typeof module !== "undefined") module.exports = CodegBridge
