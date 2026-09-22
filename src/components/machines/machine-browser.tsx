"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, RefreshCw, Server } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  formatMachineContext,
  listMachines,
  loadMachineUser,
  MACHINE_METRICS,
  machineError,
  probeMachine,
  saveMachineUser,
  type Machine,
  type MachineSnapshot,
} from "@/lib/machines"

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

  useEffect(() => {
    let active = true
    loadingRef.current = true
    // Fetch lifecycle: clear the preceding request's status when a refresh starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    listMachines()
      .then((items) => {
        if (active) setMachines(items)
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
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
          <p>{t("discoveryFailed")}</p>
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
                </span>
                <span className="block text-xs text-muted-foreground">
                  {machine.os}
                  {machine.is_self ? ` · ${t("self")}` : ""}
                </span>
              </span>
              <span
                className={cn(
                  "mt-1 flex items-center gap-1 text-xs",
                  machine.online
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
                )}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {t(machine.online ? "online" : "offline")}
              </span>
            </button>
          ))}
        </div>
        {selected ? (
          <MachineDetails
            key={selected.id}
            machine={selected}
            refresh={refresh}
            onInsert={onInsert}
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

function MachineDetails({
  machine,
  refresh,
  onInsert,
}: {
  machine: Machine
  refresh: number
  onInsert?: (context: string) => void
}) {
  const t = useTranslations("Machines")
  const [user, setUser] = useState(() => loadMachineUser(machine.id))
  const [appliedUser, setAppliedUser] = useState(user)
  const [probeVersion, setProbeVersion] = useState(0)
  const [snapshot, setSnapshot] = useState<MachineSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(true)
  const requestProbe = useCallback(() => {
    saveMachineUser(machine.id, user)
    setAppliedUser(user.trim())
    setProbeVersion((n) => n + 1)
  }, [machine.id, user])

  useEffect(() => {
    let active = true
    // Each request invalidates the displayed telemetry until it resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProbing(true)
    setSnapshot(null)
    setError(null)
    probeMachine(machine.id, appliedUser)
      .then((result) => {
        if (active) setSnapshot(result)
      })
      .catch((err: unknown) => {
        if (active) setError(machineError(err))
      })
      .finally(() => {
        if (active) setProbing(false)
      })
    return () => {
      active = false
    }
  }, [machine.id, appliedUser, probeVersion, refresh])

  return (
    <section className="min-w-0 space-y-4 overflow-y-auto rounded-xl border p-4">
      <div>
        <h2 className="font-semibold">{machine.name}</h2>
        <p className="break-all text-xs text-muted-foreground">
          {machine.dns_name}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("tailnetStatus")}: {t(machine.online ? "online" : "offline")}
        </p>
        {machine.last_seen && (
          <p className="text-xs text-muted-foreground">
            {t("lastSeen")}: {new Date(machine.last_seen).toLocaleString()}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-32 flex-1 space-y-1 text-xs text-muted-foreground">
          {t("sshUser")}
          <Input
            value={user}
            placeholder={t("defaultUser")}
            onChange={(event) => setUser(event.target.value)}
            autoComplete="off"
          />
        </label>
        <Button variant="outline" onClick={requestProbe} disabled={probing}>
          {probing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {t("probe")}
        </Button>
      </div>
      {probing && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("probing")}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="space-y-1 rounded-lg bg-destructive/10 p-3 text-sm"
        >
          <p>{t("probeFailed")}</p>
          <p className="whitespace-pre-wrap break-words text-muted-foreground">
            {error}
          </p>
        </div>
      )}
      {snapshot && (
        <>
          <p className="break-all text-xs text-muted-foreground">
            SSH: {snapshot.ssh_target}
            <br />
            {t("sampledAt")}: {new Date(snapshot.sampled_at).toLocaleString()}
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            {MACHINE_METRICS.map((key) => (
              <div
                key={key}
                className={cn(
                  "rounded-lg bg-muted/40 p-3",
                  (key === "gpu" || key === "disk") && "sm:col-span-2"
                )}
              >
                <dt className="text-xs text-muted-foreground">
                  {t(`metrics.${key}`)}
                </dt>
                <dd className="mt-1 whitespace-pre-wrap break-words text-sm">
                  {snapshot.metrics[key] || t("unknown")}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {onInsert && (
        <Button
          className="w-full"
          disabled={
            probing || (!snapshot && !error) || user.trim() !== appliedUser
          }
          onClick={() =>
            onInsert(formatMachineContext(machine, snapshot, error))
          }
        >
          {t("insert")}
        </Button>
      )}
    </section>
  )
}
