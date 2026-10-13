"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Pin } from "lucide-react"
import { SidebarConversationCard } from "@/components/conversations/sidebar-conversation-card"
import { useSubsessionSync } from "@/hooks/use-subsession-sync"
import {
  ownedSession,
  type OwnedProjectSession,
} from "@/lib/backend/project-history"
import type { BackendRuntime } from "@/lib/backend/runtime"
import type { ConversationStatus, DbConversationSummary } from "@/lib/types"
import type { CatalogRowActions } from "./project-session-list"

export function OwnedSessionCard({
  runtime,
  session,
  hostName,
  isCurrent,
  actions,
  depth = 0,
}: {
  runtime: BackendRuntime
  session: OwnedProjectSession
  hostName: string
  isCurrent(session: OwnedProjectSession): boolean
  actions: CatalogRowActions
  depth?: number
}) {
  const t = useTranslations("MultiHost")
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tabs = runtime.stores.tabs((s) => s.tabs)
  const activeTabId = runtime.stores.tabs((s) => s.activeTabId)
  const conversation = session.conversation
  // A missing regular folder is unavailable, never an implicit chat destination.
  const current = () =>
    (session.folder != null || conversation.kind === "chat") &&
    isCurrent(session)
  const locationLabel = session.folder
    ? `${session.folder.id === session.root?.id ? t("rootLocation") : (session.folder.git_branch ?? t("worktreeLocation"))} · ${session.folder.path}`
    : t(conversation.kind === "chat" ? "folderlessChats" : "folderUnavailable")
  useEffect(() => {
    try {
      const ids: unknown = JSON.parse(
        runtime.stores.storage.read("workspace:unified-sidebar-expanded") ??
          "[]"
      )
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpanded(Array.isArray(ids) && ids.includes(conversation.id))
    } catch {
      /* Optional device preference. */
    }
  }, [runtime, conversation.id])
  const toggleExpanded = () => {
    const next = !expanded
    setExpanded(next)
    try {
      const saved: unknown = JSON.parse(
        runtime.stores.storage.read("workspace:unified-sidebar-expanded") ??
          "[]"
      )
      const ids = new Set<number>(
        Array.isArray(saved)
          ? saved.filter((id): id is number => typeof id === "number")
          : []
      )
      if (next) ids.add(conversation.id)
      else ids.delete(conversation.id)
      runtime.stores.storage.write(
        "workspace:unified-sidebar-expanded",
        JSON.stringify([...ids])
      )
    } catch {
      /* Optional device preference. */
    }
  }
  const tab = tabs.find(
    (tab) =>
      tab.conversationId === conversation.id &&
      tab.agentType === conversation.agent_type
  )
  const run = async (action: () => Promise<void> | undefined) => {
    if (!current()) return
    try {
      await action()
      setError(null)
    } catch (error) {
      if (current())
        setError(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div
      data-session-key={session.key}
      data-session-owner={session.backendKey}
      data-runtime-generation={session.generation}
      data-session-selected={tab?.id === activeTabId}
    >
      <SidebarConversationCard
        conversation={conversation}
        isSelected={tab?.id === activeTabId}
        isOpenInTab={!!tab}
        onSelect={() => {
          if (current())
            actions.onOpenConversation?.(
              session.backendKey,
              session.folder,
              conversation,
              session.generation
            )
        }}
        onDoubleClick={() => {
          if (current()) {
            actions.onOpenConversation?.(
              session.backendKey,
              session.folder,
              conversation,
              session.generation
            )
            const state = runtime.stores.tabs.getState()
            const tab = state.tabs.find(
              (tab) =>
                tab.conversationId === conversation.id &&
                tab.agentType === conversation.agent_type
            )
            if (tab) state.pinTab(tab.id)
          }
        }}
        onRename={(_, title) =>
          run(() =>
            runtime.getSnapshot()?.renameConversation?.(conversation, title)
          )
        }
        onDelete={() =>
          run(() => runtime.getSnapshot()?.deleteConversation?.(conversation))
        }
        onStatusChange={(_, status: ConversationStatus) =>
          run(() =>
            runtime.getSnapshot()?.statusConversation?.(conversation, status)
          )
        }
        onTogglePin={(_, pinned) => {
          void run(() =>
            runtime.getSnapshot()?.pinConversation?.(conversation, pinned)
          )
        }}
        onNewConversation={() => {
          if (current()) {
            if (session.folder)
              actions.onNewSession?.(
                session.backendKey,
                session.folder,
                session.generation
              )
            else runtime.getSnapshot()?.newChat?.(true)
          }
        }}
        depth={depth}
        hasChildren={conversation.child_count > 0}
        expanded={expanded}
        onToggleExpand={toggleExpanded}
      />
      <p
        className="flex items-center gap-1 pl-7 text-[0.625rem] text-muted-foreground"
        title={`${hostName} · ${locationLabel}`}
      >
        {conversation.pinned_at && (
          <Pin className="size-2.5 shrink-0" aria-label={t("pinned")} />
        )}
        <span className="truncate">
          {hostName} · {locationLabel}
        </span>
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {expanded && (
        <DelegationChildren
          runtime={runtime}
          session={session}
          hostName={hostName}
          isCurrent={isCurrent}
          actions={actions}
          depth={depth + 1}
        />
      )}
    </div>
  )
}

function DelegationChildren(props: Parameters<typeof OwnedSessionCard>[0]) {
  const t = useTranslations("Folder.sidebar")
  const hostT = useTranslations("MultiHost")
  const { runtime, session, isCurrent } = props
  const folders = runtime.stores.workspace((s) => s.allFolders)
  const [childrenByParent, setChildrenByParent] = useState<
    Map<number, DbConversationSummary[]>
  >(() => new Map([[session.conversation.id, []]]))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const deletedChildIdsRef = useRef(new Set<number>())
  useSubsessionSync({ setChildrenByParent, deletedChildIdsRef })
  const cacheMissing = !childrenByParent.has(session.conversation.id)
  useEffect(() => {
    let active = true
    void runtime.client.api
      .listChildConversations(session.conversation.id)
      .then((fetched) => {
        if (!active || !isCurrent(session)) return
        setChildrenByParent((previous) => {
          const merged = new Map(
            fetched
              .filter((c) => !deletedChildIdsRef.current.has(c.id))
              .map((c) => [c.id, c])
          )
          for (const child of previous.get(session.conversation.id) ?? [])
            merged.set(child.id, child)
          return new Map(previous).set(
            session.conversation.id,
            [...merged.values()].sort(
              (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id
            )
          )
        })
        setLoading(false)
        setError(false)
      })
      .catch(() => {
        if (active && isCurrent(session)) {
          setLoading(false)
          setError(true)
        }
      })
    return () => {
      active = false
    }
    // isCurrent is an imperative lifetime check; render closures must not restart a fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, session.conversation.id, retry, cacheMissing])
  return (
    <>
      {loading && (
        <p role="status" className="pl-7 text-xs text-muted-foreground">
          {t("loadingSubsessions")}
        </p>
      )}
      {error && (
        <button
          type="button"
          className="pl-7 text-xs"
          onClick={() => setRetry((value) => value + 1)}
        >
          {hostT("retry")}
        </button>
      )}
      {(childrenByParent.get(session.conversation.id) ?? []).map((child) => {
        const folder =
          folders.find((f) => f.id === child.folder_id && f.kind !== "chat") ??
          null
        let root = folder
        const visited = new Set<number>()
        while (root?.parent_id != null) {
          if (visited.has(root.id)) {
            root = null
            break
          }
          visited.add(root.id)
          root = folders.find((f) => f.id === root?.parent_id) ?? null
        }
        return (
          <OwnedSessionCard
            key={child.id}
            {...props}
            session={ownedSession(
              session.backendKey,
              session.generation,
              folder,
              root,
              child
            )}
          />
        )
      })}
    </>
  )
}
