"use client"

import { useTranslations } from "next-intl"
import { MachineBrowser } from "./machine-browser"

export function MachinesPageTitle() {
  const t = useTranslations("Machines")
  return <span className="text-sm font-medium">{t("title")}</span>
}

export function MachinesPage() {
  const t = useTranslations("Machines")
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("commandHint")}</p>
      </div>
      <MachineBrowser />
    </div>
  )
}
