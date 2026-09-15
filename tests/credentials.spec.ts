/**
 * Credential-resolution tests for one authored server profile: how references
 * become concrete secret values merged over the plaintext plane, the log-safe
 * fingerprint that lets the supervisor detect a rotated secret, and the
 * fail-loud paths for a missing service, an unresolved reference, an empty
 * value, and a reference name outside the credential grammar.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { MemoryCredentials } from './support/memory-credentials.ts'
import { resolveProfileSecrets } from '../src/credentials.ts'
import type { HttpServerProfile, StdioServerProfile } from '../src/config.ts'

/** A provider that violates the seam's "empty is absent" rule, to pin the defensive guard. */
class EmptyValueCredentials extends MemoryCredentials {
  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve({ value: '', source: 'memory' })
  }
}

async function boot(provider?: typeof MemoryCredentials, seed?: Record<string, string>): Promise<Context> {
  const ctx = new Context()
  if (provider !== undefined) await ctx.plugin(provider, seed ?? {})
  return ctx
}

/** The fingerprint the source computes over name-ordered resolved pairs. */
function fingerprint(entries: [string, string | undefined][]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

describe('resolveProfileSecrets over the plaintext-only planes', () => {
  it('returns a stdio profile\'s plaintext env and an empty-secret fingerprint', async () => {
    const ctx = await boot()
    const profile: StdioServerProfile = { transport: 'stdio', command: 'echo', env: { PLAIN: 'value' } }
    const resolved = await resolveProfileSecrets(ctx, 'srv', profile)
    expect(resolved.values).toEqual({ PLAIN: 'value' })
    expect(resolved.fingerprint).toBe(fingerprint([]))
  })

  it('defaults both planes to empty for a bare stdio profile', async () => {
    const ctx = await boot()
    const resolved = await resolveProfileSecrets(ctx, 'srv', { transport: 'stdio', command: 'echo' })
    expect(resolved.values).toEqual({})
    expect(resolved.fingerprint).toBe(fingerprint([]))
  })

  it('returns an http profile\'s plaintext headers', async () => {
    const ctx = await boot()
    const profile: HttpServerProfile = {
      transport: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Plain': 'value' },
    }
    const resolved = await resolveProfileSecrets(ctx, 'remote', profile)
    expect(resolved.values).toEqual({ 'X-Plain': 'value' })
    expect(resolved.fingerprint).toBe(fingerprint([]))
  })

  it('defaults both planes to empty for a bare http profile', async () => {
    const ctx = await boot()
    const resolved = await resolveProfileSecrets(ctx, 'remote', {
      transport: 'streamable-http', url: 'https://example.com/mcp',
    })
    expect(resolved.values).toEqual({})
  })
})

describe('resolveProfileSecrets over declared references', () => {
  it('layers a resolved stdio secret over the plaintext env of the same name', async () => {
    const ctx = await boot(MemoryCredentials, { TOKEN: 'secret' })
    const profile: StdioServerProfile = {
      transport: 'stdio', command: 'echo', env: { TOKEN: 'plain', OTHER: 'keep' }, envCredentials: { TOKEN: 'TOKEN' },
    }
    const resolved = await resolveProfileSecrets(ctx, 'srv', profile)
    expect(resolved.values).toEqual({ TOKEN: 'secret', OTHER: 'keep' })
    expect(resolved.fingerprint).toBe(fingerprint([['TOKEN', 'secret']]))
  })

  it('resolves an http header reference into the merged headers', async () => {
    const ctx = await boot(MemoryCredentials, { AUTH: 'bearer-token' })
    const profile: HttpServerProfile = {
      transport: 'streamable-http', url: 'https://example.com/mcp', headerCredentials: { Authorization: 'AUTH' },
    }
    const resolved = await resolveProfileSecrets(ctx, 'remote', profile)
    expect(resolved.values).toEqual({ Authorization: 'bearer-token' })
    expect(resolved.fingerprint).toBe(fingerprint([['Authorization', 'bearer-token']]))
  })

  it('orders the fingerprint by reference name, so insertion order does not change it', async () => {
    const ctx = await boot(MemoryCredentials, { A: '1', B: '2' })
    const forward: StdioServerProfile = {
      transport: 'stdio', command: 'echo', envCredentials: { FIRST: 'A', SECOND: 'B' },
    }
    const backward: StdioServerProfile = {
      transport: 'stdio', command: 'echo', envCredentials: { SECOND: 'B', FIRST: 'A' },
    }
    const a = await resolveProfileSecrets(ctx, 'srv', forward)
    const b = await resolveProfileSecrets(ctx, 'srv', backward)
    expect(a.values).toEqual({ FIRST: '1', SECOND: '2' })
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).toBe(fingerprint([['FIRST', '1'], ['SECOND', '2']]))
  })
})

describe('resolveProfileSecrets fails loud', () => {
  it('names the missing service when references are declared without one', async () => {
    const ctx = await boot()
    const profile: StdioServerProfile = {
      transport: 'stdio', command: 'echo', envCredentials: { TOKEN: 'TOKEN' },
    }
    await expect(resolveProfileSecrets(ctx, 'srv', profile))
      .rejects.toThrow(/declares credential references but this deployment mounts no credentials service/)
  })

  it('names the reference that resolves to nothing', async () => {
    const ctx = await boot(MemoryCredentials, {})
    const profile: StdioServerProfile = {
      transport: 'stdio', command: 'echo', envCredentials: { TOKEN: 'MISSING' },
    }
    await expect(resolveProfileSecrets(ctx, 'srv', profile))
      .rejects.toThrow(/no credential for "TOKEN"; its profile resolves MISSING, which is not set/)
  })

  it('treats a provider-returned empty value as absent', async () => {
    const ctx = await boot(EmptyValueCredentials)
    const profile: HttpServerProfile = {
      transport: 'streamable-http', url: 'https://example.com/mcp', headerCredentials: { Authorization: 'AUTH' },
    }
    await expect(resolveProfileSecrets(ctx, 'remote', profile))
      .rejects.toThrow(/no credential for "Authorization"/)
  })

  it('rejects a reference name outside the credential grammar', async () => {
    const ctx = await boot(MemoryCredentials, {})
    const profile: StdioServerProfile = {
      transport: 'stdio', command: 'echo', envCredentials: { TOKEN: 'has space' },
    }
    await expect(resolveProfileSecrets(ctx, 'srv', profile)).rejects.toThrow(TypeError)
  })
})
