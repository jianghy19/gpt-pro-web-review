# GPT Pro Web Review

[中文安装与配置说明](README.zh-CN.md)

Chrome-backed local plugin for using ChatGPT web Pro mode as a read-only project reviewer.

This plugin prepares a local review bundle, uploads it to a fixed ChatGPT Project in Chrome, extracts the final review, and saves artifacts under:

```text
~/.codex/gpt-review/
```

Each review creates a new conversation in the fixed ChatGPT Project by default.
The first message includes a stable `Conversation identity`, work location,
topic, subtopic, and run id for human recognition. Local registry entries remain
available for audit and explicit advanced reuse only; ChatGPT sidebar renaming
is optional and is not used for routing.

Default behavior:

- ChatGPT Project routing:
  - all paths -> the configured default Project
  - fixed URL -> `https://chatgpt.com/g/g-p-your-project/project`
- Project selection uses the fixed `default` ChatGPT Project URL, not sidebar title search.
- ChatGPT mode label: `进阶专业`
- non-default Project URLs: fail closed unless `--allow-non-codex-project` is passed after explicit user confirmation
- conversation policy: `new_per_run`
- global Chrome operation slots: `5`
- batch concurrency: `5`
- maximum concurrency: `6`
- remote ChatGPT files: retained as archive
- local upload zip: deleted after confirmed submit, not merely confirmed upload
- same `session_root` in the same fixed ChatGPT Project: creates independent new conversations by default
- different topics/projects: parallel browser tabs
- all projects create new conversations in the `default` ChatGPT Project by default; put current task labels in `--topic` or `--subtopic`
- Pro thinking UI: used only as a progress signal; raw hidden reasoning is not archived
- long reviews: use watch slices plus `resumeGptProReview` instead of one blocking wait; resume first claims any existing tab with the same `/c/<conversation-id>` before opening a new tab
- active generation: never stop/cancel a GPT Pro generation automatically. If the page says `Pro 思考中`, `generating`, or `正在整理答案`, wait, detach, or resume later unless the user explicitly asks to interrupt it
- detached reviews: the runner closes the submitted tab by default after a real `/c/...` conversation and generation/submit state are confirmed
- multi-round reviews: pass `--keep-open` only when you intentionally want the submitted tab left open for manual watching or continuation
- submit safety: keyboard `Enter` fallback is disabled by default; use `--allow-enter-submit` only during supervised diagnostics
- conversation renaming: disabled by default because ChatGPT attachment cards can expose similar option controls; pass `--auto-rename` only when you explicitly want a best-effort sidebar rename
- manual adopt: use `--adopt-url` to attach an existing ChatGPT `/c/...` conversation to the local registry; it is used only with `--reuse-existing`
- result extraction: response must match the run topic or run id before it is accepted
- browser control: use the Codex `Chrome` plugin / trusted Chrome runtime first. `Computer Use` is disabled by default; if the runner returns `chrome_handoff_required`, report that state and use `Computer Use` only after explicit user approval in the current thread
- plugin maintenance boundary: ordinary project/workstream review threads must not edit `<plugin-root>`; they must log plugin bugs and stop. Only an explicit plugin-maintenance/root thread should patch and test the plugin

Use:

```bash
gpt-review --doctor
gpt-review --repair-install
gpt-review --keep-open --topic my_project --subtopic round1 "Review this plan"
gpt-review --log-issue /absolute/run/dir --issue "Chrome runner could not open file chooser"
gpt-review --list-issues 20
```

This plugin is a Codex skill plus the `gpt-review` CLI, not an MCP tool. If a
new Codex thread does not list it as a callable tool, run `gpt-review --doctor`.
If the skill or marketplace entry is missing, run `gpt-review --repair-install`.

Call from the relevant project/workstream or pass the bundle directory with
`--project-root`; the CLI separates `bundle_root` from `session_root` for local
labels and run metadata, but all default uploads route to the same configured default
ChatGPT Project. By default, every run creates a new ChatGPT conversation, even
inside the same `session_root`. `--topic` and `--subtopic` are current task
labels. `--fresh` is retained for compatibility and is effectively the default.

Fixed project routing:

```text
all paths -> https://chatgpt.com/g/g-p-your-project/project
```

Registry entries record both `session_root` and `project_url`, but default runs
do not consume registry URLs. A stale conversation from a different Project,
such as older custom Project entries, is not
opened by default. Non-default Project URLs are rejected unless the user has
explicitly approved a one-off override with `--allow-non-codex-project`.

To reuse an existing ChatGPT conversation that was created manually or by an
older plugin run, adopt its URL once and then pass `--reuse-existing`:

```bash
gpt-review --adopt-url "https://chatgpt.com/g/.../c/..." \
  --project-root /absolute/project-or-workstream \
  --topic stable_topic \
  --title "optional human title"
```

`--adopt-url` only writes `~/.codex/gpt-review/registry/`; it does not open
Chrome, upload files, or send a prompt. The adopted URL must belong to the
resolved fixed Project. Future runs use that saved `/c/...` only when
`--reuse-existing` is passed. Check the active mapping with:

```bash
gpt-review --resume --project-root /absolute/project-or-workstream --topic stable_topic
gpt-review --list
```

Then run the Chrome runner from Codex:

```js
const runnerPath = `file://${nodeRepl.homeDir}/plugins/gpt-pro-web-review/scripts/gpt_chrome_runner.mjs`;
const { runGptProReview } = await import(runnerPath);
await runGptProReview({ runDir: "/absolute/run/dir" });
```

Routine submit/resume/extraction should stay inside the Chrome runner. Resume
first claims any existing tab with the same `/c/<conversation-id>` and only
opens a new tab when no matching tab exists. If a run needs desktop
intervention, report the `chrome_handoff_required` state first; do the narrow
manual action only after explicit user approval, then return to
`resumeGptProReview`.

## Plugin bug handoff

Do not patch this global plugin from an ordinary project/workstream review
thread. A thread that is trying to review figures, manuscripts, or workstream
plans should not modify `<plugin-root>` or synced
skill/cache copies.

When a plugin bug appears, record a handoff entry and stop:

```bash
gpt-review --log-issue /absolute/run/dir --issue "short, concrete failure summary"
```

The issue log is:

```text
~/.codex/gpt-review/plugin_issue_log.jsonl
```

Maintenance/root threads can inspect it with:

```bash
gpt-review --list-issues 20
```

Each JSONL entry includes runDir, state, project, conversation URL, error,
upload flags, whether response/partial output exists, and the policy boundary.

Finish:

```bash
gpt-review --finalize /absolute/run/dir
```
