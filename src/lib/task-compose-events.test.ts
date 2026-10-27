import { describe, expect, it } from "vitest"
import {
  consumePendingTaskDraft,
  requestCreateTaskFromText,
} from "./task-compose-events"

describe("task handoff ownership", () => {
  it("retains identical folder IDs independently until the initiating machine mounts its task page", () => {
    const a = { backendKey: "remote:1", text: "A", folderId: 1 }
    const b = { backendKey: "remote:2", text: "B", folderId: 1 }
    requestCreateTaskFromText(a)
    requestCreateTaskFromText(b)
    expect(consumePendingTaskDraft()).toBeNull()
    expect(consumePendingTaskDraft("remote:2")).toEqual(b)
    expect(consumePendingTaskDraft("remote:1")).toEqual(a)
    expect(consumePendingTaskDraft("remote:1")).toBeNull()
    requestCreateTaskFromText({ text: "Legacy", folderId: 1 })
    expect(consumePendingTaskDraft()).toEqual({ text: "Legacy", folderId: 1 })
  })
  it("does not consume a previous generation's parked task on the replacement server", () => {
    requestCreateTaskFromText({
      backendKey: "remote:1",
      backendScope: "old-generation",
      text: "old A",
      folderId: 1,
    })
    expect(consumePendingTaskDraft("new-generation")).toBeNull()
    expect(consumePendingTaskDraft("remote:1")).toBeNull()
    expect(consumePendingTaskDraft("old-generation")?.text).toBe("old A")
  })
})
