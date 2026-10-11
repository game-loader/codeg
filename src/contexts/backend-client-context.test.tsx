import { useCallback } from "react"
import { act, render } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import {
  BackendClientProvider,
  useBackendApi,
  useBackendClient,
  useBackendPlatform,
} from "./backend-client-context"
import { createBackendClient } from "@/lib/backend/client"
import type { Transport } from "@/lib/transport"

function makeClient(id: number) {
  const call = vi.fn<Transport["call"]>(async () => undefined as never)
  const transport: Transport = {
    call: call as Transport["call"],
    subscribe: async () => () => {},
    isDesktop: () => false,
  }
  return {
    call,
    client: createBackendClient({
      key: `remote:${id}`,
      name: `Host ${id}`,
      transport,
      remoteConnectionId: id,
      token: "test",
      desktop: false,
    }),
  }
}

it("captures each provider's client, including callbacks retained across rerenders", async () => {
  const a = makeClient(1)
  const b = makeClient(2)
  const captures = new Map<string, () => Promise<unknown>>()
  function Probe({ slot }: { slot: string }) {
    const api = useBackendApi()
    const platform = useBackendPlatform()
    const client = useBackendClient()
    const open = useCallback(() => api.openFolder("/repo"), [api])
    captures.set(slot, open)
    expect(platform.getTransport()).toBe(client.transport)
    return <span>{client.name}</span>
  }
  const view = render(
    <>
      <BackendClientProvider client={a.client}>
        <Probe slot="left" />
      </BackendClientProvider>
      <BackendClientProvider client={b.client}>
        <Probe slot="right" />
      </BackendClientProvider>
    </>
  )
  const retained = captures.get("left")!
  await act(async () => {
    await Promise.all([retained(), captures.get("right")!()])
  })
  view.rerender(
    <BackendClientProvider client={b.client}>
      <Probe slot="left" />
    </BackendClientProvider>
  )
  await act(async () => {
    await retained()
    await captures.get("left")!()
  })
  expect(a.call).toHaveBeenCalledTimes(2)
  expect(b.call).toHaveBeenCalledTimes(2)
})
