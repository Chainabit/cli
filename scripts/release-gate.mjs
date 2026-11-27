#!/usr/bin/env node
/**
 * The release gate: may this bundle go to `main` (and so to npm)?
 *
 * The CLI is built from a newer tree than the API production runs. On
 * 2026-11-12 a bundle shipped that production refused on every message; no
 * check compared the bundle with what production runs. This gate does, and
 * fails closed:
 *
 * 1. PROVENANCE  `bin/chainabit.provenance.json` exists, names exactly this
 *                bundle (SHA-256), was built from a clean source revision, and
 *                states the CLI <-> API protocol levels the bundle itself is
 *                stamped with.
 * 2. PRODUCTION  the production API advertises (`GET /cli/compatibility`) a
 *                protocol level at least the level the bundle requires, and
 *                means the same thing by that level (digest). Unreachable,
 *                absent or malformed is a failure: unknown is not promotable.
 * 3. ACCEPTANCE  `acceptance/receipt.json` is the receipt of an automated
 *                acceptance run of exactly this bundle against the API builds
 *                of every required ref: every command path of the bundle is
 *                executed or classified, every required journey ran, nothing
 *                failed, and the screenshots it lists exist with those hashes.
 *
 * Usage: node scripts/release-gate.mjs [--bundle bin/chainabit.cjs]
 *          [--api https://api.chainabit.com/api/v1] [--receipt acceptance/receipt.json]
 *          [--required acceptance/required.json] [--screenshots <dir>]
 *          [--summary <file>]
 *
 * There is no override. A production API that does not advertise a level (it
 * predates the route) is not promotable: deploy the API first.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_API = 'https://api.chainabit.com/api/v1';
export const COMPATIBILITY_PATH = '/cli/compatibility';
export const PROVENANCE_FILE = 'chainabit.provenance.json';

export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

/** Stable serialisation: sorted keys, no whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

const STAMP =
  /^\/\* chainabit-cli-api-protocol speaks=(\d+) requires=(\d+) \*\/$/m;

/** The protocol levels stamped into a bundle's banner, or null. */
export function readProtocolStamp(bundleText) {
  const match = STAMP.exec(bundleText.slice(0, 4096));
  return match
    ? { speaks: Number(match[1]), requires: Number(match[2]) }
    : null;
}

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isLevel = (value) => Number.isSafeInteger(value) && value >= 1;
const isSha256 = (value) =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function parseJson(text, what, problems) {
  try {
    const value = JSON.parse(text);
    if (isRecord(value)) return value;
    problems.push(`${what} is not a JSON object`);
  } catch {
    problems.push(`${what} is not valid JSON`);
  }
  return null;
}

/**
 * 1. PROVENANCE. `sidecarText` is null when the file does not exist.
 * Returns `{ problems, provenance }` (`provenance` only when usable).
 */
export function checkProvenance({ bundle, sidecarText }) {
  const problems = [];
  if (sidecarText === null)
    return {
      problems: [
        `no provenance sidecar (bin/${PROVENANCE_FILE}): this bundle does not say which API it needs`,
      ],
      provenance: null,
    };
  const document = parseJson(sidecarText, 'the provenance sidecar', problems);
  if (!document) return { problems, provenance: null };
  if (document.schema !== 1)
    problems.push(`unknown provenance schema ${JSON.stringify(document.schema)}`);
  const digest = sha256(bundle);
  if (document.bundle?.sha256 !== digest)
    problems.push(
      `the provenance is for another bundle (it names ${String(document.bundle?.sha256).slice(0, 12)}, this bundle is ${digest.slice(0, 12)})`,
    );
  if (!/^[0-9a-f]{40}$/.test(document.apiSource?.sha ?? ''))
    problems.push('the provenance names no source revision');
  if (document.apiSource?.dirty !== false)
    problems.push(
      'the bundle was built from a source tree with uncommitted changes',
    );
  const protocol = document.cliApiProtocol;
  const stamp = readProtocolStamp(bundle.toString('utf8'));
  if (!stamp) problems.push('the bundle carries no protocol stamp');
  if (
    !isRecord(protocol) ||
    !isLevel(protocol.speaks) ||
    !isLevel(protocol.requires) ||
    protocol.requires > protocol.speaks
  )
    problems.push('the provenance states no valid protocol levels');
  else {
    if (
      stamp &&
      (stamp.speaks !== protocol.speaks || stamp.requires !== protocol.requires)
    )
      problems.push(
        `the provenance (speaks ${protocol.speaks}, requires ${protocol.requires}) contradicts the bundle's own stamp (speaks ${stamp.speaks}, requires ${stamp.requires})`,
      );
    for (let level = 1; level <= protocol.speaks; level++)
      if (!isSha256(protocol.digests?.[level]))
        problems.push(`the provenance has no digest for protocol level ${level}`);
  }
  return { problems, provenance: problems.length ? null : document };
}

/**
 * What an API advertises: `{ status: 'level', level, digest }`,
 * `{ status: 'absent' }` (HTTP 404: the API predates the route) or
 * `{ status: 'unknown', detail }`.
 */
export async function fetchAdvertised(api, fetchImpl = fetch) {
  const url = `${api.replace(/\/+$/, '')}${COMPATIBILITY_PATH}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { status: 'unknown', detail: `${url} is unreachable (${error?.name ?? 'error'})` };
  }
  if (response.status === 404) return { status: 'absent' };
  if (response.status !== 200)
    return { status: 'unknown', detail: `${url} answered HTTP ${response.status}` };
  let body;
  try {
    body = await response.json();
  } catch {
    return { status: 'unknown', detail: `${url} did not answer JSON` };
  }
  if (!isRecord(body) || !isLevel(body.cliApiProtocol) || !isSha256(body.cliApiProtocolDigest))
    return { status: 'unknown', detail: `${url} answered no protocol level` };
  return {
    status: 'level',
    level: body.cliApiProtocol,
    digest: body.cliApiProtocolDigest,
  };
}

/** 2. PRODUCTION. Returns the problems (empty: production serves this bundle). */
export function checkProduction({ provenance, advertised }) {
  const { requires, speaks, digests } = provenance.cliApiProtocol;
  if (advertised.status === 'level') {
    if (advertised.level < requires)
      return [
        `production implements protocol level ${advertised.level}; this bundle requires ${requires}. Deploy the API first.`,
      ];
    if (
      advertised.level <= speaks &&
      digests[advertised.level] !== advertised.digest
    )
      return [
        `production and this bundle disagree on what protocol level ${advertised.level} contains (a released level was edited)`,
      ];
    return [];
  }
  if (advertised.status === 'absent')
    return [
      `production does not advertise a protocol level (no ${COMPATIBILITY_PATH}): what it implements is unknown, and unknown is not promotable. Deploy the API first.`,
    ];
  // Unreachable or malformed: retry when it answers.
  return [`production's protocol level is unknown: ${advertised.detail}`];
}

/** Every visible command path of a bundle, from its own `--help`. */
export function commandPaths(bundle, run = spawnSync) {
  const paths = [];
  const pending = [[]];
  while (pending.length) {
    const path = pending.shift();
    if (path.length > 8) throw new Error(`unexpected nesting: ${path.join(' ')}`);
    const help = run(process.execPath, [bundle, ...path, '--help'], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, CHAINABIT_TOKEN: '', CI: '1', NO_COLOR: '1' },
    });
    if (help.status !== 0)
      throw new Error(`\`${path.join(' ')} --help\` exited ${help.status}`);
    if (path.length) paths.push(path.join(' '));
    let inCommands = false;
    for (const line of help.stdout.split('\n')) {
      if (line.trim() === 'Commands:') {
        inCommands = true;
        continue;
      }
      if (!inCommands) continue;
      if (!line.trim()) break;
      const match = /^  ([a-z][a-z0-9-]*)(?:\|[a-z][a-z0-9-]*)*(?=\s|$)/.exec(line);
      if (match && match[1] !== 'help') pending.push([...path, match[1]]);
    }
  }
  return paths.sort();
}

/** The identity of a command inventory. */
export const inventoryDigest = (paths) => sha256([...paths].sort().join('\n'));

/** The receipt's own hash: everything but `digest`, canonically. */
export function receiptDigest(receipt) {
  const { digest: _digest, ...rest } = receipt;
  return sha256(canonicalJson(rest));
}

/**
 * 3. ACCEPTANCE. `receiptText` is null when the file does not exist;
 * `screenshot(file)` returns a listed screenshot's bytes or null.
 */
export function checkReceipt({
  receiptText,
  bundleSha256,
  paths,
  required,
  screenshot,
}) {
  if (receiptText === null)
    return [
      'no acceptance receipt: this bundle was not run through the automated acceptance',
    ];
  const problems = [];
  const receipt = parseJson(receiptText, 'the acceptance receipt', problems);
  if (!receipt) return problems;
  if (receipt.schema !== 1)
    return [`unknown receipt schema ${JSON.stringify(receipt.schema)}`];
  if (receipt.digest !== receiptDigest(receipt))
    problems.push('the receipt was changed after it was written (digest mismatch)');
  if (receipt.bundle?.sha256 !== bundleSha256)
    problems.push(
      `the receipt is for another bundle (${String(receipt.bundle?.sha256).slice(0, 12)}, this bundle is ${bundleSha256.slice(0, 12)})`,
    );
  if (receipt.ok !== true) problems.push('the receipt records a failed run');
  if (
    receipt.inventory?.commands !== paths.length ||
    receipt.inventory?.sha256 !== inventoryDigest(paths)
  )
    problems.push(
      `the receipt covers another command inventory (${receipt.inventory?.commands} commands; this bundle has ${paths.length})`,
    );
  const runs = Array.isArray(receipt.runs) ? receipt.runs : [];
  for (const ref of required.refs) {
    const run = runs.find((candidate) => candidate?.api?.ref === ref);
    if (!run) {
      problems.push(`no acceptance run against the API of ${ref}`);
      continue;
    }
    const at = `[${ref}]`;
    if (!/^[0-9a-f]{40}$/.test(run.api.sha ?? ''))
      problems.push(`${at} names no API revision`);
    const commands = run.commands ?? {};
    if (commands.total !== paths.length)
      problems.push(`${at} covers ${commands.total} of ${paths.length} commands`);
    if (commands.unaccounted !== 0)
      problems.push(
        `${at} ${commands.unaccounted} command(s) neither executed nor classified`,
      );
    if (commands.failed !== 0)
      problems.push(`${at} ${commands.failed} command(s) failed`);
    if (
      !Number.isSafeInteger(commands.executed) ||
      !Number.isSafeInteger(commands.classified) ||
      commands.executed + commands.classified !== commands.total
    )
      problems.push(`${at} executed + classified does not add up to the total`);
    if (!(commands.executed > 0)) problems.push(`${at} executed no command`);
    const journeys = Array.isArray(run.journeys) ? run.journeys : [];
    for (const id of required.journeys) {
      const journey = journeys.find((candidate) => candidate?.id === id);
      if (!journey) {
        problems.push(`${at} journey "${id}" did not run`);
        continue;
      }
      const steps = Array.isArray(journey.steps) ? journey.steps : [];
      if (!steps.length) problems.push(`${at} journey "${id}" has no step`);
      for (const step of steps) {
        const where = `${at} ${id}/${step?.id}`;
        if (step?.ok !== true) problems.push(`${where} failed`);
        if (!isSha256(step?.screen))
          problems.push(`${where} has no screen snapshot`);
        if (typeof step?.file !== 'string' || !isSha256(step?.screenshot)) {
          problems.push(`${where} lists no screenshot`);
          continue;
        }
        if (!/^[a-z0-9][a-z0-9._/-]*\.png$/.test(step.file) || step.file.includes('..')) {
          problems.push(`${where} lists an invalid screenshot path`);
          continue;
        }
        const bytes = screenshot(step.file);
        if (!bytes) problems.push(`${where} screenshot is missing (${step.file})`);
        else if (sha256(bytes) !== step.screenshot)
          problems.push(`${where} screenshot does not match its hash`);
      }
    }
    if (Array.isArray(run.failures) ? run.failures.length : true)
      problems.push(`${at} records ${run.failures?.length ?? 'unknown'} failure(s)`);
  }
  return problems;
}

/** Runs the three checks. Returns `{ ok, sections, bundleSha256 }`. */
export async function releaseGate({
  root,
  bundlePath = 'bin/chainabit.cjs',
  api = PRODUCTION_API,
  receiptPath = 'acceptance/receipt.json',
  requiredPath = 'acceptance/required.json',
  screenshots = null,
  fetchImpl = fetch,
  paths = null,
}) {
  const read = (file) =>
    existsSync(resolve(root, file)) ? readFileSync(resolve(root, file)) : null;
  const bundle = read(bundlePath);
  if (!bundle) throw new Error(`No bundle at ${bundlePath}`);
  const sidecar = read(join(dirname(bundlePath), PROVENANCE_FILE));
  const provenance = checkProvenance({
    bundle,
    sidecarText: sidecar ? sidecar.toString('utf8') : null,
  });
  const sections = [{ name: 'PROVENANCE', problems: provenance.problems }];

  if (provenance.provenance)
    sections.push({
      name: 'PRODUCTION',
      problems: checkProduction({
        provenance: provenance.provenance,
        advertised: await fetchAdvertised(api, fetchImpl),
      }),
    });
  else
    sections.push({
      name: 'PRODUCTION',
      problems: ['not comparable: the bundle states no protocol level'],
    });

  const required = JSON.parse(read(requiredPath).toString('utf8'));
  const receipt = read(receiptPath);
  sections.push({
    name: 'ACCEPTANCE',
    problems: checkReceipt({
      receiptText: receipt ? receipt.toString('utf8') : null,
      bundleSha256: sha256(bundle),
      paths: paths ?? commandPaths(resolve(root, bundlePath)),
      required,
      screenshot: (file) =>
        screenshots && existsSync(resolve(screenshots, file))
          ? readFileSync(resolve(screenshots, file))
          : null,
    }),
  });
  return {
    ok: sections.every((section) => section.problems.length === 0),
    sections,
    bundleSha256: sha256(bundle),
  };
}

export function report({ ok, sections, bundleSha256 }) {
  const lines = [`Release gate for bundle ${bundleSha256}`, ''];
  for (const { name, problems } of sections) {
    lines.push(`${problems.length ? 'FAIL' : 'PASS'}  ${name}`);
    for (const problem of problems) lines.push(`      - ${problem}`);
  }
  lines.push('', ok ? 'RESULT: PASS' : 'RESULT: FAIL (this bundle is not promotable)');
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const option = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const result = await releaseGate({
    root: process.cwd(),
    bundlePath: option('--bundle'),
    api: option('--api'),
    receiptPath: option('--receipt'),
    requiredPath: option('--required'),
    screenshots: option('--screenshots') ?? null,
  });
  const text = report(result);
  console.log(text);
  const summary = option('--summary');
  if (summary) appendFileSync(summary, '```\n' + text + '\n```\n');
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
