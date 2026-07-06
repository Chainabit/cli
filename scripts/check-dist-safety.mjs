#!/usr/bin/env node
/**
 * Public distribution safety check for the Chainabit CLI.
 *
 * Verifies that the package npm would publish contains ONLY distribution-safe
 * files and no private source, secrets, source maps, internal references, or
 * local paths. Exits non-zero on any violation so it can gate CI and prepublish.
 *
 * Usage:  node scripts/check-dist-safety.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

// The package's own scoped name is a legitimate self-reference (it appears in
// package.json's "name" field); only OTHER @chainabit/* references indicate a
// leaked internal package name.
const PKG_NAME = JSON.parse(readFileSync('package.json', 'utf8')).name;
const SELF_SCOPE_SUFFIX = PKG_NAME?.startsWith('@chainabit/')
  ? PKG_NAME.slice('@chainabit/'.length)
  : null;
const PRIVATE_SCOPE_RE = SELF_SCOPE_SUFFIX
  ? new RegExp(`@chainabit/(?!${SELF_SCOPE_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b)`)
  : /@chainabit\//;

const ALLOWED_FILES = new Set([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  '.env.example',
  'bin/chainabit.cjs',
]);

const FORBIDDEN_EXTENSIONS = new Set(['.ts', '.tsx', '.map']);

// Content patterns that must never appear in any shipped file.
const CONTENT_RULES = [
  { name: 'local absolute path (/Users)', re: /\/Users\/[A-Za-z0-9._-]+/ },
  { name: 'local absolute path (/home)', re: /\/home\/[A-Za-z0-9._-]+/ },
  { name: 'source map reference', re: /sourceMappingURL=/ },
  { name: 'private scoped package', re: PRIVATE_SCOPE_RE },
  { name: 'internal workspace path', re: /\bpackages\/[a-z][a-z0-9-]+/ },
  { name: 'workspace protocol reference', re: /["']workspace:[^"']*["']/ },
  // Secret-shaped strings. Documentation placeholders such as
  // `cbt_live_xxxxxxxx` have no entropy, so we only fail when the token body
  // looks real: 12+ base62 chars that include at least one digit.
  { name: 'leaked live token', re: /cbt_live_(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{12,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'generic API secret assignment', re: /(secret|password|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9/+_-]{16,}['"]/i },
];

// .env.example is allowed to contain placeholder keys, so skip secret-shaped
// assignment scanning there (it has no real values).
const SECRET_SCAN_SKIP = new Set(['.env.example']);

function fail(msg) {
  // eslint-disable-next-line no-console
  console.error(`❌  ${msg}`);
}

function getPackedFiles() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return entry.files.map((f) => f.path);
}

let violations = 0;

let files;
try {
  files = getPackedFiles();
} catch (error) {
  fail(`could not run "npm pack --dry-run --json": ${error.message}`);
  process.exit(1);
}

// 1. Allowlist + forbidden-extension check on the exact published file set.
for (const file of files) {
  if (FORBIDDEN_EXTENSIONS.has(extname(file))) {
    fail(`forbidden file type in package: ${file}`);
    violations++;
    continue;
  }
  if (!ALLOWED_FILES.has(file)) {
    fail(`unexpected file in package (not in allowlist): ${file}`);
    violations++;
  }
}

// 2. Content scan of each shipped file.
for (const file of files) {
  if (!existsSync(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary / unreadable — skip
  }
  for (const rule of CONTENT_RULES) {
    if (rule.name === 'generic API secret assignment' && SECRET_SCAN_SKIP.has(file)) {
      continue;
    }
    if (rule.re.test(text)) {
      fail(`${file}: matched forbidden pattern — ${rule.name}`);
      violations++;
    }
  }
}

// 3. Ensure the binary exists and has the correct shebang.
if (existsSync('bin/chainabit.cjs')) {
  const head = readFileSync('bin/chainabit.cjs', 'utf8').slice(0, 32);
  if (!head.startsWith('#!/usr/bin/env node')) {
    fail('bin/chainabit.cjs is missing the "#!/usr/bin/env node" shebang');
    violations++;
  }
} else {
  fail('bin/chainabit.cjs is missing');
  violations++;
}

if (violations > 0) {
  // eslint-disable-next-line no-console
  console.error(`\nSafety check FAILED with ${violations} violation(s).`);
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log(`✅  Distribution safety check passed (${files.length} files):`);
for (const file of files) {
  // eslint-disable-next-line no-console
  console.log(`   - ${file}`);
}
