'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const CLI = process.env.CHAINABIT_TEST_CLI_BINARY ||
  path.resolve(__dirname, '../bin/chainabit.cjs');
const FAKE_TOKEN = 'cbt_test_fake';

describe('connector ownership scope', () => {
  test('install exposes explicit ownership and defaults to personal', () => {
    const result = runSync(['connectors', 'install', '--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--scope <scope>/);
    assert.match(result.stdout, /"personal", "team"/);
    assert.match(result.stdout, /"personal"\)/);
  });

  test('rejects an unknown ownership before transport', () => {
    const result = runSync(['connectors', 'install', 'slack', '--scope', 'global']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid|Allowed choices/i);
  });

  test('list forwards the selected ownership to the API', async () => {
    let selectedScope;
    const server = await mockServer((request, response) => {
      selectedScope = new URL(request.url, 'http://localhost').searchParams.get('scope');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [], meta: { total: 0 } }));
    });
    try {
      await runWithMock(server, ['connectors', 'instances', 'list', '--scope', 'team', '--json']);
      assert.equal(selectedScope, 'team');
    } finally { server.close(); }
  });
});

describe('Business membership and invitation contracts', () => {
  test('invitation help exposes explicit workspace grants', () => {
    const result = runSync(['account', 'invitations', 'invite', '--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--workspace-grant <workspace-id:role\.\.\.>/);
  });

  test('malformed workspace grants fail before transport', () => {
    const result = runSync([
      'account', 'invitations', 'invite', 'account_fixture',
      '--email', 'synthetic@example.test', '--workspace-grant', 'workspace_fixture',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Use <workspace-id>:<role>/);
  });

  test('invitation request preserves account and workspace roles separately', async () => {
    let payload;
    const server = await mockServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        payload = JSON.parse(body);
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: { id: 'invitation_fixture' } }));
      });
    });
    try {
      const result = await runWithMock(server, [
        'account', 'invitations', 'invite', 'account_fixture',
        '--email', 'synthetic@example.test', '--role', 'viewer',
        '--workspace-grant', 'workspace_one:member', 'workspace_two:analyst',
        '--workspace-grant', 'workspace_three:viewer', '--json',
      ]);
      assert.equal(result.stderr, '');
      assert.deepEqual(payload, {
        email: 'synthetic@example.test', role: 'viewer',
        workspaces: [
          { targetWorkspaceId: 'workspace_one', role: 'member' },
          { targetWorkspaceId: 'workspace_two', role: 'analyst' },
          { targetWorkspaceId: 'workspace_three', role: 'viewer' },
        ],
      });
    } finally { server.close(); }
  });

  const accountId = '00000000-0000-4000-8000-000000000001';
  const chainerId = '00000000-0000-4000-8000-000000000002';
  const consentId = '00000000-0000-4000-8000-000000000003';
  const cases = [
    { args: ['account', 'members', 'add', accountId, '--chainer', chainerId], method: 'POST', path: `/accounts/${accountId}/members`, body: { chainerId, role: 'member' } },
    { args: ['account', 'members', 'remove', accountId, chainerId], method: 'DELETE', path: `/accounts/${accountId}/members/${chainerId}` },
    { args: ['account', 'invitations', 'invite', accountId, '--email', 'synthetic@example.test'], method: 'POST', path: `/accounts/${accountId}/invitations`, body: { email: 'synthetic@example.test', role: 'member' } },
  ];
  for (const entry of cases) {
    test(`${entry.args.slice(1, 3).join(' ')} forwards explicit billing consent`, async () => {
      let observed;
      const server = await mockServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          observed = { method: request.method, url: new URL(request.url, 'http://localhost'), body: body ? JSON.parse(body) : undefined };
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ data: { id: chainerId } }));
        });
      });
      try {
        const result = await runWithMock(server, [...entry.args, '--billing-consent', consentId, '--json']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(observed.method, entry.method);
        assert.equal(observed.url.pathname, entry.path);
        if (entry.body) assert.deepEqual(observed.body, { ...entry.body, billingConsentId: consentId });
        else assert.equal(observed.url.searchParams.get('billingConsentId'), consentId);
      } finally { server.close(); }
    });
    test(`${entry.args.slice(1, 3).join(' ')} never invents an absent consent`, async () => {
      let observed;
      const server = await mockServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          observed = { query: new URL(request.url, 'http://localhost').searchParams, body: body ? JSON.parse(body) : undefined };
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ data: { id: chainerId } }));
        });
      });
      try {
        const result = await runWithMock(server, [...entry.args, '--json']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(observed.query.has('billingConsentId'), false);
        assert.equal(observed.body && Object.hasOwn(observed.body, 'billingConsentId'), entry.body ? false : undefined);
      } finally { server.close(); }
    });
    test(`${entry.args.slice(1, 3).join(' ')} rejects unsafe consent before transport`, async () => {
      let requests = 0;
      const server = await mockServer((_request, response) => { requests++; response.end('{}'); });
      try {
        const result = await runWithMock(server, [...entry.args, '--billing-consent', '../invalid', '--json']);
        assert.equal(requests, 0);
        assert.equal(result.status, 1);
        assert.match(result.stderr + result.stdout, /billing consent ID|invalid/i);
      } finally { server.close(); }
    });
  }
  test('server refusal never reports a billing mutation as successful', async () => {
    const server = await mockServer((_request, response) => {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'billing_consent_required', message: 'Reviewed billing consent required' } }));
    });
    try {
      const result = await runWithMock(server, [...cases[0].args, '--billing-consent', consentId, '--json']);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout, /added to account/);
    } finally { server.close(); }
  });

  test('removal help describes automatic Business seat reductions', () => {
    const result = runSync(['account', 'members', 'remove', '--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Business seat reductions are\s+queued\s+automatically/);
  });
});

/** Run CLI synchronously (for help/version tests that don't need network). */
function runSync(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CHAINABIT_TOKEN: FAKE_TOKEN, ...extraEnv },
  });
}

/** Create an ephemeral HTTP mock server. Resolves with the server. */
function mockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Run the CLI against a mock server, capture stdout, then kill.
 * Global options (--api-url) must come before the subcommand for Commander to parse them.
 * @param {string[]} globalArgs - args before the subcommand, e.g. ['--api-url', 'http://...']
 * @param {string[]} subArgs - subcommand + its args, e.g. ['workspace', 'list']
 */
function runWithMock(server, subArgs, extraEnv = {}) {
  const port = server.address().port;
  const apiUrl = `http://127.0.0.1:${port}`;

  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [CLI, '--api-url', apiUrl, ...subArgs],
      { env: { ...process.env, CHAINABIT_TOKEN: FAKE_TOKEN, ...extraEnv } }
    );
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => proc.kill(), 3_000);
    proc.on('close', (status) => { clearTimeout(timer); resolve({ stdout, stderr, status }); });
  });
}

// ── Smoke tests ────────────────────────────────────────────────────────────
describe('CLI smoke tests', () => {
  test('--help exits 0 and names the tool', () => {
    const r = runSync(['--help'], { CHAINABIT_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('chainabit'));
  });

  test('--version exits 0', () => {
    const r = runSync(['--version'], { CHAINABIT_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('auth --help exits 0', () => {
    const r = runSync(['auth', '--help'], { CHAINABIT_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('workspace --help exits 0', () => {
    const r = runSync(['workspace', '--help'], { CHAINABIT_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('connectors --help exits 0', () => {
    const r = runSync(['connectors', '--help'], { CHAINABIT_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('chainy --help exits 0', () => {
    const r = runSync(['chainy', '--help'], { CHAINABIT_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('chain --help exits 0', () => {
    const r = runSync(['chain', '--help'], { CHAINABIT_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('bit --help exits 0', () => {
    const r = runSync(['bit', '--help'], { CHAINABIT_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
  });
});

// ── workspace list option tests ────────────────────────────────────────────
describe('workspace list command options', () => {
  test('does not expose --offset (API rejects it)', () => {
    const r = runSync(['workspace', 'list', '--help'], { CHAINABIT_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('--offset'), 'workspace list must not expose --offset');
  });

  test('exposes --limit', () => {
    const r = runSync(['workspace', 'list', '--help'], { CHAINABIT_TOKEN: '' });
    assert.ok(r.stdout.includes('--limit'));
  });

  test('exposes --all', () => {
    const r = runSync(['workspace', 'list', '--help'], { CHAINABIT_TOKEN: '' });
    assert.ok(r.stdout.includes('--all'));
  });
});

// ── workspace list API request tests ──────────────────────────────────────
describe('workspace list API requests', () => {
  test('does not send offset to /workspaces', async () => {
    let receivedUrl = null;
    const server = await mockServer((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    try {
      await runWithMock(server, ['workspace', 'list']);
      assert.ok(receivedUrl !== null, 'CLI must call the mock server');
      const url = new URL(receivedUrl, 'http://x');
      assert.ok(!url.searchParams.has('offset'), `offset must not be sent; got ${receivedUrl}`);
    } finally {
      server.close();
    }
  });

  test('sends limit to /workspaces', async () => {
    let receivedUrl = null;
    const server = await mockServer((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    try {
      await runWithMock(server, ['workspace', 'list']);
      assert.ok(receivedUrl !== null, 'CLI must call the mock server');
      const url = new URL(receivedUrl, 'http://x');
      assert.ok(url.searchParams.has('limit'), `limit should be sent; got ${receivedUrl}`);
    } finally {
      server.close();
    }
  });

  test('respects custom --limit value', async () => {
    let receivedUrl = null;
    const server = await mockServer((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    try {
      await runWithMock(server, ['workspace', 'list', '--limit', '5']);
      assert.ok(receivedUrl !== null, 'CLI must call the mock server');
      const url = new URL(receivedUrl, 'http://x');
      assert.equal(url.searchParams.get('limit'), '5');
    } finally {
      server.close();
    }
  });
});

// ── auth status display tests ──────────────────────────────────────────────
describe('auth status display', () => {
  test('shows "-" for Username when identifier is absent', async () => {
    const server = await mockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: { email: 'test@example.com', identifier: null, userId: 'u_test', role: 'user' },
      }));
    });
    try {
      const { stdout } = await runWithMock(server, ['auth', 'status']);
      // Extract the Username line specifically; Token Expires may legitimately show "unknown"
      // when the fake token has no JWT exp claim.
      const usernameLine = stdout.split('\n').find((l) => l.includes('Username'));
      assert.ok(usernameLine, `output must contain a Username line; got: ${stdout}`);
      assert.ok(
        !usernameLine.includes('unknown'),
        `Username must show "-" not "unknown"; got: ${usernameLine}`
      );
      assert.ok(
        usernameLine.trim().endsWith('-'),
        `Username must end with "-" for missing identifier; got: ${usernameLine}`
      );
    } finally {
      server.close();
    }
  });

  test('displays identifier when it is set', async () => {
    const server = await mockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: { email: 'test@example.com', identifier: 'myhandle', userId: 'u_test', role: 'user' },
      }));
    });
    try {
      const { stdout } = await runWithMock(server, ['auth', 'status']);
      const usernameLine = stdout.split('\n').find((l) => l.includes('Username'));
      assert.ok(usernameLine, `output must contain a Username line; got: ${stdout}`);
      assert.ok(
        !usernameLine.includes('unknown'),
        `Username must not show "unknown" when identifier is set; got: ${usernameLine}`
      );
      assert.ok(usernameLine.includes('myhandle'), `Username must show the identifier; got: ${usernameLine}`);
    } finally {
      server.close();
    }
  });
});

// ── connectors list pagination option tests ────────────────────────────────
describe('connectors list command options', () => {
  test('exposes --limit', () => {
    const r = runSync(['connectors', 'list', '--help'], { CHAINABIT_TOKEN: '' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('--limit'));
  });

  test('exposes --offset', () => {
    const r = runSync(['connectors', 'list', '--help'], { CHAINABIT_TOKEN: '' });
    assert.ok(r.stdout.includes('--offset'));
  });

  test('exposes --all', () => {
    const r = runSync(['connectors', 'list', '--help'], { CHAINABIT_TOKEN: '' });
    assert.ok(r.stdout.includes('--all'));
  });
});

// ── connectors list API request tests ──────────────────────────────────────
describe('connectors list API requests', () => {
  test('sends limit to /connectors', async () => {
    let receivedUrl = null;
    const server = await mockServer((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    try {
      await runWithMock(server, ['connectors', 'list']);
      assert.ok(receivedUrl !== null, 'CLI must call the mock server');
      const url = new URL(receivedUrl, 'http://x');
      assert.ok(url.searchParams.has('limit'), `limit should be sent; got ${receivedUrl}`);
    } finally {
      server.close();
    }
  });

  test('respects --limit flag', async () => {
    let receivedUrl = null;
    const server = await mockServer((req, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    try {
      await runWithMock(server, ['connectors', 'list', '--limit', '5']);
      assert.ok(receivedUrl !== null, 'CLI must call the mock server');
      const url = new URL(receivedUrl, 'http://x');
      assert.equal(url.searchParams.get('limit'), '5');
    } finally {
      server.close();
    }
  });
});
