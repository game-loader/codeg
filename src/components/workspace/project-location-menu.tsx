"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { FolderGit2, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ProjectSetup } from "@/lib/backend/project-catalog"
import type { BackendDescriptor } from "@/lib/backend/registry"
import type { CatalogRowActions } from "./project-session-list"

/** A project is an identity; every executable action selects a working copy. */
export function ProjectLocationMenu({
  setups,
  hosts,
  ...actions
}: CatalogRowActions & {
  setups: readonly ProjectSetup[]
  hosts: readonly BackendDescriptor[]
}) {
  const t = useTranslations("MultiHost")
  const [target, setTarget] = useState("")
  const locations = setups.flatMap((setup) =>
    [setup.folder, ...setup.children].map((folder) => ({
      setup,
      folder,
      key: JSON.stringify([
        setup.backendKey,
        setup.generation,
        folder.id,
        folder.path,
      ]),
      host: hosts.find((h) => h.key === setup.backendKey)!,
    }))
  )
  const selected =
    locations.find((l) => l.key === target) ??
    (locations.length === 1 ? locations[0] : undefined)
  const choose = (event: React.ChangeEvent<HTMLSelectElement>) =>
    setTarget(event.target.value)
  return (
    <div className="flex min-w-0 items-center gap-1 pb-1">
      <select
        className="min-w-0 flex-1 rounded border bg-sidebar px-1 py-1 text-xs"
        aria-label={t("executionLocation")}
        value={selected?.key ?? ""}
        onChange={choose}
      >
        <option value="" disabled>
          {t("chooseLocation")}
        </option>
        {locations.map(({ key, host, folder }) => (
          <option key={key} value={key}>
            {host.name} · {folder.git_branch ?? folder.name} · {folder.path}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1 text-xs"
        aria-label={t("newSession")}
        disabled={!selected}
        onClick={() => {
          if (selected)
            actions.onNewSession?.(
              selected.setup.backendKey,
              selected.folder,
              selected.setup.generation
            )
        }}
      >
        <Plus className="size-3.5" />
        {t("newSession")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("locationActions")}
            title={t("locationActions")}
            disabled={!selected}
          >
            <FolderGit2 className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        {selected && (
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>
              {selected.host.name} · {selected.folder.path}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() =>
                actions.onOpenFolder(
                  selected.setup.backendKey,
                  selected.folder,
                  selected.setup.generation
                )
              }
            >
              {t("openFolder")}
            </DropdownMenuItem>
            {(["files", "git", "terminal"] as const).map((tool) => (
              <DropdownMenuItem
                key={tool}
                onSelect={() =>
                  actions.onLocationTool?.(
                    selected.setup.backendKey,
                    selected.folder,
                    selected.setup.generation,
                    tool
                  )
                }
              >
                {t(tool)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                actions.onWorktrees(
                  selected.setup.backendKey,
                  selected.setup.folder,
                  selected.setup.generation
                )
              }
            >
              {t("manageWorktrees")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        )}
      </DropdownMenu>
    </div>
  )
}
