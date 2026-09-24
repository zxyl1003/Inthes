import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('packaging rejects absent or empty Zotero-required manifest fields before producing an XPI', async () => {
  const manifest = JSON.parse(await readFile('addon/manifest.json', 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'inthes-build-'));
  try {
    await mkdir(join(directory, 'addon'));
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version: manifest.version }));
    for (const field of ['id', 'update_url', 'strict_max_version']) for (const value of [undefined, '']) {
      const invalid = structuredClone(manifest);
      invalid.applications.zotero[field] = value;
      await writeFile(join(directory, 'addon', 'manifest.json'), JSON.stringify(invalid));
      const result = spawnSync(process.execPath, [resolve('scripts/build.mjs')], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`Zotero requires applications.zotero.${field}`));
      await assert.rejects(access(join(directory, 'dist')));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
