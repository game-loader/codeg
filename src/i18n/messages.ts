import type { AbstractIntlMessages } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { AppLocale } from "@/lib/types"

const MESSAGE_CACHE = new Map<AppLocale, AbstractIntlMessages>([
  ["en", enMessages],
])

async function loadMessages(locale: AppLocale): Promise<AbstractIntlMessages> {
  switch (locale) {
    case "zh_cn":
      return (await import("@/i18n/messages/zh-CN.json")).default
    case "zh_tw":
      return (await import("@/i18n/messages/zh-TW.json")).default
    case "ja":
      return (await import("@/i18n/messages/ja.json")).default
    case "ko":
      return (await import("@/i18n/messages/ko.json")).default
    case "es":
      return (await import("@/i18n/messages/es.json")).default
    case "de":
      return (await import("@/i18n/messages/de.json")).default
    case "fr":
      return (await import("@/i18n/messages/fr.json")).default
    case "pt":
      return (await import("@/i18n/messages/pt.json")).default
    case "ar":
      return (await import("@/i18n/messages/ar.json")).default
    case "en":
    default:
      return enMessages
  }
}

export function getFallbackMessages(): AbstractIntlMessages {
  return enMessages
}

export async function getMessagesForLocale(
  locale: AppLocale
): Promise<AbstractIntlMessages> {
  const cached = MESSAGE_CACHE.get(locale)
  if (cached) return cached

  const localized = await loadMessages(locale)
  const folder = localized.Folder
  const chat = typeof folder === "object" ? folder.chat : undefined
  const connections = typeof chat === "object" ? chat.acpConnections : undefined
  const backendErrors =
    typeof connections === "object" ? connections.backendErrors : undefined
  const academic = localized.Academic
  const agentSettings = localized.AcpAgentSettings
  const piSettings =
    typeof agentSettings === "object" ? agentSettings.pi : undefined
  const thinking =
    typeof piSettings === "object" ? piSettings.thinking : undefined
  // New features ship in English and Simplified Chinese first (AGENTS.md).
  // Keep the other locales usable without copying English into their catalogs.
  const messages = {
    ...localized,
    Machines: {
      ...(typeof localized.Machines === "object" ? localized.Machines : {}),
      ssh:
        (typeof localized.Machines === "object" && localized.Machines.ssh) ||
        enMessages.Machines.ssh,
    },
    AcpAgentSettings: {
      ...(typeof agentSettings === "object" ? agentSettings : {}),
      pi: {
        ...(typeof piSettings === "object" ? piSettings : {}),
        thinking: {
          max: enMessages.AcpAgentSettings.pi.thinking.max,
          ...(typeof thinking === "object" ? thinking : {}),
        },
      },
    },
    Academic: {
      mcpTools: enMessages.Academic.mcpTools,
      mcpToolsHint: enMessages.Academic.mcpToolsHint,
      ...(typeof academic === "object" ? academic : {}),
    },
    Folder: {
      ...(typeof folder === "object" ? folder : {}),
      chat: {
        ...(typeof chat === "object" ? chat : {}),
        acpConnections: {
          ...(typeof connections === "object" ? connections : {}),
          backendErrors: {
            sessionLoadError:
              enMessages.Folder.chat.acpConnections.backendErrors
                .sessionLoadError,
            ...(typeof backendErrors === "object" ? backendErrors : {}),
          },
        },
      },
      pdfPreview:
        (typeof folder === "object" && folder.pdfPreview) ||
        enMessages.Folder.pdfPreview,
      videoPreview:
        (typeof folder === "object" && folder.videoPreview) ||
        enMessages.Folder.videoPreview,
    },
  }
  MESSAGE_CACHE.set(locale, messages)
  return messages
}
