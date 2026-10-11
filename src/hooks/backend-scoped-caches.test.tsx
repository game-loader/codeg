import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { BackendClientProvider } from "@/contexts/backend-client-context"
import type { BackendClient } from "@/lib/backend/types"
import type {
  AcpAgentInfo,
  AgentSkillItem,
  ExpertInstallStatus,
  WorkspaceStateEvent,
} from "@/lib/types"
import { useAcpAgents } from "./use-acp-agents"
import { getWorkspaceStateStore } from "./use-workspace-state-store"
import {
  primeFeedbackEnabled,
  useFeedbackEnabled,
} from "./use-feedback-enabled"
import { invalidateAgentSkillsCache, useAgentSkills } from "./use-agent-skills"
import { useEnabledSkillIds } from "./use-enabled-skill-ids"

function machine(id: number) {
  const handlers = new Map<string, (event: unknown) => void>()
  const dispose = vi.fn()
  const snapshot = {
    root_path: "/same/repo",
    seq: 0,
    version: 1,
    full: true,
    tree_snapshot: [],
    git_snapshot: [],
    deltas: [],
    degraded: false,
    is_git_repo: true,
  }
  const api = {
    acpListAgents: vi
      .fn()
      .mockResolvedValue([
        { agent_type: "custom:same", name: `Machine ${id}`, sort_order: 0 },
      ] as AcpAgentInfo[]),
    acpListAgentSkills: vi.fn().mockResolvedValue({
      supported: true,
      skills: [{ name: `Skill ${id}` }] as AgentSkillItem[],
    }),
    getFeedbackSettings: vi.fn().mockResolvedValue({ enabled: id === 1 }),
    expertsListAllInstallStatuses: vi.fn().mockResolvedValue([
      {
        expertId: `expert-${id}`,
        agentType: "codex",
        state: "linked_to_codeg",
      },
    ] as ExpertInstallStatus[]),
    officecliSkillListAllInstallStatuses: vi.fn().mockResolvedValue([]),
    scienceListAllInstallStatuses: vi.fn().mockResolvedValue([]),
    startWorkspaceStateStream: vi.fn().mockResolvedValue(snapshot),
    stopWorkspaceStateStream: vi.fn().mockResolvedValue(undefined),
    getWorkspaceSnapshot: vi.fn().mockResolvedValue(snapshot),
  }
  const platform = {
    subscribe: vi.fn(
      async (event: string, handler: (event: unknown) => void) => {
        handlers.set(event, handler)
        return () => {
          handlers.delete(event)
          dispose(event)
        }
      }
    ),
    onTransportReconnect: vi.fn(() => () => {}),
  }
  const client = {
    key: `remote:${id}`,
    api,
    platform,
  } as unknown as BackendClient
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BackendClientProvider client={client}>{children}</BackendClientProvider>
  )
  return { api, platform, client, wrapper, handlers, dispose }
}

afterEach(() => vi.useRealTimers())

describe("backend scoped hook caches with identical resource identities", () => {
  it("shares agent subscriptions only within one fixed client and releases A without touching B", async () => {
    const a = machine(1),
      b = machine(2)
    const first = renderHook(useAcpAgents, { wrapper: a.wrapper })
    const second = renderHook(useAcpAgents, { wrapper: a.wrapper })
    const other = renderHook(useAcpAgents, { wrapper: b.wrapper })
    await waitFor(() => {
      expect(first.result.current.agents[0]?.name).toBe("Machine 1")
      expect(other.result.current.agents[0]?.name).toBe("Machine 2")
    })
    expect(a.api.acpListAgents).toHaveBeenCalledTimes(1)
    expect(b.api.acpListAgents).toHaveBeenCalledTimes(1)
    first.unmount()
    expect(a.dispose).not.toHaveBeenCalled()
    second.unmount()
    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(b.dispose).not.toHaveBeenCalled()
    await act(async () => b.handlers.get("app://acp-agents-updated")?.({}))
    expect(b.api.acpListAgents).toHaveBeenCalledTimes(2)
  })

  it("keeps watcher tokens, events and late snapshots independent for the same root path", async () => {
    vi.useFakeTimers()
    const a = machine(1),
      b = machine(2)
    const sa = getWorkspaceStateStore(
      "/same/repo",
      a.client.api,
      a.client.platform
    )
    const sb = getWorkspaceStateStore(
      "/same/repo",
      b.client.api,
      b.client.platform
    )
    expect(sa).not.toBe(sb)
    const ta = sa.acquire("paths"),
      tb = sb.acquire("paths")
    await vi.advanceTimersByTimeAsync(0)
    const event = {
      root_path: "/same/repo",
      seq: 1,
      version: 1,
      requires_resync: false,
      kind: "file_change",
      payload: [],
      changed_paths: ["a.ts"],
    } as WorkspaceStateEvent
    a.handlers.get("folder://workspace-state-event")?.(event)
    expect(sa.getSnapshot().seq).toBe(1)
    expect(sb.getSnapshot().seq).toBe(0)
    sa.release(ta)
    await vi.advanceTimersByTimeAsync(700)
    expect(a.api.stopWorkspaceStateStream).toHaveBeenCalledOnce()
    expect(b.api.stopWorkspaceStateStream).not.toHaveBeenCalled()
    sb.release(tb)
    await vi.advanceTimersByTimeAsync(121_000)
  })

  it("isolates feedback primes, broadcasts and subscription cleanup", async () => {
    const a = machine(1),
      b = machine(2)
    const first = renderHook(useFeedbackEnabled, { wrapper: a.wrapper })
    const other = renderHook(useFeedbackEnabled, { wrapper: b.wrapper })
    await waitFor(() => expect(first.result.current).toBe(true))
    expect(other.result.current).toBe(false)
    act(() => primeFeedbackEnabled(false, a.client.api))
    expect(first.result.current).toBe(false)
    act(() =>
      b.handlers.get("feedback-settings://changed")?.({ enabled: true })
    )
    expect(other.result.current).toBe(true)
    expect(first.result.current).toBe(false)
    first.unmount()
    expect(a.dispose).toHaveBeenCalledOnce()
    expect(b.dispose).not.toHaveBeenCalled()
  })

  it("does not share skill lists or invalidation for identical agent IDs and paths", async () => {
    const a = machine(1),
      b = machine(2)
    const first = renderHook(() => useAgentSkills("codex", "/same/repo"), {
      wrapper: a.wrapper,
    })
    const other = renderHook(() => useAgentSkills("codex", "/same/repo"), {
      wrapper: b.wrapper,
    })
    await waitFor(() => {
      expect(first.result.current[0]?.name).toBe("Skill 1")
      expect(other.result.current[0]?.name).toBe("Skill 2")
    })
    invalidateAgentSkillsCache("codex", a.client.api)
    const again = renderHook(() => useAgentSkills("codex", "/same/repo"), {
      wrapper: b.wrapper,
    })
    expect(again.result.current[0]?.name).toBe("Skill 2")
    expect(b.api.acpListAgentSkills).toHaveBeenCalledTimes(1)
  })

  it("keeps enabled skill snapshots separate while coalescing each client's focus refresh", async () => {
    const a = machine(1),
      b = machine(2)
    const first = renderHook(() => useEnabledSkillIds("codex"), {
      wrapper: a.wrapper,
    })
    renderHook(() => useEnabledSkillIds("codex"), { wrapper: a.wrapper })
    const other = renderHook(() => useEnabledSkillIds("codex"), {
      wrapper: b.wrapper,
    })
    await waitFor(() => {
      expect([...first.result.current.enabledIds]).toEqual(["expert-1"])
      expect([...other.result.current.enabledIds]).toEqual(["expert-2"])
    })
    await act(async () => window.dispatchEvent(new Event("focus")))
    expect(a.api.expertsListAllInstallStatuses).toHaveBeenCalledTimes(2)
    expect(b.api.expertsListAllInstallStatuses).toHaveBeenCalledTimes(2)
  })
})

import { getAgentLabel, setCustomAgentDisplay } from "@/lib/custom-agents"
import { rememberModelLabels, getModelLabels } from "@/lib/model-label-store"
import { useAgentDisplay } from "./use-agent-display"
import { useModelLabels } from "./use-model-labels"
import type { SessionConfigOptionInfo } from "@/lib/types"

it("keeps identical custom agent IDs and model IDs reactive within their provider", () => {
  const a = machine(1),
    b = machine(2)
  const useMetadata = () => ({
    display: useAgentDisplay(),
    model: useModelLabels("custom:same"),
  })
  const first = renderHook(useMetadata, { wrapper: a.wrapper })
  const other = renderHook(useMetadata, { wrapper: b.wrapper })
  const options = (name: string) =>
    [
      {
        id: "model",
        category: "model",
        kind: { type: "select", options: [{ value: "same-model", name }] },
      },
    ] as SessionConfigOptionInfo[]
  act(() => {
    setCustomAgentDisplay(
      [{ agentType: "custom:same", name: "Agent A" }],
      a.client.api
    )
    setCustomAgentDisplay(
      [{ agentType: "custom:same", name: "Agent B" }],
      b.client.api
    )
    rememberModelLabels(
      "custom:same",
      options("Model A"),
      a.client.api,
      "codeg:model-labels:backend:remote:1"
    )
    rememberModelLabels(
      "custom:same",
      options("Model B"),
      b.client.api,
      "codeg:model-labels:backend:remote:2"
    )
  })
  expect(first.result.current.display.getAgentLabel("custom:same")).toBe(
    "Agent A"
  )
  expect(other.result.current.display.getAgentLabel("custom:same")).toBe(
    "Agent B"
  )
  expect(first.result.current.model("same-model")).toBe("Model A")
  expect(other.result.current.model("same-model")).toBe("Model B")
  expect(getAgentLabel("custom:same", a.client.api)).toBe("Agent A")
  expect(getModelLabels("custom:same", b.client.api).get("same-model")).toBe(
    "Model B"
  )
  first.unmount()
  act(() =>
    setCustomAgentDisplay(
      [{ agentType: "custom:same", name: "Updated B" }],
      b.client.api
    )
  )
  expect(other.result.current.display.getAgentLabel("custom:same")).toBe(
    "Updated B"
  )
})

it("discards A's late agent scan when an identical-ID hook switches to B", async () => {
  const a = machine(1),
    b = machine(2)
  let resolve!: (agents: AcpAgentInfo[]) => void
  a.api.acpListAgents.mockImplementation(
    () =>
      new Promise<AcpAgentInfo[]>((r) => {
        resolve = r
      })
  )
  let selected = a.client
  const wrapper = ({ children }: { children: ReactNode }) => (
    <BackendClientProvider client={selected}>{children}</BackendClientProvider>
  )
  const hook = renderHook(useAcpAgents, { wrapper })
  await act(async () => Promise.resolve())
  selected = b.client
  hook.rerender()
  await waitFor(() =>
    expect(hook.result.current.agents[0]?.name).toBe("Machine 2")
  )
  await act(async () =>
    resolve([
      { agent_type: "custom:same", name: "Late A", sort_order: 0 },
    ] as AcpAgentInfo[])
  )
  expect(hook.result.current.agents[0]?.name).toBe("Machine 2")
  expect(a.dispose).toHaveBeenCalledOnce()
  expect(b.dispose).not.toHaveBeenCalled()
})

import { useBuiltInExperts } from "./use-built-in-experts"
import { useBuiltInScience } from "./use-built-in-science"
it("loads each machine's built-in skill catalogs once without sharing identical skill IDs", async () => {
  const a = machine(1),
    b = machine(2)
  const listA = [{ id: "same", name: "A" }]
  const listB = [{ id: "same", name: "B" }]
  Object.assign(a.api, {
    expertsList: vi.fn().mockResolvedValue(listA),
    scienceList: vi.fn().mockResolvedValue(listA),
  })
  Object.assign(b.api, {
    expertsList: vi.fn().mockResolvedValue(listB),
    scienceList: vi.fn().mockResolvedValue(listB),
  })
  const useCatalogs = () => ({
    experts: useBuiltInExperts(),
    science: useBuiltInScience(),
  })
  const first = renderHook(useCatalogs, { wrapper: a.wrapper })
  renderHook(useCatalogs, { wrapper: a.wrapper })
  const other = renderHook(useCatalogs, { wrapper: b.wrapper })
  await waitFor(() => {
    expect(first.result.current.experts).toEqual(listA)
    expect(first.result.current.science).toEqual(listA)
    expect(other.result.current.experts).toEqual(listB)
    expect(other.result.current.science).toEqual(listB)
  })
})
