'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const installedCli = process.env.CHAINABIT_TEST_CLI_BINARY;
const cli = installedCli
  ? path.resolve(installedCli)
  : path.resolve(__dirname, '../bin/chainabit.cjs');
const packageJson = installedCli
  ? path.resolve(path.dirname(cli), '..', 'package.json')
  : path.resolve(__dirname, '../package.json');
const packageVersion = require(packageJson).version;

function runHelp(commandPath) {
  return spawnSync(process.execPath, [cli, ...commandPath, '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CHAINABIT_TOKEN: '', CI: '1', NO_COLOR: '1' },
  });
}

function childCommands(helpText) {
  const commands = [];
  let inCommands = false;

  for (const line of helpText.split('\n')) {
    if (line.trim() === 'Commands:') {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (!line.trim()) break;

    const match = /^  ([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*)(?=\s|$)/.exec(line);
    if (match) {
      for (const name of match[1].split('|')) {
        if (name !== 'help') commands.push(name);
      }
    }
  }

  return commands;
}

test('the published binary exposes help for every visible command path', async (t) => {
  const pending = [[]];
  const visited = new Set();

  while (pending.length > 0) {
    const commandPath = pending.shift();
    assert.ok(commandPath.length <= 8, `unexpected command nesting: ${commandPath.join(' ')}`);
    const name = commandPath.join(' ') || '(root)';
    assert.ok(!visited.has(name), `duplicate command path: ${name}`);
    visited.add(name);

    const result = runHelp(commandPath);
    await t.test(name, () => {
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Usage: chainabit/m);
    });

    if (result.status === 0) {
      for (const child of childCommands(result.stdout)) {
        pending.push([...commandPath, child]);
      }
    }
  }

  assert.ok(visited.size >= 50, `unexpectedly small command tree: ${visited.size}`);
});

test('the binary reports the package version exactly', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CHAINABIT_TOKEN: '', CI: '1', NO_COLOR: '1' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageVersion);
});

// The project hierarchy routes stay internal, so the public binary ships none
// of the hierarchy flags: they are absent, not hidden.
const HIERARCHY_FLAGS = ['--parent', '--root', '--children'];

test('the published binary does not expose the chainy hierarchy flags', async (t) => {
  const { createCliProgram } = require(cli);
  const chainy = createCliProgram().commands.find((command) => command.name() === 'chainy');
  assert.ok(chainy, 'chainy command must be registered');

  // Inspect the real exported parser without executing actions or contacting an API.
  const cases = [
    { command: 'list', options: ['--limit', '--offset', '--all'] },
    { command: 'create', options: ['--title', '--description'] },
    { command: 'update', options: ['--title', '--description'] },
    { command: 'delete', options: [] },
  ];

  for (const entry of cases) {
    await t.test(`chainy ${entry.command}`, () => {
      const command = chainy.commands.find((candidate) => candidate.name() === entry.command);
      assert.ok(command, `chainy ${entry.command} must be registered`);
      const longs = command.options.map((option) => option.long);
      for (const option of entry.options) assert.ok(longs.includes(option), option);
      for (const flag of HIERARCHY_FLAGS) {
        assert.ok(!longs.includes(flag), `chainy ${entry.command} must not register ${flag}`);
      }

      const result = runHelp(['chainy', entry.command]);
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
      for (const flag of HIERARCHY_FLAGS) {
        assert.ok(!result.stdout.includes(flag), `${flag} must not appear in public help`);
      }
    });
  }
});

test('the published binary refuses the chainy hierarchy flags as unknown options', async (t) => {
  const invocations = [
    ['chainy', 'list', '--parent', 'project_1'],
    ['chainy', 'list', '--root'],
    ['chainy', 'create', '--title', 'Plan', '--parent', 'project_1'],
    ['chainy', 'update', 'project_1', '--parent', 'none'],
    ['chainy', 'delete', 'project_1', '--children', 'refuse'],
  ];

  for (const args of invocations) {
    await t.test(args.join(' '), () => {
      const flag = args.find((arg) => HIERARCHY_FLAGS.includes(arg));
      // The parser refuses the flag before any action runs, so no API is contacted.
      const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, CHAINABIT_TOKEN: '', CI: '1', NO_COLOR: '1' },
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`unknown option '${flag}'`));
      // Nothing beyond the echoed refusal may suggest a hierarchy flag.
      const rest = `${result.stdout}${result.stderr}`.replace(`unknown option '${flag}'`, '');
      for (const hint of HIERARCHY_FLAGS) assert.ok(!rest.includes(hint), hint);
    });
  }

  await t.test('an update without a change flag names only the public flags', () => {
    const result = spawnSync(process.execPath, [cli, 'chainy', 'update', 'project_1'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, CHAINABIT_TOKEN: '', CI: '1', NO_COLOR: '1' },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.match(`${result.stdout}${result.stderr}`, /--title or --description/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('--parent'));
  });
});

test('the published bundle carries no hierarchy flag, internal route or work-sync code', () => {
  const bundle = fs.readFileSync(cli, 'utf8');
  for (const marker of [
    // Hierarchy flags, their strategies, routes and hints.
    '--children',
    'trash-subtree',
    'trash_subtree',
    'reparent_to_grandparent',
    'ProjectReparent',
    'ProjectDelete',
    '/chainies/:id/parent',
    'Use the dedicated reparent action',
    // The work protocol header the hierarchy and sync writes send.
    'X-Work-Protocol',
    // Internal sync routes and the private sync journal.
    '/sync/changes',
    '/sync/entities',
    'work_repository_local_only',
    'sync_context_changed',
    'work_sync_corrupt_journal',
  ]) {
    assert.ok(!bundle.includes(marker), `bundle must not contain ${marker}`);
  }
});
