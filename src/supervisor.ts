/**
 * Multi-connection supervisor: holds one live mcp-client connection per
 * configured server, diffs each server's registration facts against the last
 * reconcile, and re-creates only what changed. Reconcile passes are serialized
 * on a promise chain, so a settings write and a tools-ready signal can never
 * interleave two diffs; one server's failure is contained and never fails the
 * whole section.
 *
 * @module @mcp-manger/mcp-manager/supervisor
 */

import type { Context } from '@deepseek-ai/cordis'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { resolveReconnectPolicy, SERVER_NAME_PATTERN, startConnection } from './connection/index.ts'
import type { ConnectionHandle, Config as McpClientConfig, ResolvedReconnectPolicy } from './connection/index.ts'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'
import { buildClientConfig, registrationFacts } from './config.ts'
import type { RegistryConfig } from './config.ts'
import { resolveProfileSecrets } from './credentials.ts'
import type { McpServerStatus } from './types.ts'

/** One live supervised connection and the facts it was created from. */
interface ServerEntry {
  /** Registration snapshot the next reconcile diffs against. */
  facts: unknown
  /** The mcp-client connection handle; disposed on removal or re-creation. */
  handle: ConnectionHandle
  /** Last observed status, updated when the initial attempt settles. */
  status: McpServerStatus
}

/** Render any thrown value as a human diagnostic. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Supervise every server in the current `mcp` settings section. The controller
 * feeds it a config source and signals when the tools registry and settings are
 * ready; the supervisor owns the connection map, the reconcile chain, and the
 * `mcp/servers-updated` notification.
 */
export class ServerSupervisor {
  private readonly entries = new Map<string, ServerEntry>()
  private readonly failures = new Map<string, string>()
  /** Servers whose profile carries `disabled: true`; dormant, listed as such. */
  private readonly disabledNames = new Set<string>()
  /** In-flight connection ready promises; `awaitConnections` drains them. */
  private readonly pendingConnections = new Set<Promise<unknown>>()
  private source: () => RegistryConfig
  private toolsReady = false
  private chain: Promise<void> = Promise.resolve()
  private disposed = false

  /**
   * @param ctx - Cordis context providing the tools registry, credentials, and logger.
   * @param source - returns the `mcp` section to supervise; a supervisor never
   *   reconciles without one, so the owner states it at construction.
   */
  constructor(private readonly ctx: Context, source: () => RegistryConfig) {
    this.source = source
  }

  /**
   * Point the supervisor at a different live settings source.
   * @param source - returns the currently resolved `mcp` section.
   */
  setSource(source: () => RegistryConfig): void {
    this.source = source
  }

  /** Record that the tools registry is mounted and kick the first reconcile. */
  markToolsReady(): void {
    this.toolsReady = true
    this.scheduleReconcile()
  }

  /** Queue one reconcile pass behind any in-flight pass; failures are contained. */
  scheduleReconcile(): void {
    this.chain = this.chain
      .then(() => this.reconcile())
      .catch((error: unknown) => {
        this.ctx.logger.error('mcp-registry: a reconcile pass failed')
        this.ctx.logger.error(error)
      })
  }

  /**
   * Await every in-flight connection's initial ready promise so a caller
   * (typically `writeSection`) can return the post-settle status to the
   * client without waiting for the forwarded event channel.
   */
  async awaitConnections(): Promise<void> {
    const pending = [...this.pendingConnections]
    if (pending.length > 0) {
      await Promise.all(pending.map(async (p) => { try { await p } catch { /* contained by observeReady */ } }))
    }
  }

  /**
   * Await every queued reconcile pass; management reads use it so an answer
   * composed after a write observes the write's reconcile outcome.
   * @returns resolution of the in-flight (and queued) pass chain.
   */
  settled(): Promise<void> {
    return this.chain
  }

  /**
   * Force one server's connection to be re-created: dispose the live handle
   * (or clear a recorded failure) on the reconcile chain, then run a pass that
   * reconnects the server from its current profile.
   * @param serverName - the `servers` dict key to restart; unknown names no-op.
   */
  restart(serverName: string): void {
    this.chain = this.chain
      .then(async () => {
        if (this.disposed) return
        const entry = this.entries.get(serverName)
        if (entry !== undefined) {
          this.entries.delete(serverName)
          await this.disposeHandle(serverName, entry.handle)
        }
        this.failures.delete(serverName)
        await this.reconcile()
      })
      .catch((error: unknown) => {
        this.ctx.logger.error(`mcp-registry: restarting server "${serverName}" failed`)
        this.ctx.logger.error(error)
      })
  }

  /**
   * Snapshot every server's current status, connected, failed, and disabled
   * alike; a ready server carries its live tool inventory.
   * @returns detached statuses ordered by server name.
   */
  status(): McpServerStatus[] {
    const statuses: McpServerStatus[] = []
    for (const entry of this.entries.values()) {
      const serverName = entry.status.serverName
      statuses.push({ ...entry.status, toolNames: this.toolNames(serverName) })
    }
    for (const [serverName, error] of this.failures) {
      statuses.push({ serverName, phase: 'failed', toolCount: 0, toolNames: [], error })
    }
    for (const serverName of this.disabledNames) {
      statuses.push({ serverName, phase: 'disabled', toolCount: 0, toolNames: [] })
    }
    return statuses.sort((left, right) => left.serverName.localeCompare(right.serverName))
  }

  /**
   * Await the in-flight reconcile, then dispose every live connection
   * concurrently. Called once when the owning plugin fiber unloads.
   */
  async disposeAll(): Promise<void> {
    this.disposed = true
    // Let a queued pass finish (it early-returns once disposed) so it cannot
    // start a connection after teardown collects the handles.
    /* v8 ignore next -- scheduleReconcile's trailing catch makes the chain always resolve; the guard is defensive. */
    await this.chain.catch(() => {})
    const entries = [...this.entries.values()]
    this.entries.clear()
    this.failures.clear()
    this.disabledNames.clear()
    this.pendingConnections.clear()
    await Promise.all(entries.map(async (entry) => {
      try {
        await entry.handle.dispose()
      } catch (error) {
        this.ctx.logger.error(`mcp-registry: disposing server "${entry.status.serverName}" failed`)
        this.ctx.logger.error(error)
      }
    }))
  }

  /** One diff-and-apply pass over the current section; never throws. */
  private async reconcile(): Promise<void> {
    if (this.disposed || !this.toolsReady) return
    const servers = this.source().servers
    const nextNames = new Set(Object.keys(servers))
    let changed = false

    // Drop servers the section no longer names.
    for (const [name, entry] of [...this.entries]) {
      if (nextNames.has(name)) continue
      this.entries.delete(name)
      changed = true
      await this.disposeHandle(name, entry.handle)
    }
    for (const name of [...this.failures.keys()]) {
      if (nextNames.has(name)) continue
      this.failures.delete(name)
      changed = true
    }
    for (const name of [...this.disabledNames]) {
      if (nextNames.has(name)) continue
      this.disabledNames.delete(name)
      changed = true
    }

    // Add, re-create, or leave each configured server.
    for (const [name, profile] of Object.entries(servers)) {
      if (this.disposed) return
      if (!SERVER_NAME_PATTERN.test(name)) {
        changed = await this.recordFailure(name, `serverName "${name}" must match ${String(SERVER_NAME_PATTERN)}`) || changed
        continue
      }
      // A disabled profile keeps the server dormant: tear down whatever lived
      // under its name so a toggle off never leaves tools registered.
      if (profile.disabled === true) {
        const live = this.entries.get(name)
        if (live !== undefined) {
          this.entries.delete(name)
          changed = true
          await this.disposeHandle(name, live.handle)
        }
        if (this.failures.delete(name)) changed = true
        if (!this.disabledNames.has(name)) {
          this.disabledNames.add(name)
          changed = true
        }
        continue
      }
      if (this.disabledNames.delete(name)) changed = true
      let clientConfig: McpClientConfig
      let policy: ResolvedReconnectPolicy
      let facts: unknown
      try {
        const secrets = await resolveProfileSecrets(this.ctx, name, profile)
        clientConfig = buildClientConfig(name, profile, secrets.values)
        policy = resolveReconnectPolicy(clientConfig.reconnect, `mcp(${name}): reconnect`)
        facts = registrationFacts(name, profile, policy, secrets.fingerprint)
      } catch (error) {
        // A resolution or projection failure tears down any live connection for
        // this server and marks it failed, contained: the rest still reconcile.
        changed = await this.recordFailure(name, errorMessage(error)) || changed
        continue
      }
      const clearedFailure = this.failures.delete(name)
      const existing = this.entries.get(name)
      if (existing !== undefined && deepEqualJson(existing.facts, facts)) {
        /* v8 ignore next -- a name in failures never has a live entry: recordFailure deletes it, and a resolve clears the failure before creating one. */
        if (clearedFailure) changed = true
        continue
      }
      if (existing !== undefined) {
        this.entries.delete(name)
        await this.disposeHandle(name, existing.handle)
      }
      const handle = startConnection(this.ctx, clientConfig, policy)
      const entry: ServerEntry = {
        facts,
        handle,
        status: { serverName: name, phase: 'connecting', toolCount: 0, toolNames: [] },
      }
      this.entries.set(name, entry)
      changed = true
      this.observeReady(name, entry)
    }

    if (changed && !this.disposed) this.emitUpdated()
  }

  /**
   * Mark one server failed before it ever connected, disposing a live
   * connection for the same name so a server whose secret vanished is torn down
   * rather than left running on stale credentials.
   * @returns whether the observable state changed.
   */
  private async recordFailure(name: string, message: string): Promise<boolean> {
    let changed = false
    const existing = this.entries.get(name)
    if (existing !== undefined) {
      this.entries.delete(name)
      changed = true
      await this.disposeHandle(name, existing.handle)
    }
    if (this.failures.get(name) !== message) {
      this.failures.set(name, message)
      changed = true
    }
    this.ctx.logger.error(`mcp-registry: ${message}`)
    return changed
  }

  /** Dispose one connection, containing and logging a teardown failure. */
  private async disposeHandle(name: string, handle: ConnectionHandle): Promise<void> {
    try {
      await handle.dispose()
    } catch (error) {
      this.ctx.logger.error(`mcp-registry: disposing server "${name}" failed`)
      this.ctx.logger.error(error)
    }
  }

  /**
   * Attach the initial-attempt observer: when the connection's `ready` settles,
   * flip this server's status to `ready` (with its live tool count) or `failed`
   * and announce the change. A superseded or removed entry is ignored.
   */
  private observeReady(name: string, entry: ServerEntry): void {
    const readyPromise = entry.handle.ready.then(
      (outcome) => {
        if (this.disposed || this.entries.get(name) !== entry) return
        entry.status = outcome.error !== undefined
          ? { serverName: name, phase: 'failed', toolCount: 0, toolNames: [], error: errorMessage(outcome.error) }
          : { serverName: name, phase: 'ready', toolCount: this.countTools(name), toolNames: this.toolNames(name) }
        this.emitUpdated()
      },
      /* v8 ignore next -- mcp-client's ready never rejects; contained defensively. */
      (error: unknown) => {
        if (this.disposed || this.entries.get(name) !== entry) return
        entry.status = { serverName: name, phase: 'failed', toolCount: 0, toolNames: [], error: errorMessage(error) }
        this.emitUpdated()
      },
    )
    this.pendingConnections.add(readyPromise)
    void readyPromise.finally(() => this.pendingConnections.delete(readyPromise))
  }

  /** Public tool names currently registered under one server's namespace. */
  private toolNames(serverName: string): string[] {
    const prefix = `mcp__${serverName}__`
    return this.ctx.tools.schemas()
      .filter(schema => schema.name.startsWith(prefix))
      .map(schema => schema.name)
  }

  /** Count the tools currently registered under one server's namespace. */
  private countTools(serverName: string): number {
    return this.toolNames(serverName).length
  }

  /* jscpd:ignore-start -- deliberate symmetry with the llm and credentials
     contained fan-out: one broken observer must not starve the rest, and the
     shape is the reviewed non-vetoing notification contract. */
  /** Publish `mcp/servers-updated` with contained listener failures. */
  private emitUpdated(): void {
    let invariantFailure: unknown
    for (const listener of this.ctx.events.dispatch('emit', ['mcp/servers-updated']) as Array<() => unknown>) {
      try {
        const returned = listener()
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
  /* jscpd:ignore-end */

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(error: unknown): void {
    this.ctx.logger.warn('mcp-registry: an mcp/servers-updated listener failed')
    this.ctx.logger.warn(error)
  }
}
