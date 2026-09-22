import { beforeEach, expect, it, vi } from "vitest"
import { academicLibrary, academicPrepare, academicSelect } from "./academic"
import {
  saveConfigPreference,
  saveModePreference,
} from "./selector-prefs-storage"

const { call, environment } = vi.hoisted(() => {
  const call = vi.fn()
  return { call, environment: { local: true, transport: { call } } }
})
vi.mock("./transport", () => ({ getTransport: () => environment.transport }))
vi.mock("./platform", () => ({ isLocalDesktop: () => environment.local }))
beforeEach(() => {
  environment.local = true
  environment.transport = { call }
  localStorage.clear()
  call.mockReset()
  call.mockImplementation(async (command: string) =>
    command === "academic_settings_get"
      ? { agent_type: "codex", bridge_port: 23119, paired: true }
      : { id: "paper-a" }
  )
})
it("snapshots the configured research agent's model and permission mode before selection", async () => {
  saveModePreference("codex", {
    current_mode_id: "read-only",
    available_modes: [],
  })
  saveConfigPreference("codex", "model", "research-model")
  saveConfigPreference("codex", "reasoning_effort", "high")
  await academicSelect("ITEMKEY")
  expect(call).toHaveBeenCalledWith(
    "academic_select",
    {
      itemKey: "ITEMKEY",
      agentPreferences: {
        agent_type: "codex",
        mode_id: "read-only",
        config_values: { model: "research-model", reasoning_effort: "high" },
      },
    },
    { timeoutMs: 190_000 }
  )
})
it("takes a fresh preference snapshot for an explicit retry", async () => {
  saveConfigPreference("codex", "model", "updated-model")
  await academicPrepare("paper-a", undefined, "https://github.com/lab/repo")
  expect(call).toHaveBeenCalledWith("academic_prepare", {
    paperId: "paper-a",
    arxivId: undefined,
    repoUrl: "https://github.com/lab/repo",
    agentPreferences: {
      agent_type: "codex",
      mode_id: null,
      config_values: { model: "updated-model" },
    },
  })
})
it("does not enqueue analysis if research settings cannot be read", async () => {
  call.mockRejectedValue(new Error("settings unavailable"))
  await expect(academicSelect("ITEMKEY")).rejects.toThrow(
    "settings unavailable"
  )
  expect(call).toHaveBeenCalledTimes(1)
  expect(call).toHaveBeenCalledWith("academic_settings_get", {})
})

it("loads the Zotero library through the active remote or web transport", async () => {
  environment.local = false
  call.mockResolvedValue({ items: [{ key: "REMOTE01" }], collections: [] })
  await expect(academicLibrary()).resolves.toMatchObject({
    items: [{ key: "REMOTE01" }],
  })
})
it("does not enqueue research in a different backend after reading settings", async () => {
  let finish!: (settings: unknown) => void
  call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = academicSelect("REMOTE01")
  const otherCall = vi.fn()
  environment.transport = { call: otherCall }
  finish({ agent_type: "codex", bridge_port: 23119, paired: true })
  await expect(pending).rejects.toThrow("Workspace changed")
  expect(otherCall).not.toHaveBeenCalled()
})
