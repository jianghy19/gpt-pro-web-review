---
name: gpt-pro-web-review
description: Use when the user asks for GPT Pro, GPT-5.5 Pro, ChatGPT web, or Chrome-backed major project review, especially for uploading a local review bundle to ChatGPT Project and extracting a read-only review.
---

# GPT Pro Web Review

Use ChatGPT web through Chrome as a read-only major-project reviewer. This skill is for high-context review, not execution. Codex remains responsible for final decisions, file edits, Git, server work, and user-facing synthesis.

## Safety Rules

- Use Chrome only. Do not use the desktop ChatGPT app or the Codex in-app browser for this workflow.
- Use the `Chrome` plugin / trusted Chrome runtime for routine navigation, upload, submit, resume, extraction, tab claiming, screenshots, and cleanup. Do not use `Computer Use` for normal GPT Pro review operation.
- Use `Computer Use` only as a last-resort manual handoff when the Chrome plugin cannot communicate with Chrome, a required page state cannot be reached or inspected through the Chrome runtime, or the user explicitly asks for desktop intervention. State the fallback reason before using it.
- Do not inspect cookies, localStorage, session tokens, passwords, browser profile stores, or ChatGPT account internals.
- Treat each `gpt-review` invocation as user approval to upload the generated bundle to ChatGPT web unless the user explicitly asks for `--dry-run`.
- Remote ChatGPT Project files are retained as review archive. Local temporary `upload_bundle.zip` is deleted only after submit success is visibly confirmed, not merely after upload confirmation.
- Default mode is the ChatGPT UI label `进阶专业`. If that mode cannot be selected or confirmed, stop and keep the tab for handoff. Do not silently downgrade.
- GPT Pro is advisory only. Do not blindly adopt its suggestions; evaluate against local files, project rules, and evidence.
- ChatGPT may show an expandable `思考` / thinking area during Pro work. Treat it only as a progress signal. Do not copy, store, summarize, or quote raw hidden reasoning; save only final visible review output and coarse status flags such as `thinking_visible`.

## Browser Control Policy

- Primary control path: `Chrome` plugin -> trusted Chrome runtime -> `gpt_chrome_runner.mjs`.
- For an already-open ChatGPT tab, prefer Chrome tab discovery/claiming through the Chrome plugin. Do not switch to desktop clicking just to find, send, resume, or extract a normal run.
- If the Chrome runtime fails, first use Chrome-plugin diagnostics and preserved handoff tabs. Use `Computer Use` only when Chrome-plugin controls cannot complete the required handoff.
- When `Computer Use` is used, keep it narrow: identify the stuck page state or perform the single needed manual action, then return to Chrome runner/resume for extraction and cleanup.

## Quick Workflow

This plugin is a Codex skill plus the `gpt-review` CLI, not an MCP tool. In a
new thread, do not conclude the plugin is unavailable just because no callable
MCP tool appears. Check:

```bash
gpt-review --doctor
gpt-review --repair-install
```

1. Prepare a run packet:

```bash
gpt-review --topic TOPIC --project-root /absolute/project "Review this plan"
```

2. Run Chrome automation through the trusted Chrome runtime:

```js
const runnerPath = `file://${nodeRepl.homeDir}/plugins/gpt-pro-web-review/scripts/gpt_chrome_runner.mjs`;
const { runGptProReview } = await import(runnerPath);
await runGptProReview({ runDir: "/absolute/run/dir" });
```

3. Finalize artifacts:

```bash
gpt-review --finalize /absolute/run/dir
```

4. Summarize `response.md`, `review_packet.md`, and `meta.json` for the user. Label the output as `GPT Pro web review`, not as an official OpenAI API result.

## Commands

```bash
gpt-review "审查这个项目方案"
gpt-review --topic fig3 --subtopic stage105 "审查 Fig.3 主图"
gpt-review --mode independent-plan --topic manuscript_review --packet facts.md "先独立提出方案"
gpt-review --mode final-review --topic manuscript_review --packet synthesis.md "最终复审"
gpt-review --detach --topic project_policy "提交后我稍后再取结果"
gpt-review --keep-open --topic figure_review --subtopic round2 "继续多轮审查，暂时保留页面"
gpt-review --reuse-existing --topic figure_review "显式复用已 adopted 的旧对话"
gpt-review --resume --topic project_policy
gpt-review --adopt-url "https://chatgpt.com/g/.../c/..." --project-root /absolute/workstream --topic figure_review --title "optional human title"
gpt-review --show last
gpt-review --list
gpt-review --doctor
gpt-review --clean --days 30
```

## Context And Session Policy

- Saved state is outside project repos under `~/.codex/gpt-review/`.
- Fixed ChatGPT Project routing is used before sidebar name search:
  - configure `default_project_url` in `~/.codex/gpt-review/config.json`;
  - optionally add `project_routes` for path-specific ChatGPT Projects;
  - pass `--project-url` only for an explicit one-off override.
- Session identity is file-backed by `session_root`, but default submissions do not reuse conversations. The uploaded bundle root can differ from the session root.
- Use `--topic` or `--subtopic` for the current small task; they label the prompt and extraction checks but do not cause reuse by default.
- Use `--fresh` only as a compatibility no-op; creating a clean conversation is already the default.
- Conversation reuse is disabled by default. Use `--reuse-existing` only when the user explicitly wants to append to an adopted/registry `/c/...` conversation.
- If an existing suitable ChatGPT conversation must be reused, run `gpt-review --adopt-url ... --project-root ... --topic ...` once, then pass `--reuse-existing` on the review run. The URL must belong to the resolved fixed Project.
- The first message still includes a stable `Conversation identity`, work location, stable topic, subtopic, and run id so humans can recognize the thread.

Example workstream topics:

| Work area | Stable topic |
|---|---|
| analysis | `example_analysis` |
| figures | `example_figures` |
| experiments | `example_experiments` |
| literature | `example_literature` |

## Parallel Review

- Default Chrome operation slots are 5. Multiple projects can queue concurrently, with up to five runner operations uploading/submitting/extracting at the same time.
- Default batch concurrency is 5 and configurable to 6.
- Different `session_root` runs may open separate ChatGPT tabs in parallel.
- The same `session_root` may run multiple new-conversation reviews in parallel. Only `--reuse-existing` uses a session/registry lock to prevent concurrent writes into one conversation.
- Successful tabs are closed after extraction unless `--keep-open` is set for an ongoing multi-round review. `--detach` also closes the submitted tab by default after a real `/c/...` conversation and generation/submit state are confirmed; pass `--keep-open` only when the user wants to watch or manually continue the page.
- Login, CAPTCHA, upload, mode, extraction, and timeout handoff tabs are preserved. Submitted detach tabs are not preserved unless `--keep-open` is set.
- Conversation renaming is disabled by default to avoid mis-clicking ChatGPT attachment/file controls that can trigger `upload_bundle.zip` downloads or save dialogs. Use `--auto-rename` only for a best-effort sidebar rename. Even without it, every first prompt starts with the stable conversation identity for human recognition.
- Keyboard `Enter` submit fallback is disabled by default. The runner must find a safe send button; otherwise it fails closed instead of risking file-card download/save dialogs. Use `--allow-enter-submit` only for a supervised diagnostic run.
- Long Pro reviews should use sliced watch/resume behavior rather than one uninterrupted wait. If a run times out while still generating, resume the same run later instead of starting a new topic.
- Extraction accepts a response only when it matches the run topic or run id. Avoid using the default topic for serious work; pass a stable project topic and a current subtopic.

## Bundle Policy

- The uploaded zip contains a generated review packet, manifest, selected text/code/table/figure files, and explicit exclusion reports.
- Always exclude `.git`, dependency folders, raw data, large binary/matrix/model files, caches, browser/profile data, and known secret files.
- A lightweight content scan blocks high-confidence secrets such as private keys, `sk-...` API keys, GitHub tokens, or bearer tokens.
- Low-confidence private text is recorded but does not automatically block, because the user has explicitly chosen full-auto project review.

## Review Prompt Policy

The prompt must tell GPT Pro:

- uploaded bundle is the authoritative current state;
- older files/chats in the ChatGPT Project are historical only;
- GPT is read-only and must not ask to modify files itself;
- output should include Blockers, Important findings, Optional comments, Direct answer, and Review State;
- for important decisions, provide independent alternatives and evidence gaps, not agreement-seeking comments.
- provide its review as final visible text. Do not rely on hidden thinking content as the deliverable.

## Figure Review

For image-heavy work, Codex should inspect images first and include a structured visual packet with paths, dimensions, panel map, visible text, overlap/cropping/alignment observations, color/legend concerns, and claim ceiling. GPT Pro reviews the packet and uploaded figures; Codex still performs the final visual QA.
