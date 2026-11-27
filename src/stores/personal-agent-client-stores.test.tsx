import { act, cleanup, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BackendClientProvider } from "@/contexts/backend-client-context"
import type { BackendClient, BackendKey } from "@/lib/backend/types"
import type { BotLive, PersonalAgentActivity, RosterEntry } from "@/lib/types"

import {
  useActivity,
  useRefreshActivity,
} from "./personal-agent-activity-store"
import {
  PERSONAL_AGENT_BOTS_EVENT,
  useReadRosterNow,
  useRoster,
} from "./personal-agent-roster-store"

const initialLive: BotLive = {
  bot_id: 7,
  work: "idle",
  attention: "none",
  needs: null,
  unread: 0,
  activity: null,
  activity_known: true,
  work_on_hand: [],
  awaiting: [],
  face: "idle",
  flash: null,
  connected: true,
  last_line: null,
  last_activity_at: null,
  updated_at: "2026-11-11T07:00:00Z",
  expires_at: null,
}

function entry(name: string): RosterEntry {
  return {
    id: 7,
    name,
    kind: "worker",
    uid: null,
    hidden: false,
    has_brain: true,
    legacy_assistant_id: null,
    created_at: initialLive.updated_at,
    avatar: { kind: "face", shape: "ring", color: "teal" },
    persona: "",
    persona_unwritten: true,
    roster: {
      sort_order: 0,
      pinned_at: null,
      section: null,
      hidden: false,
      muted: false,
      unread_mark: false,
      notify: true,
    },
    live: initialLive,
  }
}

function host(key: BackendKey, name: string, waiting: number) {
  const handlers = new Map<string, Set<(value: unknown) => void>>()
  const reconnect = new Set<() => void>()
  const bots = vi.fn(async (): Promise<RosterEntry[]> => [entry(name)])
  const activity = vi.fn<
    (bot?: number | null) => Promise<PersonalAgentActivity>
  >(async () => ({ waiting }) as PersonalAgentActivity)
  const client = {
    key,
    api: { personalAgentBots: bots, personalAgentActivity: activity },
    platform: {
      async subscribe(event: string, handler: (value: unknown) => void) {
        const listeners = handlers.get(event) ?? new Set()
        handlers.set(event, listeners)
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      onTransportReconnect(handler: () => void) {
        reconnect.add(handler)
        return () => reconnect.delete(handler)
      },
    },
  } as unknown as BackendClient
  return {
    client,
    bots,
    activity,
    handlers,
    reconnect,
    emit(event: string, value: unknown) {
      for (const handle of handlers.get(event) ?? []) handle(value)
    },
  }
}

function draw(client: BackendClient) {
  return renderHook(
    () => ({
      roster: useRoster(),
      activity: useActivity(7),
      refresh: useRefreshActivity(),
      readRoster: useReadRosterNow(),
    }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <BackendClientProvider client={client}>
          {children}
        </BackendClientProvider>
      ),
    }
  )
}

const settle = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("assistant stores by backend client", () => {
  it("isolates overlapping bot IDs, pushes and refresh actions", async () => {
    const a = host("remote:1", "A", 1)
    const b = host("remote:2", "B", 2)
    const one = draw(a.client)
    const two = draw(b.client)
    await settle()
    expect(one.result.current.roster?.[0]?.name).toBe("A")
    expect(two.result.current.roster?.[0]?.name).toBe("B")
    expect(one.result.current.activity?.waiting).toBe(1)
    expect(two.result.current.activity?.waiting).toBe(2)

    const live: BotLive = {
      ...initialLive,
      work: "busy",
      updated_at: "2026-11-11T08:00:00Z",
    }
    act(() => a.emit(PERSONAL_AGENT_BOTS_EVENT, { kind: "live", live }))
    await settle(500)
    expect(one.result.current.roster?.[0]?.live).toEqual(live)
    expect(two.result.current.roster?.[0]?.live).toEqual(initialLive)
    expect(a.activity).toHaveBeenCalledTimes(2)
    expect(b.activity).toHaveBeenCalledTimes(1)

    await act(two.result.current.readRoster)
    act(two.result.current.refresh)
    await settle(500)
    expect(a.bots).toHaveBeenCalledTimes(1)
    expect(b.bots).toHaveBeenCalledTimes(2)
    expect(b.activity).toHaveBeenLastCalledWith(7)

    one.unmount()
    expect(a.handlers.get(PERSONAL_AGENT_BOTS_EVENT)?.size).toBe(0)
    expect(b.handlers.get(PERSONAL_AGENT_BOTS_EVENT)?.size).toBe(2)
    act(() => {
      for (const reconnect of b.reconnect) reconnect()
    })
    await settle(500)
    expect(a.activity).toHaveBeenCalledTimes(2)
    expect(b.activity).toHaveBeenCalledTimes(3)
    expect(b.bots).toHaveBeenCalledTimes(3)
  })

  it("keeps a replacement client for the same host clear of late reads", async () => {
    const old = host("remote:1", "old", 1)
    const next = host("remote:1", "replacement", 2)
    let finish!: (entries: RosterEntry[]) => void
    old.bots.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const oldView = draw(old.client)
    await settle()
    oldView.unmount()
    const nextView = draw(next.client)
    await settle()
    await act(async () => finish([entry("late")]))
    expect(nextView.result.current.roster?.[0]?.name).toBe("replacement")
    expect(nextView.result.current.activity?.waiting).toBe(2)
  })
})
