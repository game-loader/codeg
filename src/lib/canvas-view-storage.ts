"use client"

import {
  defaultBackendStoreStorage,
  type BackendStoreStorage,
} from "@/stores/backend-store-storage"
import type { AgentType } from "@/lib/types"

/**
 * Device-local memory of how each canvas board was left: where the viewport
 * sat, which cards and regions were open, any conversation started there but
 * never sent, and the connection key a card inherited from the draft that
 * created it — plus whether the map was showing, which is a preference of the
 * canvas as a whole rather than of one board.
 *
 * The canvas is a full-page route, and `WorkbenchRoutePage` unmounts it whenever
 * the user goes back to the workspace — so without this, every visit reopens a
 * board the user has to re-navigate and re-expand. Persisting is what makes
 * "come back to where I was" true across route switches AND app restarts.
 *
 * Per BOARD: every entry but the map toggle is keyed by the board it describes.
 * The view drops remembered ids whose node is not on the board it shows, so
 * one shared entry would have each board wipe every other board's state the
 * moment it opened. Entries written before boards existed live under the
 * un-suffixed keys; the first board to read one adopts it (see `readBoard`).
 *
 * Advisory state is scoped to the fixed backend and then the board. Numeric
 * board/node IDs and draft folders from one machine never restore on another.
 * The compatibility exports retain the original standalone storage keys.
 */

const VIEWPORT_KEY = "workspace:canvas-viewport"
const EXPANDED_CARDS_KEY = "workspace:canvas-expanded-cards"
const EXPANDED_REGIONS_KEY = "workspace:canvas-expanded-regions"
const DRAFTS_KEY = "workspace:canvas-drafts"
const MINIMAP_KEY = "workspace:canvas-minimap"
const SURFACE_KEYS_KEY = "workspace:canvas-surface-keys"

/** Every per-board entry, by its legacy (pre-board) key. */
const BOARD_KEYS = [
  VIEWPORT_KEY,
  EXPANDED_CARDS_KEY,
  EXPANDED_REGIONS_KEY,
  DRAFTS_KEY,
  SURFACE_KEYS_KEY,
] as const

function boardKey(key: string, boardId: number): string {
  return `${key}:${boardId}`
}

/** Mirrors ReactFlow's `Viewport`. Zoom is clamped to the same range the flow
 *  is configured with, so a corrupted entry can never strand the board at a
 *  zoom the user cannot recover from. */
export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export const CANVAS_MIN_ZOOM = 0.1
export const CANVAS_MAX_ZOOM = 2

/** An unsent conversation card living only on this client's board. */
export interface CanvasDraftCard {
  id: string
  target: { folderId: number } | { chat: true }
  agentType: AgentType
  /** Chosen before the card has a row to store it on; carried into that row
   *  when the first message creates it (see `materializeDraft`). Absent or
   *  empty means no colour — the palette clears by re-picking. */
  color?: string
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasSurfaceKey {
  /** The conversation the node was bound to when the key was inherited. */
  conversationId: number
  /** The node's `created_at`, as the card identity an id sequence can't give. */
  createdAt: string
  /** The ACP connection key that card must keep using. */
  key: string
}
export function createCanvasViewStorage(storage: BackendStoreStorage) {
  function readJson(key: string): unknown {
    if (typeof window === "undefined") return null
    try {
      const raw = storage.read(key)
      return raw ? (JSON.parse(raw) as unknown) : null
    } catch {
      return null
    }
  }

  function writeJson(key: string, value: unknown): void {
    if (typeof window === "undefined") return
    try {
      storage.write(key, JSON.stringify(value))
    } catch {
      /* ignore storage quota/permission failures */
    }
  }

  function remove(key: string): void {
    if (typeof window === "undefined") return
    try {
      storage.write(key, null)
    } catch {
      /* ignore */
    }
  }

  function hasItem(key: string): boolean {
    if (typeof window === "undefined") return false
    try {
      return storage.read(key) !== null
    } catch {
      return false
    }
  }

  /**
   * Read a board's entry, adopting the pre-board one first if this board has
   * none of its own.
   *
   * Before boards, the canvas was ONE board and these entries described it. The
   * upgrade puts every existing node on one board, and the first board a client
   * opens is, in practice, that one — so the first board to ask inherits the
   * entry, and the legacy key is removed so no second board inherits it too. A
   * board that already has its own entry leaves the legacy one for whichever
   * board comes next without one. Nothing is lost if the guess is wrong: ids that
   * name no node on the adopting board are pruned by the view like any stale id,
   * and a draft is simply an unsent card that now sits on this board.
   */
  function readBoard(key: string, boardId: number): unknown {
    const own = boardKey(key, boardId)
    if (!hasItem(own) && hasItem(key)) {
      try {
        const legacy = storage.read(key)
        if (legacy !== null) storage.write(own, legacy)
        storage.write(key, null)
      } catch {
        /* storage unavailable: read whatever is there */
      }
    }
    return readJson(own)
  }

  /**
   * Forget everything remembered about a board — for when the board itself is
   * deleted, so its entries don't outlive it. Ids are never handed out twice by
   * one database (`canvas_board.id` is AUTOINCREMENT), so this is tidiness, not
   * correctness: a stale entry could never be read by another board.
   */
  function forgetCanvasBoardViewState(boardId: number): void {
    for (const key of BOARD_KEYS) remove(boardKey(key, boardId))
  }

  function isFinitePosition(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v)
  }

  function isPositiveSize(v: unknown): v is number {
    return isFinitePosition(v) && v > 0
  }

  function loadCanvasViewport(boardId: number): CanvasViewport | null {
    const parsed = readBoard(VIEWPORT_KEY, boardId)
    if (!parsed || typeof parsed !== "object") return null
    const obj = parsed as Record<string, unknown>
    if (!isFinitePosition(obj.x) || !isFinitePosition(obj.y)) return null
    if (!isFinitePosition(obj.zoom)) return null
    return {
      x: obj.x,
      y: obj.y,
      zoom: Math.min(Math.max(obj.zoom, CANVAS_MIN_ZOOM), CANVAS_MAX_ZOOM),
    }
  }

  function saveCanvasViewport(
    boardId: number,
    viewport: CanvasViewport | null
  ): void {
    if (!viewport) {
      remove(boardKey(VIEWPORT_KEY, boardId))
      return
    }
    writeJson(boardKey(VIEWPORT_KEY, boardId), viewport)
  }

  function loadIds(key: string, boardId: number): number[] {
    const parsed = readBoard(key, boardId)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is number => Number.isInteger(id))
  }

  /** Pinned cards that were expanded into a live conversation. */
  function loadCanvasExpandedCards(boardId: number): number[] {
    return loadIds(EXPANDED_CARDS_KEY, boardId)
  }

  function saveCanvasExpandedCards(
    boardId: number,
    ids: readonly number[]
  ): void {
    writeJson(boardKey(EXPANDED_CARDS_KEY, boardId), [...ids])
  }

  /** Regions whose "+N more" expander was open. */
  function loadCanvasExpandedRegions(boardId: number): number[] {
    return loadIds(EXPANDED_REGIONS_KEY, boardId)
  }

  function saveCanvasExpandedRegions(
    boardId: number,
    ids: readonly number[]
  ): void {
    writeJson(boardKey(EXPANDED_REGIONS_KEY, boardId), [...ids])
  }

  /**
   * Pinned card id → the ACP connection key its surface must keep using, for the
   * cards minted by a draft's first send: those inherit the DRAFT's key so the
   * send already in flight isn't left on a surface nobody renders (see
   * `materializeDraft`).
   *
   * Remembered for the same reason the expansions are. The key is only the
   * default (`canvas-node-<id>`) for a card that was never a draft, so a card
   * that recomputed it after a route switch would go looking for a connection
   * that lives under the draft's key — and find nothing, while the agent it
   * started keeps running under a key no surface claims any more.
   *
   * Each entry names the card it was written for, and the caller drops any whose
   * node no longer matches. Within one database an id would be enough —
   * `canvas_node.id` is `AUTOINCREMENT`, so ids are never reused, and a node's
   * `conversation_id` is fixed at creation — but this file is deliberately NOT
   * scoped per backend (see the header), and two databases behind one origin
   * hand out the same low ids to entirely different cards. `createdAt` is what
   * survives that: it identifies the node itself rather than its place in some
   * database's counter, so an entry written against another database resolves to
   * nothing, like every other entry here, instead of handing a card a stranger's
   * connection key.
   */

  function loadCanvasSurfaceKeys(
    boardId: number
  ): Map<number, CanvasSurfaceKey> {
    const parsed = readBoard(SURFACE_KEYS_KEY, boardId)
    const keys = new Map<number, CanvasSurfaceKey>()
    if (!Array.isArray(parsed)) return keys
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object") continue
      const entry = raw as Record<string, unknown>
      if (!Number.isInteger(entry.nodeId)) continue
      if (!Number.isInteger(entry.conversationId)) continue
      if (typeof entry.createdAt !== "string" || entry.createdAt === "")
        continue
      if (typeof entry.key !== "string" || entry.key.length === 0) continue
      keys.set(entry.nodeId as number, {
        conversationId: entry.conversationId as number,
        createdAt: entry.createdAt,
        key: entry.key,
      })
    }
    return keys
  }

  function saveCanvasSurfaceKeys(
    boardId: number,
    keys: ReadonlyMap<number, CanvasSurfaceKey>
  ): void {
    if (keys.size === 0) {
      remove(boardKey(SURFACE_KEYS_KEY, boardId))
      return
    }
    writeJson(
      boardKey(SURFACE_KEYS_KEY, boardId),
      [...keys].map(([nodeId, entry]) => ({ nodeId, ...entry }))
    )
  }

  /**
   * Whether the navigator map is showing above the viewport controls.
   *
   * Absent, corrupt, or anything but a literal `false` means shown: the map is
   * the default because it is how a board bigger than the window stays
   * comprehensible, and a user who has never touched the toggle should not have
   * to find it. Only an explicit dismissal is remembered.
   */
  function loadCanvasMinimapVisible(): boolean {
    return readJson(MINIMAP_KEY) !== false
  }

  function saveCanvasMinimapVisible(visible: boolean): void {
    writeJson(MINIMAP_KEY, visible)
  }

  function parseDraft(value: unknown): CanvasDraftCard | null {
    if (!value || typeof value !== "object") return null
    const obj = value as Record<string, unknown>
    if (typeof obj.id !== "string" || obj.id.length === 0) return null
    // Any non-empty string: custom agents mint their own ids, and an agent that
    // has since been uninstalled is corrected by the card's own AgentSelector
    // fallback rather than by throwing the draft away here.
    if (typeof obj.agentType !== "string" || obj.agentType.trim() === "") {
      return null
    }
    if (!isFinitePosition(obj.x) || !isFinitePosition(obj.y)) return null
    // A card with no area is not a card. Zero or negative sizes are only
    // reachable from hand-edited or foreign storage, and they'd restore a window
    // that renders as an invisible sliver the user can neither read nor discard.
    if (!isPositiveSize(obj.width) || !isPositiveSize(obj.height)) return null
    const rawTarget = obj.target
    if (!rawTarget || typeof rawTarget !== "object") return null
    const target = rawTarget as Record<string, unknown>
    const parsedTarget: CanvasDraftCard["target"] | null =
      target.chat === true
        ? { chat: true }
        : Number.isInteger(target.folderId)
          ? { folderId: target.folderId as number }
          : null
    if (!parsedTarget) return null
    return {
      id: obj.id,
      target: parsedTarget,
      agentType: obj.agentType as AgentType,
      // Read leniently and never fatal: an unrecognised value is dropped by
      // `normalizeFolderThemeColor` at paint time anyway, and losing a whole
      // draft — the card AND the text typed into it — over a decoration would be
      // wildly out of proportion.
      ...(typeof obj.color === "string" ? { color: obj.color } : {}),
      x: obj.x,
      y: obj.y,
      width: obj.width,
      height: obj.height,
    }
  }

  /**
   * Unsent draft cards. Their ids are load-bearing: the composer's own text is
   * stored under a key derived from the draft id (`canvas-draft:canvas-draft-…`),
   * so restoring the id restores what the user had typed too.
   */
  function loadCanvasDrafts(boardId: number): CanvasDraftCard[] {
    const parsed = readBoard(DRAFTS_KEY, boardId)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const drafts: CanvasDraftCard[] = []
    for (const raw of parsed) {
      const draft = parseDraft(raw)
      // Ids are the React keys AND the connection keys. A duplicate would mount
      // two cards claiming the same surface, so the first one wins.
      if (!draft || seen.has(draft.id)) continue
      seen.add(draft.id)
      drafts.push(draft)
    }
    return drafts
  }

  function saveCanvasDrafts(
    boardId: number,
    drafts: readonly CanvasDraftCard[]
  ): void {
    if (drafts.length === 0) {
      remove(boardKey(DRAFTS_KEY, boardId))
      return
    }
    writeJson(boardKey(DRAFTS_KEY, boardId), [...drafts])
  }

  return {
    forgetCanvasBoardViewState,
    loadCanvasViewport,
    saveCanvasViewport,
    loadCanvasExpandedCards,
    saveCanvasExpandedCards,
    loadCanvasExpandedRegions,
    saveCanvasExpandedRegions,
    loadCanvasSurfaceKeys,
    saveCanvasSurfaceKeys,
    loadCanvasMinimapVisible,
    saveCanvasMinimapVisible,
    loadCanvasDrafts,
    saveCanvasDrafts,
  }
}

const caches = new WeakMap<
  BackendStoreStorage,
  ReturnType<typeof createCanvasViewStorage>
>()
export function getCanvasViewStorage(storage: BackendStoreStorage) {
  let cache = caches.get(storage)
  if (!cache) {
    cache = createCanvasViewStorage(storage)
    caches.set(storage, cache)
  }
  return cache
}

export const {
  forgetCanvasBoardViewState,
  loadCanvasViewport,
  saveCanvasViewport,
  loadCanvasExpandedCards,
  saveCanvasExpandedCards,
  loadCanvasExpandedRegions,
  saveCanvasExpandedRegions,
  loadCanvasSurfaceKeys,
  saveCanvasSurfaceKeys,
  loadCanvasMinimapVisible,
  saveCanvasMinimapVisible,
  loadCanvasDrafts,
  saveCanvasDrafts,
} = getCanvasViewStorage(defaultBackendStoreStorage)
