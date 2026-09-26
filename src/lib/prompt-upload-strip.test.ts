import { describe, expect, it } from "vitest"

import { stripUploadedImagePayloads } from "@/lib/api"
import type { PromptInputBlock } from "@/lib/types"
import { buildFileUri } from "@/lib/reference-link"

const UPLOADED_IMAGE: PromptInputBlock = {
  type: "image",
  data: "QkFTRTY0",
  mime_type: "image/png",
  uri: "file:///home/me/.codeg/uploads/ab/shot.png",
}

const PASTED_IMAGE_NO_URI: PromptInputBlock = {
  type: "image",
  data: "QkFTRTY0",
  mime_type: "image/png",
  uri: null,
}

const UPLOADED_IMAGE_RESOURCE: PromptInputBlock = {
  type: "resource",
  uri: "file:///home/me/.codeg/uploads/ab/pasted.png",
  mime_type: "image/png",
  text: null,
  blob: "QkFTRTY0",
}

const TEXT: PromptInputBlock = { type: "text", text: "hello" }

describe("stripUploadedImagePayloads", () => {
  it("strips inline data from an uploaded image block", () => {
    const out = stripUploadedImagePayloads([TEXT, UPLOADED_IMAGE], true)
    expect(out[0]).toEqual(TEXT)
    expect(out[1]).toEqual({ ...UPLOADED_IMAGE, data: "" })
  })

  it("strips the blob from an uploaded image-mime embedded resource", () => {
    const out = stripUploadedImagePayloads([UPLOADED_IMAGE_RESOURCE], true)
    expect(out[0]).toEqual({ ...UPLOADED_IMAGE_RESOURCE, blob: "" })
  })

  it("keeps a path-less pasted image inline (nothing to hydrate from)", () => {
    const out = stripUploadedImagePayloads([PASTED_IMAGE_NO_URI], true)
    expect(out[0]).toBe(PASTED_IMAGE_NO_URI)
  })

  it("keeps a clipboard:// synth-uri resource inline", () => {
    const block: PromptInputBlock = {
      type: "resource",
      uri: "clipboard://pasted-image-1",
      mime_type: "image/png",
      text: null,
      blob: "QkFTRTY0",
    }
    expect(stripUploadedImagePayloads([block], true)[0]).toBe(block)
  })

  it("does not touch a non-image resource blob", () => {
    const block: PromptInputBlock = {
      type: "resource",
      uri: "file:///home/me/.codeg/uploads/ab/data.bin",
      mime_type: "application/octet-stream",
      text: null,
      blob: "QkFTRTY0",
    }
    expect(stripUploadedImagePayloads([block], true)[0]).toBe(block)
  })

  it("passes everything through untouched when shouldStrip is false (desktop local)", () => {
    const blocks = [TEXT, UPLOADED_IMAGE, UPLOADED_IMAGE_RESOURCE]
    expect(stripUploadedImagePayloads(blocks, false)).toBe(blocks)
  })

  it("leaves an already-empty payload as-is (idempotent)", () => {
    const empty: PromptInputBlock = { ...UPLOADED_IMAGE, data: "" }
    const out = stripUploadedImagePayloads([empty], true)
    expect(out[0]).toBe(empty)
  })

  it("keeps four remote originals discoverable outside their visual payloads", () => {
    const images: PromptInputBlock[] = Array.from({ length: 4 }, (_, i) => ({
      ...UPLOADED_IMAGE,
      uri: buildFileUri("/srv/codeg/uploads/session/photo " + i + ".png"),
    }))
    const out = stripUploadedImagePayloads([TEXT, ...images], true)
    expect(out[0]).toBe(TEXT)
    for (let i = 0; i < 4; i++) {
      const uri = buildFileUri("/srv/codeg/uploads/session/photo " + i + ".png")
      expect(out[1 + i * 2]).toEqual({ ...images[i], data: "" })
      expect(out[2 + i * 2]).toMatchObject({
        type: "resource_link",
        uri,
        name: "photo " + i + ".png",
        mime_type: "image/png",
      })
    }
    expect(out).toHaveLength(9)
    expect(
      images.every((b) => b.type === "image" && b.data === "QkFTRTY0")
    ).toBe(true)
  })

  it("also supplies a file reference for embedded image resources", () => {
    expect(
      stripUploadedImagePayloads([UPLOADED_IMAGE_RESOURCE], true)[1]
    ).toMatchObject({
      type: "resource_link",
      uri: UPLOADED_IMAGE_RESOURCE.uri,
      name: "pasted.png",
      mime_type: "image/png",
    })
  })

  it("does not multiply references when task or queued blocks are sent again", () => {
    const once = stripUploadedImagePayloads([TEXT, UPLOADED_IMAGE], true)
    expect(once).toHaveLength(3)
    expect(stripUploadedImagePayloads(once, true)).toEqual(once)
  })

  it("reuses an original reference restored as an inline task-edit badge", () => {
    // Restoring a ResourceLink creates a file badge; re-saving serializes it
    // inside the text block. Repeated task edits must not grow more badges.
    const blocks: PromptInputBlock[] = [
      { type: "text", text: "Edit [shot.png](" + UPLOADED_IMAGE.uri + ")" },
      UPLOADED_IMAGE,
    ]
    expect(stripUploadedImagePayloads(blocks, true)).toEqual([
      blocks[0],
      { ...UPLOADED_IMAGE, data: "" },
    ])
  })

  it("reuses an existing ResourceLink even when it follows the image", () => {
    const link: PromptInputBlock = {
      type: "resource_link",
      uri: UPLOADED_IMAGE.uri!,
      name: "Original",
      mime_type: "image/png",
      description: null,
    }
    expect(stripUploadedImagePayloads([UPLOADED_IMAGE, link], true)).toEqual([
      { ...UPLOADED_IMAGE, data: "" },
      link,
    ])
  })

  it("preserves repeated visuals but emits only one original reference per uri", () => {
    const out = stripUploadedImagePayloads(
      [UPLOADED_IMAGE, UPLOADED_IMAGE],
      true
    )
    expect(out.filter((b) => b.type === "image")).toHaveLength(2)
    expect(out.filter((b) => b.type === "resource_link")).toHaveLength(1)
  })

  it("recovers file references for an already-stripped stored task", () => {
    const out = stripUploadedImagePayloads(
      [{ ...UPLOADED_IMAGE, data: "" }],
      true
    )
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({
      type: "resource_link",
      uri: UPLOADED_IMAGE.uri,
    })
  })

  it("preserves encoded server paths including Windows drives and Chinese names", () => {
    const uri = buildFileUri("D:/codeg/uploads/产品 #1.png")
    expect(
      stripUploadedImagePayloads([{ ...UPLOADED_IMAGE, uri }], true)[1]
    ).toMatchObject({
      type: "resource_link",
      uri,
      name: "产品 #1.png",
    })
  })

  it("does not invent file references for pathless or non-file images", () => {
    for (const uri of [
      null,
      "clipboard://shot.png",
      "https://example.com/shot.png",
    ]) {
      const block = { ...UPLOADED_IMAGE, uri }
      expect(stripUploadedImagePayloads([block], true)).toEqual([block])
    }
  })
})
