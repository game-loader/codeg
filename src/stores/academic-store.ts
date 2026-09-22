import { create } from "zustand"
import {
  academicLibrary,
  academicPaperGet,
  academicSelect,
  academicSettingsGet,
  type AcademicLibrary,
  type AcademicPaper,
  type AcademicSettings,
} from "@/lib/academic"
import { registerBackendScopedStoreReset } from "./backend-scoped-store-reset"

interface AcademicState {
  library: AcademicLibrary | null
  settings: AcademicSettings | null
  selectedCollectionKey: string | null
  selectedItemKey: string | null
  selectedPaper: AcademicPaper | null
  loadingLibrary: boolean
  loadingPaper: boolean
  error: string | null
  refreshLibrary: () => Promise<void>
  loadSettings: () => Promise<void>
  selectItem: (itemKey: string) => Promise<void>
  refreshPaper: (paperId: string) => Promise<void>
  showPaper: (paper: AcademicPaper) => void
  reset: () => void
}

const initialState = {
  library: null,
  settings: null,
  selectedCollectionKey: null,
  selectedItemKey: null,
  selectedPaper: null,
  loadingLibrary: false,
  loadingPaper: false,
  error: null,
}

let selectionVersion = 0
let libraryVersion = 0
let paperVersion = 0
let epoch = 0
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export const useAcademicStore = create<AcademicState>((set, get) => ({
  ...initialState,
  async refreshLibrary() {
    const version = ++libraryVersion
    set({ loadingLibrary: true, error: null })
    try {
      const library = await academicLibrary()
      if (version === libraryVersion) {
        set({ library })
      }
    } catch (error) {
      if (version === libraryVersion) set({ error: errorMessage(error) })
    } finally {
      if (version === libraryVersion) {
        set({ loadingLibrary: false })
        const selected = get().selectedPaper
        if (selected) await get().refreshPaper(selected.id)
      }
    }
  },
  async loadSettings() {
    const requestedEpoch = epoch
    try {
      const settings = await academicSettingsGet()
      if (requestedEpoch === epoch) set({ settings })
    } catch (error) {
      if (requestedEpoch === epoch) set({ error: errorMessage(error) })
    }
  },
  async selectItem(itemKey) {
    if (get().selectedItemKey === itemKey && get().loadingPaper) return
    const version = ++selectionVersion
    ++paperVersion
    set({
      selectedItemKey: itemKey,
      selectedPaper: null,
      loadingPaper: true,
      error: null,
    })
    try {
      const paper = await academicSelect(itemKey)
      if (version === selectionVersion) {
        set({ selectedPaper: paper })
        // Preparation may finish before the select response reaches the UI;
        // that event had no selected paper to refresh. Reconcile once after
        // establishing its identity, then rely on normal change events.
        await get().refreshPaper(paper.id)
      }
    } catch (error) {
      if (version === selectionVersion) set({ error: errorMessage(error) })
    } finally {
      if (version === selectionVersion) set({ loadingPaper: false })
    }
  },
  showPaper(paper) {
    ++selectionVersion
    ++paperVersion
    set({
      selectedItemKey: paper.item_key,
      selectedPaper: paper,
      loadingPaper: false,
      error: null,
    })
  },
  async refreshPaper(paperId) {
    if (get().selectedPaper?.id !== paperId) return
    const version = ++paperVersion
    const selection = selectionVersion
    try {
      const paper = await academicPaperGet(paperId)
      if (
        version === paperVersion &&
        selection === selectionVersion &&
        get().selectedPaper?.id === paperId
      ) {
        set({ selectedPaper: paper })
      }
    } catch (error) {
      if (version === paperVersion && selection === selectionVersion) {
        set({ error: errorMessage(error) })
      }
    }
  },
  reset() {
    ++epoch
    ++selectionVersion
    ++libraryVersion
    ++paperVersion
    set(initialState)
  },
}))

registerBackendScopedStoreReset(() => useAcademicStore.getState().reset())
