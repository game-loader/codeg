import type { CallTarget } from "@/lib/transport"

/**
 * Trailing argument list for an API call that may target another machine.
 * Spread it (`fn(a, ...targetArgs(target))`) so a call on the window's own
 * backend keeps exactly the arguments it had before targets existed.
 */
export function targetArgs(target?: CallTarget): [] | [CallTarget] {
  return target ? [target] : []
}
