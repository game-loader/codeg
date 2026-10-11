import { getTransport, type Transport } from "@/lib/transport"

import { getSavedPrefsForConnect } from "@/lib/selector-prefs-storage"

import type { AgentType } from "@/lib/types"

export interface AcademicSettings {
  agent_type: AgentType
  bridge_port: number
  paired: boolean
  mcp_enabled?: boolean
}

export interface AcademicCollection {
  key: string
  name: string
  parent_key: string | null
}

export interface AcademicItem {
  key: string
  title: string
  abstract_text: string
  authors: string[]
  doi: string | null
  url: string | null
  extra: string
  collections: string[]
  version: number
}

export interface AcademicLibrary {
  library_id: number
  instance_id: string
  collections: AcademicCollection[]
  items: AcademicItem[]
}

export interface ArxivCandidate {
  id: string
  title: string
  authors: string[]
  summary: string
  pdf_url: string
}

export interface AcademicConversation {
  id: number
  folder_id: number
  agent_type: AgentType
  title: string | null
}

export type AcademicStatus =
  | "queued"
  | "resolving"
  | "needs_match"
  | "needs_repo"
  | "extracting"
  | "analyzing"
  | "verifying"
  | "cloning"
  | "ready"
  | "no_code"
  | "metadata_only"
  | "failed"
  | "cancelled"
  | "interrupted"

export interface AcademicRepoCandidate {
  url: string
  evidence_quote: string
  source_url: string | null
  license: string | null
}

export interface AcademicPaper {
  id: string
  item_key: string
  library_id: number
  title: string
  authors: string[]
  abstract_text: string
  doi: string | null
  arxiv_id: string | null
  pdf_path: string | null
  text_path: string | null
  context_path: string | null
  repo_url: string | null
  repo_path: string | null
  folder_id: number | null
  status: AcademicStatus
  error: string | null
  analysis: string | null
  analysis_conversation_id: number | null
  candidates: ArxivCandidate[]
  repo_candidates: AcademicRepoCandidate[]
  conversations: AcademicConversation[]
}

export interface AcademicOpenTarget {
  paper_id: string
  agent_type: AgentType
  folder_id: number | null
  working_dir: string | null
}

export function isAcademicBusy(status: AcademicStatus): boolean {
  return [
    "queued",
    "resolving",
    "extracting",
    "analyzing",
    "verifying",
    "cloning",
  ].includes(status)
}
/** A client created here keeps its backend for every request and continuation. */
export function createAcademicApi(
  boundTransport: Transport,
  readAgentPreferences: typeof getSavedPrefsForConnect = getSavedPrefsForConnect
) {
  async function invokeAcademic<T>(
    command: string,
    args?: Record<string, unknown>,
    transport: Transport = boundTransport
  ): Promise<T> {
    // Each synchronous Zotero request has a 90s deadline. Library/select do
    // health + library; import adds translation/import. Leave 10s for overhead
    // so web and remote desktop clients receive the backend's result.
    const timeoutMs =
      command === "academic_import"
        ? 280_000
        : command === "academic_library" || command === "academic_select"
          ? 190_000
          : undefined
    const result = await (timeoutMs
      ? transport.call<T>(command, args ?? {}, { timeoutMs })
      : transport.call<T>(command, args ?? {}))
    return result
  }

  const academicSettingsGet = () =>
    invokeAcademic<AcademicSettings>("academic_settings_get")

  const academicSettingsSet = (settings: {
    agentType: AgentType
    bridgePort: number
    token?: string
    mcpEnabled?: boolean
  }) => invokeAcademic<AcademicSettings>("academic_settings_set", settings)

  const academicLibrary = () =>
    invokeAcademic<AcademicLibrary>("academic_library")

  async function researchAgentPreferences(transport: Transport) {
    const settings = await invokeAcademic<AcademicSettings>(
      "academic_settings_get",
      {},
      transport
    )
    const prefs = readAgentPreferences(settings.agent_type)
    return {
      agent_type: settings.agent_type,
      mode_id: prefs.modeId,
      config_values: prefs.configValues ?? {},
    }
  }

  const academicSelect = async (itemKey: string) => {
    const transport = boundTransport
    const agentPreferences = await researchAgentPreferences(transport)
    return invokeAcademic<AcademicPaper>(
      "academic_select",
      {
        itemKey,
        agentPreferences,
      },
      transport
    )
  }

  const academicPaperGet = (paperId: string) =>
    invokeAcademic<AcademicPaper>("academic_paper_get", { paperId })

  const academicImport = (identifier: string, collectionKey: string) =>
    invokeAcademic<AcademicItem>("academic_import", {
      identifier,
      collectionKey,
    })

  const academicPrepare = async (
    paperId: string,
    arxivId?: string,
    repoUrl?: string
  ) => {
    const transport = boundTransport
    const agentPreferences = await researchAgentPreferences(transport)
    return invokeAcademic<AcademicPaper>(
      "academic_prepare",
      {
        paperId,
        arxivId,
        repoUrl,
        agentPreferences,
      },
      transport
    )
  }

  const academicCancel = (paperId: string) =>
    invokeAcademic<void>("academic_cancel", { paperId })

  const academicOpenTarget = (paperId: string, withoutCode = false) =>
    invokeAcademic<AcademicOpenTarget>("academic_open_target", {
      paperId,
      withoutCode,
    })

  const academicBindConversation = (paperId: string, conversationId: number) =>
    invokeAcademic<void>("academic_bind_conversation", {
      paperId,
      conversationId,
    })

  const academicConversationPaper = (conversationId: number) =>
    invokeAcademic<AcademicPaper | null>("academic_conversation_paper", {
      conversationId,
    })
  return {
    academicSettingsGet,
    academicSettingsSet,
    academicLibrary,
    academicSelect,
    academicPaperGet,
    academicImport,
    academicPrepare,
    academicCancel,
    academicOpenTarget,
    academicBindConversation,
    academicConversationPaper,
  }
}

export type AcademicApi = ReturnType<typeof createAcademicApi>

/** Compatibility entry points for a single-backend page. Scoped workspaces use the factory. */
function getDefaultAcademicApi() {
  return createAcademicApi(getTransport())
}
export const academicSettingsGet: AcademicApi["academicSettingsGet"] = (
  ...args
) => getDefaultAcademicApi().academicSettingsGet(...args)
export const academicSettingsSet: AcademicApi["academicSettingsSet"] = (
  ...args
) => getDefaultAcademicApi().academicSettingsSet(...args)
export const academicLibrary: AcademicApi["academicLibrary"] = (...args) =>
  getDefaultAcademicApi().academicLibrary(...args)
export const academicSelect: AcademicApi["academicSelect"] = (...args) =>
  getDefaultAcademicApi().academicSelect(...args)
export const academicPaperGet: AcademicApi["academicPaperGet"] = (...args) =>
  getDefaultAcademicApi().academicPaperGet(...args)
export const academicImport: AcademicApi["academicImport"] = (...args) =>
  getDefaultAcademicApi().academicImport(...args)
export const academicPrepare: AcademicApi["academicPrepare"] = (...args) =>
  getDefaultAcademicApi().academicPrepare(...args)
export const academicCancel: AcademicApi["academicCancel"] = (...args) =>
  getDefaultAcademicApi().academicCancel(...args)
export const academicOpenTarget: AcademicApi["academicOpenTarget"] = (
  ...args
) => getDefaultAcademicApi().academicOpenTarget(...args)
export const academicBindConversation: AcademicApi["academicBindConversation"] =
  (...args) => getDefaultAcademicApi().academicBindConversation(...args)
export const academicConversationPaper: AcademicApi["academicConversationPaper"] =
  (...args) => getDefaultAcademicApi().academicConversationPaper(...args)
