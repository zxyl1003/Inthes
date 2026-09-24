import test from 'node:test';
import assert from 'node:assert/strict';
import { citedSources, normalizeCitations, replaceCitations } from '../src/citations.ts';
import type { Source } from '../src/types.ts';

const sources: Source[] = [1, 2, 3].map(i => ({ id: `S11P2C${i}`, itemID: 1916, title: 'Paper', page: 2, text: `Evidence ${i}` }));

test('model citation variants resolve to the same actual passages', () => {
  const text = '中文【S11P2C1】，空格[ S11P2C2 ]，全角［S11P2C3］，范围[S11P2C1-S11P2C3]';
  assert.equal(normalizeCitations(text, sources, true), '中文[S11P2C1]，空格[S11P2C2]，全角[S11P2C3]，范围[S11P2C1][S11P2C2][S11P2C3]');
  assert.deepEqual(citedSources(text, sources), sources);
  assert.equal(replaceCitations('【S11P2C1–S11P2C3】', sources, s => `<cite>${s.id}</cite>`), sources.map(s => `<cite>${s.id}</cite>`).join(''));
});

test('unknown or ambiguous references never bypass evidence validation', () => {
  for (const text of ['[S11P2C4]', '【S12P2C1】', '[ S11P2C4 ]', '[S11P2C1-S11P2C4]', '[S11P2C3-S11P2C1]', '[S11P2C1-S11P3C1]', '[S11P2]', '[S11P2C1-S11P2C99999999999999999]']) {
    assert.throws(() => citedSources(text, sources), /引用/);
    assert.equal(normalizeCitations(text, sources), text);
  }
  assert.throws(() => citedSources('[S11P2C1-S11P2C3]', [sources[0], sources[2]]), /未提供|范围无效/);
});

test('code examples and ordinary brackets are preserved verbatim', () => {
  const code = '`const citation = "【S90P1C1】"`\n```md\n[S99P1C1-S99P1C3]\n```\n[2024]';
  assert.equal(normalizeCitations(code, sources, true), code);
  assert.deepEqual(citedSources(`${code}\n【S11P2C1】`, sources), [sources[0]]);
});

test('citation-only inline code is rendered and validated as evidence', () => {
  const text = 'Evidence `[S11P2C1]` and ``【 S11P2C2 】 [S11P2C3]``.';
  assert.equal(normalizeCitations(text, sources, true), 'Evidence [S11P2C1] and [S11P2C2] [S11P2C3].');
  assert.deepEqual(citedSources(text, sources), sources);
  assert.equal(replaceCitations('`[S11P2C1]`', sources, s => `<cite>${s.id}</cite>`), '<cite>S11P2C1</cite>');
  assert.throws(() => citedSources('Evidence `[S11P2C4]`', sources), /未提供/);
  assert.throws(() => citedSources('Evidence `[S11P2]`', sources), /引用格式/);
  const fenced = '```\n[S11P2C1]\n```';
  assert.equal(normalizeCitations(fenced, sources, true), fenced);
  assert.deepEqual(citedSources(fenced, sources), []);
});

test('a repeated page marker is corrected only to an existing exact passage', () => {
  const source = { ...sources[0], id: 'S30P7C17', page: 7 };
  const text = 'Failed geolocation [S30P7P17] and 【 S30P7P17 】.';
  assert.equal(normalizeCitations(text, [source], true), 'Failed geolocation [S30P7C17] and [S30P7C17].');
  assert.deepEqual(citedSources(text, [source]), [source]);
  assert.equal(normalizeCitations('Evidence `[S30P7P17]`', [source], true), 'Evidence [S30P7C17]');
  for (const unknown of ['[S30P7P18]', '[S31P7P17]', '[S30P17]', '[S30P7P017]']) {
    assert.throws(() => citedSources(unknown, [source]), /引用/);
    assert.equal(normalizeCitations(unknown, [source]), unknown);
  }
});

test('cross-page ranges preserve source order and reject missing passages or pages', () => {
  const next = [1, 2].map(i => ({ ...sources[0], id: `S11P3C${i}`, page: 3 }));
  const text = '[S11P2C2–S11P3C2]';
  assert.equal(normalizeCitations(text, [...next, ...sources], true), '[S11P2C2][S11P2C3][S11P3C1][S11P3C2]');
  assert.throws(() => citedSources(text, [...sources, next[1]]), /未提供/);
  assert.throws(() => citedSources('[S11P2C2-S11P4C1]', [...sources, { ...next[0], id: 'S11P4C1', page: 4 }]), /未提供/);
  assert.throws(() => citedSources('[S11P3C1-S11P2C2]', [...sources, ...next]), /倒序/);
  assert.throws(() => citedSources('[S11P2C2-S12P3C1]', [...sources, { ...next[0], id: 'S12P3C1' }]), /跨文献/);
});
