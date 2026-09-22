import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import { MachineBrowser } from "./machine-browser"
import type { Machine, MachineSnapshot } from "@/lib/machines"

const api = vi.hoisted(() => ({ list: vi.fn(), probe: vi.fn() }))
vi.mock("@/lib/machines", async (original) => ({
  ...(await original<typeof import("@/lib/machines")>()),
  listMachines: api.list,
  probeMachine: api.probe,
}))
vi.mock("@/lib/transport", () => ({ getActiveRemoteConnectionId: () => null }))
const machine: Machine = {
  id: "n1",
  name: "lab-gpu",
  dns_name: "lab-gpu.ts.net",
  addresses: ["100.64.0.2"],
  os: "linux",
  online: true,
  last_seen: null,
  is_self: false,
}
const snapshot: MachineSnapshot = {
  machine,
  sampled_at: "2026-09-22T08:00:00Z",
  ssh_target: "lab-gpu.ts.net",
  metrics: { cpu: "AMD EPYC", memory_total: "64 GiB" },
}
function mount(onInsert = vi.fn()) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MachineBrowser onInsert={onInsert} />
    </NextIntlClientProvider>
  )
}
beforeEach(() => {
  localStorage.clear()
  api.list.mockReset().mockResolvedValue([machine])
  api.probe.mockReset().mockResolvedValue(snapshot)
})
afterEach(cleanup)

describe("machine browser", () => {
  it("searches discovery and probes only the selected machine before inserting context", async () => {
    const insert = vi.fn()
    mount(insert)
    await screen.findByText("lab-gpu")
    expect(api.probe).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "missing" },
    })
    expect(screen.queryByText("lab-gpu")).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "100.64" },
    })
    fireEvent.click(screen.getByRole("button", { name: /lab-gpu/ }))
    await screen.findByText("AMD EPYC")
    fireEvent.click(
      screen.getByRole("button", { name: "Insert into conversation" })
    )
    expect(insert).toHaveBeenCalledWith(expect.stringContaining("64 GiB"))
  })
  it("shows failed SSH separately and allows basic context with the failure", async () => {
    api.probe.mockRejectedValue(new Error("Permission denied"))
    const insert = vi.fn()
    mount(insert)
    fireEvent.click(await screen.findByRole("button", { name: /lab-gpu/ }))
    await screen.findByText("Permission denied")
    fireEvent.click(
      screen.getByRole("button", { name: "Insert into conversation" })
    )
    expect(insert).toHaveBeenCalledWith(
      expect.stringContaining("Permission denied")
    )
  })
  it("does not show an old machine's late probe in the newly selected machine", async () => {
    const other = { ...machine, id: "n2", name: "lab-cpu" }
    api.list.mockResolvedValue([machine, other])
    let resolve!: (value: MachineSnapshot) => void
    api.probe
      .mockImplementationOnce(
        () =>
          new Promise<MachineSnapshot>((r) => {
            resolve = r
          })
      )
      .mockResolvedValue({
        ...snapshot,
        machine: other,
        metrics: { cpu: "Intel Xeon" },
      })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: /lab-gpu/ }))
    await waitFor(() => expect(api.probe).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: /lab-cpu/ }))
    await screen.findByText("Intel Xeon")
    resolve(snapshot)
    await waitFor(() =>
      expect(screen.queryByText("AMD EPYC")).not.toBeInTheDocument()
    )
  })
})
