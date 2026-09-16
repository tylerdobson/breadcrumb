import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { captureGitSnapshot, findGitRoot } from '../src/git.ts';

const temporaryDirectories: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'breadcrumb-git-'));
  temporaryDirectories.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Breadcrumb Test', '-c', 'user.email=breadcrumb@example.invalid', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repository(): string {
  const path = directory();
  git(path, 'init', '--initial-branch=main');
  return path;
}

function commit(path: string): void {
  git(path, 'add', '--all');
  git(path, 'commit', '-m', 'test fixture');
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('outside Git returns null while filesystem errors surface', () => {
  const path = directory();
  assert.equal(findGitRoot(path), null);
  assert.equal(captureGitSnapshot(path), null);
  assert.throws(() => captureGitSnapshot(join(path, 'missing')), /Cannot locate Git worktree/);
});

test('Git is optional when its executable is unavailable', () => {
  const path = directory();
  const source = new URL('../src/git.ts', import.meta.url).href;
  const script = `import assert from 'node:assert/strict'; import { findGitRoot, captureGitSnapshot } from ${JSON.stringify(source)}; assert.equal(findGitRoot(process.cwd()), null); assert.equal(captureGitSnapshot(process.cwd()), null);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path,
    env: { ...process.env, PATH: '' },
    stdio: 'pipe',
  });
});

test('inherited Git repository variables do not redirect project snapshots', () => {
  const requested = repository();
  const inherited = repository();
  const source = new URL('../src/git.ts', import.meta.url).href;
  const script = `import assert from 'node:assert/strict'; import { findGitRoot } from ${JSON.stringify(source)}; assert.equal(findGitRoot(process.cwd()), ${JSON.stringify(realpathSync(requested))});`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: requested,
    env: { ...process.env, GIT_DIR: join(inherited, '.git'), GIT_WORK_TREE: inherited },
    stdio: 'pipe',
  });
});

test('unborn branches and subdirectories use the canonical worktree root', () => {
  const path = repository();
  mkdirSync(join(path, 'nested'));
  const state = captureGitSnapshot(join(path, 'nested'))!;
  assert.equal(state.root, realpathSync(path));
  assert.equal(findGitRoot(join(path, 'nested')), state.root);
  assert.equal(state.branch, 'main');
  assert.equal(state.head, null);
  assert.deepEqual(state.changedFiles, []);
  assert.equal(state.fingerprint.length, 64);
  assert.equal(captureGitSnapshot(path)!.fingerprint, state.fingerprint);
});

test('same-length tracked and untracked edits change fingerprints', () => {
  const path = repository();
  writeFileSync(join(path, 'tracked.txt'), 'before');
  commit(path);
  writeFileSync(join(path, 'new.txt'), 'first');
  const initial = captureGitSnapshot(path)!;
  writeFileSync(join(path, 'tracked.txt'), 'after!');
  const tracked = captureGitSnapshot(path)!;
  assert.notEqual(tracked.fingerprint, initial.fingerprint);
  writeFileSync(join(path, 'tracked.txt'), 'third!');
  const trackedAgain = captureGitSnapshot(path)!;
  assert.notEqual(trackedAgain.fingerprint, tracked.fingerprint);
  writeFileSync(join(path, 'new.txt'), 'other');
  const untracked = captureGitSnapshot(path)!;
  assert.notEqual(untracked.fingerprint, trackedAgain.fingerprint);
  assert.deepEqual(untracked.changedFiles, ['new.txt', 'tracked.txt']);
});

test('ignored files do not affect snapshots', () => {
  const path = repository();
  writeFileSync(join(path, '.gitignore'), '.env\nprivate/\n');
  commit(path);
  const initial = captureGitSnapshot(path)!;
  writeFileSync(join(path, '.env'), 'secret');
  mkdirSync(join(path, 'private'));
  writeFileSync(join(path, 'private', 'large-secret'), '');
  truncateSync(join(path, 'private', 'large-secret'), 65 * 1024 * 1024);
  assert.equal(captureGitSnapshot(path)!.fingerprint, initial.fingerprint);
});

test('index state, commits, branch changes, and detached HEAD are represented', () => {
  const path = repository();
  writeFileSync(join(path, 'tracked.txt'), 'initial');
  commit(path);
  const clean = captureGitSnapshot(path)!;
  writeFileSync(join(path, 'tracked.txt'), 'changed');
  const unstaged = captureGitSnapshot(path)!;
  git(path, 'add', 'tracked.txt');
  const staged = captureGitSnapshot(path)!;
  assert.notEqual(staged.fingerprint, unstaged.fingerprint);
  git(path, 'commit', '-m', 'new commit');
  const committed = captureGitSnapshot(path)!;
  assert.notEqual(committed.head, clean.head);
  git(path, 'switch', '-c', 'second');
  const branch = captureGitSnapshot(path)!;
  assert.equal(branch.branch, 'second');
  assert.notEqual(branch.fingerprint, committed.fingerprint);
  git(path, 'checkout', '--detach');
  const detached = captureGitSnapshot(path)!;
  assert.equal(detached.branch, null);
  assert.equal(detached.head, branch.head);
  assert.notEqual(detached.fingerprint, branch.fingerprint);
});

test('renames, deletions, Unicode, tabs, spaces, and newlines are parsed safely', () => {
  const path = repository();
  const source = process.platform === 'win32' ? 'old café name.txt' : 'old café\t name.txt';
  const target = process.platform === 'win32' ? 'new 日本語 name.txt' : 'new 日本語\n name.txt';
  writeFileSync(join(path, source), 'rename me');
  writeFileSync(join(path, 'delete.txt'), 'delete me');
  commit(path);
  const before = captureGitSnapshot(path)!;
  renameSync(join(path, source), join(path, target));
  unlinkSync(join(path, 'delete.txt'));
  git(path, 'add', '--all');
  const after = captureGitSnapshot(path)!;
  assert.deepEqual(after.changedFiles, ['delete.txt', source, target].sort());
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test('symlink targets are fingerprinted without reading target contents', { skip: process.platform === 'win32' && 'Windows symlink creation requires extra privileges' }, () => {
  const path = repository();
  const outside = directory();
  const target = join(outside, 'secret');
  writeFileSync(target, 'first private value');
  symlinkSync(target, join(path, 'link'));
  const before = captureGitSnapshot(path)!;
  writeFileSync(target, 'different private value');
  assert.equal(captureGitSnapshot(path)!.fingerprint, before.fingerprint);
  unlinkSync(join(path, 'link'));
  symlinkSync(join(outside, 'other'), join(path, 'link'));
  assert.notEqual(captureGitSnapshot(path)!.fingerprint, before.fingerprint);
});

test('tracked directories replaced by symlinks do not read outside files', { skip: process.platform === 'win32' && 'Windows symlink creation requires extra privileges' }, () => {
  const path = repository();
  const outside = directory();
  mkdirSync(join(path, 'nested'));
  writeFileSync(join(path, 'nested', 'file'), 'tracked');
  commit(path);
  unlinkSync(join(path, 'nested', 'file'));
  rmSync(join(path, 'nested'), { recursive: true });
  writeFileSync(join(outside, 'file'), '');
  truncateSync(join(outside, 'file'), 65 * 1024 * 1024);
  symlinkSync(outside, join(path, 'nested'));
  assert.ok(captureGitSnapshot(path));
});

test('large project files fail with an actionable error', () => {
  const path = repository();
  writeFileSync(join(path, 'huge.bin'), '');
  truncateSync(join(path, 'huge.bin'), 65 * 1024 * 1024);
  assert.throws(() => captureGitSnapshot(path), /files over 64 MiB/);
});

test('initialized submodule dirty contents contribute to the fingerprint', () => {
  const child = repository();
  writeFileSync(join(child, 'file'), 'first');
  commit(child);
  const path = repository();
  git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'child');
  commit(path);
  writeFileSync(join(path, 'child', 'file'), 'other');
  const before = captureGitSnapshot(path)!;
  writeFileSync(join(path, 'child', 'file'), 'third');
  assert.notEqual(captureGitSnapshot(path)!.fingerprint, before.fingerprint);
});

test('untracked nested repository contents contribute to the fingerprint', () => {
  const path = repository();
  const child = join(path, 'child');
  mkdirSync(child);
  git(child, 'init', '--initial-branch=main');
  writeFileSync(join(child, 'file'), 'first');
  commit(child);
  const before = captureGitSnapshot(path)!;
  writeFileSync(join(child, 'file'), 'other');
  assert.notEqual(captureGitSnapshot(path)!.fingerprint, before.fingerprint);
});
