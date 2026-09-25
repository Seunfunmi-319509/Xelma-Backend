#!/usr/bin/env node
/**
 * Publish a fork PR under YOUR git/GitHub identity — not Cursor Agent.
 *
 * Cursor injects `Co-authored-by: Cursor <cursoragent@cursor.com>` on commits
 * and appends "Made with Cursor" to PR bodies. GitHub then shows Cursor as a
 * co-author. This script rewrites HEAD without that trailer (via git
 * commit-tree, so Cursor cannot re-inject it), pushes the fork, and
 * creates/updates the PR with a clean body.
 *
 * Stage everything first. The script amends HEAD via `git commit-tree` (not
 * `git commit`, which Cursor can intercept) so staged files are included and
 * the Cursor trailer is never re-injected.
 *
 * Usage:
 *   git add -A
 *   npm run pr:publish -- --title "Add load-test harness" --issue 500
 *   npm run pr:publish -- --title "..." --body-file pr-body.md
 *   npm run pr:publish -- --fix-existing
 *
 * Env (optional):
 *   UPSTREAM_REPO   default TevaLabs/Xelma-Backend
 *   FORK_REMOTE     default fork
 *   BASE_BRANCH     default main
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CURSOR_COAUTHOR = /^Co-authored-by:\s*Cursor\s*<[^>\n]+>\s*$/gim;
const MADE_WITH_CURSOR = /\n*Made with \[Cursor\]\([^)]+\)\s*$/i;

function parseArgs(argv) {
  const args = {
    title: null,
    body: null,
    bodyFile: null,
    issue: null,
    fixExisting: false,
    base: process.env.BASE_BRANCH || 'main',
    repo: process.env.UPSTREAM_REPO || 'TevaLabs/Xelma-Backend',
    remote: process.env.FORK_REMOTE || 'fork',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--title') {
      args.title = next;
      i += 1;
    } else if (token === '--body') {
      args.body = next;
      i += 1;
    } else if (token === '--body-file') {
      args.bodyFile = next;
      i += 1;
    } else if (token === '--issue') {
      args.issue = next;
      i += 1;
    } else if (token === '--base') {
      args.base = next;
      i += 1;
    } else if (token === '--repo') {
      args.repo = next;
      i += 1;
    } else if (token === '--remote') {
      args.remote = next;
      i += 1;
    } else if (token === '--fix-existing') {
      args.fixExisting = true;
    } else if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    } else {
      fail(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function applyNpmConfigFallback(args) {
  // Windows npm often treats `--fix-existing` as its own config instead of
  // forwarding it after `--`, leaving argv empty. Those flags show up as
  // npm_config_* environment variables.
  if (envFlag('npm_config_fix_existing')) {
    args.fixExisting = true;
  }
  if (process.env.npm_config_title) {
    args.title = process.env.npm_config_title;
  }
  if (process.env.npm_config_issue) {
    args.issue = process.env.npm_config_issue;
  }
  if (process.env.npm_config_body) {
    args.body = process.env.npm_config_body;
  }
  if (process.env.npm_config_body_file) {
    args.bodyFile = process.env.npm_config_body_file;
  }
  if (process.env.npm_config_base) {
    args.base = process.env.npm_config_base;
  }
  if (process.env.npm_config_repo) {
    args.repo = process.env.npm_config_repo;
  }
  if (process.env.npm_config_remote) {
    args.remote = process.env.npm_config_remote;
  }
  return args;
}

function envFlag(name) {
  const value = process.env[name];
  return Boolean(value) && value !== 'false' && value !== '0';
}

function printHelp() {
  process.stdout.write(`Publish a fork PR as the local git/GitHub user, stripping Cursor attribution.

Options:
  --title <text>         PR title (required unless --fix-existing)
  --body <text>          PR body
  --body-file <path>     PR body from file
  --issue <n>            Appends "Closes #<n>" if the body does not already close it
  --fix-existing         Rewrite HEAD + update the open PR body; do not create a new PR
  --base <branch>        Upstream base (default: main)
  --repo <owner/name>    Upstream repo (default: TevaLabs/Xelma-Backend)
  --remote <name>        Fork remote (default: fork)
`);
}

function fail(message) {
  process.stderr.write(`publish-pr: ${message}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    env: opts.env || process.env,
  });
  if (opts.stdio === 'inherit') {
    return '';
  }
  return String(result || '').trim();
}

function git(args, opts = {}) {
  return run('git', args, opts);
}

function porcelainLines() {
  try {
    return git(['status', '--porcelain']).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function assertIndexReady() {
  const dirty = porcelainLines().filter((line) => {
    const indexState = line[0];
    const worktreeState = line[1];
    if (indexState === '?' && worktreeState === '?') {
      return true;
    }
    return worktreeState !== ' ';
  });
  if (dirty.length) {
    fail(
      `Unstaged or untracked files. git add them before publishing:\n${dirty.join('\n')}`,
    );
  }
}

function stripCursorAttribution(text) {
  return `${String(text || '')
    .replace(CURSOR_COAUTHOR, '')
    .replace(MADE_WITH_CURSOR, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

function hasCursorCoauthor(message) {
  return /Co-authored-by:\s*Cursor\s*</i.test(message);
}

function resolveIdentity() {
  let gitName = '';
  let gitEmail = '';
  try {
    gitName = git(['config', 'user.name']);
    gitEmail = git(['config', 'user.email']);
  } catch {
    fail('git user.name and user.email must be set locally.');
  }
  if (!gitName || !gitEmail) {
    fail('git user.name and user.email must be set locally.');
  }
  let user;
  try {
    user = JSON.parse(run('gh', ['api', 'user']));
  } catch (error) {
    fail(`gh is not authenticated. Run gh auth login as yourself.\n${error.message}`);
  }

  const ghLogin = user.login || '';
  const ghName = user.name || '';
  if (/cursoragent/i.test(ghLogin) || /cursoragent@cursor\.com/i.test(gitEmail)) {
    fail(
      `Refusing to publish as Cursor Agent (gh=${ghLogin}, git email=${gitEmail}).\n` +
        'Run `gh auth login` as your GitHub user and set git user.name / user.email locally.',
    );
  }

  return { gitName, gitEmail, ghLogin, ghName };
}

function rewriteHeadWithoutCursor(identity) {
  const rawMessage = git(['log', '-1', '--format=%B']);
  const authorEmail = git(['log', '-1', '--format=%ae']);
  const committerEmail = git(['log', '-1', '--format=%ce']);
  const headTree = git(['log', '-1', '--format=%T']);
  const indexTree = git(['write-tree']);
  const needsRewrite =
    hasCursorCoauthor(rawMessage) ||
    /cursoragent@cursor\.com/i.test(`${authorEmail}\n${committerEmail}`) ||
    indexTree !== headTree;

  if (!needsRewrite) {
    process.stdout.write('HEAD commit identity is already clean.\n');
    return false;
  }

  const cleanMessage = stripCursorAttribution(rawMessage);
  const parents = git(['log', '-1', '--format=%P']).split(/\s+/).filter(Boolean);
  const msgFile = path.join(os.tmpdir(), `xelma-pr-msg-${process.pid}.txt`);
  fs.writeFileSync(msgFile, cleanMessage, 'utf8');

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: identity.gitName,
    GIT_AUTHOR_EMAIL: identity.gitEmail,
    GIT_AUTHOR_DATE: git(['log', '-1', '--format=%aI']),
    GIT_COMMITTER_NAME: identity.gitName,
    GIT_COMMITTER_EMAIL: identity.gitEmail,
  };

  const commitTreeArgs = ['commit-tree', indexTree, '-F', msgFile];
  for (const parent of parents) {
    commitTreeArgs.push('-p', parent);
  }

  const newSha = git(commitTreeArgs, { env });
  git(['reset', '--soft', newSha]);
  process.stdout.write(
    `Rewrote HEAD as ${identity.gitName} <${identity.gitEmail}> (${newSha.slice(0, 7)})\n`,
  );
  return true;
}

function buildBody(args, existingBody) {
  let body = args.body || '';
  if (args.bodyFile) {
    body = fs.readFileSync(path.resolve(args.bodyFile), 'utf8');
  }
  if (!body && existingBody) {
    body = existingBody;
  }
  body = stripCursorAttribution(body);
  if (args.issue && !/(closes|fixes|resolves)\s+#\d+/i.test(body)) {
    body = `${body.trim()}\n\nCloses #${args.issue}\n`;
  }
  return body;
}

function findExistingPr(args, branch, identity) {
  const jsonFields = 'number,url,title,body';
  const candidates = [
    ['pr', 'view', `${identity.ghLogin}:${branch}`, '--repo', args.repo, '--json', jsonFields],
    ['pr', 'view', String(branch), '--repo', args.repo, '--json', jsonFields],
  ];

  for (const ghArgs of candidates) {
    try {
      return JSON.parse(run('gh', ghArgs));
    } catch {
      // try next lookup
    }
  }

  for (const head of [branch, `${identity.ghLogin}:${branch}`]) {
    try {
      const list = JSON.parse(
        run('gh', ['pr', 'list', '--repo', args.repo, '--head', head, '--state', 'open', '--json', jsonFields]),
      );
      if (list[0]) {
        return list[0];
      }
    } catch {
      // try next head filter
    }
  }

  return null;
}

function writeTemp(prefix, contents, ext = 'md') {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}.${ext}`);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function patchPullRequest(args, number, fields) {
  const payload = {};
  if (fields.title) {
    payload.title = fields.title;
  }
  if (fields.body != null) {
    payload.body = stripCursorAttribution(fields.body).trimEnd() + '\n';
  }
  const inputFile = writeTemp('xelma-pr-patch', `${JSON.stringify(payload)}\n`, 'json');
  // `gh pr edit` currently fails on some GitHub orgs because of the
  // Projects (classic) GraphQL deprecation. REST PATCH avoids that.
  run('gh', ['api', '--method', 'PATCH', `repos/${args.repo}/pulls/${number}`, '--input', inputFile]);
}

function pushFork(args, branch) {
  process.stdout.write(`Pushing ${branch} to ${args.remote} (force-with-lease)...\n`);
  run('git', ['push', '--force-with-lease', '-u', args.remote, `HEAD:refs/heads/${branch}`], {
    stdio: 'inherit',
  });
}

function main() {
  const args = applyNpmConfigFallback(parseArgs(process.argv.slice(2)));
  const branch = git(['branch', '--show-current']);
  if (!branch || branch === 'main' || branch === 'master') {
    fail(`Refusing to publish from '${branch || '(detached)'}'. Check out a feature branch.`);
  }

  assertIndexReady();

  const identity = resolveIdentity();
  process.stdout.write(`GitHub: ${identity.ghLogin} (${identity.ghName || 'no name'})\n`);
  process.stdout.write(`Git:    ${identity.gitName} <${identity.gitEmail}>\n`);

  rewriteHeadWithoutCursor(identity);
  pushFork(args, branch);

  const existing = findExistingPr(args, branch, identity);

  if (args.fixExisting) {
    if (!existing) {
      fail('No open PR found for this branch. Pass --title to create one.');
    }
    patchPullRequest(args, existing.number, { body: existing.body || '' });
    process.stdout.write(`Updated ${existing.url}\n`);
    return;
  }

  if (!args.title && !existing) {
    fail('Missing --title (required when creating a PR).');
  }

  const body = buildBody(args, existing && existing.body);
  const bodyFile = writeTemp(
    'xelma-pr-body',
    body.trim() ? body : `## Summary\n\n- \n\n${args.issue ? `Closes #${args.issue}\n` : ''}`,
  );

  if (existing) {
    patchPullRequest(args, existing.number, { title: args.title, body });
    process.stdout.write(`Updated ${existing.url}\n`);
    return;
  }

  run(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      args.repo,
      '--base',
      args.base,
      '--head',
      `${identity.ghLogin}:${branch}`,
      '--title',
      args.title,
      '--body-file',
      bodyFile,
    ],
    { stdio: 'inherit' },
  );

  const created = findExistingPr(args, branch, identity);
  if (created && MADE_WITH_CURSOR.test(created.body || '')) {
    patchPullRequest(args, created.number, { body: created.body });
  }
}

try {
  main();
} catch (error) {
  const detail = error.stderr ? String(error.stderr).trim() : error.message;
  fail(detail);
}
