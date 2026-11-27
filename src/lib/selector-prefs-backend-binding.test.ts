import { createElement, type ReactNode } from "react"
import { renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useAskDrawerStore } from "@/components/conversations/use-ask-drawer-store"
import { BackendStoresContext } from "@/contexts/backend-stores-selection-context"
import type { BackendStores } from "@/lib/backend/stores"
import {
  createBackendStoreStorage,
  defaultBackendStoreStorage,
} from "@/stores/backend-store-storage"

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

function mountDrawer(storage: BackendStores["storage"]) {
  return renderHook(useAskDrawerStore, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(
        BackendStoresContext.Provider,
        { value: { storage } as BackendStores },
        children
      ),
  }).result.current
}

it("connects and clears same-key Ask drawer picks on each remote host independently", () => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000001"
  )
  const a = createBackendStoreStorage("remote:1")
  const b = createBackendStoreStorage("remote:2")
  const standalone = defaultBackendStoreStorage.selectorPreferences
  standalone.saveConfigPreference("codex", "model", "standalone")
  const drawerA = mountDrawer(a)
  const drawerB = mountDrawer(b)

  for (const [storage, drawer, host] of [
    [a, drawerA, "a"],
    [b, drawerB, "b"],
  ] as const) {
    storage.selectorPreferences.saveConfigPreference(
      "codex",
      "model",
      `${host}-default`
    )
    storage.selectorPreferences.saveConfigPreference("codex", "effort", host)
    expect(
      drawer.getState().openNew({
        agentType: "codex",
        parentConversationId: 1,
        folderId: 1,
        workingDir: "/repo",
        initialSend: {
          draft: {
            blocks: [{ type: "text", text: "why?" }],
            displayText: "why?",
          },
          modeId: null,
        },
        configValues: { model: `${host}-picked` },
      })
    ).toBe(true)
  }

  const key = drawerA.getState().target!.contextKey
  expect(drawerB.getState().target?.contextKey).toBe(key)
  const readA = a.selectorPreferences.getSavedPrefsForConnect
  const readB = b.selectorPreferences.getSavedPrefsForConnect
  expect(readA("codex", key).configValues).toEqual({
    model: "a-picked",
    effort: "a",
  })
  expect(readB("codex", key).configValues).toEqual({
    model: "b-picked",
    effort: "b",
  })
  expect(standalone.getSavedPrefsForConnect("codex", key).configValues).toEqual(
    {
      model: "standalone",
    }
  )

  drawerA.getState().consumeInitialSend(key)
  expect(drawerA.getState().close()).toBe(true)
  expect(readA("codex", key).configValues).toEqual({
    model: "a-default",
    effort: "a",
  })
  expect(readB("codex", key).configValues?.model).toBe("b-picked")
  b.dispose()
  expect(readB("codex", key).configValues).toBeNull()
  expect(
    createBackendStoreStorage(
      "remote:2"
    ).selectorPreferences.getSavedPrefsForConnect("codex", key).configValues
  ).toEqual({ model: "b-default", effort: "b" })
})
