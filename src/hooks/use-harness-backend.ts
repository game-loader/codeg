import { useOptionalBackendClient } from "@/contexts/backend-client-context"
import { harnessBackendFor } from "@/lib/harness/backend"

export function useHarnessBackend() {
  return harnessBackendFor(useOptionalBackendClient())
}
