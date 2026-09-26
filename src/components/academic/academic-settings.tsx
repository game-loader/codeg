"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { getAgentLabel } from "@/lib/custom-agents"
import {
  academicSettingsSet,
  type AcademicSettings as Settings,
} from "@/lib/academic"
import { getTransport } from "@/lib/transport"
import { useAcademicStore } from "@/stores/academic-store"

export function AcademicSettings({ settings }: { settings: Settings }) {
  const t = useTranslations("Academic")
  const { agents } = useAcpAgents()
  const [agentType, setAgentType] = useState(settings.agent_type)
  const [port, setPort] = useState(String(settings.bridge_port))
  const [mcpEnabled, setMcpEnabled] = useState(settings.mcp_enabled ?? false)
  const [token, setToken] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const enabledAgents = agents.filter((a) => a.available && a.enabled)

  return (
    <form
      className="space-y-4 rounded-xl border p-4"
      onSubmit={async (event) => {
        event.preventDefault()
        const bridgePort = Number(port)
        if (
          !Number.isInteger(bridgePort) ||
          bridgePort < 1 ||
          bridgePort > 65535
        ) {
          setError(t("invalidPort"))
          return
        }
        const transport = getTransport()
        const isCurrent = () => mounted.current && transport === getTransport()
        setSaving(true)
        setError(null)
        try {
          const updated = await academicSettingsSet({
            agentType,
            bridgePort,
            mcpEnabled,
            ...(token.trim() ? { token: token.trim() } : {}),
          })
          if (!isCurrent()) return
          useAcademicStore.setState({ settings: updated })
          setToken("")
          await useAcademicStore.getState().refreshLibrary()
        } catch (cause) {
          if (isCurrent())
            setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (isCurrent()) setSaving(false)
        }
      }}
    >
      <h2 className="text-sm font-semibold">{t("settings")}</h2>
      <p className="text-xs text-muted-foreground">{t("pairingHint")}</p>
      <p className="text-xs text-muted-foreground">{t("workspaceHostHint")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          <span>{t("researchAgent")}</span>
          <select
            className="h-9 w-full rounded-lg border bg-background px-2"
            value={agentType}
            onChange={(e) => setAgentType(e.target.value)}
          >
            {!enabledAgents.some((a) => a.agent_type === agentType) && (
              <option value={agentType}>{getAgentLabel(agentType)}</option>
            )}
            {enabledAgents.map((a) => (
              <option key={a.agent_type} value={a.agent_type}>
                {getAgentLabel(a.agent_type)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span>{t("port")}</span>
          <Input
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            required
          />
        </label>
      </div>
      <label className="block space-y-1 text-xs">
        <span>{t("pairingToken")}</span>
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={settings.paired ? t("alreadyPaired") : t("pasteToken")}
          required={!settings.paired}
        />
      </label>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={mcpEnabled}
          onChange={(event) => setMcpEnabled(event.target.checked)}
          aria-describedby="academic-mcp-hint"
        />
        <span>
          <span>{t("mcpTools")}</span>
          <span
            id="academic-mcp-hint"
            className="mt-1 block text-muted-foreground"
          >
            {t("mcpToolsHint")}
          </span>
        </span>
      </label>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t("operationFailed", { message: error })}
        </p>
      )}
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? t("saving") : t("saveConnect")}
      </Button>
    </form>
  )
}
