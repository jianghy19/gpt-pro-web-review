# GPT Pro Web Review

Chrome-backed local plugin for using ChatGPT web Pro mode as a read-only project reviewer from Codex.

This plugin prepares a local review bundle, uploads it to a configured ChatGPT Project in Chrome, extracts the final visible review, and saves local artifacts under:

```text
~/.codex/gpt-review/
```

## Install

```bash
git clone https://github.com/jianghy19/gpt-pro-web-review.git ~/plugins/gpt-pro-web-review
python3 ~/plugins/gpt-pro-web-review/scripts/gpt_review.py --repair-install
gpt-review --doctor
```

The plugin requires:

- Codex Desktop with the Chrome plugin/runtime available.
- Chrome signed in to an account that can use the requested ChatGPT web review mode.
- A ChatGPT Project URL configured by the user.

## Configure

Create `~/.codex/gpt-review/config.json`:

```json
{
  "default_project_name": "My Review Project",
  "default_project_key": "my_review_project",
  "default_project_url": "https://chatgpt.com/g/g-p-your-project/project",
  "mode_label": "进阶专业",
  "default_concurrency": 5,
  "max_concurrency": 6,
  "project_routes": [
    {
      "path_prefix": "~/projects/my-important-project",
      "project_name": "My Important Project",
      "project_key": "my_important_project",
      "project_url": "https://chatgpt.com/g/g-p-your-other-project/project"
    }
  ]
}
```

The placeholder project URLs must be replaced with real ChatGPT Project URLs from the user's own account.

## Use

Prepare a review run:

```bash
gpt-review --topic my_project --subtopic round1 "Review this plan"
```

Then run the Chrome runner from Codex:

```js
const runnerPath = `file://${nodeRepl.homeDir}/plugins/gpt-pro-web-review/scripts/gpt_chrome_runner.mjs`;
const { runGptProReview } = await import(runnerPath);
await runGptProReview({ runDir: "/absolute/run/dir" });
```

Finalize after ChatGPT returns the visible review:

```bash
gpt-review --finalize /absolute/run/dir
```

Useful commands:

```bash
gpt-review --doctor
gpt-review --show last
gpt-review --list
gpt-review --resume --topic my_project
gpt-review --clean --days 30
```

## Notes

- This is a Codex skill plus the `gpt-review` CLI, not an MCP tool.
- The plugin does not inspect cookies, localStorage, session tokens, passwords, or browser profile stores.
- Uploaded ChatGPT Project files are retained remotely as a review archive.
- Local `upload_bundle.zip` files are deleted only after submit success is visibly confirmed.
- GPT Pro output is advisory; Codex remains responsible for final decisions and file edits.
