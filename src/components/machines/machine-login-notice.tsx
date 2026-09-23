"use client"

import { useTranslations } from "next-intl"
import { BrowserLink } from "@/components/ui/browser-link"

export function MachineLoginNotice({
  url,
  retry,
}: {
  url: string
  retry: "probe" | "refresh"
}) {
  const t = useTranslations("Machines")
  return (
    <div className="space-y-1">
      <p>{t("tailscaleLoginRequired")}</p>
      <BrowserLink
        className="font-medium text-primary underline underline-offset-4"
        href={url}
      >
        {t("loginTailscale")}
      </BrowserLink>
      <p className="text-muted-foreground">
        {t("afterAuthorizing", { action: t(retry) })}
      </p>
    </div>
  )
}
