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

const api = vi.hoisted(() => ({
  list: vi.fn(),
  probe: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}))
vi.mock("@/lib/machines", async (original) => ({
  ...(await original<typeof import("@/lib/machines")>()),
  listMachines: api.list,
  probeMachine: api.probe,
  saveManualMachine: api.save,
  deleteManualMachine: api.remove,
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
  api.list
    .mockReset()
    .mockResolvedValue({ machines: [machine], discovery_error: null })
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
    api.list.mockResolvedValue({
      machines: [machine, other],
      discovery_error: null,
    })
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

describe("manual machine management", () => {
  const manual = {
    ...machine,
    id: "manual:gpu",
    name: "Rental GPU",
    source: "manual" as const,
    addresses: ["203.0.113.10"],
    dns_name: "",
    ssh_port: 2222,
    ssh_user: "root",
    online: null,
  }
  beforeEach(() => {
    api.list.mockResolvedValue({
      machines: [manual],
      discovery_error: "tailscale not installed",
    })
    api.save.mockReset().mockResolvedValue(manual)
    api.remove.mockReset().mockResolvedValue(undefined)
    api.probe.mockResolvedValue({
      ...snapshot,
      machine: manual,
      ssh_target: "root@203.0.113.10",
    })
  })
  it("adds a password machine even when Tailscale discovery fails", async () => {
    api.list.mockResolvedValueOnce({
      machines: [],
      discovery_error: "tailscale not installed",
    })
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Add machine" }))
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Rental GPU" },
    })
    fireEvent.change(screen.getByLabelText("IP address"), {
      target: { value: "203.0.113.10" },
    })
    fireEvent.change(screen.getByLabelText("SSH port"), {
      target: { value: "2222" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "temporary-secret" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save machine" }))
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith({
        id: null,
        name: "Rental GPU",
        host: "203.0.113.10",
        port: 2222,
        username: "root",
        password: "temporary-secret",
      })
    )
    await waitFor(() =>
      expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
    )
    expect(
      await screen.findByRole("button", { name: /Rental GPU/ })
    ).toBeInTheDocument()
    expect(JSON.stringify(localStorage)).not.toContain("temporary-secret")
  })
  it("probes a saved manual account and inserts its custom port into the draft", async () => {
    const insert = vi.fn()
    mount(insert)
    fireEvent.click(await screen.findByRole("button", { name: /Rental GPU/ }))
    await screen.findByText("AMD EPYC")
    expect(
      screen.getByRole("button", { name: /Rental GPU.*Reachable/ })
    ).toBeInTheDocument()
    expect(api.probe).toHaveBeenCalledWith("manual:gpu", "root")
    expect(screen.queryByLabelText("SSH user")).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", { name: "Insert into conversation" })
    )
    expect(insert).toHaveBeenCalledWith(
      expect.stringContaining('"ssh_port": 2222')
    )
    expect(insert).toHaveBeenCalledWith(
      expect.stringContaining('"ssh_user": "root"')
    )
    expect(insert.mock.calls[0][0]).not.toContain("password")
  })
  it("shows a failed manual probe in the machine list", async () => {
    api.probe.mockRejectedValue(new Error("Connection refused"))
    mount()
    fireEvent.click(await screen.findByRole("button", { name: /Rental GPU/ }))
    await screen.findByText("Connection refused")
    expect(
      screen.getByRole("button", { name: /Rental GPU.*Connection failed/ })
    ).toBeInTheDocument()
  })
  it("keeps a saved password when editing only the port", async () => {
    mount()
    fireEvent.click(await screen.findByRole("button", { name: /Rental GPU/ }))
    fireEvent.click(screen.getByRole("button", { name: "Edit machine" }))
    expect(screen.getByLabelText("Password")).toHaveValue("")
    fireEvent.change(screen.getByLabelText("SSH port"), {
      target: { value: "2200" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save machine" }))
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "manual:gpu",
          port: 2200,
          password: null,
        })
      )
    )
  })
  it("keeps a machine when removal fails and removes it after retry", async () => {
    api.remove.mockRejectedValueOnce(new Error("Credential store unavailable"))
    mount()
    fireEvent.click(await screen.findByRole("button", { name: /Rental GPU/ }))
    fireEvent.click(screen.getByRole("button", { name: "Remove machine" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    await screen.findByText("Credential store unavailable")
    api.list.mockResolvedValue({ machines: [], discovery_error: null })
    fireEvent.click(screen.getByRole("button", { name: "Remove" }))
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Rental GPU/ })
      ).not.toBeInTheDocument()
    )
    expect(api.remove).toHaveBeenLastCalledWith("manual:gpu")
  })
})
