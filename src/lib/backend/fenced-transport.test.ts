import { expect, it, vi } from "vitest"
import { FencedTransport } from "./fenced-transport"

function setup() {
  let current = true
  const inner = {
    call: vi.fn().mockResolvedValue([]),
    subscribe: vi.fn().mockResolvedValue(() => {}),
    isDesktop: () => true,
  }
  const setStatus = vi.fn()
  const transport = new FencedTransport(inner, {
    generation: 1,
    isCurrent: () => current,
    setStatus,
  })
  return {
    inner,
    transport,
    setStatus,
    retire: () => {
      current = false
    },
  }
}

it.each(["network_error", "network"])(
  "preserves ordinary resource success and %s status behavior while isolating metadata",
  async (code) => {
    const { inner, transport, setStatus } = setup()
    await transport.call("get_folder", { id: 1 })
    expect(setStatus).toHaveBeenLastCalledWith("connected")
    const error = { code, message: "Remote request timed out" }
    inner.call.mockRejectedValueOnce(error)
    await expect(transport.call("get_folder", { id: 1 })).rejects.toBe(error)
    expect(setStatus).toHaveBeenLastCalledWith("offline")
    setStatus.mockClear()
    inner.call.mockRejectedValueOnce(error)
    await expect(
      transport.call("list_repository_project_identities", { folderIds: [1] })
    ).rejects.toBe(error)
    await transport.call("list_repository_project_identities", {
      folderIds: [1],
    })
    expect(setStatus).not.toHaveBeenCalled()
    transport.destroy()
  }
)

it.each(["get_folder", "list_repository_project_identities"])(
  "retains authentication fencing for %s",
  async (command) => {
    const { inner, transport, setStatus } = setup()
    const error = { code: "authentication_failed" }
    inner.call.mockRejectedValueOnce(error)
    await expect(transport.call(command)).rejects.toBe(error)
    expect(setStatus).toHaveBeenCalledTimes(1)
    expect(setStatus).toHaveBeenCalledWith("unauthorized")
    transport.destroy()
  }
)

it.each(["resolve", "reject"])(
  "drops a retired metadata %s before any status update",
  async (result) => {
    const { inner, transport, setStatus, retire } = setup()
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    inner.call.mockReturnValueOnce(
      new Promise((done, fail) => {
        resolve = done
        reject = fail
      })
    )
    const pending = transport.call("list_repository_project_identities")
    retire()
    if (result === "resolve") resolve([])
    else reject({ code: "authentication_failed" })
    await expect(pending).rejects.toMatchObject({ code: "backend_retired" })
    expect(setStatus).not.toHaveBeenCalled()
    transport.destroy()
  }
)
