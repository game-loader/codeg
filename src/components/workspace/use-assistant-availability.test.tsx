import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { expect, it, vi } from "vitest"

import { BackendClientProvider } from "@/contexts/backend-client-context"
import type { BackendClient } from "@/lib/backend/types"
import { useAssistantAvailability } from "./use-assistant-availability"

function host(key: BackendClient["key"], initialVersion: string) {
  let version = initialVersion
  const call = vi.fn(async () => ({ version }))
  let ready: (() => void) | undefined
  const off = vi.fn()
  const client = {
    key,
    platform: {
      getTransport: () => ({ call }),
      onTransportReady: (listener: () => void) => {
        ready = listener
        return off
      },
    },
  } as unknown as BackendClient
  const view = renderHook(() => useAssistantAvailability(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <BackendClientProvider client={client}>{children}</BackendClientProvider>
    ),
  })
  return {
    view,
    call,
    off,
    connect: (next: string) => {
      version = next
      ready?.()
    },
  }
}

it("enables assistants only for the supported host and rechecks after reconnect", async () => {
  const old = host("remote:1", "0.48.1")
  const current = host("remote:2", "0.49.0")
  await waitFor(() => expect(current.view.result.current).toBe(true))
  expect(old.view.result.current).toBe(false)
  expect(old.call).toHaveBeenCalledTimes(1)
  await act(async () => old.connect("0.49.0"))
  expect(old.view.result.current).toBe(true)
  expect(current.call).toHaveBeenCalledTimes(1)
  await act(async () => old.connect("0.48.1"))
  expect(old.view.result.current).toBe(false)
  old.view.unmount()
  expect(old.off).toHaveBeenCalledTimes(1)
})
