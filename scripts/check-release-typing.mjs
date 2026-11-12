#!/usr/bin/env node
/**
 * Release typing gate.
 *
 * The npm version is computed from commit types (semantic-release), so a commit's type IS the
 * release decision. On 2026-11-12 every bundle regeneration was typed `feat:` and one `feat!:`,
 * which produced five minor/major versions in six days for what were fixes. This gate makes the
 * type say what changed:
 *
 *  - every non-merge commit is a Conventional Commit with a known type;
 *  - a commit that changes the shipped bundle (`bin/chainabit.cjs`) must be `fix`, `perf` or
 *    `feat` (a changed bundle must release, `chore`/`docs`/`test`/`ci` would hide it), and must
 *    say what a user can see in a `Release-note:` footer;
 *  - `feat` (minor) additionally needs a `Feature:` footer naming the new user-visible
 *    capability; without a new capability it is a `fix` (patch);
 *  - a breaking commit (`!` or `BREAKING CHANGE`) needs a `Breaking-approved-by:` footer.
 *
 * Usage: node scripts/check-release-typing.mjs <base-ref> [<head-ref>]   (default head: HEAD)
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const BUNDLE_PATH = 'bin/chainabit.cjs';
const TYPES = ['feat', 'fix', 'perf', 'revert', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style'];
const BUNDLE_TYPES = ['fix', 'perf', 'feat'];
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?: (?<subject>\S.*)$/;

function footer(body, key) {
  const match = new RegExp(`^${key}:[ \\t]*(\\S.*)$`, 'im').exec(body);
  return match ? match[1].trim() : '';
}

/**
 * @param {{sha: string, subject: string, body: string, files: string[], merge?: boolean}} commit
 * @returns {{bump: 'major'|'minor'|'patch'|'none', problems: string[]}}
 */
export function checkCommit(commit) {
  const problems = [];
  const label = `${commit.sha.slice(0, 7)} "${commit.subject}"`;
  const header = HEADER.exec(commit.subject);
  if (!header) {
    return { bump: 'none', problems: [`${label}: not a Conventional Commit (type(scope)!: subject)`] };
  }
  const { type, bang } = header.groups;
  if (!TYPES.includes(type)) problems.push(`${label}: unknown type "${type}" (use ${TYPES.join(', ')})`);
  const breaking = Boolean(bang) || /^BREAKING[ -]CHANGE:/m.test(commit.body);
  if (breaking && !footer(commit.body, 'Breaking-approved-by'))
    problems.push(`${label}: a breaking change (major) needs a "Breaking-approved-by: <name>" footer`);
  const touchesBundle = commit.files.includes(BUNDLE_PATH);
  if (touchesBundle) {
    if (!BUNDLE_TYPES.includes(type))
      problems.push(`${label}: changes ${BUNDLE_PATH}, so it must release: use fix, perf or feat, not "${type}"`);
    if (!footer(commit.body, 'Release-note'))
      problems.push(`${label}: changes ${BUNDLE_PATH}; add a "Release-note: <what a user sees>" footer`);
    if (type === 'feat' && !footer(commit.body, 'Feature'))
      problems.push(`${label}: "feat" is a minor release; add "Feature: <new user-visible capability>" or type it "fix"`);
  }
  const bump = breaking ? 'major' : type === 'feat' ? 'minor' : type === 'fix' || type === 'perf' ? 'patch' : 'none';
  return { bump, problems };
}

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

export function checkRange(commits) {
  const problems = [];
  let bump = 'none';
  for (const commit of commits) {
    if (commit.merge) continue;
    const result = checkCommit(commit);
    problems.push(...result.problems);
    if (RANK[result.bump] > RANK[bump]) bump = result.bump;
  }
  return { bump, problems };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function commitsBetween(base, head) {
  const SEP = '\u001e';
  const out = git('log', '--format=%H%x1f%P%x1f%s%x1f%b%x1e', `${base}..${head}`);
  return out
    .split(SEP)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, subject, body = ''] = record.split('\u001f');
      const files = git('diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', sha)
        .split('\n')
        .filter(Boolean);
      return { sha, subject, body, files, merge: parents.trim().split(' ').length > 1 };
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (!base) {
    console.error('usage: node scripts/check-release-typing.mjs <base-ref> [<head-ref>]');
    process.exit(2);
  }
  const { bump, problems } = checkRange(commitsBetween(base, head));
  console.log(`release typing: ${base}..${head} would release: ${bump}`);
  if (problems.length) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
}
