import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const repository = 'zxyl1003/Inthes';
const manifest = JSON.parse(await readFile('addon/manifest.json', 'utf8'));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.version !== version) throw new Error('Package and plugin versions differ');
if (manifest.applications.zotero.update_url !== `https://raw.githubusercontent.com/${repository}/main/updates.json`)
  throw new Error('Plugin update_url does not point to this repository');

const filename = `inthes-${version}.xpi`;
const hash = createHash('sha256').update(await readFile(`dist/${filename}`)).digest('hex');
const update = {
  addons: {
    [manifest.applications.zotero.id]: {
      updates: [{
        version,
        update_link: `https://github.com/${repository}/releases/download/v${version}/${filename}`,
        update_hash: `sha256:${hash}`,
        applications: { zotero: {
          strict_min_version: manifest.applications.zotero.strict_min_version,
          strict_max_version: manifest.applications.zotero.strict_max_version,
        } },
      }],
    },
  },
};
await writeFile('updates.json', JSON.stringify(update, null, 2) + '\n');
console.log(`Updated updates.json for ${filename}`);
