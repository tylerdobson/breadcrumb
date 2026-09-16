import { spawnSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface GitSnapshot {
  root: string;
  branch: string | null;
  head: string | null;
  fingerprint: string;
  changedFiles: string[];
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_PATHS = 100_000;

interface Budget {
  bytes: number;
  paths: number;
  roots: Set<string>;
}

function git(cwd: string, args: string[], acceptedStatuses = [0]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  // Hooks and parent Git processes can export another repository's location.
  // A checkpoint always describes the worktree requested by the caller.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']) {
    delete env[key];
  }
  const result = spawnSync('git', ['-C', cwd, ...args], {
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not run Git: ${result.error.message}`, { cause: result.error });
  const stderr = result.stderr.toString('utf8').trim();
  if (result.status === null || !acceptedStatuses.includes(result.status)) {
    throw new Error(`Git ${args[0]} failed: ${stderr || result.signal || `exit ${result.status}`}`);
  }
  return { stdout: result.stdout, stderr, status: result.status };
}

/** Locate the canonical worktree root without reading project file contents. */
export function findGitRoot(cwd: string): string | null {
  let result: ReturnType<typeof git>;
  try {
    result = git(cwd, ['rev-parse', '--show-toplevel'], [0, 128]);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return null;
    throw error;
  }
  if (result.status !== 0) {
    if (/fatal: not a git repository\b/i.test(result.stderr)) return null;
    throw new Error(`Cannot locate Git worktree: ${result.stderr}`);
  }
  // Git emits one trailing newline. Whitespace may be part of the directory name.
  return realpathSync.native(result.stdout.toString('utf8').replace(/\n$/, ''));
}

function field(hash: Hash, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  hash.update(`${bytes.length}:`);
  hash.update(bytes);
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

/** NUL records preserve spaces, tabs, newlines, and Unicode in Git paths. */
function records(data: Buffer): string[] {
  const values = data.toString('utf8').split('\0');
  if (values.at(-1) === '') values.pop();
  return values;
}

function changedPaths(status: Buffer): string[] {
  const entries = records(status);
  const paths = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    paths.add(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      const original = entries[++index];
      if (original === undefined) throw new Error('Git returned an incomplete rename record.');
      paths.add(original);
    }
  }
  return [...paths].sort();
}

function safePath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const within = relative(root, absolute);
  if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) {
    throw new Error(`Git returned a path outside its worktree: ${JSON.stringify(path)}`);
  }
  return absolute;
}

function hashFile(absolute: string, displayPath: string, budget: Budget): string {
  const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`File type changed while reading ${JSON.stringify(displayPath)}; try again.`);
    if (before.size > BigInt(MAX_FILE_BYTES)) {
      throw new Error(`Cannot checkpoint ${JSON.stringify(displayPath)}: files over 64 MiB are not supported. Ignore large untracked files or move large tracked assets out of this worktree.`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let fileBytes = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      fileBytes += count;
      budget.bytes += count;
      if (fileBytes > MAX_FILE_BYTES) throw new Error(`File grew beyond 64 MiB while reading ${JSON.stringify(displayPath)}; try again.`);
      if (budget.bytes > MAX_TOTAL_BYTES) throw new Error('Cannot checkpoint this worktree: total project content exceeds the 512 MiB limit. Ignore large untracked assets or use a smaller worktree.');
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error(`File changed while reading ${JSON.stringify(displayPath)}; try again.`);
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

function hashWorktreePath(hash: Hash, root: string, path: string, submodule: boolean, budget: Budget): void {
  const absolute = safePath(root, path);
  field(hash, path);
  try {
    // Do not follow a directory symlink that replaced a tracked directory.
    const parents = path.split('/').slice(0, -1);
    let parent = root;
    for (const part of parents) {
      parent = join(parent, part);
      const stat = lstatSync(parent);
      if (stat.isSymbolicLink()) {
        field(hash, 'symlink-ancestor');
        field(hash, readlinkSync(parent, { encoding: 'buffer' }));
        return;
      }
      if (!stat.isDirectory()) {
        field(hash, 'missing');
        return;
      }
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      field(hash, 'symlink');
      field(hash, readlinkSync(absolute, { encoding: 'buffer' }));
    } else if (stat.isFile()) {
      field(hash, `file:${stat.mode & 0o111}`);
      field(hash, hashFile(absolute, path, budget));
    } else if (stat.isDirectory()) {
      field(hash, submodule ? 'submodule' : 'directory');
      const nestedRoot = findGitRoot(absolute);
      // An uninitialized submodule directory still resolves to the parent repo.
      if (nestedRoot !== realpathSync.native(absolute)) {
        field(hash, 'uninitialized');
      } else {
        field(hash, snapshot(nestedRoot, budget).fingerprint);
      }
    } else {
      field(hash, `special:${stat.mode}`);
    }
  } catch (error) {
    if (!missing(error)) throw error;
    field(hash, 'missing');
  }
}

function snapshot(root: string, budget: Budget): GitSnapshot {
  if (budget.roots.has(root)) throw new Error(`Recursive Git worktree detected at ${root}.`);
  budget.roots.add(root);
  try {
    const branchResult = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
    const branch = branchResult.status === 0 ? branchResult.stdout.toString('utf8').replace(/\n$/, '') : null;
    const headResult = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1]);
    const head = headResult.status === 0 ? headResult.stdout.toString('utf8').trim() : null;
    if (branch === null && head === null) throw new Error('Git HEAD is neither a branch nor a valid commit.');

    const index = git(root, ['ls-files', '--stage', '-z']).stdout;
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout;
    const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no']).stdout;
    const paths = new Map<string, boolean>();
    for (const entry of records(index)) {
      const separator = entry.indexOf('\t');
      if (separator < 0) throw new Error('Git returned a malformed index entry.');
      const path = entry.slice(separator + 1);
      paths.set(path, paths.get(path) === true || entry.startsWith('160000 '));
    }
    for (const path of records(untracked)) paths.set(path, false);
    budget.paths += paths.size;
    if (budget.paths > MAX_PATHS) throw new Error('Cannot checkpoint this worktree: more than 100,000 project paths. Ignore generated files or use a smaller worktree.');

    const hash = createHash('sha256');
    field(hash, 'pausepin-git-v1');
    field(hash, branch ?? '');
    field(hash, head ?? '');
    field(hash, index);
    field(hash, status);
    for (const path of [...paths.keys()].sort()) hashWorktreePath(hash, root, path, paths.get(path)!, budget);
    return { root, branch, head, fingerprint: hash.digest('hex'), changedFiles: changedPaths(status) };
  } finally {
    budget.roots.delete(root);
  }
}

/**
 * Fingerprint Git metadata and tracked/nonignored worktree bytes, without saving
 * contents or following symlinks. Ignored untracked files are never opened.
 * Limits: 64 MiB per file, 512 MiB total, 100,000 paths (including submodules).
 */
export function captureGitSnapshot(cwd: string): GitSnapshot | null {
  const root = findGitRoot(cwd);
  return root === null ? null : snapshot(root, { bytes: 0, paths: 0, roots: new Set() });
}
