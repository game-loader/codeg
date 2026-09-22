import { getTransport, type Transport } from "@/lib/transport"
import { getSavedPrefsForConnect } from "@/lib/selector-prefs-storage"
import type { AgentType } from "@/lib/types"

export interface AcademicSettings {
  agent_type: AgentType
  bridge_port: number
  paired: boolean
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

async function invokeAcademic<T>(
  command: string,
  args?: Record<string, unknown>,
  transport: Transport = getTransport()
): Promise<T> {
  if (transport !== getTransport()) throw new Error("Workspace changed")
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
  if (transport !== getTransport()) throw new Error("Workspace changed")
  return result
}

export const academicSettingsGet = () =>
  invokeAcademic<AcademicSettings>("academic_settings_get")
export const academicSettingsSet = (settings: {
  agentType: AgentType
  bridgePort: number
  token?: string
}) => invokeAcademic<AcademicSettings>("academic_settings_set", settings)
export const academicLibrary = () =>
  invokeAcademic<AcademicLibrary>("academic_library")
async function researchAgentPreferences(transport: Transport) {
  const settings = await invokeAcademic<AcademicSettings>(
    "academic_settings_get",
    {},
    transport
  )
  const prefs = getSavedPrefsForConnect(settings.agent_type)
  return {
    agent_type: settings.agent_type,
    mode_id: prefs.modeId,
    config_values: prefs.configValues ?? {},
  }
}

export const academicSelect = async (itemKey: string) => {
  const transport = getTransport()
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
export const academicPaperGet = (paperId: string) =>
  invokeAcademic<AcademicPaper>("academic_paper_get", { paperId })
export const academicImport = (identifier: string, collectionKey: string) =>
  invokeAcademic<AcademicItem>("academic_import", { identifier, collectionKey })
export const academicPrepare = async (
  paperId: string,
  arxivId?: string,
  repoUrl?: string
) => {
  const transport = getTransport()
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
export const academicCancel = (paperId: string) =>
  invokeAcademic<void>("academic_cancel", { paperId })
export const academicOpenTarget = (paperId: string, withoutCode = false) =>
  invokeAcademic<AcademicOpenTarget>("academic_open_target", {
    paperId,
    withoutCode,
  })
export const academicBindConversation = (
  paperId: string,
  conversationId: number
) =>
  invokeAcademic<void>("academic_bind_conversation", {
    paperId,
    conversationId,
  })
export const academicConversationPaper = (conversationId: number) =>
  invokeAcademic<AcademicPaper | null>("academic_conversation_paper", {
    conversationId,
  })

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
