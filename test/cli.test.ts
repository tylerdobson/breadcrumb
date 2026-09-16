import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const temporaryDirectories: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pausepin-cli-'));
  temporaryDirectories.push(root);
  const project = join(root, 'project');
  const home = join(root, 'data');
  mkdirSync(project);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (['PAUSEPIN_HOME', 'BREADCRUMB_HOME'].includes(name.toUpperCase())) delete env[name];
  }
  env.PAUSEPIN_HOME = home;

  function run(args: string[], cwd = project) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `CLI exited by signal: ${result.stderr}`);
    return result;
  }

  function json(args: string[], cwd = project) {
    const result = run([...args, '--json'], cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }

  function error(args: string[], cwd = project): string {
    const result = run([...args, '--json'], cwd);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, '', 'Errors must not pollute JSON output on stdout.');
    const parsed = JSON.parse(result.stderr);
    assert.equal(typeof parsed.error, 'string');
    assert.ok(parsed.error.length);
    return parsed.error;
  }

  return { root, project, home, env, run, json, error };
}

function git(project: string, ...args: string[]): void {
  execFileSync('git', [
    '-c', 'user.name=Pausepin Test',
    '-c', 'user.email=pausepin@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-C', project, ...args,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

const startArgs = ['start', 'Fix the mobile menu', '--next', 'Reproduce the failure', '--done-when', 'Keyboard and mobile checks pass'];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('separate invocations retain task context, explicit clearing, and checkpoint history', () => {
  const { json } = fixture();
  const started = json(startArgs).task;
  assert.equal(started.status, 'active');
  assert.equal(started.goal, 'Fix the mobile menu');
  assert.equal(started.doneWhen, 'Keyboard and mobile checks pass');

  const paused = json(['pause', '--next', 'Inspect the overlay', '--note', 'The overlay may intercept clicks', '--decision', 'Should Escape close the menu?']);
  assert.equal(paused.task.id, started.id);
  assert.equal(paused.task.status, 'paused');
  assert.equal(paused.checkpoint.next, 'Inspect the overlay');
  assert.equal(paused.checkpoint.note, 'The overlay may intercept clicks');
  assert.equal(paused.checkpoint.decision, 'Should Escape close the menu?');
  assert.equal(paused.checkpoint.snapshot, null);

  const status = json(['status']);
  assert.equal(status.task.status, 'paused', 'Reading status must not resume the task.');
  assert.equal(status.checkpoint.id, paused.checkpoint.id);
  assert.equal(status.drift, null);
  assert.equal(status.currentGit, null);
  assert.equal(status.verification, 'not-recorded');

  const resumed = json(['resume']);
  assert.equal(resumed.task.status, 'active');
  assert.equal(resumed.task.next, 'Inspect the overlay');
  assert.equal(resumed.task.note, 'The overlay may intercept clicks');
  assert.equal(resumed.task.decision, 'Should Escape close the menu?');
  assert.equal(resumed.checkpoint.id, paused.checkpoint.id);

  const unchanged = json(['pause']);
  assert.equal(unchanged.task.note, paused.task.note);
  assert.equal(unchanged.task.decision, paused.task.decision);
  const cleared = json(['pause', '--note', '', '--decision', '']);
  assert.equal(cleared.task.note, null);
  assert.equal(cleared.task.decision, null);
  assert.equal(cleared.task.next, 'Inspect the overlay');

  const exported = json(['export']);
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.tasks.length, 1);
  assert.equal(exported.checkpoints.length, 4);
  assert.equal(exported.checkpoints[1].note, paused.task.note);
  assert.equal(exported.checkpoints[3].note, null);
});

test('starting another task cannot overwrite an active or paused task', () => {
  const { json, error } = fixture();
  const started = json(startArgs).task;
  for (const status of ['active', 'paused']) {
    if (status === 'paused') json(['pause']);
    const before = json(['export']);
    assert.match(error(['start', 'A distraction', '--next', 'Investigate', '--done-when', 'Understood']), /unfinished task/);
    const after = json(['export']);
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.checkpoints, before.checkpoints);
    assert.equal(json(['status']).task.id, started.id);
  }
});

test('resume repeatedly reports Git drift until a new checkpoint is saved', () => {
  const { project, json, run } = fixture();
  git(project, 'init', '--initial-branch=main');
  writeFileSync(join(project, 'menu.ts'), 'export const menu = "before";\n');
  git(project, 'add', 'menu.ts');
  git(project, 'commit', '-m', 'Fixture');
  mkdirSync(join(project, 'src'));
  const started = json(startArgs, join(project, 'src')).task;
  assert.equal(started.project, realpathSync.native(project));
  const paused = json(['pause', '--next', 'Check close behavior']);
  assert.equal(json(['status']).drift, false);
  writeFileSync(join(project, 'menu.ts'), 'export const menu = "after!";\n');

  for (let count = 0; count < 2; count += 1) {
    const resumed = json(['resume'], join(project, 'src'));
    assert.equal(resumed.drift, true);
    assert.equal(resumed.checkpoint.id, paused.checkpoint.id);
    assert.equal(resumed.checkpoint.snapshot.fingerprint, paused.checkpoint.snapshot.fingerprint);
    assert.deepEqual(resumed.currentGit.changedFiles, ['menu.ts']);
    assert.equal(resumed.verification, 'not-recorded');
  }
  assert.equal(json(['export']).checkpoints.length, 2);
  const human = run(['resume']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Changed since checkpoint/);
  assert.match(human.stdout, /Verification: not recorded/);

  const newCheckpoint = json(['pause']);
  assert.notEqual(newCheckpoint.checkpoint.id, paused.checkpoint.id);
  assert.equal(json(['resume']).drift, false);
  assert.equal(json(['export']).checkpoints.length, 3);
});

test('ideas can be parked independently or associated with the current task', () => {
  const { json } = fixture();
  const independent = json(['park', 'Try a different terminal theme']).idea;
  assert.equal(independent.taskId, null);
  const task = json(startArgs).task;
  const associated = json(['park', 'Explore animation later']).idea;
  assert.equal(associated.taskId, task.id);
  assert.equal(json(['status']).task.next, task.next);
  json(['pause']);
  assert.equal(json(['park', 'Check reduced-motion behavior']).idea.taskId, task.id);
  json(['done']);
  const later = json(['park', 'A future project']).idea;
  assert.equal(later.taskId, null);
  const ideas = json(['ideas']).ideas;
  assert.deepEqual(ideas.map((idea: { text: string }) => idea.text), [
    independent.text, associated.text, 'Check reduced-motion behavior', later.text,
  ]);
});

test('completion retains history, permits a new task, and claims no verification', () => {
  const { json, run } = fixture();
  const first = json(startArgs).task;
  json(['pause', '--note', 'Ready for personal review']);
  const done = json(['done']);
  assert.equal(done.task.status, 'done');
  assert.equal(done.verification, 'not-recorded');
  assert.equal(json(['status']).task, null);

  const second = json(['start', 'Improve labels', '--next', 'List unclear labels', '--done-when', 'Labels reviewed']).task;
  assert.notEqual(second.id, first.id);
  const human = run(['done']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Completed by you: Improve labels/);
  assert.match(human.stdout, /No tests were run or verified/);
  const exported = json(['export']);
  assert.equal(exported.tasks.length, 2);
  assert.ok(exported.tasks.every((task: { status: string }) => task.status === 'done'));
  assert.equal(exported.checkpoints.length, 3);
  assert.equal(exported.checkpoints[1].note, 'Ready for personal review');
});

test('non-Git projects use canonical directories and exports isolate each project', () => {
  const { root, project, json } = fixture();
  const alias = join(root, 'project-alias');
  const other = join(root, 'other-project');
  symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(other);
  const first = json(startArgs, alias).task;
  assert.equal(first.project, realpathSync.native(project));
  assert.equal(json(['status'], project).task.id, first.id);
  json(['park', 'Only in the first project'], alias);

  assert.equal(json(['status'], other).task, null);
  const second = json(['start', 'Second project', '--next', 'Inspect', '--done-when', 'Reviewed'], other).task;
  json(['park', 'Only in the second project'], other);
  const firstExport = json(['export'], project);
  const secondExport = json(['export'], other);
  assert.equal(firstExport.tasks.length, 1);
  assert.equal(firstExport.tasks[0].id, first.id);
  assert.equal(firstExport.checkpoints.length, 1);
  assert.equal(firstExport.ideas[0].text, 'Only in the first project');
  assert.equal(secondExport.tasks.length, 1);
  assert.equal(secondExport.tasks[0].id, second.id);
  assert.equal(secondExport.checkpoints.length, 1);
  assert.equal(secondExport.ideas[0].text, 'Only in the second project');
});

test('invalid arguments produce parseable errors without creating task history', () => {
  const { json, error } = fixture();
  const invalid = [
    ['unknown'],
    ['start', 'A goal'],
    ['start', 'A goal', '--next', 'Do it'],
    ['start', ' ', '--next', 'Do it', '--done-when', 'Complete'],
    ['start', 'A goal', '--next', ' ', '--done-when', 'Complete'],
    ['start', 'A goal', '--next', 'Do it', '--done-when', ' '],
    ['start', 'Unquoted', 'goal', '--next', 'Do it', '--done-when', 'Complete'],
    ['park', ' '],
    ['status', 'unexpected'],
    ['status', '--next', 'Unexpected option'],
    ['status', '--unknown-option'],
    ['pause', '--next'],
  ];
  for (const args of invalid) assert.ok(error(args), args.join(' '));
  const exported = json(['export']);
  assert.deepEqual(exported.tasks, []);
  assert.deepEqual(exported.checkpoints, []);
  assert.deepEqual(exported.ideas, []);
  for (const command of ['pause', 'resume', 'done']) assert.match(error([command]), /No unfinished task/);
  assert.equal(json(['status']).task, null);
});

test('help and version are available without opening a database', () => {
  const { home, json, run } = fixture();
  assert.match(json(['--help']).help, /pausepin start/);
  assert.equal(json(['--version']).version, '0.1.0');
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.equal(existsSync(home), false);
});

test('task capture and recovery work when Git is not installed', () => {
  const { project, env } = fixture();
  // Windows environment names are case-insensitive; remove every PATH variant.
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'path') delete env[name];
  env.PATH = join(project, 'no-executables-here');
  const results = [startArgs, ['pause', '--note', 'Return here'], ['resume']].map(args => {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
      cwd: project, env, encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  });
  assert.equal(results[2].task.id, results[0].task.id);
  assert.equal(results[2].task.note, 'Return here');
  assert.equal(results[2].currentGit, null);
  assert.equal(results[2].drift, null);
  assert.equal(results[2].verification, 'not-recorded');
});

test('human output removes terminal controls while JSON preserves saved content', () => {
  const { json, run } = fixture();
  const goal = 'Fix \u001b[31mmenu\u001b[0m\nthen inspect';
  assert.equal(json(['start', goal, '--next', 'Reproduce', '--done-when', 'Reviewed']).task.goal, goal);
  const result = run(['status']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Goal: Fix menu then inspect/);
  assert.doesNotMatch(result.stdout, /\u001b/);
});
