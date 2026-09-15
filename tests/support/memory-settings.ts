/**
 * In-memory settings provider fixture, vendored from the dsh settings
 * package's own test support so this workspace's suites run without reaching
 * into the harness tree. The smallest real subclass of the Service Definition;
 * identical behavior, imports rewritten to the package face, plus an optional
 * `documentPath` so the section-view tests can pin the editor's path bar.
 */

import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** In-memory provider exposing the protected provider hooks to tests. */
export class MemorySettings extends SettingsProvider {
  /** Raw document the provider "storage" currently holds. */
  doc: Record<string, unknown>
  /** Every persist() call observed, in order. */
  persisted: Array<{ ns: SettingsNamespace; section: Record<string, unknown> }> = []
  /** When false, update() must reject before reaching persist(). */
  writableFlag: boolean

  /** Artificial persist latency so tests can interleave concurrent updates. */
  persistDelayMs: number

  /** Optional document path the section view rides to the editor's path bar. */
  private readonly pathFlag: string | undefined

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: {
    doc?: Record<string, unknown>
    writable?: boolean
    persistDelayMs?: number
    documentPath?: string
  }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
    this.writableFlag = options?.writable ?? true
    this.persistDelayMs = options?.persistDelayMs ?? 0
    this.pathFlag = options?.documentPath
  }

  get writable(): boolean {
    return this.writableFlag
  }

  override get documentPath(): string | undefined {
    return this.pathFlag
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    if (this.persistDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.persistDelayMs))
    }
    this.persisted.push({ ns, section: structuredClone(section) })
    this.doc[ns] = structuredClone(section)
  }

  /** Simulate an external storage change reaching the provider. */
  pushExternal(doc: Record<string, unknown>): void {
    this.doc = structuredClone(doc)
    this.publish(structuredClone(doc))
  }
}
