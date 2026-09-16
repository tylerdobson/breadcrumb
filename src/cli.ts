#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { captureGitSnapshot, findGitRoot } from './git.js';
import { Store } from './store.js';
import type { Checkpoint, Task } from './store.js';
import type { GitSnapshot } from './git.js';

const HELP = `Breadcrumb — pick up where you left off.

Usage:
  crumb start "goal" --next "action" --done-when "criterion"
  crumb park "idea"
  crumb pause [--note "hypothesis"] [--next "action"] [--decision "question"]
  crumb resume
  crumb status
  crumb ideas
  crumb done
  crumb export

One unfinished task per project. Run commands inside that project.
--json emits structured output. --help shows this guide. --version shows the version.
Pause saves context, not source files. Done records your decision, not a test result.
Notes stay in your local data directory; BREADCRUMB_HOME overrides its location.
`;

function readable(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function card(task: Task, checkpoint: Checkpoint | null, snapshot: GitSnapshot | null): string {
  const lines = [
    `Goal: ${readable(task.goal)}`,
    `Next: ${readable(task.next)}`,
    `Done when: ${readable(task.doneWhen)}`,
  ];
  if (task.note) lines.push(`Your note: ${readable(task.note)}`);
  if (task.decision) lines.push(`Open decision: ${readable(task.decision)}`);
  if (checkpoint) lines.push(`Checkpoint: ${checkpoint.createdAt}`);
  if (snapshot) {
    lines.push(`Git: ${readable(snapshot.branch ?? 'detached HEAD')} · ${snapshot.changedFiles.length} changed file(s)`);
    if (checkpoint?.snapshot && checkpoint.snapshot.fingerprint !== snapshot.fingerprint) {
      lines.push('Changed since checkpoint. Recheck your saved hypothesis before continuing.');
    } else if (checkpoint?.snapshot) {
      lines.push('Git state matches your checkpoint.');
    } else {
      lines.push('No Git baseline at this checkpoint; changes cannot be compared.');
    }
  } else {
    lines.push('No Git repository. Context saved; file changes are not tracked.');
  }
  lines.push('Verification: not recorded.');
  return lines.join('\n');
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      next: { type: 'string' }, 'done-when': { type: 'string' },
      note: { type: 'string' }, decision: { type: 'string' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const output = (data: unknown, message: string) => {
    process.stdout.write((values.json ? JSON.stringify(data, null, 2) : message) + '\n');
  };
  if (values.version) { output({ version: '0.1.0' }, '0.1.0'); return; }
  if (values.help || !positionals.length) { output({ help: HELP }, HELP); return; }
  const [command, ...args] = positionals;
  const allowed: Record<string, string[]> = {
    start: ['next', 'done-when'], pause: ['next', 'note', 'decision'],
    park: [], resume: [], status: [], ideas: [], done: [], export: [],
  };
  if (!command || !Object.hasOwn(allowed, command)) throw new Error(`Unknown command: ${command}. Run crumb --help.`);
  for (const option of Object.keys(values)) {
    if (!['json', 'help', 'version'].includes(option) && !allowed[command]!.includes(option)) {
      throw new Error(`--${option} is not supported by crumb ${command}.`);
    }
  }
  const needsText = command === 'start' || command === 'park';
  if (args.length !== (needsText ? 1 : 0)) throw new Error(`Unexpected arguments. Run crumb --help; quote goals and ideas containing spaces.`);
  if (needsText && !args[0]?.trim()) throw new Error('Enter a nonempty goal or idea.');
  if (values.next !== undefined && !values.next.trim()) throw new Error('--next must describe a nonempty action.');
  if (command === 'start' && (!values.next?.trim() || !values['done-when']?.trim())) {
    throw new Error('Starting needs --next "action" and --done-when "criterion".');
  }

  const cwd = realpathSync(process.cwd());
  const project = findGitRoot(cwd) ?? cwd;
  const store = new Store();
  try {
    if (command === 'start') {
      const snapshot = captureGitSnapshot(cwd);
      const task = store.start(project, args[0]!.trim(), values.next!.trim(), values['done-when']!.trim(), snapshot);
      output({ task }, `Started: ${readable(task.goal)}\nNext: ${readable(task.next)}\nDone when: ${readable(task.doneWhen)}`);
    } else if (command === 'park') {
      const idea = store.park(project, args[0]!.trim());
      output({ idea }, `Parked: ${readable(idea.text)}\nView saved ideas with crumb ideas.`);
    } else if (command === 'pause') {
      const snapshot = captureGitSnapshot(cwd);
      const task = store.pause(project, { next: values.next?.trim(), note: values.note?.trim(), decision: values.decision?.trim() }, snapshot);
      const checkpoint = store.latestCheckpoint(task.id);
      output({ task, checkpoint }, `Checkpoint saved.\nNext time: ${readable(task.next)}\nReturn with crumb resume.`);
    } else if (command === 'resume' || command === 'status') {
      let task = store.current(project);
      if (!task) {
        if (command === 'resume') throw new Error('No unfinished task here. Run crumb start to begin.');
        output({ task: null }, 'No unfinished task here. Run crumb start to begin.');
        return;
      }
      const snapshot = captureGitSnapshot(cwd);
      const checkpoint = store.latestCheckpoint(task.id);
      if (command === 'resume') task = store.setStatus(project, 'active');
      const drift = checkpoint?.snapshot && snapshot ? checkpoint.snapshot.fingerprint !== snapshot.fingerprint : null;
      output({ task, checkpoint, currentGit: snapshot, drift, verification: 'not-recorded' }, card(task, checkpoint, snapshot));
    } else if (command === 'ideas') {
      const ideas = store.ideas(project);
      output({ ideas }, ideas.length ? ideas.map((idea, i) => `${i + 1}. ${readable(idea.text)}`).join('\n') : 'No parked ideas here yet.');
    } else if (command === 'done') {
      const task = store.setStatus(project, 'done');
      output({ task, verification: 'not-recorded' }, `Completed by you: ${readable(task.goal)}\nNo tests were run or verified by Breadcrumb. Your checkpoints and ideas are retained.`);
    } else if (command === 'export') {
      process.stdout.write(JSON.stringify(store.export(project), null, 2) + '\n');
    }
  } finally {
    store.close();
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write((process.argv.includes('--json') ? JSON.stringify({ error: message }) : `crumb: ${readable(message)}`) + '\n');
  process.exitCode = 1;
}
