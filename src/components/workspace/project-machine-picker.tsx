"use client"

import { useId } from "react"
import { useTranslations } from "next-intl"
import type { BackendDescriptor } from "@/lib/backend/registry"
import type { BackendKey } from "@/lib/backend/types"

/** Where a new project opens. Unavailable machines stay listed with status. */
export function ProjectMachinePicker({
  hosts,
  value,
  disabled,
  onChange,
}: {
  hosts: readonly BackendDescriptor[]
  value: BackendKey
  disabled: boolean
  onChange(key: BackendKey): void
}) {
  const t = useTranslations("MultiHost")
  const id = useId()
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id}>{t("projectMachine")}</label>
      <select
        id={id}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as BackendKey)}
      >
        {hosts.map((host) => (
          <option key={host.key} value={host.key}>
            {host.status === "connected"
              ? host.name
              : `${host.name} · ${t(host.status)}`}
          </option>
        ))}
      </select>
    </div>
  )
}
