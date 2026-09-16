# Contributing to Breadcrumb

Breadcrumb should make returning to work easier than reconstructing the session yourself. A good contribution reduces the effort of capturing or recovering intent.

## Set up

Use Node.js 24 or later and npm:

```sh
npm ci
npm run check
npm test
npm run build
```

Run `npm link` to make `crumb` available locally. Use a separate data directory while experimenting:

```sh
export BREADCRUMB_HOME="$(mktemp -d)"
crumb --help
```

Keep that directory if you need its recorded sessions. Unset `BREADCRUMB_HOME` when you want to return to your normal store.

## Make a change

Keep changes focused and describe the user-visible problem they solve. For behavior changes, include an example of the command and its expected output. Add or update meaningful tests for persistence, project identity, state transitions, and drift detection when those behaviors change.

Before opening a pull request, run `npm run check`, `npm test`, and `npm run build`. Describe what you verified and any remaining limitations. Screenshots are optional; plain terminal output is usually enough.

## Design principles

- Keep the next action easy to find. Put additional detail behind an explicit command or option.
- Preserve the user's wording and intent. Do not silently turn a parked idea into active scope.
- Distinguish saved notes from observed facts. A passing check needs actual evidence; a goal or hypothesis is not evidence.
- Keep capture and resumption usable without an AI service.
- Keep personal context local by default. Avoid adding notes, database files, or real project exports to fixtures.
- Make automation explicit. Do not infer permission to execute a command from a task description.

ADHD-informed design is a starting hypothesis, not proof that a feature helps everyone with ADHD. Share concrete workflow observations and make room for different preferences.

## Report a problem

Include your Breadcrumb and Node versions, operating system, the command you ran, and the expected and actual behavior. For Git-related problems, say whether the repository had commits, staged changes, untracked files, or a detached HEAD.

Use a minimal example when possible. Review terminal output and exports for private notes, paths, credentials, and project details before posting them.

## Project scope

The first release focuses on local tasks, parked ideas, return checkpoints, and Git drift detection. Integrations and shared checkpoint formats can follow once the core workflow is dependable. Discuss a new runtime dependency or a change to storage/export compatibility before building a large contribution.
