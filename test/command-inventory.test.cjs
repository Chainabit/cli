'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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

test('the published binary preserves the chainy hierarchy parser contract', async (t) => {
  const { createCliProgram } = require(cli);
  const chainy = createCliProgram().commands.find((command) => command.name() === 'chainy');
  assert.ok(chainy, 'chainy command must be registered');

  // Inspect the real exported parser without executing actions or contacting an API.
  // These are contract assertions, not a generated inventory or help snapshot.
  const cases = [
    { command: 'create', flags: '--parent <id>', conflicts: [] },
    { command: 'update', flags: '--parent <id|none>', conflicts: ['title', 'description'] },
    { command: 'list', flags: '--parent <id>', conflicts: ['root'] },
    { command: 'list', flags: '--root', conflicts: ['parent'] },
    {
      command: 'delete', flags: '--children <strategy>', conflicts: [],
      choices: ['refuse', 'reparent', 'trash-subtree'], defaultValue: 'refuse',
    },
  ];

  for (const entry of cases) {
    await t.test(`chainy ${entry.command} ${entry.flags}`, () => {
      const command = chainy.commands.find((candidate) => candidate.name() === entry.command);
      assert.ok(command, `chainy ${entry.command} must be registered`);
      const long = entry.flags.split(' ')[0];
      const option = command.options.find((candidate) => candidate.long === long);
      assert.ok(option, `chainy ${entry.command} must expose ${entry.flags}`);
      assert.equal(option.flags, entry.flags);
      assert.equal(Boolean(option.hidden), false);
      assert.equal(Boolean(option.required), entry.flags.includes('<'));
      assert.equal(Boolean(option.optional), false);
      assert.equal(Boolean(option.mandatory), false);
      assert.deepEqual(option.argChoices ?? [], entry.choices ?? []);
      assert.equal(option.defaultValue, entry.defaultValue);
      assert.deepEqual([...option.conflictsWith].sort(), [...entry.conflicts].sort());

      const result = runHelp(['chainy', entry.command]);
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(entry.flags), `${entry.flags} must appear in public help`);
    });
  }
});
