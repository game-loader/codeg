"use client"

import { useBackendApi } from "@/contexts/backend-client-context"
import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const SUPPORTED_LANGUAGES = [
  "en",
  "zh-cn",
  "zh-tw",
  "ja",
  "ko",
  "es",
  "de",
  "fr",
  "pt",
  "ar",
] as const

export function ChannelOtherTab() {
  const backendApi = useBackendApi()

  const t = useTranslations("ChatChannelSettings.language")
  const [language, setLanguage] = useState("en")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    backendApi
      .getChatMessageLanguage()
      .then((lang) => setLanguage(lang))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [backendApi])

  const handleLanguageChange = useCallback(
    async (value: string) => {
      setSaving(true)
      try {
        await backendApi.setChatMessageLanguage(value)
        setLanguage(value)
        toast.success(t("saved"))
      } catch {
        toast.error(t("saveFailed"))
      } finally {
        setSaving(false)
      }
    },
    [t, backendApi]
  )

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        <Select
          value={language}
          onValueChange={handleLanguageChange}
          disabled={saving}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_LANGUAGES.map((lang) => (
              <SelectItem key={lang} value={lang}>
                {t(lang)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>
    </div>
  )
}
