"use client"

/**
 * The NEW-CONVERSATION DEFAULT (mode & config option selections) per
 * agentType, in localStorage (codeg#1179). Written only by an explicit pick
 * in a draft (the surfaces decide at pick time); read by new drafts, and once
 * by a legacy conversation that never recorded a selection of its own. Every
 * existing conversation keeps its own selection on its row
 * (`conversation.selector_state`, written by the backend), which the backend
 * replays on connect instead of this default — so picking in one
 * conversation never changes another, and changing the default never changes
 * an existing conversation.
 *
 * Preferences are shipped to the backend at `acp_connect` time (see
 * `getSavedPrefsForConnect`) which applies them to the agent BEFORE
 * the initial `session_modes` / `session_config_options` events are
 * emitted. Snapshots, replays, and live events therefore all carry the
 * user-preferred values uniformly — there is no client-side "intercept
 * incoming event and overwrite locally" path.
 */

import type { SessionModeStateInfo } from "@/lib/types"

export const SELECTOR_PREFS_STORAGE_KEY = "codeg:selector-prefs"

interface SelectorPrefs {
  modeId?: string
  configValues?: Record<string, string>
}

type AllPrefs = Record<string, SelectorPrefs>

/**
 * Built-in agent types that took over a custom agent, mapped to the custom
 * agent's id. The database migration that retired it
 * (`m20261015_000001_kiro_builtin_agent`) cannot reach this device-local
 * store, so until the built-in has picks of its own it starts from the custom
 * agent's: both ran the same `kiro-cli acp`, so its saved agent (the mode) is
 * one the built-in offers too.
 */
const RETIRED_CUSTOM_AGENTS = new Map([["kiro", "custom:kiro-cli"]])

function prefsOf(all: AllPrefs, agentType: string): SelectorPrefs | undefined {
  const own = all[agentType]
  if (own) return own
  const retired = RETIRED_CUSTOM_AGENTS.get(agentType)
  return retired ? all[retired] : undefined
}

/**
 * cursor-agent's model-parameter vocabulary, as it appeared inside the
 * stringified variants its old picker used.
 *
 * The match below keys on these NAMES, not merely on a `key=value` shape,
 * because healing runs for every agent (see [`healLegacyValues`]) and some
 * agents accept arbitrary model ids: OpenCode builds its selector values as
 * `<provider>/<modelId>` straight from the user's own config, so
 * `mygw/llama[quant=q4]` is a perfectly legitimate id that a shape-only match
 * would truncate on every reconnect.
 */
const CURSOR_VARIANT_KEYS = new Set(["thinking", "context", "effort", "fast"])

/**
 * Heal a `model` preference saved before codeg opted into cursor-agent's
 * parameterized model picker.
 *
 * That older surface identified a model by a stringified variant —
 * `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]` — and the
 * agent now rejects anything but the bare base id, so the saved value would
 * fail to apply on every connect (logged and skipped, i.e. the user silently
 * keeps landing on whatever model Cursor felt like). The base is the prefix
 * before the bracket, which is exactly what the new surface wants; the
 * parameters inside it are re-offered as their own selectors.
 *
 * Matched on the VALUE rather than on the agent id. Scoping this to
 * `agentType === "cursor"` would strand every CUSTOM agent that wraps the same
 * `cursor-agent … acp` binary: the capability gate that turns the new picker on
 * keys on the resolved launch recipe, not on the built-in identity, so those
 * agents get the new surface and carry the very same stale preference under a
 * user-chosen id this module cannot enumerate. Running for everyone is only
 * safe because the match demands cursor's own parameter names — see
 * [`CURSOR_VARIANT_KEYS`].
 */
function healLegacyValues(
  values: Record<string, string>
): Record<string, string> {
  const model = values.model
  if (typeof model !== "string" || !model.endsWith("]")) return values
  // `<= 0` also rejects a leading bracket, which would heal to an empty model.
  const open = model.lastIndexOf("[")
  if (open <= 0) return values
  // Every cursor id is a flat slug — `composer-2.5`, `claude-opus-5-thinking-
  // max-fast`. A namespaced id belongs to somebody else (OpenCode's values are
  // `<provider>/<modelId>`, and the model half comes from the user's own
  // config, so it may legitimately end in anything at all).
  if (model.slice(0, open).includes("/")) return values
  const isVariantSuffix = model
    .slice(open + 1, -1)
    .split(",")
    .every((param) => {
      const eq = param.indexOf("=")
      return eq > 0 && CURSOR_VARIANT_KEYS.has(param.slice(0, eq))
    })
  if (!isVariantSuffix) return values
  return { ...values, model: model.slice(0, open) }
}

export function createSelectorPrefsStorage(
  read: () => string | null,
  write: (value: string) => void
) {
  let disposed = false
  // A surface may choose options before it connects. Keep those picks in
  // memory for this storage instance only; the saved default stays intact.
  const connectSelections = new Map<
    string,
    { agentType: string; configValues: Record<string, string> }
  >()

  function readAll(): AllPrefs {
    if (disposed) return {}
    try {
      const raw = read()
      const all: unknown = raw ? JSON.parse(raw) : null
      return all && typeof all === "object" && !Array.isArray(all)
        ? (all as AllPrefs)
        : {}
    } catch {
      return {}
    }
  }

  function updatePrefs(
    agentType: string,
    update: (prefs: SelectorPrefs) => SelectorPrefs
  ) {
    if (disposed) return
    const all = readAll()
    const existing = prefsOf(all, agentType)
    // Project onto the current schema to drop legacy hash fields on writes.
    all[agentType] = update({
      modeId: existing?.modeId,
      configValues: existing?.configValues,
    })
    try {
      write(JSON.stringify(all))
    } catch {
      /* device storage may be unavailable */
    }
  }

  return {
    preferences: {
      getSavedModeId(agentType: string): string | null {
        return prefsOf(readAll(), agentType)?.modeId ?? null
      },
      /** Apply a surface's picks over the saved default for the same agent. */
      getSavedPrefsForConnect(
        agentType: string,
        contextKey?: string
      ): {
        modeId: string | null
        configValues: Record<string, string> | null
      } {
        const prefs = prefsOf(readAll(), agentType)
        const saved =
          prefs?.configValues && Object.keys(prefs.configValues).length > 0
            ? healLegacyValues(prefs.configValues)
            : null
        const own =
          contextKey != null ? connectSelections.get(contextKey) : null
        return {
          modeId: prefs?.modeId ?? null,
          configValues:
            own?.agentType === agentType
              ? { ...saved, ...own.configValues }
              : saved,
        }
      },
      setConnectSelection(
        contextKey: string,
        agentType: string,
        configValues: Record<string, string>
      ) {
        if (disposed) return
        if (Object.keys(configValues).length === 0) {
          connectSelections.delete(contextKey)
          return
        }
        connectSelections.set(contextKey, { agentType, configValues })
      },
      clearConnectSelection(contextKey: string) {
        connectSelections.delete(contextKey)
      },
      saveModePreference(agentType: string, modes: SessionModeStateInfo) {
        updatePrefs(agentType, (prefs) => ({
          ...prefs,
          modeId: modes.current_mode_id,
        }))
      },
      saveConfigPreference(
        agentType: string,
        configId: string,
        valueId: string
      ) {
        updatePrefs(agentType, (prefs) => ({
          ...prefs,
          configValues: { ...prefs.configValues, [configId]: valueId },
        }))
      },
    },
    dispose() {
      disposed = true
      connectSelections.clear()
    },
  }
}

const { preferences: standalonePreferences } = createSelectorPrefsStorage(
  () =>
    typeof window === "undefined"
      ? null
      : localStorage.getItem(SELECTOR_PREFS_STORAGE_KEY),
  (value) => {
    if (typeof window !== "undefined")
      localStorage.setItem(SELECTOR_PREFS_STORAGE_KEY, value)
  }
)

export const {
  getSavedModeId,
  getSavedPrefsForConnect,
  setConnectSelection,
  clearConnectSelection,
  saveModePreference,
  saveConfigPreference,
} = standalonePreferences
