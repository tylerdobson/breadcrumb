import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../src/store.ts';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const temporaryDirectories: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pausepin-storage-'));
  temporaryDirectories.push(root);
  const project = join(root, 'project');
  const xdg = join(root, 'data');
  mkdirSync(project);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (['PAUSEPIN_HOME', 'BREADCRUMB_HOME', 'XDG_DATA_HOME'].includes(name.toUpperCase())) delete env[name];
  }
  env.XDG_DATA_HOME = xdg;

  function json(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
      cwd: project,
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }

  function seed(directory: string, goal: string) {
    const overrides = { PAUSEPIN_HOME: directory };
    json(['start', goal, '--next', 'Inspect the saved hypothesis', '--done-when', 'Review complete'], overrides);
    json(['pause', '--note', `Remember ${goal}`, '--decision', 'Which approach is simpler?'], overrides);
    json(['park', `Idea for ${goal}`], overrides);
    return json(['export'], overrides);
  }

  function renameOldDatabase(directory: string): string {
    const oldPath = join(directory, 'breadcrumb.sqlite');
    renameSync(join(directory, 'pausepin.sqlite'), oldPath);
    return oldPath;
  }

  return { root, project, xdg, json, seed, renameOldDatabase };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('absolute XDG_DATA_HOME stores context in pausepin/pausepin.sqlite', () => {
  const { xdg, json } = fixture();
  json(['start', 'A fresh task', '--next', 'Inspect', '--done-when', 'Reviewed']);
  const exported = json(['export']);
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.tasks[0].goal, 'A fresh task');
  assert.equal(existsSync(join(xdg, 'pausepin', 'pausepin.sqlite')), true);
  assert.equal(existsSync(join(xdg, 'breadcrumb')), false);
});

test('absent or relative XDG_DATA_HOME selects the home default without accessing it', () => {
  // This path-only check never opens a database in the user's real home.
  const expected = join(homedir(), '.local', 'share', 'pausepin');
  assert.equal(dataDirectory({}), expected);
  assert.equal(dataDirectory({ XDG_DATA_HOME: 'relative-data' }), expected);
});

test('PAUSEPIN_HOME overrides XDG storage and retains saved context', () => {
  const { root, xdg, json, seed } = fixture();
  const directory = join(root, 'custom-store');
  const saved = seed(directory, 'Explicit storage task');
  const resumed = json(['resume'], { PAUSEPIN_HOME: directory });
  assert.equal(resumed.task.id, saved.tasks[0].id);
  assert.equal(resumed.task.note, saved.tasks[0].note);
  assert.deepEqual(resumed.checkpoint, saved.checkpoints.at(-1));
  assert.deepEqual(json(['export'], { PAUSEPIN_HOME: directory }).ideas, saved.ideas);
  assert.equal(existsSync(join(directory, 'pausepin.sqlite')), true);
  assert.equal(existsSync(xdg), false);
});

test('relative PAUSEPIN_HOME resolves from the project directory', () => {
  const { project, xdg, json } = fixture();
  const overrides = { PAUSEPIN_HOME: 'custom-store' };
  const started = json(['start', 'Relative store', '--next', 'Inspect', '--done-when', 'Reviewed'], overrides);
  assert.equal(json(['status'], overrides).task.id, started.task.id);
  assert.equal(existsSync(join(project, 'custom-store', 'pausepin.sqlite')), true);
  assert.equal(existsSync(xdg), false);
});

test('BREADCRUMB_HOME is ignored even when it points to a valid populated database', () => {
  const { root, xdg, json, seed } = fixture();
  const oldDirectory = join(root, 'old-override');
  seed(oldDirectory, 'Do not open this task');
  const oldDatabase = join(oldDirectory, 'pausepin.sqlite');
  const oldBytes = readFileSync(oldDatabase);

  const exported = json(['export'], { BREADCRUMB_HOME: oldDirectory });
  assert.deepEqual(exported.tasks, []);
  assert.deepEqual(exported.checkpoints, []);
  assert.deepEqual(exported.ideas, []);
  assert.equal(existsSync(join(xdg, 'pausepin', 'pausepin.sqlite')), true);
  assert.deepEqual(readFileSync(oldDatabase), oldBytes);
});

test('old default directory is ignored and its saved database remains untouched', () => {
  const { xdg, json, seed, renameOldDatabase } = fixture();
  const oldDirectory = join(xdg, 'breadcrumb');
  seed(oldDirectory, 'Old default task');
  const oldDatabase = renameOldDatabase(oldDirectory);
  const oldBytes = readFileSync(oldDatabase);

  const started = json(['start', 'New default task', '--next', 'Inspect', '--done-when', 'Reviewed']);
  const exported = json(['export']);
  assert.equal(exported.tasks.length, 1);
  assert.equal(exported.tasks[0].id, started.task.id);
  assert.equal(exported.tasks[0].goal, 'New default task');
  assert.equal(existsSync(join(xdg, 'pausepin', 'pausepin.sqlite')), true);
  assert.deepEqual(readFileSync(oldDatabase), oldBytes);
});

for (const mode of ['default', 'override']) {
  test(`${mode} storage always uses pausepin.sqlite and ignores an old filename`, () => {
    const { root, xdg, json, seed, renameOldDatabase } = fixture();
    const directory = mode === 'default' ? join(xdg, 'pausepin') : join(root, 'custom-store');
    seed(directory, 'Old filename task');
    const oldDatabase = renameOldDatabase(directory);
    const oldBytes = readFileSync(oldDatabase);
    const overrides = mode === 'default' ? {} : { PAUSEPIN_HOME: directory };

    const started = json(['start', 'Current filename task', '--next', 'Inspect', '--done-when', 'Reviewed'], overrides);
    const exported = json(['export'], overrides);
    assert.equal(exported.tasks.length, 1);
    assert.equal(exported.tasks[0].id, started.task.id);
    assert.equal(exported.checkpoints.length, 1);
    assert.deepEqual(exported.ideas, []);
    assert.equal(existsSync(join(directory, 'pausepin.sqlite')), true);
    assert.deepEqual(readFileSync(oldDatabase), oldBytes);
  });
}
