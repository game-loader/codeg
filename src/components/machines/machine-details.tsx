"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  formatMachineContext,
  loadMachineUser,
  MACHINE_METRICS,
  machineError,
  probeMachine,
  saveMachineUser,
  type Machine,
  type MachineSnapshot,
} from "@/lib/machines"

export type MachineProbeStatus =
  | "notProbed"
  | "probing"
  | "reachable"
  | "unreachable"

export function MachineDetails({
  machine,
  refresh,
  onInsert,
  onEdit,
  onRemove,
  onProbeStatus,
}: {
  machine: Machine
  refresh: number
  onInsert?: (context: string) => void
  onEdit: () => void
  onRemove: () => void
  onProbeStatus: (id: string, status: MachineProbeStatus) => void
}) {
  const t = useTranslations("Machines")
  const manual = machine.source === "manual"
  const [user, setUser] = useState(() =>
    manual ? (machine.ssh_user ?? "") : loadMachineUser(machine.id)
  )
  const [appliedUser, setAppliedUser] = useState(user)
  const [probeVersion, setProbeVersion] = useState(0)
  const [snapshot, setSnapshot] = useState<MachineSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(true)
  const requestProbe = useCallback(() => {
    if (!manual) saveMachineUser(machine.id, user)
    setAppliedUser(user.trim())
    setProbeVersion((n) => n + 1)
  }, [machine.id, user, manual])

  useEffect(() => {
    let active = true
    let settled = false
    // Each request invalidates the displayed telemetry until it resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProbing(true)
    setSnapshot(null)
    setError(null)
    onProbeStatus(machine.id, "probing")
    probeMachine(machine.id, appliedUser)
      .then((result) => {
        if (active) {
          setSnapshot(result)
          onProbeStatus(machine.id, "reachable")
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setError(machineError(err))
          onProbeStatus(machine.id, "unreachable")
        }
      })
      .finally(() => {
        settled = true
        if (active) setProbing(false)
      })
    return () => {
      active = false
      if (!settled) onProbeStatus(machine.id, "notProbed")
    }
  }, [machine.id, appliedUser, probeVersion, refresh, onProbeStatus])

  return (
    <section className="min-w-0 space-y-4 overflow-y-auto rounded-xl border p-4">
      <div>
        <h2 className="font-semibold">{machine.name}</h2>
        <p className="break-all text-xs text-muted-foreground">
          {machine.dns_name}
        </p>
        <p className="text-xs text-muted-foreground">
          {manual
            ? `${t("connectionStatus")}: ${t(probing ? "probing" : snapshot ? "reachable" : error ? "unreachable" : "notProbed")}`
            : `${t("tailnetStatus")}: ${t(machine.online ? "online" : "offline")}`}
        </p>
        {manual && (
          <p className="break-all text-xs text-muted-foreground">
            {machine.ssh_user}@{machine.addresses[0]} · {t("port")}:{" "}
            {machine.ssh_port}
          </p>
        )}
        {manual && (
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="size-3" />
              {t("editMachine")}
            </Button>
            <Button size="sm" variant="outline" onClick={onRemove}>
              <Trash2 className="size-3" />
              {t("removeMachine")}
            </Button>
          </div>
        )}
        {machine.last_seen && (
          <p className="text-xs text-muted-foreground">
            {t("lastSeen")}: {new Date(machine.last_seen).toLocaleString()}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {!manual && (
          <label className="min-w-32 flex-1 space-y-1 text-xs text-muted-foreground">
            {t("sshUser")}
            <Input
              value={user}
              placeholder={t("defaultUser")}
              onChange={(event) => setUser(event.target.value)}
              autoComplete="off"
            />
          </label>
        )}
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
