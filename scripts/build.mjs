// Bundles main / preload / renderer with esbuild. `--tests` also bundles test/*.test.ts to dist-test/.
import { build } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const withTests = process.argv.includes('--tests');
const common = { bundle: true, sourcemap: 'linked', logLevel: 'warning', target: 'es2022' };

await rm('dist', { recursive: true, force: true });

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main/main.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/preload/preload.ts'],
    outfile: 'dist/preload/preload.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: { pet: 'src/renderer/pet/pet.ts', panel: 'src/renderer/panel/panel.ts' },
    outdir: 'dist/renderer',
    platform: 'browser',
    format: 'iife',
  }),
]);

await mkdir('dist/renderer', { recursive: true });
for (const page of ['pet', 'panel']) {
  await cp(`src/renderer/${page}/index.html`, `dist/renderer/${page}.html`);
  await cp(`src/renderer/${page}/${page}.css`, `dist/renderer/${page}.css`);
}
await cp('src/renderer/common/base.css', 'dist/renderer/base.css');

if (withTests) {
  await rm('dist-test', { recursive: true, force: true });
  const files = (await readdir('test')).filter((f) => f.endsWith('.test.ts'));
  await build({
    ...common,
    sourcemap: false,
    entryPoints: files.map((f) => path.join('test', f)),
    outdir: 'dist-test',
    entryNames: '[name]',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
}
console.log(`built${withTests ? ' (+tests)' : ''}`);
