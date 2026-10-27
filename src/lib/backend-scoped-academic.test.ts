import { afterEach, expect, it, vi } from "vitest"
import { createBackendClient } from "@/lib/backend/client"
import { createBackendStoreStorage } from "@/stores/backend-store-storage"
import type { Transport } from "@/lib/transport"

afterEach(() => localStorage.clear())
it.each(["academic", "api"] as const)(
  "sends academic preferences through %s from each fixed backend for identical agent/model IDs",
  async (entry) => {
    const preferencesA = createBackendStoreStorage("remote:1")
    const preferencesB = createBackendStoreStorage("remote:2")
    preferencesA.selectorPreferences.saveConfigPreference(
      "codex",
      "model",
      "model-A"
    )
    preferencesB.selectorPreferences.saveConfigPreference(
      "codex",
      "model",
      "model-B"
    )
    const callA = vi.fn(async (command: string) =>
      command === "academic_settings_get" ? { agent_type: "codex" } : {}
    )
    const callB = vi.fn(async (command: string) =>
      command === "academic_settings_get" ? { agent_type: "codex" } : {}
    )
    const make = (id: number, call: typeof callA) =>
      createBackendClient({
        key: `remote:${id}`,
        name: `Machine ${id}`,
        remoteConnectionId: id,
        transport: { call } as unknown as Transport,
      })
    await Promise.all([
      make(1, callA)[entry].academicSelect("same-paper"),
      make(2, callB)[entry].academicSelect("same-paper"),
    ])
    expect(callA).toHaveBeenCalledWith(
      "academic_select",
      expect.objectContaining({
        agentPreferences: expect.objectContaining({
          config_values: { model: "model-A" },
        }),
      }),
      { timeoutMs: 190_000 }
    )
    expect(callB).toHaveBeenCalledWith(
      "academic_select",
      expect.objectContaining({
        agentPreferences: expect.objectContaining({
          config_values: { model: "model-B" },
        }),
      }),
      { timeoutMs: 190_000 }
    )
    preferencesA.dispose()
    preferencesB.dispose()
  }
)
