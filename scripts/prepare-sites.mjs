import { cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const target = join(root, '.runtime/public-site');
for (const path of ['apps/web/dist/index.html', 'dist/api/nfz.js', 'dist/api/fixtures.js']) {
  if (!existsSync(join(root, path))) throw new Error(`Build required input first: ${path}`);
}
// A single fresh generated directory. No recursive deletion or publication.
if (existsSync(join(root, '.runtime')) && lstatSync(join(root, '.runtime')).isSymbolicLink())
  throw new Error('The .runtime directory must not be a symlink or junction');
if (existsSync(target)) throw new Error('The output directory already exists; use a clean working copy');
for (const dir of ['worker', 'dist/server', 'dist/client/demo-assets', 'db'])
  mkdirSync(join(target, dir), { recursive: true });
for (const destination of ['worker', 'dist/server']) {
  copyFileSync(join(root, 'deploy/sites/worker.mjs'), join(target, destination, 'index.js'));
  for (const file of ['nfz.js', 'fixtures.js'])
    copyFileSync(join(root, 'dist/api', file), join(target, destination, file));
}
copyFileSync(join(root, 'deploy/sites/schema.ts'), join(target, 'db/schema.ts'));
cpSync(join(root, 'deploy/sites/drizzle'), join(target, 'drizzle'), { recursive: true });
cpSync(join(root, 'apps/web/dist'), join(target, 'dist/client'), { recursive: true });
mkdirSync(join(target, 'dist/client/_planb'), { recursive: true });
copyFileSync(join(target, 'dist/client/index.html'), join(target, 'dist/client/_planb/shell.txt'));
unlinkSync(join(target, 'dist/client/index.html'));
copyFileSync(join(root, 'apps/api/fixtures/polish-note.wav'), join(target, 'dist/client/demo-assets/polish-note.wav'));
writeFileSync(join(target, 'dist/server/wrangler.json'), JSON.stringify({
  name: 'plan-b', main: 'index.js', compatibility_date: '2026-10-03',
  assets: { directory: '../client', binding: 'ASSETS', run_worker_first: true },
}, null, 2) + '\n');
console.log('Prepared .runtime/public-site. No publication was performed.');
