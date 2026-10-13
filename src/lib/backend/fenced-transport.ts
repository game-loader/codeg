import { isProjectIdentityUnsupported } from "./project-catalog"
import type {
  AttachHandlers,
  AttachOptions,
  CallOptions,
  EventStream,
  EventStreamSubscription,
  Transport,
  UnsubscribeFn,
} from "@/lib/transport/types"
import type { BackendLifetime } from "./registry"

export class BackendRetiredError extends Error {
  readonly code = "backend_retired"

  constructor() {
    super("The workspace connection changed; reload this workspace")
    this.name = "BackendRetiredError"
  }
}

/** Drops results and events from a replaced connection before stores see them. */
export class FencedTransport implements Transport {
  private destroyed = false
  private stream: EventStream | null = null
  readonly eventStream?: () => EventStream

  constructor(
    private readonly inner: Transport,
    private readonly lifetime: BackendLifetime,
    private readonly ownsInner = true
  ) {
    // Local IPC uses the legacy subscription path. Preserve the absence of an
    // attach protocol rather than advertising a method that throws.
    if (inner.eventStream) this.eventStream = () => this.createEventStream()
  }

  private isCurrent(): boolean {
    return !this.destroyed && this.lifetime.isCurrent()
  }

  private assertCurrent(): void {
    if (!this.isCurrent()) throw new BackendRetiredError()
  }

  async call<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: CallOptions
  ): Promise<T> {
    this.assertCurrent()
    try {
      const result = await this.inner.call<T>(command, args, options)
      this.assertCurrent()
      this.lifetime.setStatus("connected")
      return result
    } catch (error) {
      this.assertCurrent()
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null
      if (code === "authentication_failed") {
        this.lifetime.setStatus("unauthorized")
      } else if (
        (code === "network_error" || code === "network") &&
        !(
          command === "list_repository_project_identities" &&
          isProjectIdentityUnsupported(error)
        )
      ) {
        this.lifetime.setStatus("offline")
      }
      throw error
    }
  }

  async subscribe<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<UnsubscribeFn> {
    this.assertCurrent()
    const unsubscribe = await this.inner.subscribe<T>(event, (payload) => {
      if (this.isCurrent()) handler(payload)
    })
    if (!this.isCurrent()) {
      unsubscribe()
      throw new BackendRetiredError()
    }
    return unsubscribe
  }

  isDesktop(): boolean {
    return this.inner.isDesktop()
  }

  onReconnect(callback: () => void): UnsubscribeFn {
    return (
      this.inner.onReconnect?.(() => {
        if (!this.isCurrent()) return
        this.lifetime.setStatus("connected")
        callback()
      }) ?? (() => {})
    )
  }

  async waitForReady(): Promise<void> {
    this.assertCurrent()
    await this.inner.waitForReady?.()
    this.assertCurrent()
  }

  private createEventStream(): EventStream {
    this.assertCurrent()
    if (this.stream) return this.stream
    const inner = this.inner.eventStream?.()
    if (!inner) {
      throw new Error("This backend does not support session event streams")
    }
    this.stream = {
      attach: (
        connectionId: string,
        options: AttachOptions,
        handlers: AttachHandlers
      ): EventStreamSubscription => {
        this.assertCurrent()
        return inner.attach(connectionId, options, {
          onSnapshot: (snapshot, seq) => {
            if (this.isCurrent()) handlers.onSnapshot(snapshot, seq)
          },
          onReplay: (events, seq) => {
            if (this.isCurrent()) handlers.onReplay(events, seq)
          },
          onEvent: (event) => {
            if (this.isCurrent()) handlers.onEvent(event)
          },
          onDetached: (reason) => {
            if (this.isCurrent()) handlers.onDetached(reason)
          },
        })
      },
    }
    return this.stream
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.ownsInner) this.inner.destroy?.()
  }
}
