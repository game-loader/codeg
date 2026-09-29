"use client"

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type {
  SshAuthMethod,
  SshEndpointInput,
  SshJumpHost,
} from "@/lib/machines"

export interface EndpointForm {
  host: string
  port: string
  username: string
  auth_method: SshAuthMethod
  password: string
  private_key: string
  passphrase: string
}

export function endpointForm(saved?: SshJumpHost | null): EndpointForm {
  return {
    host: saved?.host ?? "",
    port: String(saved?.port ?? 22),
    username: saved?.username ?? "root",
    auth_method: saved?.auth_method ?? "password",
    password: "",
    private_key: "",
    passphrase: "",
  }
}

export function endpointInput(form: EndpointForm): SshEndpointInput {
  const key = form.auth_method === "private_key"
  return {
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    auth_method: form.auth_method,
    password: key ? null : form.password || null,
    private_key: key ? form.private_key || null : null,
    passphrase: key ? form.passphrase || null : null,
  }
}

export function SshEndpointFields({
  value,
  onChange,
  canKeepSecret,
}: {
  value: EndpointForm
  onChange: Dispatch<SetStateAction<EndpointForm>>
  canKeepSecret: boolean
}) {
  const t = useTranslations("Machines")
  const [importError, setImportError] = useState(false)
  const importVersion = useRef(0)
  useEffect(
    () => () => {
      importVersion.current += 1
    },
    []
  )
  const update = (key: keyof EndpointForm, text: string) =>
    onChange((previous) => ({ ...previous, [key]: text }))
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
        <label className="block space-y-1 text-sm">
          {t("ssh.host")}
          <Input
            required
            maxLength={253}
            placeholder="203.0.113.10"
            value={value.host}
            onChange={(e) => update("host", e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
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
            value={value.port}
            onChange={(e) => update("port", e.target.value)}
          />
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        {t("sshUser")}
        <Input
          required
          maxLength={64}
          value={value.username}
          onChange={(e) => update("username", e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
      </label>
      <label className="block space-y-1 text-sm">
        {t("ssh.authentication")}
        <select
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={value.auth_method}
          onChange={(e) => {
            const method = e.target.value as SshAuthMethod
            importVersion.current += 1
            setImportError(false)
            onChange((previous) => ({
              ...previous,
              auth_method: method,
              password: "",
              private_key: "",
              passphrase: "",
            }))
          }}
        >
          <option value="password">{t("password")}</option>
          <option value="private_key">{t("ssh.privateKey")}</option>
        </select>
      </label>
      {value.auth_method === "password" ? (
        <label className="block space-y-1 text-sm">
          {t("password")}
          <Input
            type="password"
            required={!canKeepSecret}
            maxLength={4096}
            value={value.password}
            onChange={(e) => update("password", e.target.value)}
            autoComplete="new-password"
          />
        </label>
      ) : (
        <>
          <label className="block space-y-1 text-sm">
            {t("ssh.privateKey")}
            <Textarea
              required={!canKeepSecret}
              maxLength={65536}
              rows={5}
              value={value.private_key}
              onChange={(e) => update("private_key", e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </label>
          <label className="block space-y-1 text-sm">
            {t("ssh.importKey")}
            <Input
              type="file"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                event.target.value = ""
                if (!file) return
                const version = ++importVersion.current
                setImportError(false)
                if (file.size > 65536) {
                  setImportError(true)
                  return
                }
                try {
                  const text = await file.text()
                  if (version === importVersion.current)
                    update("private_key", text)
                } catch {
                  if (version === importVersion.current) setImportError(true)
                }
              }}
            />
          </label>
          {importError && (
            <p role="alert" className="text-sm text-destructive">
              {t("ssh.importFailed")}
            </p>
          )}
          <label className="block space-y-1 text-sm">
            {t("ssh.passphrase")}
            <Input
              type="password"
              maxLength={4096}
              value={value.passphrase}
              onChange={(e) => update("passphrase", e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <p className="text-xs text-muted-foreground">{t("ssh.keyHint")}</p>
        </>
      )}
      {canKeepSecret && (
        <p className="text-xs text-muted-foreground">{t("ssh.keepSecret")}</p>
      )}
    </div>
  )
}
