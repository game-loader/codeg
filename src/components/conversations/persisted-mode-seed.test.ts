/**
 * A persisted conversation must open in the mode its session resumed in, not
 * this device's last-used mode. The backend restores each session's own
 * selectors on resume (`session_selector_service`), possibly picked on another
 * device; a composer seeded with the local default would show that default and
 * then switch the conversation to it on the next send (`handleSend` diffs the
 * seeded mode against `modes.current_mode_id`).
 *
 * Both composers are too heavy to render here, so these source checks pin the
 * seed rule: drafts seed the saved mode, persisted conversations seed null.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const SEED =
  /useState<string \| null>\(\(\) =>\s+conversationId != null \? null : getSavedModeId\(agentType\)\s+\)/

describe("composer mode seed", () => {
  it.each([
    "src/components/conversations/conversation-detail-panel.tsx",
    "src/components/canvas/canvas-conversation-surface.tsx",
  ])("seeds the saved mode only for a new conversation in %s", (path) => {
    const source = readFileSync(resolve(process.cwd(), path), "utf8")
    expect(source).toMatch(SEED)
  })
})
