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
  const [host, setHost] = useState(machine?.addresses[0] ?? "")
  const [port, setPort] = useState(String(machine?.ssh_port ?? 22))
  const [username, setUsername] = useState(machine?.ssh_user ?? "root")
  const [password, setPassword] = useState("")
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
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        password: password || null,
      })
      setPassword("")
      onSaved(saved)
    } catch (err) {
      // The backend never returns a stored secret; also guard request errors.
      const message = machineError(err)
      setError(password ? message.split(password).join("••••••") : message)
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
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{t(machine ? "editMachine" : "addMachine")}</DialogTitle>
          <DialogDescription>{t("manualDescription")}</DialogDescription>
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
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
              <label className="block space-y-1 text-sm">
                {t("host")}
                <Input
                  required
                  maxLength={64}
                  placeholder="203.0.113.10"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="block space-y-1 text-sm">
                {t("port")}
                <Input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </label>
            </div>
            <label className="block space-y-1 text-sm">
              {t("sshUser")}
              <Input
                required
                maxLength={64}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="block space-y-1 text-sm">
              {t("password")}
              <Input
                type="password"
                required={!machine}
                maxLength={4096}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              {t(machine ? "passwordKeep" : "passwordPrivacy")}
            </p>
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
