"use client"

import { useBackendStoreSelection } from "@/contexts/backend-stores-selection-context"
import { useOptionalBackendClient } from "@/contexts/backend-client-context"
import type { BackendClient } from "@/lib/backend/types"
import {
  createAskConversationDrawerStore,
  useAskConversationDrawerStore,
} from "@/stores/ask-conversation-drawer-store"
import {
  createBackendStoreStorage,
  type BackendStoreStorage,
} from "@/stores/backend-store-storage"

const stores = new WeakMap<
  BackendStoreStorage | BackendClient,
  typeof useAskConversationDrawerStore
>()

export function useAskDrawerStore() {
  const storage = useBackendStoreSelection()?.storage
  const client = useOptionalBackendClient()
  const scoped = storage?.backendKey !== undefined ? storage : null
  const owner = scoped ?? client
  if (!owner) return useAskConversationDrawerStore
  let store = stores.get(owner)
  if (!store) {
    const preferences =
      scoped?.selectorPreferences ??
      (client
        ? createBackendStoreStorage(client.key).selectorPreferences
        : undefined)
    store = createAskConversationDrawerStore(preferences)
    stores.set(owner, store)
  }
  return store
}
