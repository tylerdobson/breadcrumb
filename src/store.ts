import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GitSnapshot } from './git.js';

export interface Task {
  id: string;
  project: string;
  goal: string;
  doneWhen: string;
  next: string;
  status: 'active' | 'paused' | 'done';
  note: string | null;
  decision: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Checkpoint {
  id: string;
  taskId: string;
  createdAt: string;
  next: string;
  note: string | null;
  decision: string | null;
  snapshot: GitSnapshot | null;
}

export interface Idea {
  id: string;
  project: string;
  taskId: string | null;
  text: string;
  createdAt: string;
}

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PAUSEPIN_HOME) return resolve(env.PAUSEPIN_HOME);
  const base = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : join(homedir(), '.local', 'share');
  return join(base, 'pausepin');
}

export class Store {
  private db: DatabaseSync;

  constructor(directory = dataDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'pausepin.sqlite');
    // SQLite creates journal files too; keep the original mask after opening.
    const mask = process.umask(0o077);
    try {
      this.db = new DatabaseSync(path);
      chmodSync(path, 0o600);
    } finally {
      process.umask(mask);
    }
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    if (version !== 0 && version !== 1) {
      this.db.close();
      throw new Error('This database uses a newer format. Upgrade Pausepin before opening it.');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, goal TEXT NOT NULL,
        doneWhen TEXT NOT NULL, next TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'done')),
        note TEXT, decision TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_task ON tasks(project) WHERE status != 'done';
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
        createdAt TEXT NOT NULL, next TEXT NOT NULL, note TEXT, decision TEXT, snapshot TEXT
      );
      CREATE INDEX IF NOT EXISTS task_checkpoints ON checkpoints(taskId);
      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, taskId TEXT REFERENCES tasks(id),
        text TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_ideas ON ideas(project);
      PRAGMA user_version = 1;
    `);
  }

  close(): void { this.db.close(); }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  current(project: string): Task | null {
    return this.db.prepare("SELECT * FROM tasks WHERE project = ? AND status != 'done'")
      .get(project) as unknown as Task ?? null;
  }

  private requireCurrent(project: string): Task {
    const task = this.current(project);
    if (!task) throw new Error('No unfinished task here. Start one with pausepin start "goal" --next "action" --done-when "criterion".');
    return task;
  }

  start(project: string, goal: string, next: string, doneWhen: string, snapshot: GitSnapshot | null): Task {
    return this.transaction(() => {
      if (this.current(project)) throw new Error('This project already has an unfinished task. Use pausepin resume, or pausepin done before starting another.');
      const now = new Date().toISOString();
      const task: Task = { id: randomUUID(), project, goal, doneWhen, next, status: 'active', note: null, decision: null, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(task.id, project, goal, doneWhen, next, task.status, null, null, now, now);
      this.checkpoint(task, snapshot);
      return task;
    });
  }

  private checkpoint(task: Task, snapshot: GitSnapshot | null): void {
    this.db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), task.id, new Date().toISOString(), task.next, task.note, task.decision, snapshot ? JSON.stringify(snapshot) : null);
  }

  pause(project: string, changes: {next?: string; note?: string; decision?: string}, snapshot: GitSnapshot | null): Task {
    return this.transaction(() => {
      const current = this.requireCurrent(project);
      const task: Task = {
        ...current, next: changes.next ?? current.next,
        note: changes.note === undefined ? current.note : changes.note || null,
        decision: changes.decision === undefined ? current.decision : changes.decision || null,
        status: 'paused', updatedAt: new Date().toISOString(),
      };
      this.db.prepare('UPDATE tasks SET next = ?, note = ?, decision = ?, status = ?, updatedAt = ? WHERE id = ?')
        .run(task.next, task.note, task.decision, task.status, task.updatedAt, task.id);
      this.checkpoint(task, snapshot);
      return task;
    });
  }

  setStatus(project: string, status: 'active' | 'done'): Task {
    return this.transaction(() => {
      const task = { ...this.requireCurrent(project), status, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?').run(status, task.updatedAt, task.id);
      return task;
    });
  }

  latestCheckpoint(taskId: string): Checkpoint | null {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE taskId = ? ORDER BY rowid DESC LIMIT 1').get(taskId);
    return row ? { ...row, snapshot: row.snapshot ? JSON.parse(String(row.snapshot)) : null } as unknown as Checkpoint : null;
  }

  park(project: string, text: string): Idea {
    return this.transaction(() => {
      const idea: Idea = { id: randomUUID(), project, taskId: this.current(project)?.id ?? null, text, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO ideas VALUES (?, ?, ?, ?, ?)').run(idea.id, project, idea.taskId, text, idea.createdAt);
      return idea;
    });
  }

  ideas(project: string): Idea[] {
    return this.db.prepare('SELECT * FROM ideas WHERE project = ? ORDER BY rowid').all(project) as unknown as Idea[];
  }

  export(project: string) {
    return this.transaction(() => ({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      project,
      tasks: this.db.prepare('SELECT * FROM tasks WHERE project = ? ORDER BY rowid').all(project),
      checkpoints: this.db.prepare('SELECT c.* FROM checkpoints c JOIN tasks t ON c.taskId = t.id WHERE t.project = ? ORDER BY c.rowid')
        .all(project).map(row => ({ ...row, snapshot: row.snapshot ? JSON.parse(String(row.snapshot)) : null })),
      ideas: this.ideas(project),
    }));
  }
}
