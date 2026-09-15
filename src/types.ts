/**
 * Wire vocabulary for the settings-driven MCP registry: the connection status
 * one `mcp` Remote read reports, and the Cordis event that announces a change
 * so configuration surfaces refresh without polling.
 *
 * @module @mcp-manger/mcp-manager/types
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The supervised MCP server set changed: a server was added, removed, or
     * re-created from a changed profile or resolved credential, or one
     * server's connection status transitioned. This payload-free notification
     * fires at each commit point; consumers re-read the registry's `status()`
     * for the new state. Observer failures are contained and cannot veto the
     * registry mutation.
     * @mode emit
     */
    'mcp/servers-updated'(): void
  }
}

/**
 * Live connection status of one settings-driven MCP server, safe to cross the
 * Remote wire: it carries no credential value, only a phase, the tools
 * currently registered under the server's namespace, and — when the initial
 * connection failed — a human diagnostic.
 */
export interface McpServerStatus {
  /** The `servers` dict key naming this server. */
  serverName: string
  /**
   * Connection phase observed by the registry. `connecting` covers the initial
   * attempt; `ready` means the first attempt published tools; `failed` means it
   * did not; `disabled` means the profile carries `disabled: true`, so the
   * supervisor keeps the server dormant until a management surface re-enables
   * it. The mcp-client supervisor owns any later reconnect loop and does not
   * re-surface those transitions here.
   */
  phase: 'connecting' | 'ready' | 'failed' | 'disabled'
  /** Tools currently registered under `mcp__<serverName>__`. */
  toolCount: number
  /**
   * Public names of the tools currently registered under
   * `mcp__<serverName>__`, in registry order; empty unless `phase` is `ready`.
   * Management surfaces render them as the server's tool inventory.
   */
  toolNames: string[]
  /** Human-readable initial-connection failure; absent unless `phase` is `failed`. */
  error?: string
}

/**
 * The `mcp` settings section as a management surface edits it: the stored user
 * layer verbatim (credential references ride as references, never values),
 * plus the document facts the configuration editor's path bar and revision
 * guard render.
 */
export interface McpSectionView {
  /** Whether the backing settings provider accepts writes. */
  writable: boolean
  /**
   * Local path of the settings document the section lives in; absent when the
   * deployment mounts no file-backed provider, in which case the entry config
   * alone drives the supervisor and writes are refused.
   */
  documentPath?: string
  /** Provider revision the view was read at; pass back as the write guard. */
  revision: number
  /** Stored user-layer server profiles keyed by mcp-client `serverName`. */
  servers: Record<string, unknown>
}
