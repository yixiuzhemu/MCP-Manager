/**
 * File-backed MCP registry plugin: supervises many MCP server connections
 * from a standalone JSON document (`~/.dsh/mcp.json`) and exposes the `mcp`
 * Remote namespace so a configuration surface can read each server's live
 * connection status.
 *
 * The plugin hands the resolved section to a {@link ServerSupervisor}, which
 * owns one mcp-client connection per server and re-creates only what a file
 * write or a rotated credential changed. Each server's tools register on
 * `ctx.tools` under its `mcp__<serverName>__` namespace, exactly as the
 * single-instance mcp-client plugin does. Disposal stops the document
 * watcher, quiesces the reconcile chain, then disconnects every live server.
 *
 * @module @mcp-manager/mcp-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { ServerProfileSchema } from './config.ts'
import type { RegistryConfig, ServerProfile } from './config.ts'
import { FileSectionStore } from './file-section.ts'
import { ServerSupervisor } from './supervisor.ts'
import type { McpSectionView, McpServerStatus } from './types.ts'

export type { HttpServerProfile, RegistryConfig, ServerProfile, StdioServerProfile } from './config.ts'
export type { McpSectionView, McpServerStatus } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `mcp` Remote namespace and the settings-driven server supervisor. */
    mcpRegistry: McpRegistry
  }
}

// Merge this owner's failure codes into the shared Remote vocabulary: `RemoteError`
// types `code`/`details` against `RemoteErrorDetailsMap`, so every code thrown below
// must be declared here (exactly as the Gateway declares its `gateway/*` codes).
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The `mcp` section was disposed between a write and this read-back. */
    'mcp/section-missing': {}
    /** No settings provider is mounted; the section is author-only via the entry config. */
    'mcp/read-only': {}
    /** The settings provider refused the section write. */
    'mcp/rejected': {}
    /** The section names no server by that key. */
    'mcp/not-found': { readonly serverName: string }
  }
}

/**
 * Host service backing the generated `ctx.remote.mcp` namespace. It resolves the
 * supervised server set from the `mcp` settings section, reports each server's
 * live connection status, and carries the management operations a configuration
 * surface drives: enable/disable, remove, restart, and the raw section read /
 * write the JSON editor submits. A status carries a phase and a tool inventory
 * but never a credential value.
 */
export class McpRegistry extends TypertRemoteService {
  /** Tools must be mounted before the supervisor registers any server's tools. */
  static inject = ['tools']

  /**
   * Plugin config schema, doubling as the `mcp` settings-section shape. The
   * literal stays in this entry file because `gen-config-catalog` walks a
   * plugin's schema from there.
   */
  static Config = z.object({
    servers: z.dict(ServerProfileSchema).default({}),
  }) as unknown as z<RegistryConfig>

  private readonly supervisor: ServerSupervisor
  /** Entry config fallback layered under the file document. */
  private readonly entryConfig: RegistryConfig
  /** Standalone JSON document backing the MCP section. */
  private readonly file: FileSectionStore

  /**
   * Register the `mcp` namespace, hand the supervisor the entry config as its
   * fallback source, and layer the file document over it. Tools are injected,
   * so the constructor kicks the first reconcile.
   * @param ctx - Host context providing the tools registry, optional credentials, and logger.
   * @param config - resolved `mcp` section: the composition entry config, which
   *   the `static Config` schema always resolves to `{ servers: {} }` at minimum.
   */
  constructor(ctx: Context, config: RegistryConfig) {
    super(ctx, 'mcpRegistry', { namespace: 'mcp' })
    this.entryConfig = config
    // Standalone JSON document: the sole persistent store for MCP config.
    this.file = new FileSectionStore(() => this.supervisor.scheduleReconcile())
    // Startup marker: lets an operator confirm which host build is actually loaded.
    ctx.logger.info(`mcp-registry: section document at ${this.file.path}`)
    // The supervisor reads through one dispatcher that layers the file document
    // over the entry config.
    this.supervisor = new ServerSupervisor(ctx, () => this.resolveSection())
    // Teardown stops the document watcher, quiesces the reconcile chain, then
    // disconnects every live server; it runs on this fiber.
    ctx.effect(() => () => {
      this.file.stop()
      return this.supervisor.disposeAll()
    }, 'mcp-registry.supervisor')
    void this.file.start().catch((error: unknown) => {
      ctx.logger.error('mcp-registry: watching the section document failed')
      ctx.logger.error(error)
    })
    // Tools are injected, so the registry is mounted: kick the first reconcile.
    this.supervisor.markToolsReady()
  }

  /**
   * The section the supervisor reconciles: the entry config layered under the
   * file document's user layer.
   * @returns the currently authoritative `mcp` section.
   */
  private resolveSection(): RegistryConfig {
    return {
      servers: {
        ...this.entryConfig.servers,
        ...this.file.servers as unknown as Record<string, ServerProfile>,
      },
    }
  }

  /**
   * Snapshot every supervised server's live connection status.
   * @returns detached statuses ordered by server name, connected, failed, and disabled alike.
   */
  @Remote
  status(): McpServerStatus[] {
    return this.supervisor.status()
  }

  /**
   * Read the `mcp` section the way a management surface edits it: the stored
   * user layer verbatim plus the document facts the editor's path bar renders.
   * @returns the section view backed by the standalone `mcp.json` document.
   */
  @Remote
  readSection(): McpSectionView {
    return {
      writable: true,
      documentPath: this.file.path,
      revision: this.file.revision,
      servers: this.file.servers,
    }
  }

  /**
   * Replace the `mcp` section's server dict wholesale — the write the JSON
   * configuration editor submits. The section schema validates the replacement,
   * so an invalid document is refused here.
   * @param servers - server profiles keyed by mcp-client `serverName`.
   * @param expectedRevision - revision the editor read; `undefined` writes unconditionally.
   * @returns the section view after the write.
   * @throws RemoteError when the write is stale, invalid, or refused.
   */
  @Remote
  async writeSection(servers: Record<string, unknown>, expectedRevision: number | undefined): Promise<McpSectionView> {
    if (expectedRevision !== undefined && expectedRevision !== this.file.revision) {
      throw new RemoteError('mcp/rejected', `stale write: the document moved past revision ${String(expectedRevision)}`, {})
    }
    try {
      McpRegistry.Config({ servers } as never)
    } catch (error: unknown) {
      throw new RemoteError('mcp/rejected', error instanceof Error ? error.message : String(error), {}, { cause: error })
    }
    try {
      await this.file.save(servers)
    } catch (error: unknown) {
      throw new RemoteError('mcp/rejected', error instanceof Error ? error.message : String(error), {}, { cause: error })
    }
    this.supervisor.scheduleReconcile()
    await this.supervisor.settled()
    // Wait for any new/recreated connections to settle so the client's
    // response carries the post-connect status instead of "connecting".
    await this.supervisor.awaitConnections()
    return this.readSection()
  }

  /**
   * Enable or disable one supervised server by flipping its profile's
   * `disabled` flag in the stored section; the profile itself is kept, so a
   * disabled server can be re-enabled without re-authoring it.
   * @param serverName - the `servers` dict key to flip.
   * @param enabled - true clears the flag and reconnects; false parks the server.
   * @returns statuses after the write's reconcile settled.
   * @throws RemoteError when the section names no such server or the write is refused.
   */
  @Remote
  async setEnabled(serverName: string, enabled: boolean): Promise<McpServerStatus[]> {
    const view = this.readSection()
    const profile = view.servers[serverName]
    if (profile === undefined || typeof profile !== 'object' || profile === null) {
      throw new RemoteError('mcp/not-found', `the mcp section names no server "${serverName}"`, { serverName })
    }
    const next = { ...view.servers, [serverName]: { ...(profile as Record<string, unknown>), disabled: !enabled } }
    await this.writeSection(next, view.revision)
    return this.status()
  }

  /**
   * Remove one server profile from the stored section; its live connection is
   * torn down by the reconcile the write triggers.
   * @param serverName - the `servers` dict key to delete.
   * @returns statuses after the write's reconcile settled.
   * @throws RemoteError when the section names no such server or the write is refused.
   */
  @Remote
  async removeServer(serverName: string): Promise<McpServerStatus[]> {
    const view = this.readSection()
    if (!(serverName in view.servers)) {
      throw new RemoteError('mcp/not-found', `the mcp section names no server "${serverName}"`, { serverName })
    }
    const next = { ...view.servers }
    delete next[serverName]
    await this.writeSection(next, view.revision)
    return this.status()
  }

  /**
   * Re-create one server's connection from its unchanged profile — the refresh
   * action of a management surface.
   * @param serverName - the `servers` dict key to reconnect.
   * @returns statuses after the restart pass settled.
   */
  @Remote
  async restart(serverName: string): Promise<McpServerStatus[]> {
    this.supervisor.restart(serverName)
    await this.supervisor.settled()
    await this.supervisor.awaitConnections()
    return this.status()
  }

  /**
   * Server-side HTTP proxy for the MCP market. The browser client cannot reach
   * external APIs directly because the Electron origin (`dsh-app://app`) is
   * blocked by CORS; this method runs in Node.js where CORS does not apply.
   * @param url - the fully-qualified URL to fetch.
   * @returns the response body as a UTF-8 string.
   * @throws RemoteError when the request fails or returns a non-2xx status.
   */
  @Remote
  async fetchMarket(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new RemoteError('mcp/rejected', `market fetch failed: HTTP ${response.status} ${response.statusText}`, {})
    }
    return response.text()
  }
}

export default McpRegistry
