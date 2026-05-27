---
name: gpt-pro-web-review
description: Use when the user asks for GPT Pro, GPT-5.5 Pro, ChatGPT web, or Chrome-backed major project review, especially for uploading a local review bundle to ChatGPT Project and extracting a read-only review.
---

# GPT Pro Web Review

Use ChatGPT web through Chrome as a read-only major-project reviewer. This skill is for high-context review, not execution. Codex remains responsible for final decisions, file edits, Git, server work, and user-facing synthesis.

## Safety Rules

- Use Chrome only. Do not use the desktop ChatGPT app or the Codex in-app browser for this workflow.
- Do not modify this plugin's code from ordinary project/workstream review threads. Only a thread explicitly opened for GPT Pro plugin maintenance may edit files under `<plugin-root>` or its synced skill/cache copies.
- If a project/workstream thread hits a plugin bug, stop at handoff: record the runDir, status, page state, and error with `gpt-review --log-issue RUN_DIR --issue "short summary"`. Do not patch the plugin inline to continue that review.
- Use the `Chrome` plugin / trusted Chrome runtime for routine navigation, upload, submit, resume, extraction, tab claiming, screenshots, and cleanup. Do not use `Computer Use` for normal GPT Pro review operation.
- Computer Use is disabled by default for this workflow. If the Chrome runner returns `chrome_handoff_required`, stop and report the handoff state; use `Computer Use` only after explicit user approval in the current thread. State the fallback reason before using it.
- Prompt entry may write the generated prompt to the browser clipboard as an input fallback when direct DOM fill fails. This is not an extraction path: result recovery must not read the system clipboard, use AppleScript scraping, or default to Computer Use.
- Do not inspect cookies, localStorage, session tokens, passwords, browser profile stores, or ChatGPT account internals.
- Treat each `gpt-review` invocation as user approval to upload the generated bundle to ChatGPT web unless the user explicitly asks for `--dry-run`.
- All default uploads go to the fixed ChatGPT `default` Project: `https://chatgpt.com/g/g-p-your-project/project`. Do not route example_project or other projects to separate ChatGPT Projects by default.
- Remote ChatGPT Project files are retained as review archive. Local temporary `upload_bundle.zip` is deleted only after submit success is visibly confirmed, not merely after upload confirmation.
- Default mode is the ChatGPT UI label `进阶专业`. If that mode cannot be selected or confirmed, stop and keep the tab for handoff. Do not silently downgrade.
- GPT Pro is advisory only. Do not blindly adopt its suggestions; evaluate against local files, project rules, and evidence.
- ChatGPT may show an expandable `思考` / thinking area during Pro work. Treat it only as a progress signal. Do not copy, store, summarize, or quote raw hidden reasoning; save only final visible review output and coarse status flags such as `thinking_visible`.
- Never stop an active GPT Pro generation automatically. If the page is `generating`, `Pro 思考中`, or `正在整理答案`, wait in bounded slices, detach, or resume later. Do not click Stop/Cancel and do not ask for a compressed/final answer in the same conversation until the current generation finishes, unless the user explicitly says to interrupt it.

## Browser Control Policy

- Primary control path: `Chrome` plugin -> trusted Chrome runtime -> `gpt_chrome_runner.mjs`.
- For an already-open ChatGPT tab, prefer Chrome tab discovery/claiming through the Chrome plugin. Do not switch to desktop clicking just to find, send, resume, or extract a normal run.
- Resume is strict by default. If a run already has a ChatGPT `/c/...` conversation URL, the runner may claim only an already-open tab for that same conversation. If no matching tab is open, it returns `resume_tab_missing` and must not open a duplicate conversation tab unless a future explicit supervised option is added.
- If an original conversation tab is open but normal resume/extraction fails, use the Chrome-runtime read-only extraction path for the saved run. If that still cannot extract final visible text, use `gpt-review --import-response RUN_DIR --from-file PATH` with a checked text file. Do not use AppleScript, clipboard scraping, or Computer Use as the default fallback.
- Each GPT run uses a per-run Chrome session name before creating tabs, so GPT review tabs do not drift into OpenEvidence or unrelated Chrome tab groups.
- If the Chrome runtime fails, first use Chrome-plugin diagnostics and preserved handoff tabs. Do not escalate to `Computer Use` automatically.
- When the user explicitly approves `Computer Use`, keep it narrow: identify the stuck page state or perform the single needed manual action, then return to Chrome runner/resume for extraction and cleanup.

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
gpt-review --mode independent-plan --topic example_single_cell --packet facts.md "先独立提出方案"
gpt-review --mode final-review --topic example_single_cell --packet synthesis.md "最终复审"
gpt-review --detach --topic example_root_policy "提交后我稍后再取结果"
gpt-review --keep-open --topic example_eit --subtopic round2 "继续多轮审查，暂时保留页面"
gpt-review --reuse-existing --topic example_eit "显式复用已 adopted 的旧对话"
gpt-review --resume --topic example_root_policy
gpt-review --adopt-url "https://chatgpt.com/g/.../c/..." --project-root /absolute/workstream --topic example_eit --title "optional human title"
gpt-review --import-response /absolute/run/dir --from-file /absolute/checked_gpt_response.txt
gpt-review --show last
gpt-review --list
gpt-review --log-issue /absolute/run/dir --issue "Chrome runner could not open file chooser"
gpt-review --list-issues 20
gpt-review --doctor
gpt-review --clean --days 30
```

## Plugin Bug Handoff

Ordinary project threads must not edit the plugin. When the runner fails due to
UI drift, Chrome runtime state, upload controls, mode selection, extraction, or
tab cleanup, log the issue and stop:

```bash
gpt-review --log-issue /absolute/run/dir --issue "short, concrete failure summary"
```

The maintenance log is:

```text
~/.codex/gpt-review/plugin_issue_log.jsonl
```

Plugin-maintenance/root threads can inspect recent entries with:

```bash
gpt-review --list-issues 20
```

Each entry records the runDir, state, project, conversation URL, error, upload
flags, response/partial presence, and the policy that non-maintenance threads
must not modify plugin code.

## Context And Session Policy

- Saved state is outside project repos under `~/.codex/gpt-review/`.
- Fixed ChatGPT Project routing is used before sidebar name search:
  - all paths -> the configured default Project
  - fixed URL -> `https://chatgpt.com/g/g-p-your-project/project`
  - non-default `--project-url` is fail-closed unless the user explicitly approved `--allow-non-codex-project`.
- Session identity is file-backed by `session_root`, but default submissions do not reuse conversations. The uploaded bundle root can differ from the session root.
- For `example_project` and every other project, new conversations are created in the `default` ChatGPT Project by default. Temporary `review_queue/gpt_*` bundles still keep local workstream labels in status metadata, but do not change ChatGPT Project routing.
- Use `--topic` or `--subtopic` for the current small task; they label the prompt and extraction checks but do not cause reuse by default.
- Use `--fresh` only as a compatibility no-op; creating a clean conversation is already the default.
- Conversation reuse is disabled by default. Use `--reuse-existing` only when the user explicitly wants to append to an adopted/registry `/c/...` conversation.
- If an existing suitable ChatGPT conversation must be reused, run `gpt-review --adopt-url ... --project-root ... --topic ...` once, then pass `--reuse-existing` on the review run. The URL must belong to the resolved fixed Project.
- The first message still includes a stable `Conversation identity`, work location, stable topic, subtopic, and run id so humans can recognize the thread.

Default `example_project` workstream topics:

| Work area | Stable topic |
|---|---|
| EIT | `example_eit` |
| Fig.1 / other_experiment | `example_other_experiment` |
| flow cytometry | `example_flow_cytometry` |
| transcriptome | `example_transcriptome` |
| single-cell | `example_single_cell` |
| cross-omics | `example_cross_omics` |

## Parallel Review

- Default Chrome operation slots are 5. Multiple projects can queue concurrently, with up to five runner operations uploading/submitting/extracting at the same time.
- Default batch concurrency is 5 and configurable to 6.
- Different `session_root` runs may open separate ChatGPT tabs in parallel.
- The same `session_root` may run multiple new-conversation reviews in parallel. Only `--reuse-existing` uses a session/registry lock to prevent concurrent writes into one conversation.
- Successful tabs are closed after extraction unless `--keep-open` is set for an ongoing multi-round review. `--detach` also closes the submitted tab by default after a real `/c/...` conversation and generation/submit state are confirmed; pass `--keep-open` only when the user wants to watch or manually continue the page.
- Login, CAPTCHA, upload, mode, extraction, and timeout handoff tabs are preserved. Submitted detach tabs are not preserved unless `--keep-open` is set.
- Conversation renaming is disabled by default to avoid mis-clicking ChatGPT attachment/file controls that can trigger `upload_bundle.zip` downloads or save dialogs. Use `--auto-rename` only for a best-effort sidebar rename. Even without it, every first prompt starts with the stable conversation identity for human recognition.
- Keyboard `Enter` submit fallback is disabled by default. The runner must find a safe send button; otherwise it fails closed instead of risking file-card download/save dialogs. Use `--allow-enter-submit` only for a supervised diagnostic run.
- Long Pro reviews should use sliced watch/resume behavior rather than one uninterrupted wait. If a run times out while still generating, resume the same run later instead of starting a new topic. Resume must first claim an existing tab with the same `/c/<conversation-id>` through Chrome runtime. If no matching tab is open, the runner fails closed with `resume_tab_missing`; reopen the original page manually before retrying. If a matching original tab is open but extraction fails, use read-only extraction or `--import-response`; do not switch to Computer Use without explicit current-thread approval. Do not interrupt or stop a generating GPT response.
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
