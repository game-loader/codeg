import { describe, expect, it } from "vitest"

import {
  dragCarriesFiles,
  dragMayCarryFiles,
  filePathsFromDataTransfer,
} from "./attachment-files"

/** Minimal DataTransfer stand-in — jsdom has no drag-data implementation. */
function dragData(init: {
  types?: string[]
  files?: File[]
  items?: Array<{ kind: string }>
  data?: Record<string, string>
}): DataTransfer {
  const throws = init.data === undefined
  return {
    types: init.types ?? [],
    files: init.files ?? [],
    items: init.items ?? [],
    getData: (type: string) => {
      if (throws) throw new Error("protected mode")
      return init.data?.[type] ?? ""
    },
  } as unknown as DataTransfer
}

describe("dragCarriesFiles", () => {
  it("accepts the standard Files type", () => {
    expect(dragCarriesFiles(dragData({ types: ["Files"] }))).toBe(true)
  })

  it("accepts a file list even when the source publishes no type", () => {
    expect(
      dragCarriesFiles(
        dragData({
          types: [],
          files: [new File(["x"], "photo.png", { type: "image/png" })],
        })
      )
    ).toBe(true)
  })

  it("accepts a file-kind item (Safari-style external drag)", () => {
    expect(
      dragCarriesFiles(dragData({ types: [], items: [{ kind: "file" }] }))
    ).toBe(true)
  })

  it("accepts WebKit's uri list for a Finder drag", () => {
    expect(dragCarriesFiles(dragData({ types: ["text/uri-list"] }))).toBe(true)
  })

  it("rejects a text-only drag", () => {
    expect(
      dragCarriesFiles(
        dragData({ types: ["text/plain"], items: [{ kind: "string" }] })
      )
    ).toBe(false)
  })

  it("rejects a link/markup drag that also publishes a uri list", () => {
    expect(
      dragCarriesFiles(dragData({ types: ["text/html", "text/uri-list"] }))
    ).toBe(false)
  })

  it("rejects a missing dataTransfer", () => {
    expect(dragCarriesFiles(null)).toBe(false)
  })
})

describe("dragMayCarryFiles", () => {
  it("treats a typeless hover as a possible file drag", () => {
    expect(dragMayCarryFiles(dragData({ types: [] }))).toBe(true)
  })

  it("still rejects a typed text drag", () => {
    expect(dragMayCarryFiles(dragData({ types: ["text/plain"] }))).toBe(false)
  })
})

describe("filePathsFromDataTransfer", () => {
  it("reads file URLs from the uri list, decoding escapes and dropping comments", () => {
    const data = dragData({
      types: ["Files", "text/uri-list"],
      data: {
        "text/uri-list":
          "# comment\r\nfile:///Users/me/My%20Notes/plan.md\r\n\r\nhttps://example.com/x",
      },
    })
    expect(filePathsFromDataTransfer(data)).toEqual([
      "/Users/me/My Notes/plan.md",
    ])
  })

  it("recovers Windows drive paths and UNC shares", () => {
    const data = dragData({
      types: ["text/uri-list"],
      data: {
        "text/uri-list":
          "file:///C:/Users/me/report.pdf\r\nfile://server/share/doc.txt",
      },
    })
    expect(filePathsFromDataTransfer(data)).toEqual([
      "C:/Users/me/report.pdf",
      "//server/share/doc.txt",
    ])
  })

  it("dedupes the uri list against the text/plain mirror", () => {
    const data = dragData({
      types: ["text/uri-list", "text/plain"],
      data: {
        "text/uri-list": "file:///tmp/a.txt",
        "text/plain": "file:///tmp/a.txt",
      },
    })
    expect(filePathsFromDataTransfer(data)).toEqual(["/tmp/a.txt"])
  })

  it("ignores plain-text drags and protected-mode reads", () => {
    expect(
      filePathsFromDataTransfer(
        dragData({ types: ["text/plain"], data: { "text/plain": "hello" } })
      )
    ).toEqual([])
    // No readable data (getData throws) — never let a drop handler blow up.
    expect(filePathsFromDataTransfer(dragData({ types: ["Files"] }))).toEqual(
      []
    )
  })
})
