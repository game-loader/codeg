"use client"

import { useState, type FormEvent } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  endpointForm,
  endpointInput,
  SshEndpointFields,
} from "./ssh-endpoint-fields"
import { machineError, saveManualMachine, type Machine } from "@/lib/machines"

/** Mounted only while open: closing also discards the password from form state. */
export function ManualMachineDialog({
  machine,
  onClose,
  onSaved,
}: {
  machine: Machine | null
  onClose: () => void
  onSaved: (machine: Machine) => void
}) {
  const t = useTranslations("Machines")
  const [name, setName] = useState(machine?.name ?? "")
  const [target, setTarget] = useState(() =>
    endpointForm(
      machine
        ? {
            host: machine.addresses[0] ?? "",
            port: machine.ssh_port ?? 22,
            username: machine.ssh_user ?? "root",
            auth_method: machine.auth_method ?? "password",
          }
        : null
    )
  )
  const [useJump, setUseJump] = useState(Boolean(machine?.jump_host))
  const [jump, setJump] = useState(() => endpointForm(machine?.jump_host))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const saved = await saveManualMachine({
        id: machine?.id ?? null,
        name: name.trim(),
        ...endpointInput(target),
        jump_host: useJump ? endpointInput(jump) : null,
      })
      setTarget(endpointForm())
      setJump(endpointForm())
      onSaved(saved)
    } catch (err) {
      // The backend never returns a stored secret; also guard request errors.
      let message = machineError(err)
      for (const value of [target, jump]) {
        for (const secret of [
          value.password,
          value.private_key,
          value.passphrase,
        ]) {
          if (secret) message = message.split(secret).join("••••••")
        }
      }
      setError(message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!saving}
        className="max-h-[90dvh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{t(machine ? "editMachine" : "addMachine")}</DialogTitle>
          <DialogDescription>{t("ssh.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={saving} className="space-y-3">
            <label className="block space-y-1 text-sm">
              {t("name")}
              <Input
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
              />
            </label>
            <SshEndpointFields
              value={target}
              onChange={setTarget}
              canKeepSecret={
                Boolean(machine) &&
                target.auth_method === (machine?.auth_method ?? "password")
              }
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useJump}
                onChange={(event) => {
                  setUseJump(event.target.checked)
                  if (!event.target.checked)
                    setJump(endpointForm(machine?.jump_host))
                }}
              />
              {t("ssh.useJump")}
            </label>
            {useJump && (
              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">
                  {t("ssh.jumpHost")}
                </legend>
                <SshEndpointFields
                  value={jump}
                  onChange={setJump}
                  canKeepSecret={
                    Boolean(machine?.jump_host) &&
                    jump.host.trim() === machine?.jump_host?.host &&
                    Number(jump.port) === machine?.jump_host?.port &&
                    jump.username.trim() === machine?.jump_host?.username &&
                    jump.auth_method === machine?.jump_host?.auth_method
                  }
                />
              </fieldset>
            )}
            <p className="text-xs text-muted-foreground">{t("ssh.privacy")}</p>
          </fieldset>
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={saving}
              onClick={onClose}
            >
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {t(saving ? "saving" : "saveMachine")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
