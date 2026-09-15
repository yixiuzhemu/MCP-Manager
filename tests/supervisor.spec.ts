/**
 * Supervisor tests: how one `mcp` settings section drives many mcp-client
 * connections. `startConnection` is mocked so each pass is observable and each
 * connection's `ready`/`dispose` is released on demand — the supervisor's own
 * diffing, failure containment, teardown races, and `mcp/servers-updated`
 * fan-out are what these pin, not the MCP wire.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import type { ConnectionHandle, ConnectionOutcome } from '@mcp-manager/mcp-manager/src/connection/index.ts'
import { MemoryCredentials } from './support/memory-credentials.ts'

/** One mocked connection and the levers a test pulls on it. */
interface FakeHandle {
  handle: ConnectionHandle
  resolveReady: (outcome: ConnectionOutcome) => void
  rejectReady: (error: unknown) => void
  dispose: ReturnType<typeof vi.fn>
  config: unknown
  policy: unknown
}

// vi.mock factories are hoisted above imports, so the fn and the handle ledger
// must be created inside vi.hoisted to exist when the factory runs.
const { mockStartConnection, handles } = vi.hoisted(() => {
  const handles: FakeHandle[] = []
  const mockStartConnection = vi.fn()
  return { mockStartConnection, handles }
})

vi.mock('@mcp-manager/mcp-manager/src/connection/index.ts', async (importOriginal) => {
  // Keep the real schema, policy resolver, and name grammar; swap only the
  // connection starter so no MCP transport is ever spawned.
  const actual = await importOriginal<typeof import('@mcp-manager/mcp-manager/src/connection/index.ts')>()
  return { ...actual, startConnection: mockStartConnection }
})

import { ServerSupervisor } from '../src/supervisor.ts'
import type { RegistryConfig } from '../src/config.ts'

/** A credentials provider whose resolve a test releases on demand. */
class DeferredCredentials extends MemoryCredentials {
  gate: PromiseWithResolvers<ResolvedCredential | undefined> | undefined
  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    this.gate = Promise.withResolvers<ResolvedCredential | undefined>()
    return this.gate.promise
  }
}

let ctx: Context
let supervisor: ServerSupervisor
let config: RegistryConfig
let toolSchemas: { name: string; description: string; parameters: Record<string, unknown> }[]

async function mount(credentials?: typeof MemoryCredentials, seed?: Record<string, string>): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (credentials !== undefined) await ctx.plugin(credentials, seed ?? {})
  toolSchemas = []
  // countTools reads the live registry; the mock never registers tools, so the
  // test drives the schema list directly.
  ctx.tools.schemas = (() => toolSchemas) as unknown as typeof ctx.tools.schemas
  config = { servers: {} }
  supervisor = new ServerSupervisor(ctx, () => config)
}

/** Await the serialized reconcile chain the supervisor schedules passes on. */
function settle(): Promise<void> {
  return (supervisor as unknown as { chain: Promise<void> }).chain
}

function captureErrors(): unknown[] {
  const errors: unknown[] = []
  ctx.logger.error = ((message: unknown) => { errors.push(message) }) as typeof ctx.logger.error
  return errors
}

function captureWarns(): unknown[] {
  const warns: unknown[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(message) }) as typeof ctx.logger.warn
  return warns
}

function countUpdates(): () => number {
  let emitted = 0
  ctx.on('mcp/servers-updated', () => { emitted += 1 })
  return () => emitted
}

beforeEach(() => {
  vi.clearAllMocks()
  handles.length = 0
  mockStartConnection.mockImplementation((_ctx: unknown, clientConfig: unknown, policy: unknown): ConnectionHandle => {
    const gate = Promise.withResolvers<ConnectionOutcome>()
    const dispose = vi.fn((): Promise<void> => Promise.resolve())
    const handle: ConnectionHandle = { ready: gate.promise, dispose }
    handles.push({ handle, resolveReady: gate.resolve, rejectReady: gate.reject, dispose, config: clientConfig, policy })
    return handle
  })
})

describe('reconcile gating', () => {
  it('connects nothing before the tools registry is ready', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.scheduleReconcile()
    await settle()
    expect(mockStartConnection).not.toHaveBeenCalled()
    expect(supervisor.status()).toEqual([])
  })

  it('connects nothing after disposal', async () => {
    await mount()
    supervisor.markToolsReady()
    await settle()
    await supervisor.disposeAll()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.scheduleReconcile()
    await settle()
    expect(mockStartConnection).not.toHaveBeenCalled()
  })
})

describe('connecting servers', () => {
  it('starts one connection per server, reports them connecting, and sorts by name', async () => {
    await mount()
    config.servers = {
      beta: { transport: 'stdio', command: 'echo' },
      alpha: { transport: 'streamable-http', url: 'https://example.com/mcp' },
    }
    supervisor.markToolsReady()
    await settle()

    expect(mockStartConnection).toHaveBeenCalledTimes(2)
    expect(supervisor.status()).toEqual([
      { serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] },
      { serverName: 'beta', phase: 'connecting', toolCount: 0, toolNames: [] },
    ])
    // The projected client config carries the dict key as the mcp-client serverName.
    const alpha = handles.find(created => (created.config as { serverName: string }).serverName === 'alpha')
    expect(alpha?.config).toMatchObject({ transport: 'streamable-http', serverName: 'alpha' })
    expect(alpha?.policy).toMatchObject({ enabled: true, maxAttempts: 10 })
  })

  it('flips a server to ready with its live tool count when the first attempt succeeds', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    toolSchemas.push(
      { name: 'mcp__alpha__demo', description: 'd', parameters: {} },
      { name: 'mcp__beta__other', description: 'd', parameters: {} },
      { name: 'plain', description: 'd', parameters: {} },
    )
    handles[0]!.resolveReady({})
    await vi.waitFor(() => {
      expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'ready', toolCount: 1, toolNames: ['mcp__alpha__demo'] }])
    })
  })

  it('flips a server to failed with the error message when the first attempt fails', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    handles[0]!.resolveReady({ error: new Error('boom') })
    await vi.waitFor(() => {
      expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'failed', toolCount: 0, toolNames: [], error: 'boom' }])
    })
  })

  it('renders a non-Error startup failure with String()', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    handles[0]!.resolveReady({ error: 'plain-string' })
    await vi.waitFor(() => {
      expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'failed', toolCount: 0, toolNames: [], error: 'plain-string' }])
    })
  })
})

describe('diffing the section', () => {
  it('leaves an unchanged server running and emits nothing on a no-op reconcile', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()
    expect(mockStartConnection).toHaveBeenCalledTimes(1)

    const emitted = countUpdates()
    supervisor.scheduleReconcile()
    await settle()
    expect(mockStartConnection).toHaveBeenCalledTimes(1)
    expect(emitted()).toBe(0)
  })

  it('re-creates a server whose profile changed, disposing the previous connection', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    config.servers = { alpha: { transport: 'stdio', command: 'node' } }
    supervisor.scheduleReconcile()
    await settle()

    expect(mockStartConnection).toHaveBeenCalledTimes(2)
    expect(handles[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] }])
  })

  it('re-creates a server whose resolved secret rotated', async () => {
    await mount(MemoryCredentials, { TOKEN: 'v1' })
    config.servers = { alpha: { transport: 'stdio', command: 'echo', envCredentials: { TOKEN: 'TOKEN' } } }
    supervisor.markToolsReady()
    await settle()
    expect(mockStartConnection).toHaveBeenCalledTimes(1)

    await ctx.credentials.set(credentialRef('TOKEN'), 'v2')
    supervisor.scheduleReconcile()
    await settle()
    // Only the fingerprint changed, which is exactly what must re-create the connection.
    expect(mockStartConnection).toHaveBeenCalledTimes(2)
    expect(handles[0]!.dispose).toHaveBeenCalledTimes(1)
  })

  it('drops and disposes a server the section no longer names', async () => {
    await mount()
    config.servers = {
      alpha: { transport: 'stdio', command: 'echo' },
      beta: { transport: 'stdio', command: 'echo' },
    }
    supervisor.markToolsReady()
    await settle()
    expect(handles).toHaveLength(2)

    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.scheduleReconcile()
    await settle()

    expect(mockStartConnection).toHaveBeenCalledTimes(2)
    expect(handles[1]!.dispose).toHaveBeenCalledTimes(1)
    expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] }])
  })

  it('contains a disposal failure when dropping a server', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    handles[0]!.dispose.mockRejectedValue(new Error('drop teardown failed'))
    const errors = captureErrors()
    config.servers = {}
    supervisor.scheduleReconcile()
    await settle()

    expect(supervisor.status()).toEqual([])
    expect(errors.some(line => String(line).includes('disposing server "alpha" failed'))).toBe(true)
  })
})

describe('failure containment', () => {
  it('records an invalid serverName as a failure and never connects it', async () => {
    await mount()
    config.servers = { 'has space': { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    expect(mockStartConnection).not.toHaveBeenCalled()
    expect(supervisor.status()).toEqual([{
      serverName: 'has space',
      phase: 'failed',
      toolCount: 0,
      toolNames: [],
      error: expect.stringContaining('serverName "has space" must match'),
    }])
  })

  it('contains a resolution failure and still connects the other servers', async () => {
    await mount()
    config.servers = {
      alpha: { transport: 'stdio', command: 'echo', envCredentials: { TOKEN: 'TOKEN' } },
      beta: { transport: 'stdio', command: 'echo' },
    }
    supervisor.markToolsReady()
    await settle()

    expect(mockStartConnection).toHaveBeenCalledTimes(1)
    expect(supervisor.status()).toEqual([
      {
        serverName: 'alpha',
        phase: 'failed',
        toolCount: 0,
        toolNames: [],
        error: expect.stringContaining('mounts no credentials service'),
      },
      { serverName: 'beta', phase: 'connecting', toolCount: 0, toolNames: [] },
    ])
  })

  it('tears down a live connection when its server starts failing', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()
    expect(mockStartConnection).toHaveBeenCalledTimes(1)

    config.servers = { alpha: { transport: 'stdio', command: 'echo', envCredentials: { TOKEN: 'TOKEN' } } }
    supervisor.scheduleReconcile()
    await settle()

    expect(handles[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(supervisor.status()).toEqual([{
      serverName: 'alpha',
      phase: 'failed',
      toolCount: 0,
      toolNames: [],
      error: expect.stringContaining('mounts no credentials service'),
    }])
  })

  it('does not re-emit when the same failure repeats', async () => {
    await mount()
    config.servers = { 'has space': { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    const emitted = countUpdates()
    supervisor.scheduleReconcile()
    await settle()
    expect(emitted()).toBe(0)
    expect(supervisor.status()).toHaveLength(1)
  })

  it('still announces a sibling change while an identical resolution failure repeats', async () => {
    await mount()
    config.servers = { beta: { transport: 'stdio', command: 'echo', envCredentials: { TOKEN: 'TOKEN' } } }
    supervisor.markToolsReady()
    await settle()
    expect(mockStartConnection).not.toHaveBeenCalled()

    const emitted = countUpdates()
    // beta fails with the same message, so it changes nothing on its own; alpha
    // joining is what this pass must still announce.
    config.servers = {
      alpha: { transport: 'stdio', command: 'echo' },
      beta: { transport: 'stdio', command: 'echo', envCredentials: { TOKEN: 'TOKEN' } },
    }
    supervisor.scheduleReconcile()
    await settle()

    expect(mockStartConnection).toHaveBeenCalledTimes(1)
    expect(emitted()).toBe(1)
    expect(supervisor.status()).toEqual([
      { serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] },
      {
        serverName: 'beta',
        phase: 'failed',
        toolCount: 0,
        toolNames: [],
        error: expect.stringContaining('mounts no credentials service'),
      },
    ])
  })

  it('drops a failure the section no longer names and keeps one still named', async () => {
    await mount()
    config.servers = {
      'bad one': { transport: 'stdio', command: 'echo' },
      'bad two': { transport: 'stdio', command: 'echo' },
    }
    supervisor.markToolsReady()
    await settle()
    expect(supervisor.status()).toHaveLength(2)

    config.servers = { 'bad one': { transport: 'stdio', command: 'echo' } }
    supervisor.scheduleReconcile()
    await settle()
    expect(supervisor.status()).toEqual([{
      serverName: 'bad one',
      phase: 'failed',
      toolCount: 0,
      toolNames: [],
      error: expect.stringContaining('must match'),
    }])
  })
})

describe('disposal', () => {
  it('disposes every live connection and clears status on teardown', async () => {
    await mount()
    config.servers = {
      alpha: { transport: 'stdio', command: 'echo' },
      beta: { transport: 'stdio', command: 'echo' },
    }
    supervisor.markToolsReady()
    await settle()
    handles[0]!.resolveReady({})
    handles[1]!.resolveReady({})
    await vi.waitFor(() => expect(supervisor.status().every(server => server.phase === 'ready')).toBe(true))

    await supervisor.disposeAll()
    expect(handles[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(handles[1]!.dispose).toHaveBeenCalledTimes(1)
    expect(supervisor.status()).toEqual([])
  })

  it('contains a disposal failure and still clears every entry', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    handles[0]!.dispose.mockRejectedValue(new Error('teardown failed'))
    const errors = captureErrors()
    await supervisor.disposeAll()
    expect(supervisor.status()).toEqual([])
    expect(errors.some(line => String(line).includes('disposing server "alpha" failed'))).toBe(true)
  })
})

describe('teardown races', () => {
  it('stops reconciling mid-loop when disposal lands during a resolve', async () => {
    await mount(DeferredCredentials)
    const deferred = ctx.get('credentials') as DeferredCredentials
    config.servers = {
      alpha: { transport: 'stdio', command: 'echo', envCredentials: { X: 'DEFER' } },
      beta: { transport: 'stdio', command: 'echo' },
    }
    supervisor.markToolsReady()
    await vi.waitFor(() => expect(deferred.gate).toBeDefined())

    const disposing = supervisor.disposeAll()
    deferred.gate!.resolve({ value: 'secret', source: 'memory' })
    await disposing

    // alpha's resolve completed after disposal landed, so it connected; beta hit
    // the disposed guard at the top of its iteration and never started.
    expect(mockStartConnection).toHaveBeenCalledTimes(1)
  })

  it('skips the update emit when disposal lands before the pass ends', async () => {
    await mount(DeferredCredentials)
    const deferred = ctx.get('credentials') as DeferredCredentials
    config.servers = { alpha: { transport: 'stdio', command: 'echo', envCredentials: { X: 'DEFER' } } }
    const emitted = countUpdates()
    supervisor.markToolsReady()
    await vi.waitFor(() => expect(deferred.gate).toBeDefined())

    const disposing = supervisor.disposeAll()
    deferred.gate!.resolve({ value: 'secret', source: 'memory' })
    await disposing

    expect(mockStartConnection).toHaveBeenCalledTimes(1)
    expect(emitted()).toBe(0)
  })

  it('ignores a ready signal that settles after disposal', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    const emitted = countUpdates()
    await supervisor.disposeAll()
    handles[0]!.resolveReady({})
    await vi.waitFor(() => expect(emitted()).toBe(0))
    expect(supervisor.status()).toEqual([])
  })

  it("ignores a superseded connection's late ready signal", async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    config.servers = { alpha: { transport: 'stdio', command: 'node' } }
    supervisor.scheduleReconcile()
    await settle()
    expect(handles).toHaveLength(2)

    toolSchemas.push({ name: 'mcp__alpha__demo', description: 'd', parameters: {} })
    handles[0]!.resolveReady({})
    handles[1]!.resolveReady({})
    await vi.waitFor(() => {
      expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'ready', toolCount: 1, toolNames: ['mcp__alpha__demo'] }])
    })
  })
})

describe('the mcp/servers-updated notification', () => {
  it('contains every listener failure without vetoing the change', async () => {
    await mount()
    const warns = captureWarns()
    ctx.on('mcp/servers-updated', () => {})
    ctx.on('mcp/servers-updated', () => 42)
    ctx.on('mcp/servers-updated', async () => {})
    ctx.on('mcp/servers-updated', async () => { throw new Error('async listener failed') })
    ctx.on('mcp/servers-updated', () => { throw new Error('sync listener failed') })

    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    expect(mockStartConnection).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(warns.some(line => String(line).includes('an mcp/servers-updated listener failed'))).toBe(true)
    })
  })

  it('rethrows an invariant-coded listener failure after every listener ran', async () => {
    await mount()
    const errors = captureErrors()
    let normalRan = 0
    ctx.on('mcp/servers-updated', () => { normalRan += 1 })
    ctx.on('mcp/servers-updated', () => {
      const failure = new Error('invariant violated') as Error & { code: string }
      failure.code = 'INVARIANT'
      throw failure
    })

    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    expect(normalRan).toBe(1)
    expect(errors.some(line => String(line).includes('a reconcile pass failed'))).toBe(true)
  })
})

describe('disabled servers', () => {
  it('keeps a disabled profile dormant and lists it as disabled', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo', disabled: true } }
    supervisor.markToolsReady()
    await settle()

    expect(mockStartConnection).not.toHaveBeenCalled()
    expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'disabled', toolCount: 0, toolNames: [] }])
  })

  it('tears down a live connection when its profile is disabled', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()
    expect(mockStartConnection).toHaveBeenCalledTimes(1)

    const emitted = countUpdates()
    config.servers = { alpha: { transport: 'stdio', command: 'echo', disabled: true } }
    supervisor.scheduleReconcile()
    await settle()

    expect(handles[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(emitted()).toBe(1)
    expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'disabled', toolCount: 0, toolNames: [] }])
  })

  it('reconnects a disabled server when the flag is cleared', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo', disabled: true } }
    supervisor.markToolsReady()
    await settle()

    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.scheduleReconcile()
    await settle()

    expect(mockStartConnection).toHaveBeenCalledTimes(1)
    expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] }])
  })

  it('keeps an invalid name failed even when the profile is disabled', async () => {
    await mount()
    config.servers = { 'has space': { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()
    expect(supervisor.status()).toEqual([expect.objectContaining({ phase: 'failed' })])

    // The name grammar is checked before the disabled short-circuit, so the
    // failure survives the flag: a rename is the only way to clear it.
    config.servers = { 'has space': { transport: 'stdio', command: 'echo', disabled: true } }
    supervisor.scheduleReconcile()
    await settle()
    expect(supervisor.status()).toEqual([{ serverName: 'has space', phase: 'failed', toolCount: 0, toolNames: [], error: expect.stringContaining('must match') }])
  })

  it('drops a disabled server the section no longer names', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo', disabled: true } }
    supervisor.markToolsReady()
    await settle()

    config.servers = {}
    supervisor.scheduleReconcile()
    await settle()
    expect(supervisor.status()).toEqual([])
  })

  it('restarts a live server on demand, disposing and reconnecting it', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()
    expect(mockStartConnection).toHaveBeenCalledTimes(1)

    supervisor.restart('alpha')
    await settle()

    expect(handles[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(mockStartConnection).toHaveBeenCalledTimes(2)
    expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] }])
  })

  it('restarts a failed server by clearing the failure and retrying', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()
    handles[0]!.resolveReady({ error: new Error('boom') })
    await vi.waitFor(() => {
      expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'failed', toolCount: 0, toolNames: [], error: 'boom' }])
    })

    supervisor.restart('alpha')
    await settle()

    expect(mockStartConnection).toHaveBeenCalledTimes(2)
    expect(supervisor.status()).toEqual([{ serverName: 'alpha', phase: 'connecting', toolCount: 0, toolNames: [] }])
  })

  it('ignores a restart of an unknown name and a restart after disposal', async () => {
    await mount()
    config.servers = { alpha: { transport: 'stdio', command: 'echo' } }
    supervisor.markToolsReady()
    await settle()

    supervisor.restart('ghost')
    await settle()
    expect(mockStartConnection).toHaveBeenCalledTimes(1)
    expect(handles[0]!.dispose).not.toHaveBeenCalled()

    await supervisor.disposeAll()
    supervisor.restart('alpha')
    await settle()
    expect(mockStartConnection).toHaveBeenCalledTimes(1)
  })
})
