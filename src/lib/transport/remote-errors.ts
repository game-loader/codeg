export const REMOTE_CONFIGURATION_CHANGED_MESSAGE =
  "Remote connection configuration changed; close and reopen this window."

export function isRemoteConfigurationChanged(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    String(err.message).startsWith("Remote connection configuration changed;")
  )
}
