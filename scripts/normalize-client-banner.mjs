#!/usr/bin/env node
/**
 * Post-build normalization of client/client.js.
 *
 * 1. Rolldown pretty-prints the tsdown banner into a three-line header, but the
 *    published contract (enforced by preflight.mjs, and relied on by hosts that
 *    sniff the loader id from the file head) requires the file to START with the
 *    exact one-line `window.__ModuleLoader__.load({ id: "…"` prefix. Collapse
 *    the header onto one line, leaving blank lines in place of the folded ones
 *    so line numbers stay stable.
 * 2. tsdown names the CSS module's virtual chunk by ABSOLUTE path, so the
 *    builder's checkout path (E:\htmlProjects\…, /Users/…) ends up in a region
 *    comment and ships to the registry. Rewrite it to a stable repo-relative
 *    form and fail if any absolute build path survives.
 */
import fs from 'node:fs'

const file = 'client/client.js'
const name = JSON.parse(fs.readFileSync('package.json', 'utf8')).name
const required = `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`

let code = fs.readFileSync(file, 'utf8')

// --- 1. one-line loader banner -------------------------------------------
if (!code.startsWith(required)) {
  const lines = code.split('\n')
  const head = [
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(name)},`,
    '\tfactory: (require) => {',
  ]
  if (lines[0] !== head[0] || lines[1] !== head[1] || lines[2] !== head[2]) {
    console.error(`normalize-client-banner: unexpected ${file} header:\n` + lines.slice(0, 3).join('\n'))
    process.exit(1)
  }
  lines[0] = required
  lines[1] = ''
  lines[2] = ''
  code = lines.join('\n')
}

// --- 2. machine-independent CSS virtual ids -------------------------------
// `\0dsh-css:<abs>/src/client/X.module.css.mjs` → `\0dsh-css:src/client/X.module.css.mjs`
const root = process.cwd().replaceAll('\\', '/')
code = code.replace(/(dsh-css:)([^\n"]*)(src[/\\][^\n"]*?\.css\.mjs)/g, (_all, prefix, _dir, rel) =>
  prefix + rel.replaceAll('\\', '/'))
// Guard: this builder's own checkout path must not survive anywhere, and no
// virtual id may stay absolute. Deliberately narrow — the bundle legitimately
// contains strings like `s:\` inside regexes, so a generic drive-letter scan
// would false-positive.
const leaks = [
  ...code.matchAll(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')),
  ...code.matchAll(/dsh-css:(?:\/|[A-Za-z]:[/\\])[^\n"]*/g),
].map(match => match[0].slice(0, 60))
if (leaks.length > 0) {
  console.error(`normalize-client-banner: absolute build path left in ${file}: ${leaks.slice(0, 3).join(', ')}`)
  process.exit(1)
}

fs.writeFileSync(file, code)
console.log(`normalize-client-banner ok: ${file}`)
