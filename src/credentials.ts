/**
 * Credential resolution for one authored server profile: turn its credential
 * references into concrete secret values and a log-safe fingerprint, so the
 * supervisor can merge them into the connection env/headers and re-create a
 * server when a referenced secret changes.
 *
 * A reference that names nothing fails loud for that one server, exactly as the
 * LLM adapters fail on a missing key: connecting with an absent secret would
 * authenticate as some unrelated ambient identity instead of surfacing the gap.
 *
 * @module @mcp-manger/mcp-manager/credentials
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ServerProfile } from './config.ts'

/** The resolved secret plane for one server profile. */
export interface ResolvedSecrets {
  /**
   * Merged env (stdio) or headers (http): the profile's plaintext values with
   * every resolved credential value layered on top by name.
   */
  values: Record<string, string>
  /**
   * SHA-256 digest of the resolved credential values, keyed and ordered by
   * name. Two profiles resolving the same secrets share a fingerprint, so an
   * unchanged secret never re-creates the connection while a rotated one does.
   */
  fingerprint: string
}

/**
 * Resolve one profile's credential references against the credentials seam.
 *
 * @param ctx - Cordis context whose optional `credentials` service resolves references.
 * @param serverName - the server being resolved, named in every diagnostic.
 * @param profile - the authored profile whose references are resolved.
 * @returns the merged secret values and their fingerprint.
 * @throws when a reference is named but the credentials seam is absent, the
 *   reference name is invalid, or the reference resolves to no value.
 */
export async function resolveProfileSecrets(
  ctx: Context,
  serverName: string,
  profile: ServerProfile,
): Promise<ResolvedSecrets> {
  const isStdio = profile.transport === 'stdio'
  const refs: Record<string, string> = (isStdio ? profile.envCredentials : profile.headerCredentials) ?? {}
  const plain: Record<string, string> = (isStdio ? profile.env : profile.headers) ?? {}
  const names = Object.keys(refs).sort()
  const resolved: Record<string, string> = {}
  if (names.length > 0) {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      throw new Error(
        `mcp(${serverName}): the profile declares credential references but this deployment mounts no credentials service`,
      )
    }
    for (const name of names) {
      const ref = refs[name]
      /* v8 ignore next -- the loop reads keys from the same record it indexes. */
      if (ref === undefined) continue
      // credentialRef judges the reference grammar and throws an actionable
      // TypeError for a name that can never resolve.
      const hit = await credentials.resolve(credentialRef(ref))
      if (hit === undefined || hit.value.length === 0) {
        throw new Error(
          `mcp(${serverName}): no credential for "${name}"; its profile resolves ${ref}, which is not set —`
          + ` store a value for ${ref} through the credentials service, or remove the reference`,
        )
      }
      resolved[name] = hit.value
    }
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(names.map(name => [name, resolved[name]])))
    .digest('hex')
  return { values: { ...plain, ...resolved }, fingerprint }
}
