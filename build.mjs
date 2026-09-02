import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** Host (extension host) bundle: CommonJS, `vscode` external. */
const hostConfig = {
  platform: 'node',
  format: 'cjs',
  entryPoints: [path.join(dir, 'src/extension.ts')],
  outfile: path.join(dir, 'dist/extension.js'),
  bundle: true,
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

/** Webview bundle: browser ESM, engine + katex + mermaid bundled. */
const webviewConfig = {
  platform: 'browser',
  format: 'esm',
  entryPoints: [path.join(dir, 'src/webview/editor.ts')],
  outdir: path.join(dir, 'dist/webview'),
  bundle: true,
  splitting: true,
  chunkNames: '[name]-[hash]',
  // @vscode/diff has a guarded Node-only dynamic import that is dead code here.
  external: ['node:fs/promises'],
  loader: {
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
    '.eot': 'file',
    '.svg': 'file',
  },
  assetNames: '[name]-[hash]',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  const ctxHost = await build({ ...hostConfig, logLevel: 'silent' });
  const ctxWeb = await build({ ...webviewConfig, logLevel: 'silent' });
  await Promise.all([ctxHost.watch(), ctxWeb.watch()]);
  console.log('watching for changes...');
} else {
  await build(hostConfig);
  await build(webviewConfig);
  console.log('build complete');
}
