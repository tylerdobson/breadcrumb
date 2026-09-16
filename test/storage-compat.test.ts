import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

  function makeLegacy(directory: string): string {
    const legacy = join(directory, 'breadcrumb.sqlite');
    renameSync(join(directory, 'pausepin.sqlite'), legacy);
    return legacy;
  }

  return { root, xdg, json, seed, makeLegacy };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('fresh default storage uses the Pausepin directory and database name', () => {
  const { xdg, json } = fixture();
  json(['start', 'A fresh task', '--next', 'Inspect', '--done-when', 'Reviewed']);
  const exported = json(['export']);
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.tasks[0].goal, 'A fresh task');
  assert.equal(existsSync(join(xdg, 'pausepin', 'pausepin.sqlite')), true);
  assert.equal(existsSync(join(xdg, 'breadcrumb')), false);
});

test('default storage resumes legacy tasks in place without losing notes, checkpoints, or ideas', () => {
  const { xdg, json, seed, makeLegacy } = fixture();
  const legacyDirectory = join(xdg, 'breadcrumb');
  const saved = seed(legacyDirectory, 'Keep my old context');
  const legacyDatabase = makeLegacy(legacyDirectory);

  const resumed = json(['resume']);
  assert.equal(resumed.task.id, saved.tasks[0].id);
  assert.equal(resumed.task.note, saved.tasks[0].note);
  assert.equal(resumed.task.next, saved.tasks[0].next);
  assert.equal(resumed.task.decision, saved.tasks[0].decision);
  assert.equal(resumed.task.status, 'active');
  assert.deepEqual(resumed.checkpoint, saved.checkpoints.at(-1));
  const exported = json(['export']);
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.tasks.length, 1);
  assert.deepEqual(exported.checkpoints, saved.checkpoints);
  assert.deepEqual(exported.ideas, saved.ideas);
  assert.equal(existsSync(legacyDatabase), true);
  assert.equal(existsSync(join(legacyDirectory, 'pausepin.sqlite')), false);
  assert.equal(existsSync(join(xdg, 'pausepin')), false);
});

test('PAUSEPIN_HOME takes precedence while BREADCRUMB_HOME still opens legacy storage', () => {
  const { root, json, seed, makeLegacy } = fixture();
  const legacyDirectory = join(root, 'legacy-override');
  const newDirectory = join(root, 'new-override');
  const legacy = seed(legacyDirectory, 'Legacy override task');
  makeLegacy(legacyDirectory);
  const legacyOnly = json(['resume'], { BREADCRUMB_HOME: legacyDirectory });
  assert.equal(legacyOnly.task.id, legacy.tasks[0].id);
  assert.equal(legacyOnly.task.note, legacy.tasks[0].note);

  const current = seed(newDirectory, 'Preferred override task');
  const both = json(['resume'], { BREADCRUMB_HOME: legacyDirectory, PAUSEPIN_HOME: newDirectory });
  assert.equal(both.task.id, current.tasks[0].id);
  assert.equal(both.task.note, current.tasks[0].note);
  assert.deepEqual(both.checkpoint, current.checkpoints.at(-1));
  assert.equal(json(['status'], { BREADCRUMB_HOME: legacyDirectory }).task.id, legacy.tasks[0].id);
});

for (const override of ['PAUSEPIN_HOME', 'BREADCRUMB_HOME']) {
  test(`${override} selects an existing Pausepin database before a legacy filename`, () => {
    const { root, json, seed, makeLegacy } = fixture();
    const directory = join(root, 'shared-override');
    const staging = join(root, 'new-database');
    const legacy = seed(directory, 'Legacy filename task');
    const legacyDatabase = makeLegacy(directory);
    const legacyOnly = json(['resume'], { [override]: directory });
    assert.equal(legacyOnly.task.id, legacy.tasks[0].id);
    assert.equal(legacyOnly.task.note, legacy.tasks[0].note);
    const legacyBytes = readFileSync(legacyDatabase);
    const current = seed(staging, 'New filename task');
    renameSync(join(staging, 'pausepin.sqlite'), join(directory, 'pausepin.sqlite'));

    const resumed = json(['resume'], { [override]: directory });
    assert.equal(resumed.task.id, current.tasks[0].id);
    assert.equal(resumed.task.note, current.tasks[0].note);
    assert.deepEqual(resumed.checkpoint, current.checkpoints.at(-1));
    assert.deepEqual(readFileSync(legacyDatabase), legacyBytes);
  });
}

for (const filename of ['pausepin.sqlite', 'breadcrumb.sqlite']) {
  test(`default Pausepin directory with ${filename} takes precedence over legacy storage`, () => {
    const { xdg, json, seed, makeLegacy } = fixture();
    const legacyDirectory = join(xdg, 'breadcrumb');
    const newDirectory = join(xdg, 'pausepin');
    seed(legacyDirectory, 'Legacy default task');
    const legacyDatabase = makeLegacy(legacyDirectory);
    const legacyBytes = readFileSync(legacyDatabase);
    const current = seed(newDirectory, 'Preferred default task');
    if (filename === 'breadcrumb.sqlite') makeLegacy(newDirectory);

    const resumed = json(['resume']);
    assert.equal(resumed.task.id, current.tasks[0].id);
    assert.equal(resumed.task.note, current.tasks[0].note);
    assert.deepEqual(resumed.checkpoint, current.checkpoints.at(-1));
    assert.deepEqual(json(['export']).ideas, current.ideas);
    assert.deepEqual(readFileSync(legacyDatabase), legacyBytes);
    assert.equal(existsSync(join(newDirectory, filename)), true);
    if (filename === 'breadcrumb.sqlite') assert.equal(existsSync(join(newDirectory, 'pausepin.sqlite')), false);
  });
}
