'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/check-release-typing.mjs')).href);
const commit = (subject, over = {}) => ({ sha: 'abcdef1234567', subject, body: '', files: [], ...over });
const BUNDLE = ['bin/chainabit.cjs'];

test('a bundle regeneration typed fix with a release note is a patch', async () => {
  const { checkCommit } = await load();
  const result = checkCommit(commit('fix: regenerate the public bundle from api abc', { files: BUNDLE, body: 'Release-note: update works again' }));
  assert.deepEqual(result, { bump: 'patch', problems: [] });
});

test('a bundle regeneration typed feat without a Feature footer is refused (the 2026-11-12 pattern)', async () => {
  const { checkCommit } = await load();
  const result = checkCommit(commit('feat: regenerate the public bundle from api abc', { files: BUNDLE, body: 'Release-note: update works again' }));
  assert.equal(result.bump, 'minor');
  assert.match(result.problems.join('\n'), /Feature:/);
});

test('feat with Feature and Release-note footers is an allowed minor', async () => {
  const { checkCommit } = await load();
  const result = checkCommit(commit('feat(tui): select and copy transcript text', { files: BUNDLE, body: 'Release-note: drag to select, release to copy\n\nFeature: transcript selection' }));
  assert.deepEqual(result, { bump: 'minor', problems: [] });
});

test('a bundle change typed chore/docs/test/ci would not release and is refused', async () => {
  const { checkCommit } = await load();
  for (const type of ['chore', 'docs', 'test', 'ci', 'refactor']) {
    const result = checkCommit(commit(`${type}: sync bundle`, { files: BUNDLE, body: 'Release-note: x' }));
    assert.match(result.problems.join('\n'), /must release/, type);
  }
});

test('a bundle change without a Release-note footer is refused', async () => {
  const { checkCommit } = await load();
  const result = checkCommit(commit('fix: regenerate', { files: BUNDLE }));
  assert.match(result.problems.join('\n'), /Release-note/);
});

test('a breaking change needs Breaking-approved-by, with ! or a BREAKING CHANGE footer', async () => {
  const { checkCommit } = await load();
  assert.match(checkCommit(commit('feat!: drop a flag')).problems.join(''), /Breaking-approved-by/);
  assert.match(checkCommit(commit('fix: x', { body: 'BREAKING CHANGE: y' })).problems.join(''), /Breaking-approved-by/);
  const ok = checkCommit(commit('feat!: drop a flag', { body: 'Breaking-approved-by: owner' }));
  assert.deepEqual(ok, { bump: 'major', problems: [] });
});

test('non-conventional and unknown-type commits are refused', async () => {
  const { checkCommit } = await load();
  assert.match(checkCommit(commit('update stuff')).problems.join(''), /Conventional Commit/);
  assert.match(checkCommit(commit('wip: stuff')).problems.join(''), /unknown type/);
});

test('commits that do not touch the bundle keep ordinary typing and merges are ignored', async () => {
  const { checkRange } = await load();
  const result = checkRange([
    commit('docs: wording', { files: ['README.md'] }),
    commit('Merge pull request #1 from x/y', { merge: true }),
    commit('test: add a case', { files: ['test/cli.test.cjs'] }),
  ]);
  assert.deepEqual(result, { bump: 'none', problems: [] });
});

test('the range reports the highest bump among valid commits', async () => {
  const { checkRange } = await load();
  const result = checkRange([
    commit('fix: a', { files: BUNDLE, body: 'Release-note: a' }),
    commit('feat: b', { files: BUNDLE, body: 'Release-note: b\n\nFeature: b' }),
  ]);
  assert.deepEqual(result, { bump: 'minor', problems: [] });
});
