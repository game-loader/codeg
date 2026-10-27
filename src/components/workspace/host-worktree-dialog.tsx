"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranch, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import type { BackendClient } from "@/lib/backend/types"
import {
  BackendWorktrees,
  WorktreeRegistrationError,
  WorktreeRemovalError,
  type HostGitWorktree,
} from "@/lib/backend/worktrees"
import { toErrorMessage } from "@/lib/app-error"
import type { FolderDetail } from "@/lib/types"

interface HostWorktreeDialogProps {
  client: BackendClient
  repository: FolderDetail
  open: boolean
  onOpenChange(open: boolean): void
  onRegistered(folder: FolderDetail): void
  onChanged(): void
}

/** The selected machine is a prop, fixed even if another pane gains focus. */
export function HostWorktreeDialog({
  client,
  repository,
  open,
  onOpenChange,
  onRegistered,
  onChanged,
}: HostWorktreeDialogProps) {
  const t = useTranslations("MultiHost")
  const service = useMemo(() => new BackendWorktrees(client), [client])
  const ref = useMemo(
    () => ({
      backendKey: client.key,
      folderId: repository.id,
      path: repository.path,
    }),
    [client.key, repository.id, repository.path]
  )
  const [worktrees, setWorktrees] = useState<HostGitWorktree[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [creating, setCreating] = useState(false)
  const [branchName, setBranchName] = useState("")
  const [base, setBase] = useState(repository.git_branch ?? "HEAD")
  const [path, setPath] = useState("")
  const [partial, setPartial] = useState<WorktreeRegistrationError | null>(null)
  const [removeTarget, setRemoveTarget] = useState<HostGitWorktree | null>(null)
  const [branchRecovery, setBranchRecovery] =
    useState<WorktreeRemovalError | null>(null)
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [force, setForce] = useState(false)

  useEffect(() => {
    if (!open) return
    let disposed = false
    setLoading(true)
    setError(null)
    service
      .list(ref)
      .then((list) => {
        if (!disposed) setWorktrees(list)
      })
      .catch((err: unknown) => {
        if (!disposed) setError(toErrorMessage(err))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [open, service, ref, reload])

  const refresh = () => {
    setReload((value) => value + 1)
    onChanged()
  }

  const register = async (worktreePath: string) => {
    setBusy(true)
    setError(null)
    try {
      const folder = await service.register(ref, worktreePath)
      setPartial(null)
      onRegistered(folder)
      refresh()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const finishBranch = async () => {
    if (!branchRecovery) return
    setBusy(true)
    setError(null)
    try {
      await service.finishBranchRemoval(
        branchRecovery.repository,
        branchRecovery.branchName,
        force
      )
      setBranchRecovery(null)
      refresh()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const folder = await service.create(ref, {
        branchName: branchName.trim(),
        worktreePath: path.trim(),
        base: base.trim(),
      })
      setCreating(false)
      setBranchName("")
      setPath("")
      onRegistered(folder)
      refresh()
    } catch (err) {
      if (err instanceof WorktreeRegistrationError) {
        setPartial(err)
        setCreating(false)
        refresh()
      } else {
        setError(toErrorMessage(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!removeTarget) return
    setBusy(true)
    setError(null)
    try {
      await service.remove(ref, removeTarget, { deleteBranch, force })
      setRemoveTarget(null)
      refresh()
    } catch (err) {
      if (err instanceof WorktreeRemovalError) {
        setBranchRecovery(err)
        setRemoveTarget(null)
      }
      setError(toErrorMessage(err))
      refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) onOpenChange(next)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t("worktrees")} · {client.name}
            </DialogTitle>
          </DialogHeader>
          <div
            className="truncate text-sm text-muted-foreground"
            title={repository.path}
          >
            {repository.name} · {repository.path}
          </div>
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          {partial && (
            <div className="rounded-md border p-3 text-sm">
              <p>{t("partialCreate")}</p>
              <p className="my-1 break-all text-muted-foreground">
                {partial.worktreePath}
              </p>
              <Button
                disabled={busy}
                size="sm"
                onClick={() => void register(partial.worktreePath)}
              >
                {t("retryRegistration")}
              </Button>
            </div>
          )}
          {branchRecovery && (
            <div className="rounded-md border p-3 text-sm">
              <p>{t("partialRemove", { branch: branchRecovery.branchName })}</p>
              <label className="my-2 flex items-center gap-2">
                <Checkbox
                  checked={force}
                  disabled={busy}
                  onCheckedChange={(checked) => setForce(checked === true)}
                />
                {t("forceBranchDelete")}
              </label>
              <Button
                disabled={busy}
                size="sm"
                onClick={() => void finishBranch()}
              >
                {t("retryBranchDelete")}
              </Button>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || partial !== null}
              onClick={() => setCreating(true)}
            >
              <Plus />
              {t("newWorktree")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || loading}
              onClick={refresh}
            >
              <RefreshCw />
              {t("refresh")}
            </Button>
          </div>
          {creating && (
            <form
              className="grid gap-3 rounded-md border p-3"
              onSubmit={(event) => {
                event.preventDefault()
                void create()
              }}
            >
              <Label htmlFor="host-wt-branch">{t("branch")}</Label>
              <Input
                id="host-wt-branch"
                value={branchName}
                disabled={busy}
                onChange={(event) => {
                  const next = event.target.value
                  setBranchName(next)
                  if (
                    !path ||
                    path ===
                      `${repository.path.replace(/[\\/]+$/, "")}-${branchName.replace(/[\\/]/g, "-")}`
                  ) {
                    setPath(
                      `${repository.path.replace(/[\\/]+$/, "")}-${next.replace(/[\\/]/g, "-")}`
                    )
                  }
                }}
                autoFocus
              />
              <Label htmlFor="host-wt-base">{t("base")}</Label>
              <Input
                id="host-wt-base"
                value={base}
                disabled={busy}
                onChange={(event) => setBase(event.target.value)}
              />
              <Label htmlFor="host-wt-path">{t("path")}</Label>
              <Input
                id="host-wt-path"
                value={path}
                disabled={busy}
                onChange={(event) => setPath(event.target.value)}
              />
              <Button
                type="submit"
                disabled={busy || !branchName.trim() || !path.trim()}
              >
                {busy && <Loader2 className="animate-spin" />}
                {t("create")}
              </Button>
            </form>
          )}
          <div className="max-h-80 overflow-y-auto rounded-md border">
            {loading && (
              <div className="flex justify-center p-4">
                <Loader2 className="animate-spin" />
              </div>
            )}
            {!loading && worktrees.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                {t("noWorktrees")}
              </p>
            )}
            {worktrees.map((worktree) => (
              <div
                key={worktree.path}
                className="flex items-center gap-2 border-b p-3 last:border-b-0"
              >
                <GitBranch className="size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    {worktree.branch ??
                      (worktree.bare ? t("bare") : t("detached"))}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={worktree.path}
                  >
                    {worktree.path}
                  </div>
                  <div className="flex gap-2 text-xs text-muted-foreground">
                    {worktree.is_main && <span>{t("main")}</span>}
                    {worktree.locked !== null && (
                      <span title={worktree.locked}>{t("locked")}</span>
                    )}
                    {worktree.prunable !== null && (
                      <span title={worktree.prunable}>{t("prunable")}</span>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || worktree.bare || worktree.prunable !== null}
                  onClick={() => {
                    if (worktree.is_main) onRegistered(repository)
                    else void register(worktree.path)
                  }}
                >
                  {t("open")}
                </Button>
                {!worktree.is_main && !worktree.bare && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("remove")}
                    disabled={busy}
                    onClick={() => {
                      setDeleteBranch(false)
                      setForce(false)
                      setRemoveTarget(worktree)
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setRemoveTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("removeConfirm", {
                path: removeTarget?.path ?? "",
                machine: client.name,
              })}
            </AlertDialogTitle>
          </AlertDialogHeader>
          {removeTarget?.branch && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={deleteBranch}
                disabled={busy}
                onCheckedChange={(checked) => setDeleteBranch(checked === true)}
              />
              {t("deleteBranch")}
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={force}
              disabled={busy}
              onCheckedChange={(checked) => setForce(checked === true)}
            />
            {t("forceRemove")}
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("close")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void remove()
              }}
            >
              {t("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
