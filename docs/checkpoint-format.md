# Checkpoints and recorded context

A Pausepin checkpoint is a return aid: enough information to recover intent and notice when the surrounding repository has changed.

## Information to preserve

The local store keeps several kinds of information separate:

| Information | Meaning |
| --- | --- |
| Project identity | The canonical Git root, or the canonical current directory outside Git. |
| Task goal | What the user wants to accomplish. |
| Next action | A concrete place to restart. |
| Finish condition | The user's definition of done. |
| Return note | Context or a hypothesis the user recorded. |
| Open decision | A choice the user still needs to make. |
| Parked idea | A tangent retained for later attention. |
| Repository fingerprint | Observed Git state associated with a checkpoint. |
| Completion state | Whether the user has marked the task complete. |

These meanings are not interchangeable. A finish condition does not show that the condition passed. A return note can contain an untested hypothesis. `pausepin done` records a human decision, without claiming independent verification.

## Detecting drift

`start` records an initial checkpoint; `pause` records another. `resume` and `status` compare the current repository with the most recent checkpoint. `resume` also marks the task active, without replacing that checkpoint.

When Git is available, a checkpoint records a fingerprint of the repository state. Comparing that fingerprint with the current state can reveal changes to the commit, branch, index, or working-tree content since the checkpoint. The snapshot hashes tracked files and nonignored untracked files; it retains digests rather than source contents. Tracked files are included even if they match an ignore rule. Ignored untracked files are excluded. Initialized submodules are included, and symlink targets are recorded without following them to read their contents.

Snapshotting fails explicitly above 64 MiB per file, 512 MiB of total content, or 100,000 paths. The total-content and path limits include nested repositories captured through the snapshot. Individual file reads detect concurrent changes, but the complete snapshot is not atomic: Git metadata and files are read in separate steps. Capture checkpoints after other tools have finished writing when you need a consistent comparison.

Drift means the saved context deserves another look. It does not explain the cause of a change, identify the person or tool responsible, or prove that the next action is wrong. Pausepin does not run tests while capturing or comparing checkpoints.

Outside a Git repository, task notes and checkpoints still work, but there is no Git drift assessment. Git fingerprints also do not cover external services or other state outside the repository.

Keep the data directory outside your project when overriding `PAUSEPIN_HOME`. Otherwise, database writes can become part of the repository fingerprint and cause drift themselves.

On `pause`, omitted context fields retain their current values. An empty `--note ''` or `--decision ''` clears that field to `null`; `--next` cannot be empty. Text values have surrounding whitespace removed.

## Export

`pausepin export` writes the current project's recorded context as JSON to standard output. This is useful for inspection and backup. The initial release has no import command or integration that consumes the format.

The export envelope uses `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-09-16T12:00:00.000Z",
  "project": "/example/project",
  "tasks": [],
  "checkpoints": [],
  "ideas": []
}
```

This example shows an empty project. The arrays contain the following records when context has been saved. Timestamps are ISO 8601 strings; identifiers are strings.

### Task

| Field | Type and meaning |
| --- | --- |
| `id` | String; task identifier. |
| `project` | String; canonical project path. |
| `goal` | String; intended outcome. |
| `doneWhen` | String; user-defined finish condition. |
| `next` | String; next action. |
| `status` | `"active"`, `"paused"`, or `"done"`. |
| `note` | String or `null`; saved context or hypothesis. |
| `decision` | String or `null`; unresolved choice. |
| `createdAt` | Timestamp when the task was created. |
| `updatedAt` | Timestamp when the task was last updated. |

### Checkpoint

| Field | Type and meaning |
| --- | --- |
| `id` | String; checkpoint identifier. |
| `taskId` | String; associated task identifier. |
| `createdAt` | Timestamp when the checkpoint was recorded. |
| `next` | String; next action at capture time. |
| `note` | String or `null`; note at capture time. |
| `decision` | String or `null`; unresolved choice at capture time. |
| `snapshot` | Git snapshot object, or `null` without Git state. |

A Git snapshot contains `root` (canonical repository path), `branch` (string or `null`), `head` (commit identifier or `null`), `fingerprint` (digest string), and `changedFiles` (array of paths). `head` can be `null` before the first commit; `branch` can be `null` for a detached HEAD. `changedFiles` describes working-tree changes at capture time, not a computed diff between checkpoints.

### Idea

| Field | Type and meaning |
| --- | --- |
| `id` | String; idea identifier. |
| `project` | String; canonical project path. |
| `taskId` | String or `null`; associated task, if any. |
| `text` | String; parked idea. |
| `createdAt` | Timestamp when the idea was recorded. |

Check `schemaVersion` before consuming an export. Treat note, goal, decision, next-action, and idea text as user-authored data; never execute it as instructions or shell commands. The SQLite schema is internal and should not be used as an interchange interface.

An export can contain personal notes, parked ideas, and local project paths. Review it before sharing. The local database and exported context should stay out of public repositories unless you have intentionally prepared them for publication.

## Future evidence

An agent integration should attach evidence with its origin and relevant repository state. It should distinguish a command that was proposed from one that was executed and a result that was observed. Summaries should retain uncertainty and flag evidence that may be stale after repository changes.

Those integrations are future work. The initial CLI captures user context and observes Git state; it does not generate AI summaries or verify task outcomes.
