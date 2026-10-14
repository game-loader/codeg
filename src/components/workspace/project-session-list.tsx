"use client"

import { useState, type ReactNode } from "react"
import {
  ownedSession,
  matchesOwnedTagFilter,
  DEFAULT_HISTORY_OPTIONS,
  type HistoryOptions,
  type OwnedProjectSession,
} from "@/lib/backend/project-history"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  Pin,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BackendKey } from "@/lib/backend/types"
import type { ProjectSetup } from "@/lib/backend/project-catalog"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import {
  compareByUpdatedAtDesc,
  compareByPinnedAtDesc,
} from "@/components/conversations/sidebar-conversation-grouping"

export interface CatalogRowActions {
  onOpenFolder(key: BackendKey, folder: FolderDetail, generation: number): void
  onNewSession?(key: BackendKey, folder: FolderDetail, generation: number): void
  onOpenConversation?(
    key: BackendKey,
    folder: FolderDetail | null,
    conversation: DbConversationSummary,
    generation: number
  ): void
  onWorktrees(key: BackendKey, folder: FolderDetail, generation: number): void
  onRetry?(key: BackendKey, generation: number): void
  renderSession?(
    session: OwnedProjectSession,
    options?: { showLocation?: boolean }
  ): ReactNode
  onLocationTool?(
    key: BackendKey,
    folder: FolderDetail,
    generation: number,
    tool: "files" | "git" | "terminal"
  ): void
}

interface SetupRowsProps extends CatalogRowActions {
  setup: ProjectSetup
  hostName: string
  conversations?: readonly DbConversationSummary[]
  historyLoading?: boolean
  historyError?: string | null
  options?: HistoryOptions
}

function FolderHistory({
  setup,
  folder,
  hostName,
  conversations = [],
  historyLoading,
  historyError,
  options = DEFAULT_HISTORY_OPTIONS,
  ...actions
}: SetupRowsProps & { folder: FolderDetail }) {
  const t = useTranslations("MultiHost")
  const [expanded, setExpanded] = useState(false)
  const [limit, setLimit] = useState(10)
  const worktree = folder !== setup.folder
  // Children remain in the advanced sidebar's delegation tree. Include all
  // root statuses and pinned sessions here, independent of opened tabs.
  const sessions = conversations
    .filter(
      (c) =>
        (c.folder_id === folder.id ||
          (!options.showWorktrees &&
            folder === setup.folder &&
            setup.children.some((f) => f.id === c.folder_id))) &&
        c.kind !== "chat" &&
        c.parent_id == null &&
        (options.showCompleted || !!c.pinned_at || c.status !== "completed") &&
        matchesOwnedTagFilter(
          setup.backendKey,
          setup.generation,
          c,
          options.tagFilter
        )
    )
    .sort((a, b) => {
      if (a.pinned_at && b.pinned_at) return compareByPinnedAtDesc(a, b)
      if (a.pinned_at) return -1
      if (b.pinned_at) return 1
      return options.sortMode === "updated"
        ? compareByUpdatedAtDesc(a, b)
        : b.created_at.localeCompare(a.created_at)
    })
  const label = worktree
    ? (folder.git_branch ?? folder.alias ?? folder.name)
    : (folder.alias ?? folder.name)
  return (
    <div
      className={worktree ? "ml-3 border-l pl-2" : "mb-1"}
      data-folder-id={folder.id}
    >
      <div className="flex items-center rounded-md hover:bg-sidebar-accent">
        <button
          type="button"
          className="p-1"
          aria-label={`${t("history")} · ${label}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
        </button>
        <button
          type="button"
          title={folder.path}
          className="min-w-0 flex-1 py-1.5 text-left text-sm"
          onClick={() => {
            setExpanded(true)
            actions.onOpenFolder(setup.backendKey, folder, setup.generation)
          }}
        >
          <span className="flex items-center gap-1.5">
            {worktree ? (
              <GitBranch className="size-3.5 shrink-0" />
            ) : (
              <FolderGit2 className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{label}</span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {hostName} · {folder.path}
          </span>
        </button>
        {!worktree && (
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            aria-label={`${t("manageWorktrees")} · ${folder.name}`}
            onClick={() =>
              actions.onWorktrees(setup.backendKey, folder, setup.generation)
            }
          >
            <GitBranch className="size-3.5" />
          </Button>
        )}
      </div>
      {expanded && (
        <div
          className="ml-5 pb-2"
          data-testid={`history-${setup.backendKey}-${folder.id}`}
        >
          <div className="flex items-center justify-between gap-1 py-1">
            <span className="text-xs text-muted-foreground">
              {t(worktree ? "worktreeSessions" : "rootSessions")}
            </span>
            {actions.onNewSession && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1 text-xs"
                aria-label={`${t("newSession")} · ${folder.name}`}
                onClick={() =>
                  actions.onNewSession?.(
                    setup.backendKey,
                    folder,
                    setup.generation
                  )
                }
              >
                {t("newSession")}
              </Button>
            )}
          </div>
          {historyLoading && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("historyLoading")}
            </p>
          )}
          {historyError && (
            <div role="alert" className="text-xs text-destructive">
              <p>{historyError}</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1 text-xs"
                onClick={() =>
                  actions.onRetry?.(setup.backendKey, setup.generation)
                }
              >
                {t("retry")}
              </Button>
            </div>
          )}
          {!historyLoading && !historyError && sessions.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("noSessions")}</p>
          )}
          {sessions.slice(0, limit).map((session) =>
            actions.renderSession ? (
              <div key={`${session.agent_type}:${session.id}`}>
                {actions.renderSession(
                  ownedSession(
                    setup.backendKey,
                    setup.generation,
                    [setup.folder, ...setup.children].find(
                      (f) => f.id === session.folder_id
                    ) ?? folder,
                    setup.folder,
                    session
                  )
                )}
              </div>
            ) : (
              <button
                key={`${session.folder_id}:${session.agent_type}:${session.id}`}
                type="button"
                className="flex w-full items-center gap-1 rounded px-1 py-1.5 text-left text-xs hover:bg-sidebar-accent"
                onClick={() =>
                  actions.onOpenConversation?.(
                    setup.backendKey,
                    folder,
                    session,
                    setup.generation
                  )
                }
              >
                {session.pinned_at && (
                  <Pin aria-label={t("pinned")} className="size-3 shrink-0" />
                )}
                <span className="truncate">
                  {session.title || t("untitledSession")}
                </span>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {session.agent_type}
                </span>
              </button>
            )
          )}
          {sessions.length > limit && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => setLimit((value) => value + 10)}
            >
              {t("showMore")}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function ProjectSetupRows(props: SetupRowsProps) {
  return (
    <div
      data-backend-key={props.setup.backendKey}
      data-runtime-generation={props.setup.generation}
    >
      <FolderHistory
        key={`${props.setup.folder.id}:${props.setup.folder.path}`}
        {...props}
        folder={props.setup.folder}
      />
      {(props.options?.showWorktrees === false ? [] : props.setup.children).map(
        (child) => (
          <FolderHistory
            key={`${child.id}:${child.path}`}
            {...props}
            folder={child}
          />
        )
      )}
    </div>
  )
}
