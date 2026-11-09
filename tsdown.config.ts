import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
const require = createRequire(import.meta.url)
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => {
    if (!source.endsWith('?raw')) return undefined
    const id = source.slice(0, -4)
    const file = id.startsWith('.') && importer ? resolve(dirname(importer), id)
      : (() => { try { return require.resolve(id) } catch { return undefined } })()
    return file ? file + '?raw' : undefined
  },
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
export default defineConfig([
  { entry: { provider: 'src/paseo-ui/provider.ts', 'host-control': 'src/paseo-ui/host-control.ts', 'project-manager': 'src/projects/index.ts' }, outDir: 'paseo-plugin/server', format: 'esm', platform: 'node', target: 'es2024', dts: true,
    deps: { alwaysBundle: ['zod'] } },
  { entry: { index: 'src/index.ts', 'paseo-host': 'src/hosts/paseo.ts', 'paseo-project-child': 'src/projects/child.ts', 'project-cli': 'src/projects/cli.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts', 'local-cli': 'src/local/cli.ts', 'paseo-mcp': 'src/paseo/mcp.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: true, clean: true, deps: { neverBundle: [/^@deepseek-ai\//, /^@modelcontextprotocol\//, 'zod', 'proper-lockfile'] } },
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw],
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-superagent", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
  { entry: { app: 'src/flow-web/ui/index.tsx' }, outDir: 'lib/flow-web', format: 'esm', platform: 'browser',
    dts: false, clean: false, plugins: [raw, { name: 'flow-html', writeBundle() {
      mkdirSync(resolve('lib/flow-web'), { recursive: true })
      copyFileSync(resolve('src/flow-web/ui/index.html'), resolve('lib/flow-web/index.html'))
    } }],
    deps: { alwaysBundle: [/.*/] },
    outputOptions: { entryFileNames: 'app.js', assetFileNames: 'app.[ext]' } },
])
