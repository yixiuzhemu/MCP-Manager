/**
 * Pure-projection tests for the `mcp` settings schema: how one authored server
 * profile becomes an mcp-client connection config and the log-safe registration
 * facts the supervisor diffs on. No connection is started here; these cover the
 * schema's defaults and the two transport branches of each projection.
 */
import { describe, expect, it } from 'vitest'
import { RECONNECT_DEFAULTS } from '@mcp-manager/mcp-manager/src/connection/index.ts'
import type { ResolvedReconnectPolicy } from '@mcp-manager/mcp-manager/src/connection/index.ts'
import {
  buildClientConfig,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  registrationFacts,
} from '../src/config.ts'
import type { HttpServerProfile, StdioServerProfile } from '../src/config.ts'
import McpRegistry from '../src/index.ts'

const POLICY: ResolvedReconnectPolicy = RECONNECT_DEFAULTS

/** The section schema, declared on the plugin entry that owns it. */
const Config = McpRegistry.Config

describe('the mcp settings-section schema', () => {
  it('defaults an absent or empty section to the dormant posture', () => {
    // Cordis resolves a bare composition entry through this schema, so an
    // absent section must yield the dormant posture rather than fail the load.
    expect(Config()).toEqual({ servers: {} })
    expect(Config({ servers: {} })).toEqual({ servers: {} })
  })

  it('resolves both transport profiles under one dict', () => {
    const resolved = Config({
      servers: {
        local: { transport: 'stdio', command: 'echo' },
        remote: { transport: 'streamable-http', url: 'https://example.com/mcp' },
      },
    })
    expect(Object.keys(resolved.servers).sort()).toEqual(['local', 'remote'])
    expect(resolved.servers['local']).toMatchObject({ transport: 'stdio', command: 'echo' })
    expect(resolved.servers['remote']).toMatchObject({ transport: 'streamable-http', url: 'https://example.com/mcp' })
  })

  it('rejects a profile whose transport matches neither branch', () => {
    expect(() => Config({ servers: { bad: { transport: 'carrier-pigeon' } } as never })).toThrow()
  })
})

describe('buildClientConfig', () => {
  it('projects a minimal stdio profile through the mcp-client defaults', () => {
    const profile: StdioServerProfile = { transport: 'stdio', command: 'echo' }
    expect(buildClientConfig('srv', profile, {})).toEqual({
      transport: 'stdio',
      serverName: 'srv',
      command: 'echo',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
      reconnect: { ...RECONNECT_DEFAULTS },
    })
  })

  it('carries every authored stdio field and merges resolved secrets into env', () => {
    const profile: StdioServerProfile = {
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/opt/mcp',
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
      reconnect: { enabled: false, initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 1 },
    }
    const config = buildClientConfig('srv', profile, { TOKEN: 'secret' })
    expect(config).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/opt/mcp',
      env: { TOKEN: 'secret' },
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
    })
    expect(config.transport === 'stdio' && config.reconnect).toEqual({
      enabled: false, initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 1,
    })
  })

  it('projects a minimal http profile and merges resolved secrets into headers', () => {
    const profile: HttpServerProfile = { transport: 'streamable-http', url: 'https://example.com/mcp' }
    expect(buildClientConfig('remote', profile, { Authorization: 'Bearer x' })).toEqual({
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
      reconnect: { ...RECONNECT_DEFAULTS },
    })
  })

  it('carries every authored http field', () => {
    const profile: HttpServerProfile = {
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { 'X-Plain': 'value' },
      toolCallTimeoutMs: 1_000,
      failOnStartupError: true,
      reconnect: { enabled: true, initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 },
    }
    // Secrets layer over the plaintext headers the profile authored.
    expect(buildClientConfig('remote', profile, { 'X-Plain': 'value', Authorization: 'Bearer x' }))
      .toMatchObject({
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: { 'X-Plain': 'value', Authorization: 'Bearer x' },
        toolCallTimeoutMs: 1_000,
        failOnStartupError: true,
      })
  })

  it('rejects a serverName the mcp-client grammar denies', () => {
    const profile: StdioServerProfile = { transport: 'stdio', command: 'echo' }
    expect(() => buildClientConfig('has space', profile, {})).toThrow()
  })
})

describe('registrationFacts', () => {
  it('snapshots a minimal stdio profile with plaintext env and the secret fingerprint', () => {
    const profile: StdioServerProfile = { transport: 'stdio', command: 'echo' }
    expect(registrationFacts('srv', profile, POLICY, 'fp')).toEqual({
      serverName: 'srv',
      transport: 'stdio',
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
      reconnect: POLICY,
      secretFingerprint: 'fp',
      command: 'echo',
      args: [],
      cwd: '',
      env: {},
    })
  })

  it('snapshots an authored stdio profile verbatim, secrets riding only as the fingerprint', () => {
    const profile: StdioServerProfile = {
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/opt/mcp',
      env: { PLAIN: 'value' },
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
    }
    const facts = registrationFacts('srv', profile, POLICY, 'digest') as Record<string, unknown>
    expect(facts).toMatchObject({
      command: 'node', args: ['server.js'], cwd: '/opt/mcp', env: { PLAIN: 'value' },
      toolCallTimeoutMs: 5_000, failOnStartupError: true, secretFingerprint: 'digest',
    })
    // The resolved secret value never rides in the facts; only its digest does.
    expect(JSON.stringify(facts)).not.toContain('value-secret')
  })

  it('snapshots both http shapes', () => {
    const minimal: HttpServerProfile = { transport: 'streamable-http', url: 'https://example.com/mcp' }
    expect(registrationFacts('remote', minimal, POLICY, 'fp')).toEqual({
      serverName: 'remote',
      transport: 'streamable-http',
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      failOnStartupError: false,
      reconnect: POLICY,
      secretFingerprint: 'fp',
      url: 'https://example.com/mcp',
      headers: {},
    })
    const authored: HttpServerProfile = {
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { 'X-Plain': 'value' },
      toolCallTimeoutMs: 1_000,
      failOnStartupError: true,
    }
    expect(registrationFacts('remote', authored, POLICY, 'fp'))
      .toMatchObject({ headers: { 'X-Plain': 'value' }, toolCallTimeoutMs: 1_000, failOnStartupError: true })
  })

  it('is deep-equal for identical inputs and differs when a diffed field changes', () => {
    const profile: StdioServerProfile = { transport: 'stdio', command: 'echo' }
    const a = registrationFacts('srv', profile, POLICY, 'fp')
    const b = registrationFacts('srv', { ...profile }, POLICY, 'fp')
    expect(a).toEqual(b)
    // A rotated secret changes only the fingerprint, which is exactly what the
    // supervisor must re-create the connection for.
    expect(registrationFacts('srv', profile, POLICY, 'rotated')).not.toEqual(a)
    // So does a changed command.
    expect(registrationFacts('srv', { ...profile, command: 'node' }, POLICY, 'fp')).not.toEqual(a)
  })
})
