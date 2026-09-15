/**
 * Standalone JSON store for the `mcp` section: a single document
 * (`mcp.json` under the dsh profile directory, e.g. `~/.dsh/mcp.json`)
 * that is the sole backing store for MCP server configuration. The store
 * owns the raw `servers` dict (the user layer), a monotonic revision used
 * as the editor's stale-write guard, and a polling watcher so an external
 * hand-edit reaches the supervisor without a restart.
 *
 * @module @mcp-manager/mcp-manager/file-section
 */

import { watchFile, unwatchFile } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Default document name, resolved under the dsh profile directory. */
export const DEFAULT_SECTION_DOCUMENT = 'mcp.json'

/** dsh profile directory name under the user's home. */
const DSH_DIR = '.dsh'

/**
 * Read/write the workspace `mcp` section document and announce external
 * changes. One instance per registry; started at mount, stopped at dispose.
 */
export class FileSectionStore {
  /** Absolute path of the backing JSON document. */
  readonly path: string

  /** The raw user-layer server profiles last observed in the document. */
  private current: Record<string, unknown> = {}
  /** Monotonic revision: bumps on every observed or applied change. */
  private rev = 0
  private readonly change: () => void

  /**
   * @param onChange - invoked after each observed change so the owner can
   *   re-reconcile; also fired once after the initial load.
   * @param filename - document name under the dsh profile directory.
   */
  constructor(onChange: () => void, filename: string = DEFAULT_SECTION_DOCUMENT) {
    this.path = resolve(homedir(), DSH_DIR, filename)
    this.change = onChange
  }

  /** The user-layer servers as last observed. */
  get servers(): Record<string, unknown> {
    return this.current
  }

  /** The revision the current view was read at. */
  get revision(): number {
    return this.rev
  }

  /** Load the document (absent/invalid reads as empty) and start watching it. */
  async start(): Promise<void> {
    await this.reload()
    watchFile(this.path, { interval: 1000 }, () => { void this.reload() })
  }

  /** Stop watching the document. */
  stop(): void {
    unwatchFile(this.path)
  }

  /** Replace the document's `servers` dict wholesale and bump the revision. */
  async save(servers: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, `${JSON.stringify({ servers }, null, 2)}\n`, 'utf8')
    this.current = servers
    this.rev += 1
  }

  /** Re-read the document from disk, bumping the revision and announcing it. */
  private async reload(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as { servers?: unknown }
      this.current = raw !== null && typeof raw === 'object' && raw.servers !== null && typeof raw.servers === 'object'
        ? raw.servers as Record<string, unknown>
        : {}
    } catch {
      // An absent or unparseable document reads as an empty user layer; the
      // supervisor simply sees no file-authored servers.
      this.current = {}
    }
    this.rev += 1
    this.change()
  }
}
