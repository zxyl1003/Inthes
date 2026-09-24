import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const manifest = JSON.parse(await readFile('addon/manifest.json', 'utf8'));
if (manifest.version !== version) throw new Error('Synchronize addon/manifest.json with package.json before building');
// Zotero rejects a plugin without update_url even when updates are distributed manually.
for (const field of ['id', 'update_url', 'strict_max_version']) {
  const value = manifest.applications?.zotero?.[field];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Zotero requires applications.zotero.${field} in addon/manifest.json`);
}
await mkdir('build', { recursive: true });
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'iife', globalName: 'Folio', target: 'firefox115', outfile: 'build/folio.js', loader: { '.css': 'text', '.svg': 'dataurl' } });
const files = {};
for (const name of ['manifest.json', 'bootstrap.js']) {
  await copyFile(`addon/${name}`, `build/${name}`);
  files[name] = new Uint8Array(await readFile(`build/${name}`));
}
files['folio.js'] = new Uint8Array(await readFile('build/folio.js'));
await copyFile('src/assets/inthes.svg', 'build/inthes.svg');
files['inthes.svg'] = new Uint8Array(await readFile('build/inthes.svg'));
files['service-marks.md'] = new Uint8Array(await readFile('src/assets/README.md'));
files['LICENSE'] = new Uint8Array(await readFile('LICENSE'));
files['dompurify-LICENSE.txt'] = new Uint8Array(await readFile('node_modules/dompurify/LICENSE'));
files['marked-LICENSE.md'] = new Uint8Array(await readFile('node_modules/marked/LICENSE.md'));
files['katex-LICENSE.txt'] = new Uint8Array(await readFile('node_modules/katex/LICENSE'));
files['fflate-LICENSE.txt'] = new Uint8Array(await readFile('node_modules/fflate/LICENSE'));
await writeFile(`dist/inthes-${version}.xpi`, zipSync(files));
console.log(`Built dist/inthes-${version}.xpi`);
