"use client"

import { useCallback, useSyncExternalStore } from "react"

import { useBackendApi } from "@/contexts/backend-client-context"
import type { BackendApi } from "@/lib/backend/types"
import * as legacyBackendApi from "@/lib/api"
import type { AgentSkillItem, AgentType } from "@/lib/types"

/**
 * The skills an agent sees from one folder, held ONCE per window and shared by
 * every component that reads them.
 *
 * Several readers routinely share a folder: a Codex tab's composer (its `$`
 * menu) and its transcript (its badge check) read the same list, and background
 * tabs stay mounted. There is one entry per backend client, agent and folder,
 * every reader subscribes to it through `useSyncExternalStore`, and one scan
 * refreshes them all — including a reader that mounted after the list was
 * already loaded, which a per-reader copy would leave behind for good.
 *
 * Keyed by folder so project-scoped skills (`{folder}/.codex/skills`) never leak
 * into another workspace, and a key switch never serves the previous folder's
 * list. `Map`s throughout: the keys are paths codeg does not choose.
 */
interface SkillsEntry {
  readonly agentType: AgentType
  readonly workspacePath: string | null
  /** The last list a scan returned; null until one succeeds. */
  skills: AgentSkillItem[] | null
  /** Bumped by every scan started, so only the newest scan's answer lands: a
   *  slow earlier scan that answers last cannot overwrite a fresher list. */
  generation: number
  /** A scan whose answer is still wanted is running. */
  loading: boolean
}

interface SkillsCache {
  readonly api: BackendApi
  readonly entries: Map<string, SkillsEntry>
  readonly readers: Map<string, Set<() => void>>
}

// A new backend generation receives a new API object, so paths and agent ids
// can never reuse another machine's entries or in-flight scans.
const caches = new WeakMap<BackendApi, SkillsCache>()
/** Only caches with mounted readers participate in the shared focus listener. */
const activeCaches = new Set<SkillsCache>()

function getCache(api: BackendApi): SkillsCache {
  let cache = caches.get(api)
  if (!cache) {
    cache = { api, entries: new Map(), readers: new Map() }
    caches.set(api, cache)
  }
  return cache
}
let listeningForFocus = false

/** Stable empty answer: a fresh `[]` per read would never compare equal to
 *  itself as a `useSyncExternalStore` snapshot, and React would re-render
 *  forever. */
const EMPTY: AgentSkillItem[] = []

function makeKey(agentType: AgentType, workspacePath: string | null): string {
  return JSON.stringify([agentType, workspacePath])
}

/** Compared as serialized data so a field added to `AgentSkillItem` later is
 *  compared too. Lists are a few dozen entries and this runs once per scan. */
function sameSkills(
  a: readonly AgentSkillItem[],
  b: readonly AgentSkillItem[]
): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function entryFor(
  cache: SkillsCache,
  agentType: AgentType,
  workspacePath: string | null
): [string, SkillsEntry] {
  const key = makeKey(agentType, workspacePath)
  let entry = cache.entries.get(key)
  if (!entry) {
    entry = {
      agentType,
      workspacePath,
      skills: null,
      generation: 0,
      loading: false,
    }
    cache.entries.set(key, entry)
  }
  return [key, entry]
}

/** Scan a folder's skills, superseding any scan of it already running. */
function scan(cache: SkillsCache, key: string, entry: SkillsEntry): void {
  const generation = ++entry.generation
  entry.loading = true
  // Forgotten (by invalidation) or superseded (by a newer scan) since it began.
  const stale = () =>
    cache.entries.get(key) !== entry || entry.generation !== generation
  cache.api
    .acpListAgentSkills({
      agentType: entry.agentType,
      workspacePath: entry.workspacePath,
    })
    .then(
      (result) => {
        if (stale()) return
        entry.loading = false
        const skills = result.supported ? result.skills : EMPTY
        // An unchanged list keeps its reference, so a refresh that found nothing
        // new re-renders no reader (nor re-parses a transcript's messages).
        if (entry.skills && sameSkills(entry.skills, skills)) return
        entry.skills = skills
        for (const onChange of cache.readers.get(key) ?? []) onChange()
      },
      (err: unknown) => {
        if (stale()) return
        entry.loading = false
        // The last list that loaded stays up: a transient failure must not wipe
        // every `$` menu and transcript badge reading this folder.
        console.warn("[useAgentSkills] failed:", err)
      }
    )
}

// Rescan when the window regains focus: skills can change while it is in the
// background (the settings window creates or removes them). One scan per folder
// something on screen reads, however many components read it, and none for a
// folder nothing reads any more.
function onWindowFocus() {
  for (const cache of activeCaches) {
    for (const key of cache.readers.keys()) {
      const entry = cache.entries.get(key)
      if (entry) scan(cache, key, entry)
    }
  }
}

function subscribe(
  cache: SkillsCache,
  agentType: AgentType,
  workspacePath: string | null,
  onChange: () => void
): () => void {
  const [key, entry] = entryFor(cache, agentType, workspacePath)
  let keyReaders = cache.readers.get(key)
  if (!keyReaders) {
    keyReaders = new Set()
    cache.readers.set(key, keyReaders)
  }
  keyReaders.add(onChange)
  activeCaches.add(cache)
  if (!listeningForFocus) {
    window.addEventListener("focus", onWindowFocus)
    listeningForFocus = true
  }
  // Loaded already (another reader got here first): nothing to fetch. A failed
  // first scan left `skills` null, so the next reader to mount retries it.
  if (entry.skills === null && !entry.loading) scan(cache, key, entry)
  return () => {
    keyReaders.delete(onChange)
    if (keyReaders.size === 0 && cache.readers.get(key) === keyReaders) {
      cache.readers.delete(key)
    }
    if (cache.readers.size === 0) activeCaches.delete(cache)
    if (activeCaches.size === 0 && listeningForFocus) {
      window.removeEventListener("focus", onWindowFocus)
      listeningForFocus = false
    }
  }
}

const noReader = () => () => {}
const emptySnapshot = () => EMPTY

export function useAgentSkills(
  agentType: AgentType | null,
  workspacePath?: string | null
): AgentSkillItem[] {
  const api = useBackendApi()
  const cache = getCache(api)
  const normalizedPath = workspacePath ?? null
  const subscribeToFolder = useCallback(
    (onChange: () => void) =>
      agentType
        ? subscribe(cache, agentType, normalizedPath, onChange)
        : noReader(),
    [cache, agentType, normalizedPath]
  )
  const getSnapshot = useCallback(
    () =>
      agentType
        ? (cache.entries.get(makeKey(agentType, normalizedPath))?.skills ??
          EMPTY)
        : EMPTY,
    [cache, agentType, normalizedPath]
  )
  return useSyncExternalStore(subscribeToFolder, getSnapshot, emptySnapshot)
}

/**
 * Drop what is known about an agent's skills (every agent's, without one) after
 * they changed. A folder something on screen reads is rescanned at once, its
 * current list staying up until the new one lands; any other folder is
 * forgotten, so the next component to read it scans afresh.
 */
export function invalidateAgentSkillsCache(
  agentType?: AgentType,
  api: BackendApi = legacyBackendApi
) {
  const cache = getCache(api)
  for (const [key, entry] of cache.entries) {
    if (agentType && entry.agentType !== agentType) continue
    if (cache.readers.has(key)) scan(cache, key, entry)
    else cache.entries.delete(key)
  }
}
