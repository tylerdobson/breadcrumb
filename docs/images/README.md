# Terminal example assets

These illustrations use **only fictional demo data**. They are not screenshots of anyone's desktop, terminal history, files, or saved Pausepin database.

The account `demo@laptop`, project `~/projects/weather-widget`, tasks, notes, and decisions are invented. `capture-demo.mjs` runs the real CLI in a temporary Git repository with a separate home, Git configuration, and Pausepin data directory. It creates a fictional source file to demonstrate Git drift. Only the displayed checkpoint timestamp is replaced with a fixed example timestamp. No paths, commit IDs, source-file contents, or JSON exports from the temporary repository are published.

`render-demo.mjs` renders the captured text and ANSI colors into self-contained SVG terminal illustrations. The window frame, two-line shell prompt, headings, and palette are presentation styling; the CLI responses are real. Terminal colors vary by theme. No AI-generated command text or external images are used.

Regenerate from the repository root with Node.js 24+ and Git:

```sh
npm run build
node scripts/capture-demo.mjs
node scripts/render-demo.mjs
```

Files:

- `pausepin-focus.svg`: start a task, park a tangent, and pause.
- `pausepin-resume.svg`: recover context and notice a Git change.
- `pausepin-finish.svg`: retrieve ideas, mark completion, and check status.
- `demo-transcript.txt`: accessible plain-text version of every illustrated command and response.
- `demo-session.json`: fictional captured output used by the renderer.
- `manifest.json`: asset dimensions and source information.

Completion in the demo is the fictional user's decision. Pausepin does not run tests or verify the finish condition.
