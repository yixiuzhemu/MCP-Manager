/**
 * Per-profile schemas and types for the `mcp` settings section, plus the pure
 * projections from one authored server profile to the mcp-client connection
 * config and the registration facts the supervisor diffs on. The plugin entry
 * owns the section schema that dicts these profiles by server name.
 *
 * A profile splits plaintext fields (`env`, `headers`) from credential
 * references (`envCredentials`, `headerCredentials`): only the references are
 * stored in `settings.yaml`, so no secret value is ever materialized into the
 * settings document. The `servers` dict key IS the mcp-client `serverName`.
 *
 * @module @mcp-manager/mcp-manager/config
 */

import z from '@deepseek-ai/schemastery'
import { Config as McpConfigSchema } from './connection/index.ts'
import type {
  Config as McpClientConfig,
  ReconnectConfig,
  ResolvedReconnectPolicy,
} from './connection/index.ts'

/** Default per-tool-call timeout, mirroring the mcp-client default. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** One stdio MCP server as authored in the `mcp` settings section. */
export interface StdioServerProfile {
  /** Selects the child-process stdio transport. */
  transport: 'stdio'
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args?: string[]
  /** Working directory for the child process. */
  cwd?: string
  /** Non-secret environment variables, stored verbatim in `settings.yaml`. */
  env?: Record<string, string>
  /**
   * Secret environment values by variable name: each value is a credential
   * reference resolved through `ctx.credentials` at connect time, never stored
   * here as plaintext.
   */
  envCredentials?: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs?: number
  /** Fail this server's registration when its initial connection fails. */
  failOnStartupError?: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the mcp-client defaults. */
  reconnect?: ReconnectConfig
  /**
   * Keep the server dormant: the supervisor holds no connection and registers
   * no tools for a disabled profile, and a management surface flips this flag
   * to enable or disable the server without deleting its profile.
   */
  disabled?: boolean
}

/** One Streamable HTTP MCP server as authored in the `mcp` settings section. */
export interface HttpServerProfile {
  /** Selects the Streamable HTTP transport. */
  transport: 'streamable-http'
  /** MCP endpoint URL. */
  url: string
  /** Non-secret request headers, stored verbatim in `settings.yaml`. */
  headers?: Record<string, string>
  /**
   * Secret request headers by header name: each value is a credential reference
   * resolved through `ctx.credentials` at connect time, never stored here as
   * plaintext.
   */
  headerCredentials?: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs?: number
  /** Fail this server's registration when its initial connection fails. */
  failOnStartupError?: boolean
  /** Automatic reconnect policy after a lost connection; omission uses the mcp-client defaults. */
  reconnect?: ReconnectConfig
  /**
   * Keep the server dormant: the supervisor holds no connection and registers
   * no tools for a disabled profile, and a management surface flips this flag
   * to enable or disable the server without deleting its profile.
   */
  disabled?: boolean
}

/** One MCP server profile, discriminated on `transport`. */
export type ServerProfile = StdioServerProfile | HttpServerProfile

/** The whole `mcp` settings section: a dict of server profiles by server name. */
export interface RegistryConfig {
  /** Servers to supervise, keyed by mcp-client `serverName`; empty is the dormant posture. */
  servers: Record<string, ServerProfile>
}

const reconnectSchema = z.object({
  enabled: z.boolean(),
  initialDelayMs: z.number().min(1),
  maxDelayMs: z.number().min(1),
  maxAttempts: z.number().step(1).min(1),
})

const stdioProfile = z.object({
  transport: z.const('stdio'),
  command: z.string().required(),
  args: z.array(z.string()),
  cwd: z.string(),
  env: z.dict(z.string()),
  envCredentials: z.dict(z.string()),
  toolCallTimeoutMs: z.number().step(1).min(1),
  failOnStartupError: z.boolean(),
  reconnect: reconnectSchema,
  disabled: z.boolean(),
})

const httpProfile = z.object({
  transport: z.const('streamable-http'),
  url: z.string().required(),
  headers: z.dict(z.string()),
  headerCredentials: z.dict(z.string()),
  toolCallTimeoutMs: z.number().step(1).min(1),
  failOnStartupError: z.boolean(),
  reconnect: reconnectSchema,
  disabled: z.boolean(),
})

/**
 * Schemastery schema for one authored server profile, discriminated on
 * `transport`; the plugin entry dicts it by server name.
 */
export const ServerProfileSchema: z<ServerProfile> = z.union([
  stdioProfile,
  httpProfile,
]) as unknown as z<ServerProfile>

/**
 * Project one authored profile plus its resolved secret values onto the
 * mcp-client connection config, normalized through the mcp-client schema so
 * defaults and the `serverName` grammar are judged exactly as the one-instance
 * plugin judges them.
 *
 * @param serverName - the `servers` dict key, used as the mcp-client namespace.
 * @param profile - the authored server profile.
 * @param secrets - merged plaintext and resolved-credential env (stdio) or headers (http).
 * @returns the resolved mcp-client config for one supervised connection.
 * @throws when the profile or the derived config is invalid.
 */
export function buildClientConfig(
  serverName: string,
  profile: ServerProfile,
  secrets: Record<string, string>,
): McpClientConfig {
  const shared = {
    serverName,
    toolCallTimeoutMs: profile.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: profile.failOnStartupError ?? false,
    ...(profile.reconnect === undefined ? {} : { reconnect: profile.reconnect }),
  }
  const input = profile.transport === 'stdio'
    ? {
      ...shared,
      transport: 'stdio' as const,
      command: profile.command,
      args: profile.args ?? [],
      env: secrets,
      cwd: profile.cwd ?? '',
    }
    : {
      ...shared,
      transport: 'streamable-http' as const,
      url: profile.url,
      headers: secrets,
    }
  return McpConfigSchema(input as never)
}

/**
 * The facts a supervised connection is captured by: everything that would
 * change the spawned child, the endpoint, or the resolved secrets. The
 * supervisor deep-compares this against the previous value to decide whether a
 * server must be re-created. Plaintext env/headers ride verbatim while secret
 * values ride only as a fingerprint, so the facts stay log-safe.
 *
 * @param serverName - the mcp-client namespace.
 * @param profile - the authored server profile.
 * @param policy - the resolved reconnect policy.
 * @param secretFingerprint - digest of the resolved credential values.
 * @returns a JSON-comparable snapshot of the connection's registration inputs.
 */
export function registrationFacts(
  serverName: string,
  profile: ServerProfile,
  policy: ResolvedReconnectPolicy,
  secretFingerprint: string,
): unknown {
  const base = {
    serverName,
    transport: profile.transport,
    toolCallTimeoutMs: profile.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: profile.failOnStartupError ?? false,
    reconnect: policy,
    secretFingerprint,
  }
  return profile.transport === 'stdio'
    ? { ...base, command: profile.command, args: profile.args ?? [], cwd: profile.cwd ?? '', env: profile.env ?? {} }
    : { ...base, url: profile.url, headers: profile.headers ?? {} }
}
