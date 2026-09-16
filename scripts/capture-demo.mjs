#!/usr/bin/env node
// Capture the real CLI against a disposable, fictional project. No user data,
// Git configuration, terminal history, or existing Pausepin store is loaded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const outputPath = fileURLToPath(new URL('../docs/images/demo-session.json', import.meta.url));
const displayPrompt = 'demo@laptop ~/projects/weather-widget $ ';
const displayTimestamp = '2030-04-18T14:32:00.000Z';
const fixtureRoot = mkdtempSync(join(tmpdir(), 'pausepin-fictional-demo-'));
const projectDirectory = join(fixtureRoot, 'projects', 'weather-widget');
const fixtureHome = join(fixtureRoot, 'demo-home');
const emptyGitConfig = join(fixtureRoot, 'empty.gitconfig');

function checkPrivacy(value) {
  const visible = stripVTControlCharacters(value);
  const forbidden = [
    /\/(?:Users|home|private|tmp)\//i,
    /\/var\/folders\//i,
    /[a-z]:[\\/]/i,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    /breadcrumb|\bcrumb\b/i,
  ];
  assert.ok(forbidden.every(pattern => !pattern.test(visible)), 'Demo output contains a forbidden path, identifier, or former product name.');
  const hostMarkers = [
    fixtureRoot,
    dirname(dirname(cliPath)),
    homedir(),
    basename(homedir()),
    process.env.USER,
    process.env.USERNAME,
    process.env.LOGNAME,
  ].filter(value => value && value.length > 2 && !['demo', 'laptop'].includes(value.toLowerCase()));
  assert.ok(hostMarkers.every(marker => !visible.toLowerCase().includes(marker.toLowerCase())), 'Demo output contains a host-specific name or path.');
}

try {
  assert.ok(existsSync(cliPath), 'Build the CLI with npm run build before capturing the demo.');
  for (const path of [projectDirectory, fixtureHome, join(fixtureRoot, 'tmp'), join(fixtureRoot, 'empty-git-template')]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(emptyGitConfig, '');

  // Start with an allowlist, not the caller's environment. HOME and USERPROFILE
  // are isolated only for these child processes; the host environment is untouched.
  const env = {};
  for (const name of Object.keys(process.env)) {
    if (['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR'].includes(name.toUpperCase())) env[name] = process.env[name];
  }
  Object.assign(env, {
    HOME: fixtureHome,
    USERPROFILE: fixtureHome,
    USER: 'demo',
    USERNAME: 'demo',
    LOGNAME: 'demo',
    PAUSEPIN_HOME: join(fixtureRoot, 'pausepin-data'),
    XDG_CONFIG_HOME: join(fixtureRoot, 'config'),
    XDG_DATA_HOME: join(fixtureRoot, 'data'),
    TMPDIR: join(fixtureRoot, 'tmp'),
    TMP: join(fixtureRoot, 'tmp'),
    TEMP: join(fixtureRoot, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TEMPLATE_DIR: join(fixtureRoot, 'empty-git-template'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_DATE: displayTimestamp,
    GIT_COMMITTER_DATE: displayTimestamp,
    FORCE_COLOR: '1',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  });

  function run(executable, args, label) {
    const result = spawnSync(executable, args, {
      cwd: projectDirectory,
      env,
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Do not echo subprocess errors: filesystem failures can include host paths.
    assert.ok(!result.error && result.status === 0 && result.signal === null, `The isolated ${label} command failed.`);
    return result;
  }

  function git(...args) {
    return run('git', [
      '-c', 'user.name=Demo Developer',
      '-c', 'user.email=demo@example.invalid',
      '-c', 'commit.gpgsign=false',
      '-c', 'core.autocrlf=false',
      ...args,
    ], 'Git');
  }

  function capture(args, commandLines) {
    const result = run(process.execPath, [cliPath, ...args], 'Pausepin');
    assert.equal(result.stderr, '', 'The demo requires successful CLI output without stderr.');
    const output = result.stdout.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g, displayTimestamp);
    const command = [displayPrompt + commandLines[0], ...commandLines.slice(1)];
    assert.match(output, /\u001b\[[\d;]*m/, 'The demo requires the real CLI ANSI colors.');
    checkPrivacy(command.join('\n') + '\n' + output);
    return { command, output };
  }

  git('init', '--initial-branch=main');
  const forecastFile = join(projectDirectory, 'forecast.js');
  writeFileSync(forecastFile, "export function renderForecast(forecast) {\n  return forecast.map(day => day.summary).join(', ');\n}\n");
  git('add', 'forecast.js');
  git('commit', '-m', 'Create the fictional weather widget');

  const focus = {
    id: 'focus',
    title: 'Pin your place.',
    subtitle: 'One task, a parked idea, and a clear next step.',
    entries: [
      capture([
        'start', 'Handle an empty forecast',
        '--next', 'Add an empty-state test',
        '--done-when', 'Empty-state test passes',
      ], [
        'pausepin start "Handle an empty forecast" \\',
        '  --next "Add an empty-state test" \\',
        '  --done-when "Empty-state test passes"',
      ]),
      capture(['park', 'Add keyboard shortcuts'], ['pausepin park "Add keyboard shortcuts"']),
      capture([
        'pause',
        '--note', 'Empty response skips the fallback',
        '--next', 'Check the empty-response branch',
        '--decision', 'Retry or show cached weather?',
      ], [
        'pausepin pause \\',
        '  --note "Empty response skips the fallback" \\',
        '  --next "Check the empty-response branch" \\',
        '  --decision "Retry or show cached weather?"',
      ]),
    ],
  };

  // This is the only file change between the saved checkpoint and resume.
  writeFileSync(forecastFile, "export function renderForecast(forecast) {\n  if (forecast.length === 0) return 'No forecast available';\n  return forecast.map(day => day.summary).join(', ');\n}\n");
  const resumed = capture(['resume'], ['pausepin resume']);
  const visibleResume = stripVTControlCharacters(resumed.output);
  assert.match(visibleResume, /Git: main · 1 changed file\(s\)/);
  assert.match(visibleResume, /Changed since checkpoint\./);
  assert.match(visibleResume, /Verification: not recorded\./);
  const resume = {
    id: 'resume',
    title: 'Come back with context.',
    subtitle: 'The fictional forecast file changed after the checkpoint.',
    entries: [resumed],
  };

  const finish = {
    id: 'finish',
    title: 'Finish on your terms.',
    subtitle: 'Completion records your decision. Pausepin does not run tests.',
    entries: [
      capture(['ideas'], ['pausepin ideas']),
      capture(['done'], ['pausepin done']),
      capture(['status'], ['pausepin status']),
    ],
  };
  assert.match(stripVTControlCharacters(finish.entries[1].output), /No tests were run or verified by Pausepin\./);
  assert.match(stripVTControlCharacters(finish.entries[2].output), /No unfinished task here\./);

  const session = { panels: [focus, resume, finish] };
  checkPrivacy(session.panels.flatMap(panel => [
    panel.id,
    panel.title,
    panel.subtitle,
    ...panel.entries.flatMap(entry => [...entry.command, entry.output]),
  ]).join('\n'));
  const serialized = JSON.stringify(session, null, 2) + '\n';
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized);
  process.stdout.write('Captured 3 fictional demo panels in docs/images/demo-session.json.\n');
} catch (error) {
  // Avoid stack traces and host-specific paths in generation logs.
  const message = error instanceof assert.AssertionError ? error.message.split(/\r?\n/, 1)[0] : 'The isolated demo could not be generated.';
  process.stderr.write(`Demo capture failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  // This directory was created by this invocation and contains only demo data.
  rmSync(fixtureRoot, { recursive: true, force: true });
}
