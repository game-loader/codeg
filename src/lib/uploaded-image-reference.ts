import type { PromptInputBlock } from "./types"
import {
  tokenizeReferenceLinks,
  unwrapReferenceDestination,
} from "./reference-link"

// Draft restore folds this generated companion reference back into its image
// so deleting the thumbnail also removes its file reference. Explicit links stay.
export const UPLOADED_IMAGE_REFERENCE_DESCRIPTION =
  "Original image file on the agent host for file processing"

/** Keep original files discoverable after adapters consume the visual bytes.
 * Run during draft construction for consistent optimistic/history display, and
 * again at HTTP delivery for stored tasks or older drafts (idempotent). */
export function withUploadedImageReferences(
  blocks: PromptInputBlock[]
): PromptInputBlock[] {
  const linkedUris = new Set(
    blocks.flatMap((block) => {
      if (block.type === "resource_link") return [block.uri]
      if (block.type === "text") {
        return tokenizeReferenceLinks(block.text).flatMap((token) =>
          token.type === "link"
            ? [unwrapReferenceDestination(token.destination)]
            : []
        )
      }
      return []
    })
  )
  return blocks.flatMap((block): PromptInputBlock[] => {
    let uri: string
    let mimeType: string
    if (block.type === "image" && block.uri?.startsWith("file://")) {
      uri = block.uri
      mimeType = block.mime_type
    } else if (
      block.type === "resource" &&
      typeof block.blob === "string" &&
      block.mime_type?.startsWith("image/") &&
      block.uri.startsWith("file://")
    ) {
      uri = block.uri
      mimeType = block.mime_type
    } else {
      return [block]
    }
    if (linkedUris.has(uri)) return [block]
    linkedUris.add(uri)
    let name = uri.split(/[?#]/, 1)[0].split("/").pop() || "image"
    try {
      name = decodeURIComponent(name)
    } catch {
      // A malformed escape should not prevent sending the attachment.
    }
    return [
      block,
      {
        type: "resource_link",
        uri,
        name,
        mime_type: mimeType,
        description: UPLOADED_IMAGE_REFERENCE_DESCRIPTION,
      },
    ]
  })
}
