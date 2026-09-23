"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Plus, RefreshCw, Server } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  listMachines,
  machineError,
  tailscaleLoginUrl,
  type Machine,
} from "@/lib/machines"
import { MachineDetails, type MachineProbeStatus } from "./machine-details"
import { ManualMachineDialog } from "./manual-machine-dialog"
import { MachineRemoveDialog } from "./machine-remove-dialog"
import { MachineLoginNotice } from "./machine-login-notice"

export function MachineBrowser({
  onInsert,
}: {
  onInsert?: (context: string) => void
}) {
  const t = useTranslations("Machines")
  const [machines, setMachines] = useState<Machine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const loadingRef = useRef(false)
  const [editing, setEditing] = useState<Machine | null | undefined>(undefined)
  const [removing, setRemoving] = useState<Machine | null>(null)
  const [probeStates, setProbeStates] = useState<
    Record<string, MachineProbeStatus>
  >({})
  const updateProbeStatus = useCallback(
    (id: string, status: MachineProbeStatus) => {
      setProbeStates((current) => ({ ...current, [id]: status }))
    },
    []
  )

  useEffect(() => {
    let active = true
    loadingRef.current = true
    // Fetch lifecycle: clear the preceding request's status when a refresh starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    listMachines()
      .then((items) => {
        if (active) {
          setMachines(items.machines)
          setError(items.discovery_error)
        }
      })
      .catch((err: unknown) => {
        if (active) setError(machineError(err))
      })
      .finally(() => {
        if (active) {
          setLoading(false)
          loadingRef.current = false
        }
      })
    return () => {
      active = false
    }
  }, [refresh])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !loadingRef.current)
        setRefresh((n) => n + 1)
    }, 30_000)
    return () => clearInterval(timer)
  }, [autoRefresh])

  const selected = machines.find((machine) => machine.id === selectedId)
  const needle = query.trim().toLowerCase()
  const filtered = machines.filter((machine) =>
    [machine.name, machine.dns_name, machine.os, ...machine.addresses]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  )
  const discoveryLoginUrl = tailscaleLoginUrl(error)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {editing !== undefined && (
        <ManualMachineDialog
          machine={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            setEditing(undefined)
            setProbeStates((current) => {
              const next = { ...current }
              delete next[saved.id]
              return next
            })
            setMachines((current) => [
              ...current.filter((item) => item.id !== saved.id),
              saved,
            ])
            setSelectedId(saved.id)
            setQuery("")
            setRefresh((n) => n + 1)
          }}
        />
      )}
      {removing && (
        <MachineRemoveDialog
          machine={removing}
          onClose={() => setRemoving(null)}
          onRemoved={(id) => {
            setRemoving(null)
            setSelectedId((current) => (current === id ? null : current))
            setMachines((current) => current.filter((item) => item.id !== id))
            setRefresh((n) => n + 1)
          }}
        />
      )}
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label={t("search")}
          placeholder={t("search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-40 flex-1"
        />
        <Button onClick={() => setEditing(null)}>
          <Plus className="size-4" />
          {t("addMachine")}
        </Button>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          {t("refresh")}
        </Button>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          {t("autoRefresh")}
        </label>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 p-3 text-sm"
        >
          {discoveryLoginUrl ? (
            <MachineLoginNotice url={discoveryLoginUrl} retry="refresh" />
          ) : (
            <p>{t("discoveryFailed")}</p>
          )}
          <p className="break-words text-muted-foreground">{error}</p>
          <p className="mt-2 text-muted-foreground">{t("setupHint")}</p>
        </div>
      )}
      {loading && machines.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      )}
      {!loading && !error && machines.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      )}
      {!loading && machines.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("noMatches")}</p>
      )}
      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]">
        <div
          className="max-h-64 space-y-1 overflow-y-auto md:max-h-none"
          aria-label={t("title")}
        >
          {filtered.map((machine) => (
            <button
              key={machine.id}
              type="button"
              aria-pressed={selectedId === machine.id}
              onClick={() => setSelectedId(machine.id)}
              className={cn(
                "flex w-full items-start gap-3 rounded-xl border p-3 text-left hover:bg-muted",
                selectedId === machine.id && "border-primary bg-primary/5"
              )}
            >
              <Server className="mt-1 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {machine.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {machine.addresses.join(", ") || machine.dns_name}
                  {machine.source === "manual" && ` · ${machine.ssh_port}`}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {machine.source === "manual" ? t("manual") : machine.os}
                  {machine.is_self ? ` · ${t("self")}` : ""}
                </span>
              </span>
              <span
                className={cn(
                  "mt-1 flex items-center gap-1 text-xs",
                  (
                    machine.source === "manual"
                      ? probeStates[machine.id] === "reachable"
                      : machine.online
                  )
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
                )}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {t(
                  machine.source === "manual"
                    ? (probeStates[machine.id] ?? "notProbed")
                    : machine.online === null
                      ? "notProbed"
                      : machine.online
                        ? "online"
                        : "offline"
                )}
              </span>
            </button>
          ))}
        </div>
        {selected ? (
          <MachineDetails
            key={`${selected.id}:${selected.ssh_port}:${selected.ssh_user}:${selected.addresses.join(",")}`}
            machine={selected}
            refresh={refresh}
            onInsert={onInsert}
            onEdit={() => setEditing(selected)}
            onRemove={() => setRemoving(selected)}
            onProbeStatus={updateProbeStatus}
          />
        ) : (
          <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            {t("selectMachine")}
          </div>
        )}
      </div>
    </div>
  )
}
