# GPT Pro Web Review 中文说明

这是一个给 Codex Desktop 使用的本地插件。它会把本地项目整理成审查包，通过 Chrome 里的 ChatGPT 网页版上传到你配置的 ChatGPT Project，然后把最终可见回答保存回本地。

它不是 OpenAI API wrapper，也不是独立浏览器自动化工具。正常使用路径是：

```text
gpt-review CLI 生成本地 run -> Codex Chrome runtime 提交到 ChatGPT -> gpt-review finalize 整理结果
```

## 一、前置条件

你需要先准备好：

- 已安装 Codex Desktop，并且可使用 Codex 的 Chrome 插件/runtime。
- Chrome 已登录 ChatGPT，账号能使用目标 Project 和所需模式。
- 你有一个 ChatGPT Project URL，形如：

```text
https://chatgpt.com/g/g-p-your-project/project
```

不要把 cookies、localStorage、session token、密码或浏览器 profile 文件交给本插件。本插件也不需要读取这些内容。

## 二、安装插件

建议放在本地插件目录，例如：

```bash
mkdir -p ~/plugins
git clone https://github.com/jianghy19/gpt-pro-web-review.git ~/plugins/gpt-pro-web-review
cd ~/plugins/gpt-pro-web-review
python3 scripts/gpt_review.py --repair-install
gpt-review --doctor
```

`--repair-install` 会安装/修复：

- `gpt-review` 命令入口
- Codex skill 副本
- 本地 plugin cache/marketplace 记录

如果 `gpt-review --doctor` 能看到 `current_project_url`、`chrome_runner`、`trusted_chrome_runtime` 等信息，说明本地命令侧基本可用。

## 三、配置 ChatGPT Project

先创建配置目录：

```bash
mkdir -p ~/.codex/gpt-review
cp ~/plugins/gpt-pro-web-review/config.example.json ~/.codex/gpt-review/config.json
```

然后编辑：

```bash
nano ~/.codex/gpt-review/config.json
```

示例：

```json
{
  "default_project_name": "My Review Project",
  "default_project_key": "my_review_project",
  "default_project_url": "https://chatgpt.com/g/g-p-your-project/project",
  "mode_label": "进阶专业",
  "default_concurrency": 5,
  "max_concurrency": 6
}
```

需要替换的是：

| 字段 | 说明 |
|---|---|
| `default_project_name` | 你给这个 ChatGPT Project 起的本地显示名 |
| `default_project_key` | 本地状态用的短 key，只用英文、数字、下划线较稳 |
| `default_project_url` | 你的真实 ChatGPT Project URL |
| `mode_label` | ChatGPT 页面里的模式标签，默认 `进阶专业` |

配置好后再运行：

```bash
gpt-review --doctor
```

确认输出里的 `current_project_url` 已变成你的 Project URL。

## 四、准备一次审查

在要审查的项目目录里运行：

```bash
gpt-review --topic my_project --subtopic round1 "Review this project plan"
```

或者显式指定项目目录：

```bash
gpt-review --project-root /absolute/path/to/project --topic my_project "Review this project"
```

命令会在下面生成一个 run 目录：

```text
~/.codex/gpt-review/runs/
```

里面包含：

- `review_packet.md`
- `bundle_manifest.json`
- `upload_bundle.zip`
- `status.json`

## 五、通过 Chrome 提交到 ChatGPT

在 Codex 里用 Node REPL / Chrome runtime 执行：

```js
const runnerPath = `file://${nodeRepl.homeDir}/plugins/gpt-pro-web-review/scripts/gpt_chrome_runner.mjs`;
const { runGptProReview } = await import(runnerPath);
await runGptProReview({ runDir: "/absolute/run/dir" });
```

把 `/absolute/run/dir` 换成上一步生成的 run 目录。

默认行为：

- 在配置的 ChatGPT Project 里新建一个 conversation。
- 上传 `upload_bundle.zip`。
- 选择/确认 `mode_label`。
- 提交 prompt。
- 如果成功完成，会抽取最终可见回答并关闭成功页面。
- 登录、验证码、模式不可确认、上传失败、抽取失败等情况会保留页面并写入状态，方便人工接管。

## 六、整理结果

ChatGPT 完成后运行：

```bash
gpt-review --finalize /absolute/run/dir
```

查看最近结果：

```bash
gpt-review --show last
```

常用状态文件：

```text
status.json
response.md
response.partial.md
conversation.json
```

## 七、断点恢复和人工导入

如果页面还在生成，不要停止它。后续可以 resume 同一个 run：

```bash
gpt-review --resume --topic my_project
```

如果 runner 返回 `resume_tab_missing`，说明原 conversation tab 没有打开。默认策略是失败并提示，不自动新开重复页面。你需要先手动打开原 `/c/...` 页面，再重试恢复。

如果 Chrome runtime 无法抽取最终回答，可以把 ChatGPT 最终可见回答保存成普通文本文件，然后导入：

```bash
gpt-review --import-response /absolute/run/dir --from-file /absolute/checked_gpt_response.txt
gpt-review --finalize /absolute/run/dir
```

不建议用系统剪贴板、AppleScript 或 Computer Use 作为默认抽取方式。

## 八、安全边界

默认安全策略：

- 不读取 cookies、localStorage、session token、密码或浏览器 profile。
- 不默认使用 Computer Use。
- 不点击 Stop/Cancel 中断正在生成的 GPT Pro 回答。
- 不自动新开一个已有 run 的重复 conversation。
- 上传包会排除 `.git`、依赖目录、缓存、大型原始数据、浏览器/profile 数据和常见 secret 文件。
- 高置信 secret，例如私钥、`sk-...`、GitHub token、bearer token，会阻止打包。

GPT Pro 的输出是外部审查意见。最终是否采纳，仍需要你或 Codex 根据本地文件和项目规则判断。

## 九、常用命令

```bash
gpt-review --doctor
gpt-review --repair-install
gpt-review --topic my_project "Review this plan"
gpt-review --detach --topic my_project "Submit and extract later"
gpt-review --keep-open --topic my_project "Keep the page open after success"
gpt-review --resume --topic my_project
gpt-review --finalize /absolute/run/dir
gpt-review --show last
gpt-review --list
gpt-review --clean --days 30
```

遇到插件问题时，记录维护日志：

```bash
gpt-review --log-issue /absolute/run/dir --issue "short concrete failure summary"
gpt-review --list-issues 20
```

