import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import type { BackendKey } from "./types"
import type { ProjectSetup } from "./project-catalog"
import type { SidebarSortMode } from "@/lib/sidebar-view-mode-storage"

export interface OwnedProjectSession {
  key: string
  backendKey: BackendKey
  generation: number
  folder: FolderDetail | null
  root: FolderDetail | null
  conversation: DbConversationSummary
}

export interface HistoryOptions {
  showCompleted: boolean
  showWorktrees: boolean
  sortMode: SidebarSortMode
}

export const DEFAULT_HISTORY_OPTIONS: HistoryOptions = {
  showCompleted: true,
  showWorktrees: true,
  sortMode: "updated",
}

export function ownedSession(
  backendKey: BackendKey,
  generation: number,
  folder: FolderDetail | null,
  root: FolderDetail | null,
  conversation: DbConversationSummary
): OwnedProjectSession {
  return {
    key: JSON.stringify([
      backendKey,
      generation,
      folder?.id ?? null,
      folder?.path ?? null,
      conversation.agent_type,
      conversation.id,
    ]),
    backendKey,
    generation,
    folder,
    root,
    conversation,
  }
}

export function sortOwnedSessions(
  sessions: readonly OwnedProjectSession[],
  options: HistoryOptions
): OwnedProjectSession[] {
  return sessions
    .filter(
      (row) =>
        options.showCompleted ||
        !!row.conversation.pinned_at ||
        row.conversation.status !== "completed"
    )
    .slice()
    .sort((a, b) => {
      const ap = a.conversation.pinned_at
      const bp = b.conversation.pinned_at
      if (!!ap !== !!bp) return ap ? -1 : 1
      const timeA = ap || a.conversation[`${options.sortMode}_at`]
      const timeB = bp || b.conversation[`${options.sortMode}_at`]
      return timeB.localeCompare(timeA) || a.key.localeCompare(b.key)
    })
}

/** Owner qualification happens before merging: numeric IDs never cross hosts. */
export function projectHistory(
  setups: readonly ProjectSetup[],
  catalogs: ReadonlyMap<
    BackendKey,
    {
      generation?: number
      conversations?: readonly DbConversationSummary[]
    }
  >,
  options: HistoryOptions = DEFAULT_HISTORY_OPTIONS
): OwnedProjectSession[] {
  const sessions = new Map<string, OwnedProjectSession>()
  for (const setup of setups) {
    const catalog = catalogs.get(setup.backendKey)
    if (
      !catalog ||
      (catalog.generation !== undefined &&
        catalog.generation !== setup.generation)
    )
      continue
    const folders = [setup.folder, ...setup.children]
    for (const conversation of catalog.conversations ?? []) {
      if (conversation.kind === "chat" || conversation.parent_id != null)
        continue
      const folder = folders.find((f) => f.id === conversation.folder_id)
      if (!folder) continue
      const row = ownedSession(
        setup.backendKey,
        setup.generation,
        folder,
        setup.folder,
        conversation
      )
      sessions.set(row.key, row)
    }
  }
  return sortOwnedSessions([...sessions.values()], options)
}
