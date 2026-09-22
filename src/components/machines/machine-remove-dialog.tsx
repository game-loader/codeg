"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { deleteManualMachine, machineError, type Machine } from "@/lib/machines"

export function MachineRemoveDialog({
  machine,
  onClose,
  onRemoved,
}: {
  machine: Machine
  onClose: () => void
  onRemoved: (id: string) => void
}) {
  const t = useTranslations("Machines")
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function remove() {
    if (removing) return
    setRemoving(true)
    setError(null)
    try {
      await deleteManualMachine(machine.id)
      onRemoved(machine.id)
    } catch (err) {
      setError(machineError(err))
    } finally {
      setRemoving(false)
    }
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !removing) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("removeTitle", { name: machine.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("removeDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>
            {t("cancel")}
          </AlertDialogCancel>
          <Button variant="destructive" disabled={removing} onClick={remove}>
            {t(removing ? "removing" : "removeConfirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
