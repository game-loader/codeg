import type { BackendPlatform } from "@/lib/backend/types"
import { defaultBackendPlatform as legacyBackendPlatform } from "@/lib/backend/defaults"

export const SHARED_BARK_DEVICE_ID = "00000000-0000-4000-8000-000000000001"

export interface BarkNotificationSettings {
  enabled: boolean
  pushUrl: string
  includePreview: boolean
  language: string
  serverUrl: string
  sourceName: string
}

export interface BarkNotificationRegistration {
  deviceId: string
  settings: BarkNotificationSettings
}

type BarkSettingsResponse = Omit<BarkNotificationSettings, "sourceName"> & {
  sourceName?: string
}

function normalizeSettings(
  settings: BarkSettingsResponse
): BarkNotificationSettings {
  return { ...settings, sourceName: settings.sourceName ?? "" }
}

export async function getBarkNotificationSettings(
  deviceId: string,
  backendPlatform: BackendPlatform = legacyBackendPlatform
) {
  const settings = await backendPlatform
    .getTransport()
    .call<BarkSettingsResponse>("get_bark_notification_settings", { deviceId })
  return normalizeSettings(settings)
}

export async function setBarkNotificationSettings(
  deviceId: string,
  settings: BarkNotificationSettings,
  backendPlatform: BackendPlatform = legacyBackendPlatform
) {
  const saved = await backendPlatform
    .getTransport()
    .call<BarkSettingsResponse>("set_bark_notification_settings", {
      deviceId,
      settings,
    })
  return normalizeSettings(saved)
}

export function testBarkNotification(
  deviceId: string,
  backendPlatform: BackendPlatform = legacyBackendPlatform
) {
  return backendPlatform
    .getTransport()
    .call<void | null>("test_bark_notification", {
      deviceId,
    })
}

export async function listBarkNotificationSettings(
  backendPlatform: BackendPlatform = legacyBackendPlatform
): Promise<BarkNotificationRegistration[]> {
  const registrations = await backendPlatform
    .getTransport()
    .call<
      { deviceId: string; settings: BarkSettingsResponse }[]
    >("list_bark_notification_settings", {})
  return registrations.map((entry) => ({
    ...entry,
    settings: normalizeSettings(entry.settings),
  }))
}
