/**
 * Public-surface guard for the connection supervisor re-exports.
 *
 * The host registry (`@mcp-manager/mcp-manager`'s `.` face) drives many servers
 * from a settings section and reuses the connection layer's lifecycle verbatim.
 * That reuse depends on `startConnection`, `resolveReconnectPolicy`,
 * `RECONNECT_DEFAULTS`, and `SERVER_NAME_PATTERN` being reachable from the
 * connection module's barrel — so a rename or an accidental drop must fail here
 * rather than silently breaking the registry at composition time.
 */

import { describe, expect, it } from 'vitest'
import {
  RECONNECT_DEFAULTS,
  resolveReconnectPolicy,
  SERVER_NAME_PATTERN,
  startConnection,
} from '@mcp-manager/mcp-manager/src/connection/index.ts'

describe('dsh-mcp-client supervisor re-exports', () => {
  it('exposes the connection supervisor entry points from the connection barrel', () => {
    expect(typeof startConnection).toBe('function')
    expect(typeof resolveReconnectPolicy).toBe('function')
    expect(RECONNECT_DEFAULTS).toEqual({
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 10,
    })
  })

  it('exposes SERVER_NAME_PATTERN for registry-side validation', () => {
    expect(SERVER_NAME_PATTERN.test('my-server_1')).toBe(true)
    expect(SERVER_NAME_PATTERN.test('bad name')).toBe(false)
  })

  it('resolves defaults through the exported policy resolver', () => {
    expect(resolveReconnectPolicy(undefined, 'mcp')).toEqual(RECONNECT_DEFAULTS)
  })
})
