"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  FolderOpen,
  Link2,
  Link2Off,
  Loader2,
  MonitorCloud,
  MonitorDot,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { InputGroupButton } from "@/components/ui/input-group"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  DirectoryBrowser,
  normalizeFsPath,
  type DirectoryBrowserHandle,
} from "@/components/shared/directory-browser"
import {
  createFolderLinks,
  listFolderLinks,
  openFolder as openFolderOn,
  previewFolderLinks,
  removeFolderLink,
  renameFolderLink,
  repairFolderLink,
} from "@/lib/api"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { isDesktop, openFileDialog } from "@/lib/platform"
import { parentFsPath } from "@/lib/path-utils"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import type { CallTarget } from "@/lib/transport"
import { toErrorMessage } from "@/lib/app-error"
import { targetArgs } from "@/lib/call-target"
import {
  isBackendBindingChangedError,
  parseBackendKey,
  pinBackendClient,
  remoteBackendKey,
} from "@/lib/backend-client"
import type { BackendKey } from "@/lib/project-identity"
import {
  listRemoteWorkspaceConnections,
  openRemoteWorkspace,
} from "@/lib/remote-workspace"
import { requestProjectCatalogRefresh } from "@/hooks/use-project-catalog"
import {
  basenameOf,
  linkNameKey,
  partitionPlans,
  validateLinkName,
  type LinkNameIssue,
} from "@/lib/folder-links"
import type {
  FolderDetail,
  FolderLinkDetail,
  FolderLinkPlan,
  FolderLinkStatus,
  RemoteWorkspaceConnection,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

type View = "pick-root" | "links" | "add-targets"

/**
 * The machine a step works on, fixed when the step starts. `target` is
 * omitted for this machine, so its calls keep using the window's own backend
 * exactly as before; another machine gets a client pinned to the address its
 * connection had when it was picked (see `pinBackendClient`).
 */
interface MachineBinding {
  machine: BackendKey
  target?: CallTarget
}

const LOCAL_BINDING: MachineBinding = { machine: "local" }

/**
 * Binding for a picked machine, or null when its connection is no longer
 * saved. Null is not "fall back to this machine": callers refuse instead.
 */
function machineBinding(
  machine: BackendKey,
  connections: readonly RemoteWorkspaceConnection[]
): MachineBinding | null {
  const parsed = parseBackendKey(machine)
  if (parsed?.kind !== "remote") return LOCAL_BINDING
  const connection = connections.find((c) => c.id === parsed.connectionId)
  if (!connection) return null
  return {
    machine,
    target: pinBackendClient(machine, connection.base_url),
  }
}

interface WorkspaceFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Manage mode: skip root selection and edit this folder's links directly.
   * When absent the dialog starts at directory selection and opens the folder
   * before moving on.
   */
  folder?: FolderDetail | null
  /**
   * Called once the workspace folder has been opened (creation flow only),
   * and only for a folder on this window's own machine: another machine's
   * folder id means nothing to this window's callers.
   */
  onFolderOpened?: (folder: FolderDetail) => void
}

/**
 * The single entry point for adding a workspace folder.
 *
 * Step 1 picks the workspace root (the same in-app browser on desktop and web —
 * the native picker is offered as a shortcut, not as a separate code path), and
 * step 2 links any number of other directories in as subdirectories of that
 * root. Reopened from the folder menu, it starts at step 2 so links can be
 * renamed, repaired, or removed later.
 */
export function WorkspaceFolderDialog({
  open,
  onOpenChange,
  folder,
  onFolderOpened,
}: WorkspaceFolderDialogProps) {
  const t = useTranslations("Folder.workspaceDialog")
  const tBrowser = useTranslations("DirectoryBrowser")
  const tProjects = useTranslations("ProjectCatalog")
  const tRemote = useTranslations("RemoteWorkspace")
  const openFolder = useAppWorkspaceStore((s) => s.openFolder)

  const manageMode = !!folder
  const [view, setView] = useState<View>(manageMode ? "links" : "pick-root")
  const [rootFolder, setRootFolder] = useState<FolderDetail | null>(
    folder ?? null
  )
  const [rootPath, setRootPath] = useState("")
  const [browserBusy, setBrowserBusy] = useState(false)
  const [openingRoot, setOpeningRoot] = useState(false)
  const rootBrowserRef = useRef<DirectoryBrowserHandle>(null)

  // Link targets being picked in the "add" view.
  const [targetPath, setTargetPath] = useState("")
  const [pickedTargets, setPickedTargets] = useState<string[]>([])
  const [pending, setPending] = useState<PendingLink[]>([])
  const [skipped, setSkipped] = useState<FolderLinkPlan[]>([])
  const [previewing, setPreviewing] = useState(false)
  const [creating, setCreating] = useState(false)

  const [links, setLinks] = useState<FolderLinkDetail[]>([])
  const [loadingLinks, setLoadingLinks] = useState(false)
  const [gitExclude, setGitExclude] = useState(true)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [busyLinkId, setBusyLinkId] = useState<number | null>(null)

  // Which machine a new workspace is opened on, and the machine the opened
  // root lives on. The root and its machine move together: every link call
  // goes to `rootBinding`, never to whatever the picker shows by then.
  const [machine, setMachine] = useState<BackendKey>("local")
  const [connections, setConnections] = useState<RemoteWorkspaceConnection[]>(
    []
  )
  const [rootBinding, setRootBinding] = useState<MachineBinding>(LOCAL_BINDING)

  // Only this machine's desktop window can reach other saved machines: a web
  // page talks to the one server serving it, and a remote window's own
  // backend is already another machine.
  const localDesktopWindow =
    isDesktop() && getActiveRemoteConnectionId() === null
  const machinePickerEnabled = localDesktopWindow && !manageMode
  const pickBinding = useMemo(
    () => machineBinding(machine, connections),
    [machine, connections]
  )
  // The native picker only sees this computer's filesystem.
  const rootNativePickerAvailable =
    localDesktopWindow && pickBinding?.machine === "local"
  const targetNativePickerAvailable =
    localDesktopWindow && rootBinding.machine === "local"

  const linkBrowseStart = useMemo(
    () =>
      rootFolder ? (parentFsPath(rootFolder.path) ?? undefined) : undefined,
    [rootFolder]
  )

  // Reset to a clean session on every real open, so a dialog reopened after a
  // cancel never shows the previous run's picks.
  useEffect(() => {
    if (!open) return
    setView(folder ? "links" : "pick-root")
    setRootFolder(folder ?? null)
    setRootPath(folder?.path ?? "")
    setTargetPath("")
    setPickedTargets([])
    setPending([])
    setSkipped([])
    setLinks([])
    setRenamingId(null)
    setBusyLinkId(null)
    setOpeningRoot(false)
    setCreating(false)
    setPreviewing(false)
    setMachine("local")
    setRootBinding(LOCAL_BINDING)
  }, [open, folder])

  const loadConnections = useCallback(() => {
    return listRemoteWorkspaceConnections().then(
      (list) => {
        setConnections(list)
        // A machine whose connection is gone can't stay picked.
        setMachine((current) => {
          const parsed = parseBackendKey(current)
          return parsed?.kind === "remote" &&
            !list.some((c) => c.id === parsed.connectionId)
            ? "local"
            : current
        })
      },
      // No machine list just hides the picker: this machine still works.
      () => setConnections([])
    )
  }, [])

  useEffect(() => {
    if (!open || !machinePickerEnabled) return
    void loadConnections()
  }, [open, machinePickerEnabled, loadConnections])

  const machineName = useCallback(
    (key: BackendKey) => {
      if (key === "local") return tProjects("thisComputer")
      const parsed = parseBackendKey(key)
      const connection =
        parsed?.kind === "remote"
          ? connections.find((c) => c.id === parsed.connectionId)
          : undefined
      return connection?.name ?? key
    },
    [connections, tProjects]
  )

  // The connection behind a remote root now points at another server, or is
  // gone: none of its folder or link ids belong to whatever answers now, so
  // the flow starts over from the machine pick.
  const handleBindingChanged = useCallback(() => {
    toast.error(tProjects("bindingChanged"), {
      description: tProjects("bindingChangedDescription"),
    })
    setRootFolder(null)
    setRootBinding(LOCAL_BINDING)
    setRootPath("")
    setPending([])
    setSkipped([])
    setLinks([])
    setRenamingId(null)
    setMachine("local")
    setView("pick-root")
    void loadConnections()
  }, [tProjects, loadConnections])

  const reportError = useCallback(
    (title: string, err: unknown) => {
      if (isBackendBindingChangedError(err)) handleBindingChanged()
      else toast.error(title, { description: toErrorMessage(err) })
    },
    [handleBindingChanged]
  )

  const refreshLinks = useCallback(
    async (folderId: number, binding: MachineBinding) => {
      setLoadingLinks(true)
      try {
        setLinks(await listFolderLinks(folderId, ...targetArgs(binding.target)))
      } catch (err) {
        if (isBackendBindingChangedError(err)) handleBindingChanged()
        else console.error("[WorkspaceFolderDialog] failed to list links:", err)
      } finally {
        setLoadingLinks(false)
      }
    },
    [handleBindingChanged]
  )

  useEffect(() => {
    if (!open || !rootFolder) return
    void refreshLinks(rootFolder.id, rootBinding)
  }, [open, rootFolder, rootBinding, refreshLinks])

  // ── Step 1: workspace root ────────────────────────────────────────────────

  const commitRoot = useCallback(
    async (path: string) => {
      // Pinned to the machine whose browser picked the path, so a machine
      // switch while this is in flight can't move where the folder opens.
      const binding = pickBinding
      if (!binding) return
      setOpeningRoot(true)
      try {
        let detail: FolderDetail
        if (binding.machine === "local") {
          detail = await openFolder(path)
          onFolderOpened?.(detail)
        } else {
          // Another machine's folder stays out of this window's workspace
          // store: its ids belong to that machine's database. The sidebar
          // picks it up through the cross-machine catalog instead.
          detail = await openFolderOn(path, ...targetArgs(binding.target))
          requestProjectCatalogRefresh()
        }
        setRootFolder(detail)
        setRootBinding(binding)
        setView("links")
      } catch (err) {
        reportError(t("openFailed"), err)
      } finally {
        setOpeningRoot(false)
      }
    },
    [pickBinding, openFolder, onFolderOpened, reportError, t]
  )

  const handleConfirmRoot = useCallback(async () => {
    if (openingRoot || browserBusy || !pickBinding) return
    const selected = await rootBrowserRef.current?.confirm()
    if (selected) await commitRoot(selected)
  }, [openingRoot, browserBusy, pickBinding, commitRoot])

  // The picker fills the path box and stops there. It sits inside that box, so
  // it has to behave like typing into it — opening the folder outright would
  // skip the confirm step and land it in the sidebar before the user asked.
  const handleNativeRootPick = useCallback(async () => {
    const selected = await openFileDialog({ directory: true, multiple: false })
    if (!selected) return
    const path = Array.isArray(selected) ? selected[0] : selected
    if (path) setRootPath(path)
  }, [])

  // ── Step 2: link targets ──────────────────────────────────────────────────

  const toggleTarget = useCallback((path: string) => {
    const key = normalizeFsPath(path)
    setPickedTargets((prev) =>
      prev.some((p) => normalizeFsPath(p) === key)
        ? prev.filter((p) => normalizeFsPath(p) !== key)
        : [...prev, path]
    )
  }, [])

  const runPreview = useCallback(
    async (paths: string[]) => {
      if (!rootFolder || paths.length === 0) return
      setPreviewing(true)
      try {
        const plans = await previewFolderLinks(
          rootFolder.id,
          paths,
          ...targetArgs(rootBinding.target)
        )
        const { usable, skipped: rejected } = partitionPlans(plans)
        // Merge rather than replace: a second "add" round keeps what the user
        // already queued (and edited) instead of dropping it.
        setPending((prev) => {
          const seen = new Set(prev.map((p) => normalizeFsPath(p.targetPath)))
          const additions = usable
            .filter((plan) => !seen.has(normalizeFsPath(plan.targetPath)))
            .map<PendingLink>((plan) => ({
              targetPath: plan.targetPath,
              name: plan.name,
              baseName: plan.baseName,
              renamed: plan.renamed,
              collidesWithExistingEntry: plan.collidesWithExistingEntry,
            }))
          return [...prev, ...additions]
        })
        setSkipped(rejected)
        setView("links")
      } catch (err) {
        reportError(t("previewFailed"), err)
      } finally {
        setPreviewing(false)
      }
    },
    [rootFolder, rootBinding, reportError, t]
  )

  const handleAddPicked = useCallback(async () => {
    // With nothing ticked, fall back to whatever is in the path box — that's
    // the whole interaction for a typed path. Once anything IS ticked the box
    // only tracks the last row clicked, so honouring it too would re-add a
    // folder the user had just unticked.
    const typed = targetPath.trim()
    const all = pickedTargets.length > 0 ? pickedTargets : typed ? [typed] : []
    setPickedTargets([])
    await runPreview(all)
  }, [targetPath, pickedTargets, runPreview])

  // Same rule as the root picker: stage, don't commit. A multi-select lands in
  // the tick list (which is what "Add" reads) with the box tracking the last
  // one, exactly as if the rows had been clicked in the tree.
  const handleNativeTargetPick = useCallback(async () => {
    const selected = await openFileDialog({ directory: true, multiple: true })
    if (!selected) return
    const paths = (Array.isArray(selected) ? selected : [selected]).filter(
      Boolean
    )
    if (paths.length === 0) return
    setPickedTargets((prev) => {
      const seen = new Set(prev.map(normalizeFsPath))
      return [...prev, ...paths.filter((p) => !seen.has(normalizeFsPath(p)))]
    })
    setTargetPath(paths[paths.length - 1])
  }, [])

  // Names already spoken for, so an inline edit can be validated before saving.
  const takenNames = useMemo(
    () => new Set(links.map((l) => linkNameKey(l.name))),
    [links]
  )

  const pendingIssues = useMemo(() => {
    const issues = new Map<string, LinkNameIssue>()
    const seen = new Set(takenNames)
    for (const item of pending) {
      const issue = validateLinkName(item.name, seen)
      if (issue) issues.set(item.targetPath, issue)
      else seen.add(linkNameKey(item.name))
    }
    return issues
  }, [pending, takenNames])

  const handleCreate = useCallback(async () => {
    if (!rootFolder || pending.length === 0 || pendingIssues.size > 0) return
    setCreating(true)
    try {
      const created = await createFolderLinks(
        rootFolder.id,
        pending.map((item) => ({ path: item.targetPath, name: item.name })),
        gitExclude,
        ...targetArgs(rootBinding.target)
      )
      setPending([])
      setSkipped([])
      await refreshLinks(rootFolder.id, rootBinding)
      if (created.length < pending.length) {
        toast.warning(t("partiallyCreated", { count: created.length }))
      }
    } catch (err) {
      reportError(t("createFailed"), err)
    } finally {
      setCreating(false)
    }
  }, [
    rootFolder,
    rootBinding,
    pending,
    pendingIssues,
    gitExclude,
    refreshLinks,
    reportError,
    t,
  ])

  // ── Existing link actions ─────────────────────────────────────────────────

  const renameIssue = useMemo(() => {
    if (renamingId === null) return null
    const others = new Set(
      links.filter((l) => l.id !== renamingId).map((l) => linkNameKey(l.name))
    )
    return validateLinkName(renameValue, others)
  }, [renamingId, renameValue, links])

  const commitRename = useCallback(async () => {
    if (renamingId === null || renameIssue) return
    const id = renamingId
    setBusyLinkId(id)
    try {
      await renameFolderLink(
        id,
        renameValue.trim(),
        ...targetArgs(rootBinding.target)
      )
      setRenamingId(null)
      if (rootFolder) await refreshLinks(rootFolder.id, rootBinding)
    } catch (err) {
      reportError(t("renameFailed"), err)
    } finally {
      setBusyLinkId(null)
    }
  }, [
    renamingId,
    renameIssue,
    renameValue,
    rootFolder,
    rootBinding,
    refreshLinks,
    reportError,
    t,
  ])

  const handleRemove = useCallback(
    async (link: FolderLinkDetail) => {
      setBusyLinkId(link.id)
      try {
        await removeFolderLink(link.id, true, ...targetArgs(rootBinding.target))
        if (rootFolder) await refreshLinks(rootFolder.id, rootBinding)
      } catch (err) {
        reportError(t("removeFailed"), err)
      } finally {
        setBusyLinkId(null)
      }
    },
    [rootFolder, rootBinding, refreshLinks, reportError, t]
  )

  const handleRepair = useCallback(
    async (link: FolderLinkDetail) => {
      setBusyLinkId(link.id)
      try {
        await repairFolderLink(link.id, ...targetArgs(rootBinding.target))
        if (rootFolder) await refreshLinks(rootFolder.id, rootBinding)
      } catch (err) {
        reportError(t("repairFailed"), err)
      } finally {
        setBusyLinkId(null)
      }
    },
    [rootFolder, rootBinding, refreshLinks, reportError, t]
  )

  // A root on another machine is used from that machine's own window.
  const openRootMachine = useCallback(() => {
    const parsed = parseBackendKey(rootBinding.machine)
    if (parsed?.kind !== "remote") return
    openRemoteWorkspace(parsed.connectionId).catch((err) => {
      toast.error(tRemote("openFailed"), { description: toErrorMessage(err) })
    })
    onOpenChange(false)
  }, [rootBinding, onOpenChange, tRemote])

  // ── Render ────────────────────────────────────────────────────────────────

  const title =
    view === "add-targets"
      ? t("addTargetsTitle")
      : manageMode
        ? t("manageTitle")
        : t("title")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {view === "pick-root"
              ? t("pickRootDescription")
              : view === "add-targets"
                ? t("addTargetsDescription")
                : t("linksDescription")}
          </DialogDescription>
        </DialogHeader>

        {view === "pick-root" ? (
          <>
            {machinePickerEnabled && connections.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-xs font-medium text-muted-foreground">
                    {tProjects("machine")}
                  </span>
                  <Select
                    value={machine}
                    onValueChange={(value) => {
                      setMachine(value as BackendKey)
                      // The path box belongs to the machine being left.
                      setRootPath("")
                    }}
                    disabled={openingRoot || browserBusy}
                  >
                    <SelectTrigger
                      size="sm"
                      className="min-w-0 max-w-[18rem]"
                      aria-label={tProjects("machine")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">
                        {tProjects("thisComputer")}
                      </SelectItem>
                      {connections.map((c) => (
                        <SelectItem key={c.id} value={remoteBackendKey(c.id)}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {machine !== "local" ? (
                  <p className="text-xs text-muted-foreground">
                    {tProjects("remoteMachineHint", {
                      machine: machineName(machine),
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
            <DirectoryBrowser
              // One panel per machine: a switch remounts it, so no listing or
              // in-flight request from one machine reaches the other.
              key={machine}
              ref={rootBrowserRef}
              active={open && view === "pick-root"}
              value={rootPath}
              onValueChange={setRootPath}
              onQuickSelect={commitRoot}
              onBusyChange={setBrowserBusy}
              target={pickBinding?.target}
              // A new project often starts as an empty folder: make it here,
              // land in it, and "Next" opens it.
              allowCreateFolder
              pathInputAction={
                rootNativePickerAvailable ? (
                  <NativePickerButton
                    onPick={handleNativeRootPick}
                    disabled={openingRoot}
                  />
                ) : null
              }
            />
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => onOpenChange(false)}
              >
                {tBrowser("cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleConfirmRoot}
                disabled={
                  !rootPath.trim() || openingRoot || browserBusy || !pickBinding
                }
              >
                {openingRoot ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {t("next")}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {view === "add-targets" ? (
          <>
            <DirectoryBrowser
              key={rootBinding.machine}
              active={open && view === "add-targets"}
              // Link targets live on the root's machine, whatever the picker
              // shows by now.
              target={rootBinding.target}
              // Start beside the workspace, not inside it: anything under the
              // root is already reachable and gets rejected, while sibling
              // projects are what people actually link.
              initialPath={linkBrowseStart}
              value={targetPath}
              onValueChange={setTargetPath}
              multiple
              selectedPaths={pickedTargets}
              onToggleSelected={toggleTarget}
              pathInputAction={
                targetNativePickerAvailable ? (
                  <NativePickerButton
                    onPick={handleNativeTargetPick}
                    disabled={previewing}
                  />
                ) : null
              }
            />
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  setPickedTargets([])
                  setView("links")
                }}
              >
                <ArrowLeft className="size-4" />
                {t("back")}
              </Button>
              <Button
                type="button"
                onClick={handleAddPicked}
                disabled={
                  previewing ||
                  (pickedTargets.length === 0 && !targetPath.trim())
                }
              >
                {previewing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {pickedTargets.length > 1
                  ? t("addSelectedCount", { count: pickedTargets.length })
                  : t("addSelected")}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {view === "links" ? (
          <>
            <div className="flex min-h-0 flex-col gap-3">
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={rootFolder?.path}
                >
                  {rootFolder?.path ?? ""}
                </span>
                {rootBinding.machine !== "local" ? (
                  <span className="flex min-w-0 max-w-[40%] shrink items-center gap-1 text-xs text-muted-foreground">
                    <MonitorCloud aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {machineName(rootBinding.machine)}
                    </span>
                  </span>
                ) : null}
                {!manageMode ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => setView("pick-root")}
                  >
                    {t("change")}
                  </Button>
                ) : null}
              </div>

              <ScrollArea className="min-h-0 flex-1 rounded-md border">
                <div className="divide-y">
                  {loadingLinks &&
                  links.length === 0 &&
                  pending.length === 0 ? (
                    <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" />
                      {tBrowser("loading")}
                    </div>
                  ) : null}

                  {links.map((link) => (
                    <LinkRow
                      key={link.id}
                      link={link}
                      busy={busyLinkId === link.id}
                      editing={renamingId === link.id}
                      renameValue={renameValue}
                      renameIssue={renameIssue}
                      onRenameChange={setRenameValue}
                      onStartRename={() => {
                        setRenamingId(link.id)
                        setRenameValue(link.name)
                      }}
                      onCancelRename={() => setRenamingId(null)}
                      onCommitRename={commitRename}
                      onRemove={() => handleRemove(link)}
                      onRepair={() => handleRepair(link)}
                    />
                  ))}

                  {pending.map((item, index) => (
                    <PendingRow
                      key={item.targetPath}
                      item={item}
                      issue={pendingIssues.get(item.targetPath) ?? null}
                      onNameChange={(name) =>
                        setPending((prev) =>
                          prev.map((p, i) => (i === index ? { ...p, name } : p))
                        )
                      }
                      onRemove={() =>
                        setPending((prev) => prev.filter((_, i) => i !== index))
                      }
                    />
                  ))}

                  {skipped.map((plan) => (
                    <div
                      key={plan.targetPath}
                      className="flex items-start gap-2 px-3 py-2 text-xs text-muted-foreground"
                    >
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                      <div className="min-w-0">
                        <div className="truncate font-mono">
                          {plan.targetPath}
                        </div>
                        <div>
                          {plan.rejection === "already_linked" &&
                          plan.existingLinkName
                            ? t("rejection.alreadyLinkedAs", {
                                name: plan.existingLinkName,
                              })
                            : t(`rejection.${plan.rejection ?? "not_found"}`)}
                        </div>
                      </div>
                    </div>
                  ))}

                  {!loadingLinks &&
                  links.length === 0 &&
                  pending.length === 0 &&
                  skipped.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">
                      {t("noLinks")}
                    </div>
                  ) : null}
                </div>
              </ScrollArea>

              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setPickedTargets([])
                    setTargetPath("")
                    setView("add-targets")
                  }}
                >
                  <Plus className="size-4" />
                  {t("addFolders")}
                </Button>
                {pending.length > 0 ? (
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={gitExclude}
                      onCheckedChange={(v) => setGitExclude(v === true)}
                    />
                    {t("gitExclude")}
                  </label>
                ) : null}
              </div>
            </div>

            <DialogFooter>
              {pending.length > 0 ? (
                <>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => {
                      setPending([])
                      setSkipped([])
                    }}
                  >
                    {t("discardPending")}
                  </Button>
                  <Button
                    type="button"
                    onClick={handleCreate}
                    disabled={creating || pendingIssues.size > 0}
                  >
                    {creating ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    {t("createCount", { count: pending.length })}
                  </Button>
                </>
              ) : (
                <>
                  {rootBinding.machine !== "local" ? (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={openRootMachine}
                    >
                      <MonitorCloud className="size-4" />
                      {tProjects("openMachineWindow", {
                        machine: machineName(rootBinding.machine),
                      })}
                    </Button>
                  ) : null}
                  <Button type="button" onClick={() => onOpenChange(false)}>
                    {t("done")}
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Native-picker shortcut that lives at the trailing edge of the path box.
 * Icon-only — the label moves into a tooltip, so the affordance sits next to
 * the thing it fills in instead of competing with the footer's real actions.
 */
function NativePickerButton({
  onPick,
  disabled,
}: {
  onPick: () => void
  disabled: boolean
}) {
  const t = useTranslations("Folder.workspaceDialog")

  return (
    // The app mounts no global tooltip provider — each surface brings its own,
    // and Radix throws without one.
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            type="button"
            onClick={onPick}
            disabled={disabled}
            aria-label={t("useSystemPicker")}
          >
            <MonitorDot className="size-3.5" />
          </InputGroupButton>
        </TooltipTrigger>
        <TooltipContent>{t("useSystemPicker")}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

interface PendingLink {
  targetPath: string
  name: string
  baseName: string
  renamed: boolean
  collidesWithExistingEntry: boolean
}

function statusTone(status: FolderLinkStatus) {
  switch (status) {
    case "ok":
      return "text-muted-foreground"
    case "missing":
    case "broken":
      return "text-amber-500"
    case "conflicted":
      return "text-destructive"
  }
}

function LinkRow({
  link,
  busy,
  editing,
  renameValue,
  renameIssue,
  onRenameChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onRemove,
  onRepair,
}: {
  link: FolderLinkDetail
  busy: boolean
  editing: boolean
  renameValue: string
  renameIssue: LinkNameIssue | null
  onRenameChange: (value: string) => void
  onStartRename: () => void
  onCancelRename: () => void
  onCommitRename: () => void
  onRemove: () => void
  onRepair: () => void
}) {
  const t = useTranslations("Folder.workspaceDialog")
  const ime = useImeGuard()

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Link2
        className={cn("size-4 shrink-0", statusTone(link.status))}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1">
            <Input
              value={renameValue}
              onChange={(e) => onRenameChange(e.target.value)}
              {...ime.props}
              onKeyDown={(e) => {
                if (ime.isComposing(e)) return
                if (e.key === "Enter") onCommitRename()
                if (e.key === "Escape") onCancelRename()
              }}
              className={cn(
                "h-7 text-sm",
                renameIssue && "border-destructive focus-visible:ring-0"
              )}
              autoFocus
            />
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              type="button"
              onClick={onCommitRename}
              disabled={!!renameIssue || busy}
              title={t("saveName")}
            >
              <Check className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              type="button"
              onClick={onCancelRename}
              title={t("cancelRename")}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <div className="truncate text-sm font-medium">{link.name}</div>
        )}
        {editing && renameIssue ? (
          <div className="mt-0.5 text-xs text-destructive">
            {t(`nameIssue.${renameIssue}`)}
          </div>
        ) : (
          <div
            className="truncate font-mono text-xs text-muted-foreground"
            title={link.targetPath}
          >
            {link.targetPath}
          </div>
        )}
        {link.status !== "ok" ? (
          <div className={cn("mt-0.5 text-xs", statusTone(link.status))}>
            {t(`status.${link.status}`)}
          </div>
        ) : null}
      </div>

      {!editing ? (
        // The app mounts no global tooltip provider — each surface brings its
        // own, and Radix throws without one.
        <TooltipProvider delayDuration={200}>
          <div className="flex shrink-0 items-center gap-0.5">
            {link.status === "missing" || link.status === "broken" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    type="button"
                    onClick={onRepair}
                    disabled={busy}
                    aria-label={t("repair")}
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("repair")}</TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  type="button"
                  onClick={onStartRename}
                  disabled={busy}
                  aria-label={t("rename")}
                >
                  <Pencil className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("rename")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  type="button"
                  onClick={onRemove}
                  disabled={busy}
                  aria-label={t("unlink")}
                >
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Link2Off className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("unlink")}</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      ) : null}
    </div>
  )
}

function PendingRow({
  item,
  issue,
  onNameChange,
  onRemove,
}: {
  item: PendingLink
  issue: LinkNameIssue | null
  onNameChange: (name: string) => void
  onRemove: () => void
}) {
  const t = useTranslations("Folder.workspaceDialog")

  return (
    <div className="flex items-center gap-2 bg-primary/5 px-3 py-2">
      <Plus className="size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <Input
          value={item.name}
          onChange={(e) => onNameChange(e.target.value)}
          className={cn(
            "h-7 text-sm",
            issue && "border-destructive focus-visible:ring-0"
          )}
        />
        <div
          className="truncate font-mono text-xs text-muted-foreground"
          title={item.targetPath}
        >
          {item.targetPath}
        </div>
        {issue ? (
          <div className="text-xs text-destructive">
            {t(`nameIssue.${issue}`)}
          </div>
        ) : item.renamed ? (
          <div className="text-xs text-amber-600 dark:text-amber-500">
            {item.collidesWithExistingEntry
              ? t("renamedForExistingEntry", { base: item.baseName })
              : t("renamedForDuplicate", { base: item.baseName })}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {t("willAppearAs", { name: basenameOf(item.targetPath) })}
          </div>
        )}
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        type="button"
        onClick={onRemove}
        title={t("removePending")}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}
