/**
 * Browser client bundle for the MCP-Manager plugin, mirroring the DeepSeek
 * Harness client preset for an external package: a closure-factory artifact
 * that calls window.__ModuleLoader__.load({ id, factory }) and resolves
 * externals through the injected require (loader module table). CSS Modules
 * compile via lightningcss inside the bundle: importing `x.module.css` yields
 * the hashed class map, and the css text auto-injects a <style data-plugin>
 * tag at factory execution (the loader removes plugin-owned tags on unload).
 *
 * scripts/preflight.mjs asserts the emitted client/client.js starts with the
 * exact `window.__ModuleLoader__.load({ id: "@mcp-manager/mcp-manager"` prefix.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const id = '@mcp-manager/mcp-manager'

/**
 * Externals resolved from the loader module table at runtime. The dsh client
 * base seeds React; everything else this bundle needs (zod, dsh-client-store,
 * the CSS Modules) inlines, because a require() the table cannot answer is a
 * guaranteed runtime throw.
 */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime']

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches ids
 * ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  // The published artifact location: package.json exports "./client" points at
  // client/client.js, so the bundle lands there directly.
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // Host types ship from lib/types (tsc); dts here would wrap the banner/footer
  // into .d.cts and break parsing.
  dts: false,
  sourcemap: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // tsdown auto-externalizes package dependencies; anything NOT in the loader
  // module table must inline instead.
  noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      // The filename feeds lightningcss's `[hash]`. Repo-relative with posix
      // separators is the same input everywhere, including Windows, so the
      // class prefix is not a fingerprint of the checkout location.
      const { code, exports: cssExports } = transform({
        filename: relative(process.cwd(), fileId).split('\\').join('/'),
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
        // Without targets, lightningcss collapses hand-written vendor-prefixed
        // pairs to one form. Targets (major << 16) keep both.
        targets: { chrome: 90 << 16, firefox: 100 << 16, safari: 13 << 16, edge: 90 << 16 },
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      // One <style data-plugin> per module file; idempotent under re-evaluation.
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(id)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
