import type { BackendClient } from "@/lib/backend/types"
import { defaultBackendPlatform } from "@/lib/backend/defaults"
import * as main from "@/lib/api"
import { getTransport } from "@/lib/transport"
import { createSkillsFollower, listenSkillsChanged } from "@/lib/skills/changes"
import * as catalog from "@/lib/harness/api"
import * as skillInstall from "@/lib/harness/skill-install-api"
import * as mcpInstall from "@/lib/harness/mcp-install-api"
import * as pluginInstall from "@/lib/harness/plugin-install-api"
import * as updates from "@/lib/harness/updates"
import * as skills from "@/lib/skills/api"
import * as mcp from "@/lib/mcp/api"

const standalone = {
  main,
  platform: defaultBackendPlatform,
  getTransport: () => getTransport(),
  listenSkillsChanged: (listener: Parameters<typeof listenSkillsChanged>[0]) =>
    listenSkillsChanged(listener),
  catalog,
  skillInstall,
  mcpInstall,
  pluginInstall,
  updates,
  skills,
  mcp,
}
function bind(client: BackendClient) {
  const transport = () => client.transport
  const skillsApi = skills.createSkillsApi(transport)
  return {
    main: client.api,
    platform: client.platform,
    getTransport: transport,
    listenSkillsChanged: createSkillsFollower(
      skillsApi.onSkillsChanged,
      transport
    ),
    catalog: catalog.createCatalogApi(transport),
    skillInstall: skillInstall.createSkillInstallApi(transport),
    mcpInstall: mcpInstall.createMcpInstallApi(transport),
    pluginInstall: pluginInstall.createPluginInstallApi(transport),
    updates: updates.createUpdatesApi(transport),
    skills: skillsApi,
    mcp: mcp.createMcpApi(transport),
  }
}
export type HarnessBackend = ReturnType<typeof bind>
const clients = new WeakMap<BackendClient, HarnessBackend>()

/** All reads, writes and subscriptions in this view keep the same host. */
export function harnessBackendFor(
  client?: BackendClient | null
): HarnessBackend {
  if (!client) return standalone
  let backend = clients.get(client)
  if (!backend) {
    backend = bind(client)
    clients.set(client, backend)
  }
  return backend
}
