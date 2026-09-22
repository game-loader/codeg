import { describe, expect, it } from "vitest"
import { formatMachineContext, machineError, type Machine } from "./machines"

const machine: Machine = {
  id: "n1",
  name: "lab-gpu",
  dns_name: "lab-gpu.tail.ts.net",
  addresses: ["100.64.0.2"],
  os: "linux",
  online: true,
  last_seen: null,
  is_self: false,
}

describe("machine context", () => {
  it("includes connection details, telemetry and the actual sampling time", () => {
    const text = formatMachineContext(
      machine,
      {
        machine,
        sampled_at: "2026-09-22T08:00:00Z",
        ssh_target: "root@lab-gpu.tail.ts.net",
        metrics: {
          cpu: "AMD EPYC",
          memory_total: "64 GiB",
          gpu: "NVIDIA A100",
        },
      },
      null
    )
    expect(text).toContain("2026-09-22T08:00:00Z")
    expect(text).toContain("root@lab-gpu.tail.ts.net")
    expect(text).toContain("100.64.0.2")
    expect(text).toContain("NVIDIA A100")
    expect(text).toContain("64 GiB")
    // Tailnet SSH may use a custom port from ~/.ssh/config; it is not observed.
    expect(text).not.toContain('"ssh_port": 22')
  })
  it("marks failed probes explicitly without claiming hardware or SSH access", () => {
    const text = formatMachineContext(machine, null, "Permission denied")
    expect(text).toContain("Permission denied")
    expect(text).toContain('"metrics": null')
    expect(text).toContain('"ssh_target": null')
    expect(text).toContain("lab-gpu")
  })
})

it("shows the backend SSH diagnostic instead of dropping its error detail", () => {
  expect(
    machineError({
      code: "external_command_failed",
      message: "SSH machine probe failed",
      detail: "root@lab: Permission denied (publickey).",
    })
  ).toContain("Permission denied")
})

it("includes a custom SSH port but never serializes credential fields", () => {
  const manual = {
    ...machine,
    source: "manual" as const,
    ssh_port: 2222,
    ssh_user: "root",
    password: "do-not-share",
  }
  const text = formatMachineContext(manual, null, null)
  expect(text).toContain('"ssh_port": 2222')
  expect(text).toContain('"ssh_user": "root"')
  expect(text).not.toContain("do-not-share")
  expect(text).not.toContain('"password"')
})
