/**
 * Plugin wiring tests: how `McpRegistry` binds the `mcp` Remote namespace,
 * hands its composition entry config to the supervisor, and layers the optional
 * `mcp` user-settings section over it. `startConnection` is mocked, so a test
 * observes which servers the wiring asked for without spawning a transport.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { remoteMethods, RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionHandle, ConnectionOutcome } from '@mcp-manger/mcp-manager/src/connection/index.ts'
import { MemorySettings } from './support/memory-settings.ts'

/** One mocked connection and the two facts a wiring test asserts on. */
interface FakeConnection {
  /** The projected mcp-client config, carrying the dict key as `serverName`. */
  config: unknown
  dispose: ReturnType<typeof vi.fn>
}

// vi.mock factories are hoisted above imports, so the fn and the connection
// ledger must be created inside vi.hoisted to exist when the factory runs.
const { mockStartConnection, connections } = vi.hoisted(() => {
  const connections: FakeConnection[] = []
  const mockStartConnection = vi.fn()
  return { mockStartConnection, connections }
})

vi.mock('@mcp-manger/mcp-manager/src/connection/index.ts', async (importOriginal) => {
  // Keep the real config schema, policy resolver, and serverName grammar; swap
  // only the connection starter so no MCP transport is ever spawned.
  const actual = await importOriginal<typeof import('@mcp-manger/mcp-manager/src/connection/index.ts')>()
  return { ...actual, startConnection: mockStartConnection }
})

import McpRegistry from '../src/index.ts'
import type { RegistryConfig } from '../src/config.ts'

let ctx: Context

/** One `alpha` stdio server, freshly allocated so no test shares a frozen entry. */
function entryConfig(): RegistryConfig {
  return { servers: { alpha: { transport: 'stdio', command: 'echo' } } }
}

/** A stored `mcp` section naming one server the composition entry does not. */
function settingsDoc(): Record<string, unknown> {
  return { mcp: { servers: { beta: { transport: 'stdio', command: 'node' } } } }
}

/** Mount the tools registry the plugin injects, then the registry itself. */
async function boot(config: RegistryConfig, doc?: Record<string, unknown>) {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const settingsFiber = doc === undefined ? undefined : ctx.plugin(MemorySettings, { doc })
  await settingsFiber
  const fiber = ctx.plugin(McpRegistry, config)
  await fiber
  return { fiber, settingsFiber }
}

/** Every server name a reconcile pass asked mcp-client to connect, in order. */
function connectedNames(): string[] {
  return connections.map(connection => (connection.config as { serverName: string }).serverName)
}

function connectionOf(serverName: string): FakeConnection {
  const connection = connections
    .find(candidate => (candidate.config as { serverName: string }).serverName === serverName)
  if (connection === undefined) throw new Error(`no mocked connection for "${serverName}"`)
  return connection
}

beforeEach(() => {
  vi.clearAllMocks()
  connections.length = 0
  mockStartConnection.mockImplementation((_ctx: unknown, clientConfig: unknown): ConnectionHandle => {
    const dispose = vi.fn((): Promise<void> => Promise.resolve())
    connections.push({ config: clientConfig, dispose })
    // Never settles: these tests pin which servers are supervised and torn
    // down, not the ready/failed transition the supervisor tests cover.
    return { ready: new Promise<ConnectionOutcome>(() => {}), dispose }
  })
})

describe('the mcp Remote namespace', () => {
  it('publishes mcpRegistry under the mcp wire namespace with the management surface', async () => {
    await boot({ servers: {} })
    const registry = ctx.mcpRegistry
    expect(registry.typertRemote.serviceKey).toBe('mcpRegistry')
    expect(registry.typertRemote.namespace).toBe('mcp')
    expect(remoteMethods(registry)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'readSection', invocation: { kind: 'direct' } },
      { method: 'writeSection', invocation: { kind: 'direct' } },
      { method: 'setEnabled', invocation: { kind: 'direct' } },
      { method: 'removeServer', invocation: { kind: 'direct' } },
      { method: 'restart', invocation: { kind: 'direct' } },
    ])
    // An entry naming no server is the dormant posture: mounted, supervising nothing.
    expect(registry.status()).toEqual([])
  })
})

describe('the composition entry as the config source', () => {
  it('supervises the servers its entry names while no settings provider is mounted', async () => {
    await boot(entryConfig())
    await vi.waitFor(() => expect(mockStartConnection).toHaveBeenCalledTimes(1))

    expect(connectedNames()).toEqual(['alpha'])
    expect(connections[0]!.config).toMatchObject({ transport: 'stdio', serverName: 'alpha', command: 'echo' })
    expect(ctx.mcpRegistry.status()).toEqual([{ serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] }])
  })
})

describe('the mcp settings section', () => {
  it('layers the stored section over the composition entry', async () => {
    await boot(entryConfig(), settingsDoc())
    await vi.waitFor(() => expect(mockStartConnection).toHaveBeenCalledTimes(2))

    expect(connectedNames().sort()).toEqual(['alpha', 'beta'])
    expect(ctx.mcpRegistry.status()).toEqual([
      { serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] },
      { serverName: 'beta', phase: 'connecting', toolCount: 0, toolNames: [] },
    ])
  })

  it('reconciles a server a settings write adds', async () => {
    await boot(entryConfig(), settingsDoc())
    await vi.waitFor(() => expect(mockStartConnection).toHaveBeenCalledTimes(2))

    await ctx.settings.update('mcp', { servers: { gamma: { transport: 'stdio', command: 'deno' } } })
    await vi.waitFor(() => expect(mockStartConnection).toHaveBeenCalledTimes(3))
    expect(connectedNames().sort()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const { settingsFiber } = await boot(entryConfig(), settingsDoc())
    await vi.waitFor(() => expect(mockStartConnection).toHaveBeenCalledTimes(2))
    const beta = connectionOf('beta')

    // Losing the provider leaves the registry running: the entry layer alone
    // drives the supervisor again, so the section-only server is disconnected.
    await settingsFiber!.dispose()
    await vi.waitFor(() => expect(beta.dispose).toHaveBeenCalledTimes(1))
    expect(ctx.mcpRegistry.status()).toEqual([{ serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] }])
  })
})

describe('teardown', () => {
  it('disconnects every supervised server and unregisters when its fiber unloads', async () => {
    const { fiber } = await boot(entryConfig())
    await vi.waitFor(() => expect(mockStartConnection).toHaveBeenCalledTimes(1))

    await fiber.dispose()
    expect(connections[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(ctx.get('mcpRegistry')).toBeUndefined()
  })
})

describe('the management surface', () => {
  /** The mounted MemorySettings provider instance, for revision and writability levers. */
  function memorySettings(): MemorySettings {
    const settings = ctx.get('settings') as MemorySettings | undefined
    if (settings === undefined) throw new Error('no settings provider mounted')
    return settings
  }

  it('renders the entry config as a read-only view while no provider mounts', async () => {
    await boot(entryConfig())
    expect(ctx.mcpRegistry.readSection()).toEqual({
      writable: false,
      revision: 0,
      servers: { alpha: { transport: 'stdio', command: 'echo' } },
    })
  })

  it('refuses a section write while no provider mounts', async () => {
    await boot(entryConfig())
    await expect(ctx.mcpRegistry.writeSection({}, undefined)).rejects.toMatchObject({ code: 'mcp/read-only' })
    await expect(ctx.mcpRegistry.writeSection({}, undefined)).rejects.toBeInstanceOf(RemoteError)
  })

  it('reads the stored user section with the document facts the editor renders', async () => {
    await boot(entryConfig(), settingsDoc())
    memorySettings().pushExternal(settingsDoc())
    const view = ctx.mcpRegistry.readSection()
    expect(view).toMatchObject({
      writable: true,
      servers: { beta: { transport: 'stdio', command: 'node' } },
    })
    expect(typeof view.revision).toBe('number')
    expect(view.documentPath).toBeUndefined()
  })

  it('replaces the section on write and reconciles the supervisor behind it', async () => {
    await boot(entryConfig(), settingsDoc())
    await vi.waitFor(() => expect(mockStartConnection).toHaveBeenCalledTimes(2))

    const view = await ctx.mcpRegistry.writeSection({ gamma: { transport: 'stdio', command: 'deno' } }, view0Revision())
    expect(view.servers).toEqual({ gamma: { transport: 'stdio', command: 'deno' } })
    // The write's reconcile settled before the answer: beta is torn down and gamma asked for.
    expect(connectionOf('beta').dispose).toHaveBeenCalledTimes(1)
    expect(connectedNames()).toContain('gamma')

    function view0Revision(): number | undefined {
      return ctx.mcpRegistry.readSection().revision
    }
  })

  it('refuses a write whose expected revision is stale', async () => {
    await boot(entryConfig(), settingsDoc())
    const stale = ctx.mcpRegistry.readSection().revision
    // An external document change bumps the revision under the editor's feet.
    memorySettings().pushExternal({ mcp: { servers: { delta: { transport: 'stdio', command: 'true' } } } })

    await expect(
      ctx.mcpRegistry.writeSection({ gamma: { transport: 'stdio', command: 'deno' } }, stale),
    ).rejects.toMatchObject({ code: 'mcp/rejected' })
  })

  it('parks a server on setEnabled(false) and reconnects it on setEnabled(true)', async () => {
    await boot(entryConfig(), settingsDoc())
    await vi.waitFor(() => expect(mockStartConnection).toHaveBeenCalledTimes(2))

    const disabled = await ctx.mcpRegistry.setEnabled('beta', false)
    expect(disabled).toEqual(expect.arrayContaining([
      { serverName: 'beta', phase: 'disabled', toolCount: 0, toolNames: [] },
    ]))
    expect(connectionOf('beta').dispose).toHaveBeenCalledTimes(1)
    expect(ctx.mcpRegistry.readSection().servers).toEqual({
      beta: { transport: 'stdio', command: 'node', disabled: true },
    })

    const enabled = await ctx.mcpRegistry.setEnabled('beta', true)
    expect(enabled).toEqual(expect.arrayContaining([
      { serverName: 'beta', phase: 'connecting', toolCount: 0, toolNames: [] },
    ]))
    expect(mockStartConnection).toHaveBeenCalledTimes(3)
  })

  it('refuses setEnabled and removeServer for a server the stored section does not name', async () => {
    await boot(entryConfig(), settingsDoc())
    // alpha rides the composition entry only, so the stored section cannot flip it.
    await expect(ctx.mcpRegistry.setEnabled('alpha', false)).rejects.toMatchObject({ code: 'mcp/not-found' })
    await expect(ctx.mcpRegistry.removeServer('ghost')).rejects.toMatchObject({ code: 'mcp/not-found' })
  })

  it('drops a server from the section on removeServer, disposing its connection', async () => {
    await boot(entryConfig(), settingsDoc())
    await vi.waitFor(() => expect(mockStartConnection).toHaveBeenCalledTimes(2))

    const statuses = await ctx.mcpRegistry.removeServer('beta')
    expect(statuses).toEqual([{ serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] }])
    expect(connectionOf('beta').dispose).toHaveBeenCalledTimes(1)
    expect(ctx.mcpRegistry.readSection().servers).toEqual({})
  })

  it('re-creates one connection on restart', async () => {
    await boot(entryConfig(), settingsDoc())
    await vi.waitFor(() => expect(mockStartConnection).toHaveBeenCalledTimes(2))

    const statuses = await ctx.mcpRegistry.restart('beta')
    expect(statuses).toEqual(expect.arrayContaining([
      { serverName: 'beta', phase: 'connecting', toolCount: 0, toolNames: [] },
    ]))
    expect(connectionOf('beta').dispose).toHaveBeenCalledTimes(1)
    expect(mockStartConnection).toHaveBeenCalledTimes(3)
  })
})
