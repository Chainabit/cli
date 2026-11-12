import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  canonicalJson,
  checkProduction,
  checkProvenance,
  checkReceipt,
  commandPaths,
  fetchAdvertised,
  inventoryDigest,
  readProtocolStamp,
  receiptDigest,
  releaseGate,
  report,
  sha256,
} from '../scripts/release-gate.mjs';

const DIGESTS = { 1: 'a'.repeat(64), 2: 'b'.repeat(64) };
const bundleBytes = (speaks = 2, requires = 2) =>
  Buffer.from(
    `#!/usr/bin/env node\n/* chainabit-cli-api-protocol speaks=${speaks} requires=${requires} */\n"use strict";\n`,
  );
const sidecar = (bundle, change = {}) => ({
  schema: 1,
  bundle: { file: 'chainabit.cjs', sha256: sha256(bundle) },
  apiSource: { sha: 'c'.repeat(40), dirty: false },
  cliApiProtocol: { speaks: 2, requires: 2, digests: DIGESTS },
  ...change,
});
const provenanceOf = (bundle, change) =>
  checkProvenance({ bundle, sidecarText: JSON.stringify(sidecar(bundle, change)) });

/* ------------------------------ provenance ------------------------------ */

test('a bundle with a matching sidecar and stamp has provenance', () => {
  const bundle = bundleBytes();
  const { problems, provenance } = provenanceOf(bundle);
  assert.deepEqual(problems, []);
  assert.equal(provenance.cliApiProtocol.requires, 2);
  assert.deepEqual(readProtocolStamp(bundle.toString()), { speaks: 2, requires: 2 });
});

test('a bundle without a sidecar is refused (the 2.3.0 bundle)', () => {
  const { problems, provenance } = checkProvenance({
    bundle: Buffer.from('#!/usr/bin/env node\n"use strict";\n'),
    sidecarText: null,
  });
  assert.equal(provenance, null);
  assert.match(problems[0], /no provenance sidecar/);
});

test('a sidecar for another bundle is refused', () => {
  const { problems } = checkProvenance({
    bundle: bundleBytes(),
    sidecarText: JSON.stringify(sidecar(Buffer.from('other'))),
  });
  assert.ok(problems.some((problem) => /another bundle/.test(problem)));
});

test('a sidecar that lowers the level the bundle is stamped with is refused', () => {
  const { problems } = provenanceOf(bundleBytes(2, 2), {
    cliApiProtocol: { speaks: 2, requires: 1, digests: DIGESTS },
  });
  assert.ok(problems.some((problem) => /contradicts the bundle's own stamp/.test(problem)));
});

test('an unstamped bundle, a dirty build, a missing digest and bad JSON are refused', () => {
  const plain = Buffer.from('#!/usr/bin/env node\n');
  assert.ok(
    checkProvenance({ bundle: plain, sidecarText: JSON.stringify(sidecar(plain)) })
      .problems.some((problem) => /no protocol stamp/.test(problem)),
  );
  assert.ok(
    provenanceOf(bundleBytes(), { apiSource: { sha: 'c'.repeat(40), dirty: true } })
      .problems.some((problem) => /uncommitted changes/.test(problem)),
  );
  assert.ok(
    provenanceOf(bundleBytes(), { apiSource: { sha: 'abc', dirty: false } })
      .problems.some((problem) => /no source revision/.test(problem)),
  );
  assert.ok(
    provenanceOf(bundleBytes(), {
      cliApiProtocol: { speaks: 2, requires: 2, digests: { 1: DIGESTS[1] } },
    }).problems.some((problem) => /no digest for protocol level 2/.test(problem)),
  );
  assert.deepEqual(
    checkProvenance({ bundle: bundleBytes(), sidecarText: '{' }).problems,
    ['the provenance sidecar is not valid JSON'],
  );
  assert.ok(
    provenanceOf(bundleBytes(), { schema: 2 }).problems.some((problem) =>
      /unknown provenance schema/.test(problem),
    ),
  );
});

/* ------------------------------ production ------------------------------ */

const provenance = provenanceOf(bundleBytes()).provenance;
const answering = (status, body) => async () => ({
  status,
  json: async () => {
    if (body === undefined) throw new Error('not json');
    return body;
  },
});

test('production at the required level with the same digest passes', () => {
  assert.deepEqual(
    checkProduction({
      provenance,
      advertised: { status: 'level', level: 2, digest: DIGESTS[2] },
    }),
    [],
  );
});

test('production above what the bundle speaks passes (nothing to compare)', () => {
  assert.deepEqual(
    checkProduction({
      provenance,
      advertised: { status: 'level', level: 5, digest: 'f'.repeat(64) },
    }),
    [],
  );
});

test('production below the required level fails', () => {
  const problems = checkProduction({
    provenance,
    advertised: { status: 'level', level: 1, digest: DIGESTS[1] },
  });
  assert.match(problems[0], /implements protocol level 1; this bundle requires 2/);
});

test('a released level that means something else in production fails', () => {
  const problems = checkProduction({
    provenance,
    advertised: { status: 'level', level: 2, digest: 'e'.repeat(64) },
  });
  assert.match(problems[0], /disagree on what protocol level 2 contains/);
});

test('production that advertises nothing, or cannot be reached, fails closed', () => {
  assert.match(
    checkProduction({ provenance, advertised: { status: 'absent' } })[0],
    /unknown is not promotable/,
  );
  assert.match(
    checkProduction({ provenance, advertised: { status: 'unknown', detail: 'x is unreachable' } })[0],
    /level is unknown: x is unreachable/,
  );
});

test('the gate has no override switch', () => {
  const source = readFileSync(new URL('../scripts/release-gate.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /accept-unknown|acceptUnknown|override\s*[:=(]/i);
  const workflow = (name) =>
    readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  assert.doesNotMatch(workflow('release-gate.yml'), /accept_unknown|inputs:|continue-on-error/);
  const publish = workflow('publish.yml');
  assert.doesNotMatch(publish, /accept_unknown|continue-on-error/);
  // The release job cannot start unless the gate passed.
  assert.match(publish, /\n  release-gate:\n    uses: \.\/\.github\/workflows\/release-gate\.yml\n/);
  assert.match(publish, /\n  release:\n    needs: \[[^\]]*\brelease-gate\b[^\]]*\]/);
});

test('the advertisement is read from the public route, fail closed', async () => {
  const seen = [];
  const level = await fetchAdvertised('https://api.example.test/api/v1/', async (url, init) => {
    seen.push([url, init.method, init.redirect]);
    return answering(200, { cliApiProtocol: 2, cliApiProtocolDigest: DIGESTS[2] })();
  });
  assert.deepEqual(level, { status: 'level', level: 2, digest: DIGESTS[2] });
  assert.deepEqual(seen, [
    ['https://api.example.test/api/v1/cli/compatibility', 'GET', 'error'],
  ]);
  assert.deepEqual(await fetchAdvertised('https://a.test', answering(404, {})), {
    status: 'absent',
  });
  for (const fetchImpl of [
    answering(500, {}),
    answering(200, undefined),
    answering(200, { cliApiProtocol: '2', cliApiProtocolDigest: DIGESTS[2] }),
    answering(200, { cliApiProtocol: 2 }),
    answering(200, { data: { cliApiProtocol: 2, cliApiProtocolDigest: DIGESTS[2] } }),
    async () => {
      throw new TypeError('fetch failed');
    },
  ])
    assert.equal((await fetchAdvertised('https://a.test', fetchImpl)).status, 'unknown');
});

/* ------------------------------ acceptance ------------------------------ */

const PATHS = ['auth', 'auth login', 'bit', 'bit list'];
const REQUIRED = { refs: ['origin/main', 'origin/development'], journeys: ['message', 'update'] };
const PNG = Buffer.from('png-bytes');
const step = (id, change = {}) => ({
  id,
  ok: true,
  screen: sha256(`screen ${id}`),
  screenshot: sha256(PNG),
  file: `origin-main/${id}.png`,
  ...change,
});
const run = (ref, change = {}) => ({
  api: { ref, sha: 'd'.repeat(40), cliApiProtocol: null },
  commands: { total: 4, executed: 3, classified: 1, failed: 0, unaccounted: 0 },
  journeys: [
    { id: 'message', steps: [step('reply')] },
    { id: 'update', steps: [step('check')] },
  ],
  failures: [],
  ...change,
});
function receipt(bundle, change = {}) {
  const body = {
    schema: 1,
    bundle: { sha256: sha256(bundle) },
    inventory: { commands: PATHS.length, sha256: inventoryDigest(PATHS) },
    runs: [run('origin/main'), run('origin/development')],
    ok: true,
    ...change,
  };
  return JSON.stringify({ ...body, digest: receiptDigest(body) });
}
const acceptance = (receiptText, options = {}) =>
  checkReceipt({
    receiptText,
    bundleSha256: sha256(bundleBytes()),
    paths: PATHS,
    required: REQUIRED,
    screenshot: () => PNG,
    ...options,
  });

test('a complete receipt for this bundle passes', () => {
  assert.deepEqual(acceptance(receipt(bundleBytes())), []);
});

test('no receipt, a receipt for another bundle and an edited receipt fail', () => {
  assert.match(acceptance(null)[0], /no acceptance receipt/);
  assert.ok(
    acceptance(receipt(Buffer.from('other'))).some((problem) => /another bundle/.test(problem)),
  );
  const edited = JSON.parse(receipt(bundleBytes()));
  edited.runs[0].commands.failed = 0;
  edited.runs[0].failures = [];
  edited.ok = true;
  edited.runs[0].api.sha = 'e'.repeat(40);
  assert.ok(
    acceptance(JSON.stringify(edited)).some((problem) => /digest mismatch/.test(problem)),
  );
});

test('a command that is neither executed nor classified fails the gate', () => {
  const problems = acceptance(
    receipt(bundleBytes(), {
      runs: [
        run('origin/main', {
          commands: { total: 4, executed: 2, classified: 1, failed: 0, unaccounted: 1 },
        }),
        run('origin/development'),
      ],
    }),
  );
  assert.ok(problems.some((problem) => /1 command\(s\) neither executed nor classified/.test(problem)));
  assert.ok(problems.some((problem) => /does not add up/.test(problem)));
});

test('a new command the receipt does not know fails the gate', () => {
  const problems = acceptance(receipt(bundleBytes()), { paths: [...PATHS, 'bit create'] });
  assert.ok(problems.some((problem) => /another command inventory/.test(problem)));
  assert.ok(problems.some((problem) => /covers 4 of 5 commands/.test(problem)));
});

test('a failed command, a failed step, a failed run and a missing ref fail', () => {
  assert.ok(
    acceptance(
      receipt(bundleBytes(), {
        runs: [
          run('origin/main', {
            commands: { total: 4, executed: 3, classified: 1, failed: 1, unaccounted: 0 },
            failures: ['chao: property localRuntime should not exist'],
          }),
          run('origin/development'),
        ],
        ok: false,
      }),
    ).some((problem) => /\[origin\/main\] 1 command\(s\) failed/.test(problem)),
  );
  assert.ok(
    acceptance(
      receipt(bundleBytes(), {
        runs: [
          run('origin/main', {
            journeys: [
              { id: 'message', steps: [step('reply', { ok: false })] },
              { id: 'update', steps: [step('check')] },
            ],
          }),
          run('origin/development'),
        ],
      }),
    ).some((problem) => /message\/reply failed/.test(problem)),
  );
  assert.ok(
    acceptance(receipt(bundleBytes(), { ok: false })).some((problem) =>
      /records a failed run/.test(problem),
    ),
  );
  assert.ok(
    acceptance(receipt(bundleBytes(), { runs: [run('origin/development')] })).some(
      (problem) => /no acceptance run against the API of origin\/main/.test(problem),
    ),
  );
});

test('a required journey that did not run, or ran without steps, fails', () => {
  const problems = acceptance(
    receipt(bundleBytes(), {
      runs: [
        run('origin/main', { journeys: [{ id: 'message', steps: [] }] }),
        run('origin/development'),
      ],
    }),
  );
  assert.ok(problems.some((problem) => /journey "update" did not run/.test(problem)));
  assert.ok(problems.some((problem) => /journey "message" has no step/.test(problem)));
});

test('a listed screenshot must exist with its hash, inside the receipt folder', () => {
  assert.ok(
    acceptance(receipt(bundleBytes()), { screenshot: () => null }).some((problem) =>
      /screenshot is missing/.test(problem),
    ),
  );
  assert.ok(
    acceptance(receipt(bundleBytes()), { screenshot: () => Buffer.from('other') }).some(
      (problem) => /does not match its hash/.test(problem),
    ),
  );
  assert.ok(
    acceptance(
      receipt(bundleBytes(), {
        runs: [
          run('origin/main', {
            journeys: [
              { id: 'message', steps: [step('reply', { file: '../../etc/passwd.png' })] },
              { id: 'update', steps: [step('check')] },
            ],
          }),
          run('origin/development'),
        ],
      }),
    ).some((problem) => /invalid screenshot path/.test(problem)),
  );
});

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(receiptDigest({ a: 1, b: 2, digest: 'x' }), receiptDigest({ b: 2, a: 1 }));
});

/* ------------------------------ end to end ------------------------------ */

function repository({ withSidecar = true, withReceipt = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-gate-'));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'acceptance'));
  mkdirSync(join(root, 'shots', 'origin-main'), { recursive: true });
  const bundle = bundleBytes();
  writeFileSync(join(root, 'bin', 'chainabit.cjs'), bundle);
  if (withSidecar)
    writeFileSync(
      join(root, 'bin', 'chainabit.provenance.json'),
      JSON.stringify(sidecar(bundle)),
    );
  writeFileSync(join(root, 'acceptance', 'required.json'), JSON.stringify(REQUIRED));
  if (withReceipt)
    writeFileSync(join(root, 'acceptance', 'receipt.json'), receipt(bundle));
  for (const id of ['reply', 'check'])
    writeFileSync(join(root, 'shots', 'origin-main', `${id}.png`), PNG);
  return root;
}
const production = (status, body) => answering(status, body);

test('the gate passes a provable bundle and fails closed otherwise', async (t) => {
  const roots = [];
  t.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
  const gate = (root, options = {}) =>
    releaseGate({
      root,
      paths: PATHS,
      screenshots: join(root, 'shots'),
      fetchImpl: production(200, { cliApiProtocol: 2, cliApiProtocolDigest: DIGESTS[2] }),
      ...options,
    });
  const good = repository();
  roots.push(good);

  const passed = await gate(good);
  assert.equal(passed.ok, true, report(passed));
  assert.match(report(passed), /RESULT: PASS/);

  // Production behind the bundle: the 2026-11-12 incident.
  const behind = await gate(good, {
    fetchImpl: production(200, { cliApiProtocol: 1, cliApiProtocolDigest: DIGESTS[1] }),
  });
  assert.equal(behind.ok, false);
  assert.match(report(behind), /FAIL {2}PRODUCTION[\s\S]*requires 2[\s\S]*RESULT: FAIL/);

  // Production that cannot say (it predates the route): fail closed.
  const silent = await gate(good, { fetchImpl: production(404, {}) });
  assert.equal(silent.ok, false);
  assert.match(report(silent), /FAIL {2}PRODUCTION[\s\S]*not promotable/);

  // A bundle that says nothing about itself: the published 2.3.0.
  const anonymous = repository({ withSidecar: false });
  roots.push(anonymous);
  const refused = await gate(anonymous);
  assert.equal(refused.ok, false);
  assert.match(report(refused), /FAIL {2}PROVENANCE[\s\S]*FAIL {2}PRODUCTION/);

  const unproven = repository({ withReceipt: false });
  roots.push(unproven);
  const noReceipt = await gate(unproven);
  assert.equal(noReceipt.ok, false);
  assert.match(report(noReceipt), /PASS {2}PROVENANCE[\s\S]*PASS {2}PRODUCTION[\s\S]*FAIL {2}ACCEPTANCE/);

  const noShots = await gate(good, { screenshots: null });
  assert.equal(noShots.ok, false);
});

test('the command inventory is read from the bundle itself', () => {
  const help = {
    '': 'Commands:\n  auth            sign in\n  bit|bits        tasks\n  help [command]  help\n\n',
    auth: 'Commands:\n  login  sign in\n\n',
    'auth login': 'Usage: x\n',
    bit: 'Usage: x\n\nCommands:\n  list  list\n\nOther:\n  nope  no\n',
    'bit list': '',
  };
  const paths = commandPaths('bundle.cjs', (_node, argv) => ({
    status: 0,
    stdout: help[argv.slice(1, -1).join(' ')],
  }));
  assert.deepEqual(paths, ['auth', 'auth login', 'bit', 'bit list']);
  assert.throws(() => commandPaths('bundle.cjs', () => ({ status: 1, stdout: '' })));
});
