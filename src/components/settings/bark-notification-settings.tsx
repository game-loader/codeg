"use client"

import { useEffect, useRef, useState } from "react"
import { BellRing, Eye, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"

import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import {
  SettingsError,
  SettingsSection,
} from "@/components/shared/settings-section"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { getWebServerStatus } from "@/lib/api"
import { getRemoteWorkspaceConnection } from "@/lib/remote-workspace"
import {
  getBarkNotificationSettings,
  listBarkNotificationSettings,
  setBarkNotificationSettings,
  SHARED_BARK_DEVICE_ID,
  testBarkNotification,
  type BarkNotificationRegistration,
  type BarkNotificationSettings,
} from "@/lib/bark-notifications"
import {
  getActiveRemoteConnectionId,
  getServerBaseUrl,
  getTransport,
  isDesktop,
} from "@/lib/transport"

function httpUrl(value: string): string {
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? value
      : ""
  } catch {
    return ""
  }
}

async function suggestedServerUrl(): Promise<string> {
  if (!isDesktop() || getActiveRemoteConnectionId() !== null) {
    return httpUrl(getServerBaseUrl())
  }
  try {
    const status = await getWebServerStatus()
    return (
      status?.addresses.find((address) => {
        if (!httpUrl(address)) return false
        const host = new URL(address).hostname
        return (
          !["localhost", "0.0.0.0", "[::]", "[::1]"].includes(host) &&
          !host.startsWith("127.")
        )
      }) ?? ""
    )
  } catch {
    return ""
  }
}

async function suggestedDefaults() {
  const remoteId = getActiveRemoteConnectionId()
  const [serverUrl, connection] = await Promise.all([
    suggestedServerUrl(),
    remoteId === null
      ? null
      : getRemoteWorkspaceConnection(remoteId).catch(() => null),
  ])
  return {
    serverUrl,
    sourceName: (
      connection?.name.trim() || (serverUrl ? new URL(serverUrl).hostname : "")
    ).slice(0, 80),
  }
}

export function BarkNotificationSettingsSection() {
  // Remote workspaces normally have separate windows. Also reset on an
  // identity change if this section is reused in a live workspace switcher.
  const scope = `${getActiveRemoteConnectionId() ?? "local"}:${getServerBaseUrl()}`
  return <BarkSubscriptions key={scope} />
}

function BarkSubscriptions() {
  const t = useTranslations("BarkNotificationSettings")
  const [transport] = useState(getTransport)
  const [registrations, setRegistrations] = useState<
    BarkNotificationRegistration[] | null
  >(null)
  const [deviceId, setDeviceId] = useState(SHARED_BARK_DEVICE_ID)
  const [suggested, setSuggested] = useState({ serverUrl: "", sourceName: "" })
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    Promise.all([listBarkNotificationSettings(), suggestedDefaults()])
      .then(([entries, defaults]) => {
        if (!active || getTransport() !== transport) return
        setRegistrations(entries)
        setSuggested(defaults)
      })
      .catch(() => {
        if (active && getTransport() === transport) setLoadFailed(true)
      })
    return () => {
      active = false
    }
  }, [attempt, transport])

  return (
    <SettingsSection
      icon={BellRing}
      title={t("title")}
      description={t("description")}
    >
      <SettingCard>
        <SettingRow title={t("subscription")} htmlFor="bark-subscription">
          <Select
            value={deviceId}
            onValueChange={setDeviceId}
            disabled={!registrations}
          >
            <SelectTrigger id="bark-subscription" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SHARED_BARK_DEVICE_ID}>
                {t("sharedSubscription")}
              </SelectItem>
              {registrations
                ?.filter((entry) => entry.deviceId !== SHARED_BARK_DEVICE_ID)
                .map((entry) => (
                  <SelectItem key={entry.deviceId} value={entry.deviceId}>
                    {t("phoneSubscription", {
                      id: entry.deviceId.slice(0, 8),
                    })}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingCard>
      {loadFailed ? (
        <>
          <SettingsError>{t("loadFailed")}</SettingsError>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLoadFailed(false)
              setAttempt((value) => value + 1)
            }}
          >
            {t("retry")}
          </Button>
        </>
      ) : registrations ? (
        <BarkSubscriptionForm
          key={deviceId}
          deviceId={deviceId}
          registered={registrations.some(
            (entry) => entry.deviceId === deviceId
          )}
          suggested={suggested}
          onSaved={(settings) =>
            setRegistrations((entries) => [
              ...(entries ?? []).filter((entry) => entry.deviceId !== deviceId),
              { deviceId, settings },
            ])
          }
        />
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          {t("loading")}
        </p>
      )}
    </SettingsSection>
  )
}

function BarkSubscriptionForm({
  deviceId,
  registered,
  suggested,
  onSaved,
}: {
  deviceId: string
  registered: boolean
  suggested: { serverUrl: string; sourceName: string }
  onSaved: (settings: BarkNotificationSettings) => void
}) {
  const t = useTranslations("BarkNotificationSettings")
  const [transport] = useState(getTransport)
  const [initiallyRegistered] = useState(registered)
  const active = useRef(false)
  const [draft, setDraft] = useState<BarkNotificationSettings | null>(null)
  const [saved, setSaved] = useState<BarkNotificationSettings | null>(null)
  const [busy, setBusy] = useState<"save" | "test" | null>(null)
  const [error, setError] = useState<
    "loadFailed" | "saveFailed" | "testFailed" | null
  >(null)
  const [notice, setNotice] = useState<"saved" | "testSent" | null>(null)
  const [showPushUrl, setShowPushUrl] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    active.current = true
    getBarkNotificationSettings(deviceId)
      .then((settings) => {
        if (cancelled || getTransport() !== transport) return
        setSaved(settings)
        setDraft(
          !initiallyRegistered && deviceId === SHARED_BARK_DEVICE_ID
            ? {
                ...settings,
                serverUrl: settings.serverUrl || suggested.serverUrl,
                sourceName: settings.sourceName || suggested.sourceName,
              }
            : settings
        )
      })
      .catch(() => {
        if (!cancelled && getTransport() === transport) setError("loadFailed")
      })
    return () => {
      cancelled = true
      active.current = false
    }
  }, [deviceId, initiallyRegistered, suggested, attempt, transport])

  const dirty =
    draft !== null &&
    saved !== null &&
    (Object.keys(draft) as (keyof BarkNotificationSettings)[]).some(
      (key) => draft[key] !== saved[key]
    )
  const disabled = !draft || busy !== null
  const canTest = !disabled && !dirty && !!saved?.pushUrl

  function update(patch: Partial<BarkNotificationSettings>) {
    if (!draft || disabled) return
    setDraft({ ...draft, ...patch })
    setError(null)
    setNotice(null)
  }

  async function run(action: "save" | "test") {
    if (disabled || !draft || (action === "test" && !canTest)) return
    if (getTransport() !== transport) return
    setBusy(action)
    setError(null)
    setNotice(null)
    try {
      if (action === "save") {
        const normalized = await setBarkNotificationSettings(deviceId, draft)
        if (!active.current || getTransport() !== transport) return
        setSaved(normalized)
        setDraft(normalized)
        onSaved(normalized)
        setNotice("saved")
      } else {
        await testBarkNotification(deviceId)
        if (!active.current || getTransport() !== transport) return
        setNotice("testSent")
      }
    } catch {
      // Backend errors can contain the secret Bark URL. Only show fixed,
      // actionable messages, never interpolate or log the raw exception.
      if (active.current && getTransport() === transport) {
        setError(action === "save" ? "saveFailed" : "testFailed")
      }
    } finally {
      if (active.current && getTransport() === transport) setBusy(null)
    }
  }

  return (
    <>
      {!draft && !error && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("loading")}
        </p>
      )}
      <SettingCard>
        <SettingRow
          title={t("enabled")}
          htmlFor="bark-enabled"
          control={
            <Switch
              id="bark-enabled"
              checked={draft?.enabled ?? false}
              disabled={disabled}
              onCheckedChange={(enabled) => update({ enabled })}
            />
          }
        />
        <SettingRow
          title={t("pushUrl")}
          description={t("pushUrlHint")}
          htmlFor="bark-push-url"
        >
          <div className="relative">
            <Input
              id="bark-push-url"
              type={showPushUrl ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              value={draft?.pushUrl ?? ""}
              disabled={disabled}
              onChange={(event) => update({ pushUrl: event.target.value })}
              className="pr-9"
            />
            <button
              type="button"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50"
              aria-label={t(showPushUrl ? "hidePushUrl" : "showPushUrl")}
              disabled={disabled}
              onClick={() => setShowPushUrl((visible) => !visible)}
            >
              {showPushUrl ? (
                <EyeOff className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </SettingRow>
        <SettingRow
          title={t("includePreview")}
          description={t("previewHint")}
          htmlFor="bark-preview"
          control={
            <Switch
              id="bark-preview"
              checked={draft?.includePreview ?? false}
              disabled={disabled}
              onCheckedChange={(includePreview) => update({ includePreview })}
            />
          }
        />
        <SettingRow
          title={t("sourceName")}
          description={t("sourceNameHint")}
          htmlFor="bark-source-name"
        >
          <Input
            id="bark-source-name"
            maxLength={80}
            placeholder={t("sourceNamePlaceholder")}
            value={draft?.sourceName ?? ""}
            disabled={disabled}
            onChange={(event) => update({ sourceName: event.target.value })}
          />
        </SettingRow>
        <SettingRow title={t("language")} htmlFor="bark-language">
          <Select
            value={draft?.language ?? "en"}
            disabled={disabled}
            onValueChange={(language) => update({ language })}
          >
            <SelectTrigger id="bark-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="zh-Hans">简体中文</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("serverUrl")}
          description={t(
            deviceId === SHARED_BARK_DEVICE_ID
              ? "serverUrlHint"
              : "phoneServerUrlHint"
          )}
          htmlFor="bark-server-url"
        >
          <Input
            id="bark-server-url"
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://codeg.example.com"
            value={draft?.serverUrl ?? ""}
            disabled={disabled}
            onChange={(event) => update({ serverUrl: event.target.value })}
          />
        </SettingRow>
      </SettingCard>
      {error && <SettingsError>{t(error)}</SettingsError>}
      {error === "loadFailed" && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setError(null)
            setAttempt((value) => value + 1)
          }}
        >
          {t("retry")}
        </Button>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {t(notice)}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t("testHint")}</p>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!canTest}
          onClick={() => void run("test")}
        >
          {t(busy === "test" ? "testing" : "test")}
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => void run("save")}>
          {t(busy === "save" ? "saving" : "save")}
        </Button>
      </div>
    </>
  )
}
