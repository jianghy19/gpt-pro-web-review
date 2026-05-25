import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CHROME_PLUGIN_ROOT = path.join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "chrome");
const ENV = typeof process === "undefined" ? {} : process.env;
const STATE_ROOT = ENV.GPT_REVIEW_STATE_ROOT || path.join(homedir(), ".codex", "gpt-review");
const LOCK_ROOT = path.join(STATE_ROOT, "locks");
const CHATGPT_URL = "https://chatgpt.com/";
const DEFAULT_PROJECT_NAME = "your ChatGPT Project";
const DEFAULT_PROJECT_URL = "https://chatgpt.com/g/g-p-your-project/project";
const DEFAULT_MODE_LABEL = "进阶专业";
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 6;
const DEFAULT_CHROME_OPERATION_SLOTS = 5;
const DONE_STABLE_CHECKS = 3;
const QUICK_DONE_MIN_CHARS = 300;
const QUICK_DONE_AFTER_MS = 20 * 1000;
const DEFAULT_WATCH_SLICE_MS = 75 * 1000;
const WATCH_TIMEOUT_MS = 45 * 60 * 1000;
const LOCK_STALE_MS = 75 * 1000;
const LOCK_ORPHAN_MS = 5 * 1000;
const LOCK_HEARTBEAT_MS = 15 * 1000;
const RUNTIME_INSTANCE_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const SECRET_KEY_RE =
  /(^|[_-])(token|api[_-]?key|authorization|auth[_-]?token|secret|password|credential|cookie|csrf|bearer)([_-]|$)|(^|[_-])session([_-]?(id|token|cookie|secret|key))([_-]|$)/i;
const HANDOFF_STATUSES = new Set([
  "login_required",
  "human_verification_required",
  "project_not_found",
  "mode_unavailable",
  "upload_failed",
  "submit_failed",
  "submit_pending_conversation_url",
  "submit_button_unavailable",
  "project_mismatch",
  "extract_failed",
  "detached",
  "kept_open",
  "tab_lost",
  "timeout",
  "error",
]);

const CHATGPT_FILE_CONTENT_RE =
  /chatgpt\.com\/backend-api\/estuary\/content|backend-api\/estuary\/content|download|save|upload|attach|remove|delete|cancel|下载|保存|上传|附件|添加|移除|删除|取消|\.zip|upload_bundle|file_/i;
const CHATGPT_FILE_DOWNLOAD_RE =
  /chatgpt\.com\/backend-api\/estuary\/content|backend-api\/estuary\/content|download|save|下载|保存|\.zip|upload_bundle|file_/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeText(text) {
  return String(text || "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
    .replace(
      /(token|api[_-]?key|auth|secret|password|credential|cookie|session)\s*[:=]\s*['"]?[^'"\s]+/gi,
      (_match, key) => `${key}=<redacted>`,
    )
    .replace(/bearer\s+[A-Za-z0-9._-]{12,}/gi, "bearer <redacted>")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "<redacted>")
    .replace(/(?<![A-Za-z0-9_-])[A-Fa-f0-9]{32,}(?![A-Za-z0-9_-])/g, "<redacted>");
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY_RE.test(key) ? "<redacted>" : redactValue(item),
      ]),
    );
  }
  if (typeof value === "string") return sanitizeText(value);
  return value;
}

async function writeJsonAtomic(targetPath, value) {
  const tmpPath = `${targetPath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(redactValue(value), null, 2) + "\n");
  await fs.rename(tmpPath, targetPath);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeStatus(runDir, patch) {
  const statusPath = path.join(runDir, "status.json");
  const current = JSON.parse(await fs.readFile(statusPath, "utf8"));
  const next = {
    ...current,
    ...redactValue(patch),
    updated_at: new Date().toISOString(),
  };
  await writeJsonAtomic(statusPath, next);
  return next;
}

function lockNameForStatus(status) {
  return String(status.run_lock_key || status.registry_key || status.run_id || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function runtimePid() {
  return typeof process === "undefined" ? null : process.pid;
}

function pidAppearsAlive(pid) {
  if (!pid || typeof process === "undefined" || typeof process.kill !== "function") return true;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    return true;
  }
}

async function lockHolderAppearsOrphaned(lockPath) {
  const holder = await readJson(path.join(lockPath, "holder.json")).catch(() => null);
  if (!holder || !holder.pid) return false;
  return !pidAppearsAlive(holder.pid);
}

async function staleOrOrphanLockReason(lockPath, options = {}) {
  const staleMs = options.staleMs || LOCK_STALE_MS;
  const orphanMs = options.orphanMs || LOCK_ORPHAN_MS;
  const holderStat = await fs.stat(path.join(lockPath, "holder.json")).catch(() => null);
  const lockStat = await fs.stat(lockPath).catch(() => null);
  const holderAge = holderStat ? Date.now() - holderStat.mtimeMs : Infinity;
  const lockAge = lockStat ? Date.now() - lockStat.mtimeMs : Infinity;
  if (holderStat && await lockHolderAppearsOrphaned(lockPath)) return "orphaned_pid";
  if (holderStat && holderAge > staleMs) return "stale_heartbeat";
  if (!holderStat && lockStat && lockAge > orphanMs) return "orphaned_empty_lock";
  return "";
}

async function removeLockIfStaleOrOrphaned(lockPath, options = {}) {
  const reason = await staleOrOrphanLockReason(lockPath, options);
  if (!reason) return "";
  await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  return reason;
}

async function writeLockHolder(lockPath, status) {
  await writeJsonAtomic(path.join(lockPath, "holder.json"), {
    run_id: status.run_id,
    run_lock_key: status.run_lock_key,
    registry_key: status.registry_key,
    pid: runtimePid(),
    runtime_instance_id: RUNTIME_INSTANCE_ID,
    heartbeat_at: new Date().toISOString(),
  });
}

async function acquireRunLock(status, options = {}) {
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const staleMs = options.staleMs || LOCK_STALE_MS;
  const orphanMs = options.orphanMs || LOCK_ORPHAN_MS;
  const lockPath = path.join(LOCK_ROOT, `${lockNameForStatus(status)}.chrome.lock`);
  const start = Date.now();
  await fs.mkdir(LOCK_ROOT, { recursive: true });
  while (true) {
    let heartbeat = null;
    try {
      await fs.mkdir(lockPath);
      try {
        await writeLockHolder(lockPath, status);
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      heartbeat = setInterval(() => {
        writeLockHolder(lockPath, status).catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      if (typeof heartbeat.unref === "function") heartbeat.unref();
      return async () => {
        if (heartbeat) clearInterval(heartbeat);
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (await removeLockIfStaleOrOrphaned(lockPath, { staleMs, orphanMs })) {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for GPT review topic lock: ${lockPath}`);
      }
      await sleep(1000);
    }
  }
}

async function acquireChromeOperationSlot(options = {}) {
  const slots = Math.max(1, Math.min(MAX_CONCURRENCY, Number(options.slots || DEFAULT_CHROME_OPERATION_SLOTS)));
  const timeoutMs = options.timeoutMs || 20 * 60 * 1000;
  const staleMs = options.staleMs || LOCK_STALE_MS;
  const orphanMs = options.orphanMs || LOCK_ORPHAN_MS;
  const start = Date.now();
  await fs.mkdir(LOCK_ROOT, { recursive: true });
  while (true) {
    for (let idx = 1; idx <= slots; idx += 1) {
      await removeLockIfStaleOrOrphaned(path.join(LOCK_ROOT, `chrome-operation-slot-${idx}.lock`), { staleMs, orphanMs });
    }
    for (let idx = 1; idx <= slots; idx += 1) {
      const lockPath = path.join(LOCK_ROOT, `chrome-operation-slot-${idx}.lock`);
      let heartbeat = null;
      try {
        await fs.mkdir(lockPath);
        const writeHolder = async () => {
          await writeJsonAtomic(path.join(lockPath, "holder.json"), {
            slot: idx,
            pid: runtimePid(),
            runtime_instance_id: RUNTIME_INSTANCE_ID,
            heartbeat_at: new Date().toISOString(),
          });
        };
        try {
          await writeHolder();
        } catch (error) {
          await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        heartbeat = setInterval(() => {
          writeHolder().catch(() => {});
        }, LOCK_HEARTBEAT_MS);
        if (typeof heartbeat.unref === "function") heartbeat.unref();
        return async () => {
          if (heartbeat) clearInterval(heartbeat);
          await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        };
      } catch (error) {
        if (!error || error.code !== "EEXIST") throw error;
        await removeLockIfStaleOrOrphaned(lockPath, { staleMs, orphanMs });
      }
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for GPT review Chrome operation slot (${slots} slots).`);
    }
    await sleep(1000);
  }
}

async function withRunLock(runDir, worker) {
  const status = await readJson(path.join(runDir, "status.json"));
  const release = await acquireRunLock(status);
  try {
    return await worker(status);
  } finally {
    await release();
  }
}

function chooseConcurrency(items, requested = DEFAULT_CONCURRENCY, maxValue = MAX_CONCURRENCY) {
  const count = Array.isArray(items) ? items.length : Number(items || 0);
  const value = requested === "auto" || requested == null ? DEFAULT_CONCURRENCY : Number(requested);
  const cap = Math.max(1, Math.min(MAX_CONCURRENCY, Number(maxValue) || MAX_CONCURRENCY));
  return Math.max(1, Math.min(cap, count || 1, value || DEFAULT_CONCURRENCY));
}

async function findChromeClient() {
  const entries = await fs.readdir(CHROME_PLUGIN_ROOT, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    const candidate = path.join(CHROME_PLUGIN_ROOT, entry.name, "scripts", "browser-client.mjs");
    try {
      await fs.access(candidate);
      candidates.push(candidate);
    } catch {
      // Ignore non-plugin entries.
    }
  }
  candidates.sort();
  if (!candidates.length) throw new Error("Chrome browser-client.mjs not found.");
  return candidates[candidates.length - 1];
}

async function setupChrome() {
  if (!globalThis.agent) {
    const chromeClient = await findChromeClient();
    const { setupBrowserRuntime } = await import(chromeClient);
    await setupBrowserRuntime({ globals: globalThis });
  }
  const browser = await agent.browsers.get("extension");
  await browser.nameSession("🧠 GPT Pro review");
  return browser;
}

async function visibleText(tab) {
  const text = await tab.playwright.evaluate(() => (document.body ? document.body.innerText : ""));
  return sanitizeText(text).slice(0, 200000);
}

function classifyChatGptPage(text) {
  const lower = String(text || "").toLowerCase();
  if (/(log in|sign up|continue with google|登录|注册|继续使用 google)/.test(lower)) return "login_required";
  if (/(captcha|verify you are human|cloudflare|验证你是真人|人机验证)/.test(lower)) {
    return "human_verification_required";
  }
  if (/(ask anything|message chatgpt|你在忙什么|有什么可以帮忙|进阶专业)/i.test(String(text || ""))) {
    return "ok";
  }
  if (/(something went wrong|network error|try again later|出了点问题|网络错误)/.test(lower)) return "page_error";
  return "ok";
}

function looksLikeMissingConversation(text) {
  return /(conversation (was )?not found|unable to load conversation|not found|找不到.*(聊天|对话)|无法加载.*(聊天|对话)|该(聊天|对话).*不存在|此(聊天|对话).*已删除)/i.test(
    String(text || ""),
  );
}

async function waitForLoad(tab, timeoutMs = 30000) {
  await Promise.allSettled([tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs })]);
  await sleep(1000);
  await installDownloadClickGuard(tab).catch(() => false);
}

function isChatGptFileContentUrl(url) {
  return /chatgpt\.com\/backend-api\/estuary\/content/i.test(String(url || ""));
}

function isDangerousChatGptFileDescriptor(descriptor, uploadBaseName = "") {
  const value = String(descriptor || "");
  if (!value.trim()) return false;
  if (CHATGPT_FILE_DOWNLOAD_RE.test(value)) return true;
  return Boolean(uploadBaseName && value.includes(uploadBaseName));
}

function isTabNotFoundError(error) {
  return /Tab not found|No tab with id|Existing tabs: none/i.test(
    error && error.message ? error.message : String(error || ""),
  );
}

async function installDownloadClickGuard(tab, uploadBaseName = "upload_bundle.zip") {
  await tab.playwright.evaluate((baseName) => {
    const marker = "__codexGptReviewDownloadClickGuardInstalled";
    const base = String(baseName || "upload_bundle.zip");
    window.__codexGptReviewUploadBundleBaseName = base;
    if (window[marker]) return true;
    const riskRe = /chatgpt\.com\/backend-api\/estuary\/content|backend-api\/estuary\/content|download|save|下载|保存|\.zip|upload_bundle|file_/i;
    const candidateText = (el) => {
      if (!el || typeof el.getAttribute !== "function") return "";
      const attrs = ["href", "aria-label", "title", "download", "data-testid"]
        .map((name) => el.getAttribute(name) || "")
        .join("\n");
      const ownText = /^(A|BUTTON|SUMMARY)$/i.test(el.tagName || "") || el.getAttribute("role") === "button"
        ? (el.textContent || "").slice(0, 300)
        : "";
      return `${attrs}\n${ownText}`;
    };
    const isRisky = (target) => {
      let el = target && target.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
      for (let depth = 0; el && el !== document.documentElement && depth < 8; depth += 1, el = el.parentElement) {
        const text = candidateText(el);
        if (riskRe.test(text)) return true;
        if (base && text.includes(base)) return true;
      }
      return false;
    };
    document.addEventListener(
      "click",
      (event) => {
        if (!isRisky(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    window[marker] = true;
    return true;
  }, uploadBaseName, { timeoutMs: 2000 });
  return true;
}

async function goChatGpt(tab) {
  await tab.goto(CHATGPT_URL);
  await waitForLoad(tab);
  const text = await visibleText(tab);
  const state = classifyChatGptPage(text);
  if (state !== "ok") {
    return { ok: false, status: state, text };
  }
  return { ok: true, status: "ok", text };
}

async function openProjectForStatus(tab, status) {
  if (status.project_url) {
    const project = await ensureProject(tab, status.chatgpt_project || DEFAULT_PROJECT_NAME, status.project_url || "");
    return { startup: { ok: true, status: "project_url_direct" }, project };
  }
  const startup = await goChatGpt(tab);
  if (!startup.ok) return { startup, project: null };
  const project = await ensureProject(tab, status.chatgpt_project || DEFAULT_PROJECT_NAME, status.project_url || "");
  return { startup, project };
}

async function clickVisibleText(tab, text, options = {}) {
  const exact = options.exact ?? true;
  const locator = tab.playwright.getByText(text, { exact });
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    try {
      if (await candidate.isVisible()) {
        await candidate.click({ timeoutMs: options.timeoutMs || 5000 });
        return true;
      }
    } catch {
      // Ignore hidden or stale matches.
    }
  }
  return false;
}

async function findProjectHref(tab, projectName = DEFAULT_PROJECT_NAME, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const href = await tab.playwright
      .evaluate((name) => {
        const links = [...document.querySelectorAll('a[href*="/project"]')];
        const match = links.find((link) => {
          const text = (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim();
          return text === name || text.includes(name);
        });
        return match ? match.href : "";
      }, projectName)
      .catch(() => "");
    if (href) return href;
    await sleep(750);
  }
  return "";
}

async function ensureProject(tab, projectName = DEFAULT_PROJECT_NAME, projectUrl = "") {
  if (projectUrl) {
    await tab.goto(projectUrl);
    await waitForLoad(tab, 20000);
    const text = await visibleText(tab);
    const state = classifyChatGptPage(text);
    if (state !== "ok") return { ok: false, status: state, detail: text.slice(0, 2000) };
    const currentUrl = await tab.url();
    if (String(currentUrl || "").includes("/project")) {
      return { ok: true, status: "project_selected_by_url", href: currentUrl };
    }
    return {
      ok: false,
      status: "project_not_found",
      detail: `Fixed ChatGPT Project URL did not resolve to a project page: ${projectUrl}`,
    };
  }
  const href = await findProjectHref(tab, projectName);
  if (href) {
    await tab.goto(href);
    await waitForLoad(tab, 20000);
    return { ok: true, status: "project_selected", href };
  }
  const body = await visibleText(tab);
  if (body.includes(projectName)) {
    if (await clickVisibleText(tab, projectName, { exact: true, timeoutMs: 5000 })) {
      await waitForLoad(tab, 15000);
      const afterUrl = await tab.url();
      const afterText = await visibleText(tab);
      if (String(afterUrl || "").includes("/project") && afterText.includes(projectName)) {
        return { ok: true, status: "project_selected", href: afterUrl };
      }
    }
  }
  const created = await createProject(tab, projectName);
  if (created.ok) return created;
  const observedProjectUrl = await tab.url();
  if (String(observedProjectUrl || "").includes("/g/") || body.includes("项目") || body.includes("Project")) {
    return {
      ok: false,
      status: "project_not_found",
      detail:
        created.detail ||
        `ChatGPT Project "${projectName}" was not visible and could not be created automatically. Open it manually, then resume this run.`,
    };
  }
  return {
    ok: false,
    status: "project_not_found",
    detail: created.detail || `ChatGPT Project "${projectName}" was not visible on the ChatGPT home page.`,
  };
}

async function createProject(tab, projectName = DEFAULT_PROJECT_NAME) {
  try {
    const newProjectButtons = [];
    for (const label of ["新项目", "New project"]) {
      newProjectButtons.push(tab.playwright.getByRole("button", { name: label, exact: false }));
      newProjectButtons.push(tab.playwright.getByText(label, { exact: true }));
    }
    let opened = false;
    for (const locator of newProjectButtons) {
      const count = await locator.count();
      for (let i = 0; i < count; i += 1) {
        const candidate = locator.nth(i);
        try {
          if (await candidate.isVisible()) {
            await candidate.click({ timeoutMs: 5000 });
            opened = true;
            break;
          }
        } catch {
          // Try next candidate.
        }
      }
      if (opened) break;
    }
    if (!opened) return { ok: false, status: "project_not_found", detail: "New project control was not visible." };
    await sleep(800);
    const input = tab.playwright.locator('input, textarea, [role="textbox"]').last();
    await input.fill(projectName, { timeoutMs: 8000 });
    const createButtons = [];
    for (const label of ["创建项目", "Create project", "Create"]) {
      createButtons.push(tab.playwright.getByRole("button", { name: label, exact: false }));
      createButtons.push(tab.playwright.getByText(label, { exact: true }));
    }
    for (const locator of createButtons) {
      const count = await locator.count();
      for (let i = count - 1; i >= 0; i -= 1) {
        const button = locator.nth(i);
        try {
          if ((await button.isVisible()) && (await button.isEnabled())) {
            await button.click({ timeoutMs: 8000 });
            await waitForLoad(tab, 20000);
            await sleep(1500);
            const after = await visibleText(tab);
            const afterUrl = await tab.url();
            if (after.includes(projectName)) return { ok: true, status: "project_created", href: afterUrl };
          }
        } catch {
          // Try next candidate.
        }
      }
    }
    return { ok: false, status: "project_not_found", detail: "Project create dialog opened but submit failed." };
  } catch (error) {
    return {
      ok: false,
      status: "project_not_found",
      detail: `Automatic project creation failed: ${sanitizeText(error && error.message ? error.message : String(error))}`,
    };
  }
}

async function ensureMode(tab, modeLabel = DEFAULT_MODE_LABEL, timeoutMs = 20000) {
  const labels = [modeLabel];
  if (modeLabel === DEFAULT_MODE_LABEL && !labels.includes("深入")) labels.push("深入");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
  const body = await visibleText(tab);
  if (labels.some((label) => body.includes(label))) return { ok: true, status: "mode_present" };
  const possibleButtons = [
    tab.playwright.getByRole("button", { name: /.+/ }),
    tab.playwright.locator("button"),
  ];
  for (const buttons of possibleButtons) {
    const count = await buttons.count();
    for (let i = 0; i < Math.min(count, 30); i += 1) {
      const button = buttons.nth(i);
      try {
        const text = await button.innerText({ timeoutMs: 500 });
        if (!text || !/(模式|mode|thinking|专业|深入|fast|auto|自动)/i.test(text)) continue;
        await button.click({ timeoutMs: 2000 });
        await sleep(700);
        for (const label of labels) {
          if (await clickVisibleText(tab, label, { exact: false, timeoutMs: 4000 })) {
            await sleep(500);
            return { ok: true, status: "mode_selected" };
          }
        }
      } catch {
        // Try next button.
      }
    }
  }
    await sleep(1000);
  }
  return {
    ok: false,
    status: "mode_unavailable",
    detail: `Required ChatGPT mode label "${modeLabel}" was not visible/selectable.`,
  };
}

async function findComposer(tab) {
  const selectors = [
    "textarea",
    '[contenteditable="true"]',
    '[role="textbox"]',
    'div.ProseMirror',
  ];
  for (const selector of selectors) {
    const loc = tab.playwright.locator(selector);
    const count = await loc.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const candidate = loc.nth(i);
      try {
        if (await candidate.isVisible()) return candidate;
      } catch {
        // Ignore hidden/stale candidates.
      }
    }
  }
  throw new Error("ChatGPT composer was not found.");
}

async function fillComposer(tab, text) {
  const composer = await findComposer(tab);
  await composer.click({ timeoutMs: 5000 });
  await composer.press("Meta+A", { timeoutMs: 2000 }).catch(() => {});
  await composer.press("Backspace", { timeoutMs: 2000 }).catch(() => {});
  try {
    await composer.fill(text, { timeoutMs: 10000 });
  } catch {
    await tab.clipboard.writeText(text);
    await composer.press("Meta+V", { timeoutMs: 10000 });
  }
  return composer;
}

async function clickUploadControl(tab, zipPath) {
  let lastError = "";
  const noteUploadError = (error) => {
    const message = sanitizeText(error && error.message ? error.message : String(error));
    if (message) lastError = message;
  };
  const inputs = tab.playwright.locator('input[type="file"]');
  const inputCount = await inputs.count();
  if (inputCount > 0) {
    const chooserPromise = tab.playwright.waitForEvent("filechooser", { timeoutMs: 12000 });
    try {
      await inputs.nth(inputCount - 1).click({ timeoutMs: 5000, force: true });
      const chooser = await chooserPromise;
      const source = await setFilesWithChipFallback(tab, chooser, zipPath);
      return `input-file:${source}`;
    } catch (error) {
      noteUploadError(error);
      // Fall through to button based file chooser.
    }
  }
  const uploadButtons = [
    tab.playwright.getByRole("button", { name: "添加文件", exact: false }),
    tab.playwright.getByRole("button", { name: "Attach", exact: false }),
    tab.playwright.getByRole("button", { name: "Add files", exact: false }),
    tab.playwright.locator('button[aria-label*="Attach"], button[aria-label*="Add"], button[aria-label*="添加"]'),
  ];
  for (const locator of uploadButtons) {
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      try {
        if (!(await candidate.isVisible())) continue;
        const descriptor = await buttonDescriptor(candidate);
        if (!looksLikeUploadControlDescriptor(descriptor)) continue;
        const chooserPromise = tab.playwright.waitForEvent("filechooser", { timeoutMs: 12000 });
        await candidate.click({ timeoutMs: 5000 });
        const chooser = await chooserPromise;
        const source = await setFilesWithChipFallback(tab, chooser, zipPath);
        return `upload-button:${source}`;
      } catch (error) {
        noteUploadError(error);
        // Try next candidate.
      }
    }
  }
  const addButtons = [
    tab.playwright.getByRole("button", { name: "添加文件", exact: false }),
    tab.playwright.getByRole("button", { name: "Attach", exact: false }),
    tab.playwright.getByRole("button", { name: "Add files", exact: false }),
    tab.playwright.locator('button[aria-label*="添加"], button[aria-label*="Add"], button[aria-label*="Attach"]'),
  ];
  const uploadMenuLabels = ["上传照片和文件", "上传文件", "Upload photos and files", "Upload files"];
  for (const locator of addButtons) {
    const count = await locator.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const button = locator.nth(i);
      try {
        if (!(await button.isVisible())) continue;
        const descriptor = await buttonDescriptor(button);
        if (!looksLikeUploadControlDescriptor(descriptor)) continue;
        await button.click({ timeoutMs: 5000 });
        await sleep(500);
        const menuItems = [];
        for (const label of uploadMenuLabels) {
          menuItems.push(tab.playwright.getByRole("menuitem", { name: label, exact: false }));
          menuItems.push(tab.playwright.getByText(label, { exact: false }));
        }
        for (const menuItem of menuItems) {
          const menuCount = await menuItem.count();
          for (let j = 0; j < menuCount; j += 1) {
            const item = menuItem.nth(j);
            try {
              if (!(await item.isVisible())) continue;
              const chooserPromise = tab.playwright.waitForEvent("filechooser", { timeoutMs: 12000 });
              await item.click({ timeoutMs: 5000 });
              const chooser = await chooserPromise;
              const source = await setFilesWithChipFallback(tab, chooser, zipPath);
              return `upload-menuitem:${source}`;
            } catch (error) {
              noteUploadError(error);
              // Try next item.
            }
          }
        }
      } catch (error) {
        noteUploadError(error);
        // Try next button.
      }
    }
  }
  if (/Not allowed|fileChooser\.setFiles failed/i.test(lastError)) {
    throw new Error(
      "Chrome file upload is blocked by extension permissions. To enable file upload, go to chrome://extensions in Chrome, click Details under the Codex extension, and enable \"Allow access to file URLs.\" See https://developers.openai.com/codex/app/chrome-extension#upload-files for details.",
    );
  }
  throw new Error(`Could not open ChatGPT file chooser.${lastError ? ` Last error: ${lastError}` : ""}`);
}

async function waitForUploadConfirmation(tab, zipPath, timeoutMs = 180000) {
  const baseName = path.basename(zipPath);
  const start = Date.now();
  let lastText = "";
  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    const text = await visibleText(tab);
    lastText = text;
    const state = classifyChatGptPage(text);
    if (state !== "ok") return { ok: false, status: state, text };
    const uploadState = uploadStateFromText(text, baseName);
    if (uploadState === "confirmed") {
      return { ok: true, status: "upload_confirmed", text };
    }
    if (uploadState === "failed") return { ok: false, status: "upload_failed", text };
  }
  return { ok: false, status: "upload_failed", text: lastText };
}

async function uploadBundleWithRetry(tab, zipPath, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 2));
  let last = { ok: false, status: "upload_failed", text: "" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await clickUploadControl(tab, zipPath);
    const upload = await waitForUploadConfirmation(tab, zipPath, options.timeoutMs || 180000);
    if (upload.ok) return { ...upload, attempt };
    last = { ...upload, attempt };
    if (upload.status !== "upload_failed") return last;
    const baseName = path.basename(zipPath);
    const text = String(upload.text || "");
    if (text.includes(baseName) && uploadStateFromText(text, baseName) === "failed") return last;
    if (attempt < attempts) await sleep(2000);
  }
  return last;
}

function uploadStateFromText(text, baseName) {
  const body = String(text || "");
  const idx = body.indexOf(baseName);
  if (idx < 0) return "missing";
  const context = body.slice(Math.max(0, idx - 180), idx + baseName.length + 240).toLowerCase();
  if (/(uploading|上传中|正在上传|processing|处理中)/i.test(context)) return "uploading";
  if (/(upload failed|failed to upload|上传失败|附件失败)/i.test(context)) return "failed";
  return "confirmed";
}

async function waitForUploadChip(tab, zipPath, timeoutMs = 60000) {
  const baseName = path.basename(zipPath);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(1000);
    const found = await tab.playwright
      .evaluate((name) => {
        const body = document.body ? document.body.innerText || "" : "";
        if (body.includes(name)) return true;
        return [...document.querySelectorAll("[aria-label], [role='group'], button, div, span")].some((node) => {
          const aria = node.getAttribute("aria-label") || "";
          const text = node.innerText || node.textContent || "";
          return aria.includes(name) || text.includes(name);
        });
      }, baseName)
      .catch(() => false);
    if (found) return true;
  }
  return false;
}

async function setFilesWithChipFallback(tab, chooser, zipPath) {
  const setFilesPromise = chooser
    .setFiles([zipPath])
    .then(() => ({ ok: true, source: "setFiles" }))
    .catch((error) => ({ ok: false, source: "setFiles", error }));
  const first = await Promise.race([
    setFilesPromise,
    sleep(8000).then(() => ({ ok: true, source: "setFiles-timeout-await-chip" })),
  ]);
  if (!first.ok) {
    const chipAfterFailure = await waitForUploadChip(tab, zipPath, 5000);
    if (chipAfterFailure) return "upload-chip-after-setFiles-error";
    throw first.error || new Error("File upload did not complete.");
  }
  const chip = await waitForUploadChip(tab, zipPath, 45000);
  if (chip) return first.source === "setFiles" ? "setFiles+upload-chip" : first.source;
  if (first.source === "setFiles") return "setFiles-no-chip";
  throw new Error("Upload chip was not observed after file selection.");
}

function looksLikeSendButtonDescriptor(descriptor) {
  const value = String(descriptor || "");
  if (!value.trim()) return false;
  if (CHATGPT_FILE_CONTENT_RE.test(value)) {
    return false;
  }
  return /(send|submit prompt|send message|发送|发送消息|提交|arrow-up|arrow up|composer-submit|send-button)/i.test(value);
}

function looksLikeUploadControlDescriptor(descriptor) {
  const value = String(descriptor || "");
  if (!value.trim()) return false;
  if (/(backend-api\/estuary\/content|download|save|remove|delete|cancel|下载|保存|移除|删除|取消|\.zip|upload_bundle|file_)/i.test(value)) {
    return false;
  }
  return /(add file|add files|attach|attachment|upload files|upload photos and files|添加文件|添加照片|上传文件|上传照片和文件|附件)/i.test(value);
}

function looksLikeComposerSendDescriptor(descriptor) {
  const value = String(descriptor || "");
  if (!value.trim()) return false;
  if (/(backend-api\/estuary\/content|download|save|upload|attach|remove|delete|cancel|下载|保存|上传|附件|添加|移除|删除|取消|\.zip|upload_bundle|file_)/i.test(value)) {
    return false;
  }
  return /(send|submit prompt|send message|发送|发送消息|提交|arrow-up|arrow up|composer-submit|send-button)/i.test(value);
}

async function buttonDescriptor(button) {
  const evaluateDescriptor = async (target) => target.evaluate((node) => {
    const collect = (item, prefix) => {
      if (!item) return "";
      const attrs = ["aria-label", "title", "data-testid", "type", "class", "href"]
        .map((name) => `${prefix}.${name}=${item.getAttribute?.(name) || ""}`)
        .join("\n");
      const text = item.innerText || item.textContent || "";
      return `${attrs}\n${prefix}.text=${text}`;
    };
    const attrs = ["aria-label", "title", "data-testid", "type", "class"]
      .map((name) => `${name}=${node.getAttribute(name) || ""}`)
      .join("\n");
    const text = node.innerText || node.textContent || "";
    const parent = node.closest?.("a, button, [role='button'], [role='group'], form, [data-testid]");
    const downloadLink = node.closest?.("a[href*='backend-api/estuary/content'], [href*='backend-api/estuary/content']")
      || node.querySelector?.("a[href*='backend-api/estuary/content'], [href*='backend-api/estuary/content']");
    return `${text}\n${attrs}\n${collect(parent, "closest")}\n${collect(downloadLink, "downloadLink")}`;
  }, undefined, { timeoutMs: 1000 });

  if (typeof button.evaluate === "function") {
    return await evaluateDescriptor(button).catch(() => "");
  }
  if (typeof button.elementHandle === "function") {
    const handle = await button.elementHandle().catch(() => null);
    if (handle && typeof handle.evaluate === "function") {
      return await evaluateDescriptor(handle).catch(() => "");
    }
  }

  const attrs = [];
  for (const name of ["aria-label", "title", "data-testid", "type", "class", "href"]) {
    if (typeof button.getAttribute !== "function") continue;
    const value = await button.getAttribute(name).catch(() => "");
    attrs.push(`${name}=${value || ""}`);
  }
  const text = typeof button.innerText === "function"
    ? await button.innerText({ timeoutMs: 500 }).catch(() => "")
    : "";
  return `${text}\n${attrs.join("\n")}`;
}

async function composerHasVerifiedFocus(composer) {
  return await composer
    .evaluate((node) => {
      const active = document.activeElement;
      if (!active) return false;
      if (node === active || node.contains(active)) return true;
      const activeComposer = active.closest?.("textarea, [contenteditable='true'], [role='textbox'], div.ProseMirror");
      return Boolean(activeComposer && (activeComposer === node || node.contains(activeComposer)));
    }, undefined, { timeoutMs: 1000 })
    .catch(() => false);
}

async function clickFirstSafeSendButton(tab) {
  await installDownloadClickGuard(tab).catch(() => false);
  const strictSelectors = [
    'button[data-testid="send-button"]',
    'button[data-testid*="send" i]',
    'button[data-testid="composer-submit-button"]',
    'button[data-testid*="submit" i]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Submit" i]',
    'button[aria-label*="发送"]',
    'button[aria-label*="提交"]',
  ];
  for (const selector of strictSelectors) {
    const locator = tab.playwright.locator(selector);
    const count = await locator.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const button = locator.nth(i);
      try {
        if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
        const descriptor = await buttonDescriptor(button);
        if (!looksLikeSendButtonDescriptor(descriptor)) continue;
        await button.click({ timeoutMs: 5000 });
        return true;
      } catch {
        // Try next.
      }
    }
  }

  return false;
}

function clickComposerScopedSubmitButtonInPage(node) {
      const isVisible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      const collect = (el) => {
        const closestRisky = el.closest?.(
          'a[href*="backend-api/estuary/content"], [href*="backend-api/estuary/content"], [data-testid*="attachment" i], [data-testid*="file" i], [aria-label*="download" i], [aria-label*="下载"]',
        );
        const attrs = ["aria-label", "title", "data-testid", "type", "class", "href"]
          .map((name) => `${name}=${el.getAttribute?.(name) || ""}`)
          .join("\n");
        const text = el.innerText || el.textContent || "";
        const hrefs = [...el.querySelectorAll?.("[href]") || []].map((item) => item.getAttribute("href") || "").join("\n");
        const closestAttrs = closestRisky
          ? ["aria-label", "title", "data-testid", "class", "href"]
              .map((name) => `closestRisky.${name}=${closestRisky.getAttribute?.(name) || ""}`)
              .join("\n")
          : "";
        return `${text}\n${attrs}\n${hrefs}\n${closestAttrs}`;
      };
      const roots = [];
      const form = node.closest?.("form");
      if (form) roots.push(form);
      const composerRoot = node.closest?.("[data-testid*='composer'], main, [role='main']");
      if (composerRoot && !roots.includes(composerRoot)) roots.push(composerRoot);
      for (const root of roots) {
        const buttons = [...root.querySelectorAll("button")].reverse();
        for (const button of buttons) {
          if (!isVisible(button) || button.disabled || button.getAttribute("aria-disabled") === "true") continue;
          const descriptor = collect(button);
          if (/(backend-api\/estuary\/content|download|save|upload|attach|remove|delete|cancel|下载|保存|上传|附件|添加|移除|删除|取消|\.zip|upload_bundle|file_)/i.test(descriptor)) continue;
          if (/(send|submit prompt|send message|发送|发送消息|提交|arrow-up|arrow up|composer-submit|send-button)/i.test(descriptor)) {
            button.click();
            return { ok: true, method: "composer-send" };
          }
        }
      }
      return { ok: false, method: "" };
}

async function clickComposerScopedSubmitButton(tab, composer) {
  try {
    if (composer && typeof composer.evaluate === "function") {
      return await composer
        .evaluate(clickComposerScopedSubmitButtonInPage, undefined, { timeoutMs: 2000 })
        .catch(() => ({ ok: false, method: "" }));
    }
    if (composer && typeof composer.click === "function") {
      await composer.click({ timeoutMs: 2000 }).catch(() => {});
    }
    return await tab.playwright.evaluate((clickerSource) => {
      const clicker = Function(`return (${clickerSource})`)();
      const node = document.activeElement || document.querySelector("textarea, [contenteditable='true'], [role='textbox'], div.ProseMirror");
      return clicker(node);
    }, clickComposerScopedSubmitButtonInPage.toString());
  } catch {
    return { ok: false, method: "" };
  }
}

async function clickSafeSendButtonWithWait(tab, composer, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await installDownloadClickGuard(tab).catch(() => false);
    if (await clickFirstSafeSendButton(tab)) return true;
    const scoped = await clickComposerScopedSubmitButton(tab, composer);
    if (scoped.ok) return true;
    await sleep(1000);
  }
  return false;
}

async function submitPrompt(tab, composer, options = {}) {
  if (await clickSafeSendButtonWithWait(tab, composer, options.safeSendTimeoutMs || 60000)) return "button";
  if (!shouldAllowEnterSubmit(options.status || {}, options)) {
    throw new Error("Safe ChatGPT send button was not found; keyboard Enter fallback is disabled to prevent file-card downloads.");
  }
  await composer.click({ timeoutMs: 5000 });
  if (!(await composerHasVerifiedFocus(composer))) {
    throw new Error("Safe ChatGPT send button was not found, and composer focus could not be verified for keyboard submit.");
  }
  await composer.press("Enter", { timeoutMs: 5000 });
  return "enter";
}

function isConversationUrl(url) {
  return /chatgpt\.com\/g\/.+\/c\//.test(String(url || "")) || /chatgpt\.com\/c\//.test(String(url || ""));
}

function conversationIdFromUrl(url) {
  const match = String(url || "").match(/\/c\/([^/?#]+)/);
  return match ? match[1] : "";
}

function titleSearchNeedles(status) {
  return [
    status.conversation_title,
    status.topic,
    status.stable_topic,
    status.registry_key,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function projectSlugFromProjectUrl(url) {
  const match = String(url || "").match(/chatgpt\.com\/g\/([^/]+)\/project/);
  return match ? match[1] : "";
}

function projectSlugAliases(projectUrl) {
  const slug = projectSlugFromProjectUrl(projectUrl);
  if (!slug) return [];
  const aliases = [slug];
  const idMatch = slug.match(/^(g-p-[A-Za-z0-9]+)/);
  if (idMatch && idMatch[1] !== slug) aliases.push(idMatch[1]);
  return aliases;
}

function isProjectConversationUrl(url, projectUrl) {
  const aliases = projectSlugAliases(projectUrl);
  if (!aliases.length) return true;
  const value = String(url || "");
  return aliases.some((slug) => value.includes(`/g/${slug}/c/`));
}

function shouldKeepOpen(status, options = {}) {
  return options.keepOpen === true || status.keep_open === true;
}

function shouldAutoRename(status, options = {}) {
  return options.autoRename === true || status.auto_rename === true;
}

function shouldAllowEnterSubmit(status, options = {}) {
  return options.allowEnterSubmit === true || status.allow_enter_submit === true;
}

function expectedConversationUrl(status) {
  if (status.conversation_policy !== "reuse_existing" && status.reuse_existing !== true) return "";
  const projectUrl = String(status.project_url || "");
  if (
    isConversationUrl(status.expected_conversation_url) &&
    (!projectUrl || isProjectConversationUrl(status.expected_conversation_url, projectUrl))
  ) return String(status.expected_conversation_url);
  if (status.registry_conversation_available && isConversationUrl(status.conversation_url)) {
    if (projectUrl && !isProjectConversationUrl(status.conversation_url, projectUrl)) return "";
    return String(status.conversation_url);
  }
  return "";
}

function uploadRecoveryStates() {
  return new Set(["uploading", "upload_failed", "upload_confirmed", "submit_failed", "submit_button_unavailable", "submit_pending_conversation_url"]);
}

async function latestConversationUrlForRun(runDir, fallback = "") {
  const status = await readJson(path.join(runDir, "status.json")).catch(() => ({}));
  if (isConversationUrl(status.conversation_url)) return String(status.conversation_url);
  const conversation = await readJson(path.join(runDir, "conversation.json")).catch(() => ({}));
  if (isConversationUrl(conversation.url)) return String(conversation.url);
  return isConversationUrl(fallback) ? String(fallback) : "";
}

async function waitForConversationUrl(tab, timeoutMs = 12000) {
  const start = Date.now();
  let url = (await tab.url()) || "";
  while (Date.now() - start < timeoutMs) {
    url = (await tab.url()) || "";
    if (isConversationUrl(url)) return url;
    await sleep(500);
  }
  return url;
}

function submissionStateFromText(text, uploadBaseName = "") {
  const body = String(text || "");
  const hasEmptyProjectMarker = /(尚无聊天|No chats yet|No chat|Chats in .* will appear here)/i.test(body);
  const hasUpload = uploadBaseName ? body.includes(uploadBaseName) : /upload_bundle\.zip/.test(body);
  if (hasEmptyProjectMarker && hasUpload) return "not_sent";
  if (/(正在整理答案|已思考|Thinking|Reasoning|停止生成|Stop generating)/i.test(body)) return "generating";
  return "unknown";
}

async function waitForSubmissionConfirmation(tab, options = {}) {
  const timeoutMs = options.timeoutMs || 45000;
  const uploadBaseName = options.uploadBaseName || "";
  const start = Date.now();
  let lastText = "";
  let lastUrl = (await tab.url()) || "";
  while (Date.now() - start < timeoutMs) {
    await sleep(1000);
    lastUrl = (await tab.url()) || "";
    if (isConversationUrl(lastUrl)) return { ok: true, status: "submitted", url: lastUrl };
    if (await stopControlVisible(tab)) return { ok: true, status: "generating", url: lastUrl };
    const text = await visibleText(tab);
    lastText = text;
    const pageState = classifyChatGptPage(text);
    if (pageState !== "ok") return { ok: false, status: pageState, url: lastUrl, text };
    if (submissionStateFromText(text, uploadBaseName) === "generating") {
      return { ok: true, status: "generating", url: lastUrl };
    }
  }
  const state = submissionStateFromText(lastText, uploadBaseName);
  return {
    ok: false,
    status: "submit_failed",
    url: lastUrl,
    text: lastText,
    detail: state === "not_sent"
      ? "ChatGPT still showed the uploaded bundle in an empty project composer after send was attempted."
      : "ChatGPT did not expose a conversation URL or generation indicator after send was attempted.",
  };
}

async function submitPromptWithConfirmation(tab, composer, options = {}) {
  let last = null;
  const attempts = options.attempts || 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let method = "";
    try {
      method = await submitPrompt(tab, composer, options);
    } catch (error) {
      return {
        ok: false,
        status: "submit_button_unavailable",
        detail: sanitizeText(error && error.message ? error.message : String(error)),
        attempt,
      };
    }
    const confirmation = await waitForSubmissionConfirmation(tab, {
      timeoutMs: options.timeoutMs || 30000,
      uploadBaseName: options.uploadBaseName || "",
    });
    if (confirmation.ok) return { ...confirmation, method, attempt };
    last = { ...confirmation, method, attempt };
    const text = confirmation.text || await visibleText(tab).catch(() => "");
    if (submissionStateFromText(text, options.uploadBaseName || "") !== "not_sent") break;
    await sleep(1500);
  }
  return last || { ok: false, status: "submit_failed", detail: "Submit did not produce a confirmation." };
}

async function stopControlVisible(tab) {
  const locators = [
    tab.playwright.locator('button[data-testid="stop-button"]'),
    tab.playwright.getByRole("button", { name: /stop|停止|中止/i }),
  ];
  for (const locator of locators) {
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      try {
        if (await locator.nth(i).isVisible()) return true;
      } catch {
        // Ignore.
      }
    }
  }
  return false;
}

async function extractAssistantResponse(tab) {
  const articles = await tab.playwright.locator("article").allTextContents({ timeoutMs: 3000 }).catch(() => []);
  const finalArticles = articles
    .map((text) => sanitizeText(stripThinkingText(text)).trim())
    .filter((text) => looksLikeFinalReviewResponse(text));
  if (finalArticles.length) return finalArticles[finalArticles.length - 1].trim();
  const body = stripThinkingText(await visibleText(tab));
  const marker = "GPT Pro web review";
  const idx = body.lastIndexOf(marker);
  if (idx >= 0) {
    const candidate = body.slice(idx).trim();
    if (looksLikeFinalReviewResponse(candidate)) return candidate;
  }
  return "";
}

function looksLikeFinalReviewResponse(text) {
  const value = String(text || "").trim();
  if (!value.startsWith("GPT Pro web review")) return false;
  if (!/Review State/i.test(value)) return false;
  if (/(Then provide|Required output format|Non-negotiable boundaries|##\s*User request|Mode instructions)/i.test(value)) {
    return false;
  }
  return /(Blockers|Important findings|Direct answer|直接回答|重要|阻塞)/i.test(value);
}

function stripThinkingText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const output = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(思考|Thinking|Reasoning)(中|\.\.\.)?$/i.test(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping && /^(GPT Pro web review|Blockers|Important findings|Optional comments|Direct answer|Review State)\b/i.test(trimmed)) {
      skipping = false;
    }
    if (!skipping) output.push(line);
  }
  return output.join("\n");
}

async function waitForCompletion(tab, runDir, timeoutMs = WATCH_TIMEOUT_MS) {
  const start = Date.now();
  let phase = "waiting_for_start";
  let stableCount = 0;
  let lastResponse = "";
  let lastWrite = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(5000);
    let text = "";
    try {
      text = await visibleText(tab);
    } catch (error) {
      if (isTabNotFoundError(error)) {
        return {
          ok: false,
          status: "tab_lost",
          phase,
          response: lastResponse,
          error: sanitizeText(error && error.message ? error.message : String(error)),
        };
      }
      throw error;
    }
    const pageState = classifyChatGptPage(text);
    if (pageState !== "ok") return { ok: false, status: pageState, phase, response: "" };
    const stopVisible = await stopControlVisible(tab);
    const thinkingState = await probeThinkingState(tab);
    const response = await extractAssistantResponse(tab);
    const hasResponse = response.length > 200;
    if (stopVisible) phase = "generating";
    else if (hasResponse && phase !== "waiting_for_start") phase = "stabilizing";
    else if (hasResponse) phase = "stabilizing";
    if (response && Date.now() - lastWrite > 10000) {
      await fs.writeFile(path.join(runDir, "response.partial.md"), response + "\n");
      lastWrite = Date.now();
    }
    if (hasResponse && !stopVisible && response === lastResponse) stableCount += 1;
    else stableCount = 0;
    lastResponse = response;
    await writeStatus(runDir, {
      state: "watching",
      watch_phase: phase,
      response_chars: response.length,
      stable_checks: stableCount,
      thinking_visible: thinkingState.visible,
      thinking_detail_available: thinkingState.detailAvailable,
    });
    const elapsed = Date.now() - start;
    if (
      hasResponse &&
      !stopVisible &&
      (stableCount >= DONE_STABLE_CHECKS || (response.length >= QUICK_DONE_MIN_CHARS && stableCount >= 1 && elapsed >= QUICK_DONE_AFTER_MS))
    ) {
      return { ok: true, status: "success", phase: "done", response };
    }
  }
  return { ok: false, status: "timeout", phase, response: lastResponse };
}

async function probeThinkingState(tab) {
  return await tab.playwright
    .evaluate(() => {
      const body = document.body ? document.body.innerText || "" : "";
      const visible = /(^|\n|\s)(思考|Thinking|Reasoning)(\n|\s|$)/i.test(body);
      const detailAvailable = [...document.querySelectorAll("button, [role='button'], summary")]
        .some((node) => {
          const text = node.innerText || node.textContent || "";
          const aria = node.getAttribute("aria-label") || "";
          return /(思考|Thinking|Reasoning)/i.test(`${text}\n${aria}`);
        });
      return { visible, detailAvailable };
    }, undefined, { timeoutMs: 1500 })
    .catch(() => ({ visible: false, detailAvailable: false }));
}

function effectiveWatchTimeout(options = {}) {
  if (options.timeoutMs != null) return options.timeoutMs;
  if (options.longWait === true) return WATCH_TIMEOUT_MS;
  return DEFAULT_WATCH_SLICE_MS;
}

function keepEntryForStatus(tab, status) {
  if (!HANDOFF_STATUSES.has(status)) return null;
  return { tab, status: "handoff", reason: status, tabId: tab?.id || "" };
}

function finalizeKeepEntries(keepTabs) {
  return (keepTabs || [])
    .map((item) => {
      if (!item) return null;
      if (item && typeof item === "object" && "tab" in item) {
        return { tab: item.tab, status: item.status || "handoff", reason: item.reason || "", tabId: item.tabId || item.tab?.id || "" };
      }
      return { tab: item, status: "handoff", tabId: item?.id || "" };
    })
    .filter(Boolean);
}

async function finalizeBrowserTabs(browser, keepTabs) {
  const keep = finalizeKeepEntries(keepTabs);
  // Do not call browser.tabs.finalize() here. With multiple projects running in
  // parallel, broad finalization can close another runner's active ChatGPT tab.
  // Each run explicitly closes only its own completed tab; handoff/detach tabs
  // are intentionally preserved until resume or explicit cleanup.
  return keep.length;
}

async function closeStrayProjectTabs(browser, status = {}) {
  const projectUrl = String(status.project_url || "");
  if (!projectUrl) return 0;
  let closed = 0;
  const openTabs = await browser.user.openTabs().catch(() => []);
  for (const info of openTabs) {
    const url = String(info.url || "");
    const group = String(info.tabGroup || "");
    if (url !== projectUrl) continue;
    if (!group.includes("GPT Pro review")) continue;
    try {
      const tab = await browser.user.claimTab(info);
      if (await closeTabQuietly(tab)) closed += 1;
    } catch {
      // Ignore tabs that disappeared between list and claim.
    }
  }
  return closed;
}

async function closeTabQuietly(tab) {
  try {
    await tab.close();
    return true;
  } catch {
    return false;
  }
}

async function deleteLocalZipIfUploaded(runDir, zipPath) {
  if (!zipPath) return false;
  try {
    await fs.unlink(zipPath);
    await writeStatus(runDir, { local_zip_deleted: true });
    return true;
  } catch {
    return false;
  }
}

async function submitPromptAndMaybeWatch(tab, runDir, status, options = {}) {
  const keepTabs = [];
  const prompt = await fs.readFile(path.join(runDir, "review_packet.md"), "utf8");
  const composer = await fillComposer(tab, prompt);
  const uploadBaseName = status.upload_bundle ? path.basename(status.upload_bundle) : "";
  const submitted = await submitPromptWithConfirmation(tab, composer, { uploadBaseName, status, ...options });
  if (!submitted.ok) {
    const failedState = submitted.status || "submit_failed";
    if (failedState === "submit_button_unavailable") {
      await closeTabQuietly(tab);
    } else {
      keepTabs.push(keepEntryForStatus(tab, failedState));
    }
    await saveConversation(runDir, tab, status.conversation_title || "");
    await writeStatus(runDir, {
      state: failedState,
      error: submitted.detail || submitted.status || "Submit did not produce a confirmation.",
      submit_attempts: submitted.attempt || 0,
      submit_method: submitted.method || "",
    });
    return { status: failedState, keepTabs };
  }
  if (submitted.url && isConversationUrl(submitted.url)) {
    await writeStatus(runDir, { conversation_url: submitted.url });
  } else {
    const conversationUrl = await waitForConversationUrl(tab, 20000);
    if (isConversationUrl(conversationUrl)) await writeStatus(runDir, { conversation_url: conversationUrl });
  }
  const savedConversation = await saveConversation(runDir, tab, status.conversation_title || "");
  const latestStatus = await readJson(path.join(runDir, "status.json"));
  const finalConversationUrl = isConversationUrl(latestStatus.conversation_url)
    ? latestStatus.conversation_url
    : isConversationUrl(savedConversation.url)
      ? savedConversation.url
      : "";
  if (!finalConversationUrl) {
    keepTabs.push(keepEntryForStatus(tab, "submit_pending_conversation_url"));
    await writeStatus(runDir, {
      state: "submit_pending_conversation_url",
      submit_confirmed: false,
      submit_confirmation: submitted.status,
      submit_attempts: submitted.attempt || 1,
      submit_method: submitted.method || "",
      error: "Submit action did not yield a project conversation URL; keeping local upload bundle for retry.",
    });
    return { status: "submit_pending_conversation_url", keepTabs };
  }
  if (
    latestStatus.project_url &&
    finalConversationUrl &&
    !isProjectConversationUrl(finalConversationUrl, latestStatus.project_url)
  ) {
    keepTabs.push(keepEntryForStatus(tab, "project_mismatch"));
    await writeStatus(runDir, {
      state: "project_mismatch",
      conversation_url: "",
      non_project_conversation_url: finalConversationUrl,
      submit_confirmed: true,
      submit_confirmation: submitted.status,
      submit_attempts: submitted.attempt || 1,
      submit_method: submitted.method || "",
      error: `Submitted conversation did not remain inside ChatGPT Project ${latestStatus.chatgpt_project || DEFAULT_PROJECT_NAME}.`,
    });
    return { status: "project_mismatch", keepTabs };
  }
  const expectedUrl = expectedConversationUrl(status);
  const conversationReused = Boolean(expectedUrl && finalConversationUrl === expectedUrl);
  const conversationForked = Boolean(expectedUrl && finalConversationUrl && finalConversationUrl !== expectedUrl);
  await writeStatus(runDir, {
    submit_confirmed: true,
    submit_confirmation: submitted.status,
    submit_attempts: submitted.attempt || 1,
    submit_method: submitted.method || "",
    conversation_reused: conversationReused,
    conversation_forked_after_submit: conversationForked,
    expected_conversation_url: expectedUrl,
    actual_conversation_url: finalConversationUrl,
  });
  await deleteLocalZipIfUploaded(runDir, status.upload_bundle);
  if (shouldAutoRename(status, options)) {
    const renameStatus = await readJson(path.join(runDir, "status.json"));
    await renameConversationIfPossible(tab, runDir, renameStatus, options);
  }
  if (status.run_mode === "detach" || options.detach) {
    const keepDetachedTab = shouldKeepOpen(status, options);
    if (keepDetachedTab) keepTabs.push(keepEntryForStatus(tab, "detached"));
    else await closeTabQuietly(tab);
    await writeStatus(runDir, {
      state: "detached",
      error: "",
      submit_confirmed: true,
      submit_confirmation: submitted.status,
      submit_attempts: submitted.attempt || 1,
      submit_method: submitted.method || "",
      detached_tab_preserved: keepDetachedTab,
      detached_at: new Date().toISOString(),
    });
    return { status: "detached", keepTabs };
  }

  const result = await waitForCompletion(tab, runDir, effectiveWatchTimeout(options));
  if (!result.ok) {
    if (result.response) await fs.writeFile(path.join(runDir, "response.partial.md"), result.response + "\n");
    keepTabs.push(keepEntryForStatus(tab, result.status));
    await writeStatus(runDir, { state: result.status, watch_phase: result.phase });
    return { status: result.status, keepTabs };
  }
  if (!responseMatchesRun(result.response, status)) {
    keepTabs.push(keepEntryForStatus(tab, "extract_failed"));
    await writeStatus(runDir, {
      state: "extract_failed",
      error: "Extracted response did not match this run topic/run id.",
      response_chars: result.response.length,
    });
    return { status: "extract_failed", keepTabs };
  }
  await fs.writeFile(path.join(runDir, "response.md"), result.response + "\n");
  await saveConversation(runDir, tab, status.conversation_title || "");
  const renameStatus = await readJson(path.join(runDir, "status.json"));
  await renameConversationIfPossible(tab, runDir, renameStatus, options);
  await writeStatus(runDir, { state: "completed", error: "", completed_at: new Date().toISOString() });
  if (shouldKeepOpen(status, options)) keepTabs.push(keepEntryForStatus(tab, "kept_open"));
  return { status: "success", keepTabs };
}

function responseMatchesRun(response, status) {
  const text = String(response || "");
  const topic = String(status.topic || "");
  const runId = String(status.run_id || "");
  if (runId && text.includes(runId)) return true;
  if (topic && text.includes(topic)) return true;
  if (topic) return false;
  return false;
}

async function updateRegistryFromStatus(runDir, overrides = {}) {
  const status = await readJson(path.join(runDir, "status.json"));
  if (status.registry_update_enabled !== true && status.conversation_policy !== "reuse_existing") return false;
  const registryPath = String(status.registry_path || "");
  if (!registryPath) return false;

  const conversation = await readJson(path.join(runDir, "conversation.json")).catch(() => ({}));
  const conversationUrl = isConversationUrl(overrides.conversationUrl)
    ? String(overrides.conversationUrl)
    : isConversationUrl(conversation.url)
      ? String(conversation.url)
      : isConversationUrl(status.conversation_url)
        ? String(status.conversation_url)
        : "";
  if (!conversationUrl) return false;
  if (status.project_url && !isProjectConversationUrl(conversationUrl, status.project_url)) return false;

  const existing = await readJson(registryPath).catch(() => ({}));
  const title = overrides.title || conversation.title || status.conversation_title || existing.conversation_title || "";
  const now = new Date().toISOString();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await writeJsonAtomic(registryPath, {
    ...existing,
    project_root: status.session_root || status.project_root || existing.project_root || "",
    bundle_root: status.bundle_root || status.project_root || existing.bundle_root || "",
    session_root: status.session_root || status.project_root || existing.session_root || "",
    topic: status.topic || existing.topic || "",
    registry_key: status.registry_key || existing.registry_key || "",
    chatgpt_project: status.chatgpt_project || existing.chatgpt_project || "",
    project_key: status.project_key || existing.project_key || "",
    project_url: status.project_url || existing.project_url || "",
    project_slug: status.project_slug || existing.project_slug || "",
    conversation_title: title,
    conversation_url: conversationUrl,
    part: status.conversation_part || existing.part || 1,
    last_run_id: status.run_id || existing.last_run_id || "",
    last_state: status.state || existing.last_state || "",
    updated_at: now,
  });
  await writeStatus(runDir, { registry_updated_at: now });
  return true;
}

function keyForTextChar(char) {
  const direct = /^[A-Za-z0-9]$/.test(char);
  if (direct) return char;
  const map = {
    " ": "Space",
    "-": "Minus",
    "_": "Shift+Minus",
    "[": "BracketLeft",
    "]": "BracketRight",
    "/": "Slash",
    ".": "Period",
    ":": "Shift+Semicolon",
    "(": "Shift+Digit9",
    ")": "Shift+Digit0",
    "+": "Shift+Equal",
    "&": "Shift+Digit7",
  };
  return map[char] || "";
}

async function pressText(locator, text) {
  for (const char of String(text || "")) {
    const key = keyForTextChar(char);
    if (!key) throw new Error(`Unsupported title character for keyboard rename: ${char}`);
    await locator.press(key, { timeout: 2000 });
  }
}

function conversationNameFromBrowserTitle(title, projectName = DEFAULT_PROJECT_NAME) {
  const text = String(title || "").trim();
  const prefix = `${projectName} - `;
  if (text.startsWith(prefix)) return text.slice(prefix.length).trim();
  const parts = text.split(" - ");
  return parts.length > 1 ? parts.slice(1).join(" - ").trim() : text;
}

async function clickCurrentConversationOptions(tab, status) {
  const linkScoped = await clickConversationOptionsByConversationId(tab, status);
  if (linkScoped.ok) return linkScoped;

  const browserTitle = await tab.title().catch(() => "");
  const currentName = conversationNameFromBrowserTitle(browserTitle, status.chatgpt_project || DEFAULT_PROJECT_NAME);
  const selectors = [];
  if (currentName) {
    const escaped = currentName.replace(/"/g, '\\"');
    selectors.push(`button[data-testid="undefined-options"][aria-label="打开“${escaped}”的对话选项"]`);
    selectors.push(`button[data-testid="undefined-options"][aria-label="Open “${escaped}” conversation options"]`);
    selectors.push(`button[data-testid="undefined-options"][aria-label*="${escaped}"]`);
  }
  if (!selectors.length) {
    selectors.push(...[]);
  }

  for (const selector of selectors) {
    const buttons = tab.playwright.locator(selector);
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      try {
        const button = buttons.nth(i);
        await button.click({ timeout: 10000, force: true });
        await sleep(900);
        const hasMenu = await tab.playwright
          .evaluate(() => {
            return [...document.querySelectorAll('[role="menu"], [role="menuitem"]')]
              .some((node) => {
                const text = node.innerText || node.textContent || "";
                return /(重命名|Rename)/.test(text);
              });
          }, undefined, { timeoutMs: 1500 })
          .catch(() => false);
        if (hasMenu) return { ok: true, status: "menu_opened", selector, currentName };
      } catch {
        // Try next visible options button.
      }
    }
  }

  const sidebarFallbackSelectors = [
    'nav button[data-testid="undefined-options"]',
    'aside button[data-testid="undefined-options"]',
    '[data-testid*="sidebar" i] button[data-testid="undefined-options"]',
    '[class*="sidebar" i] button[data-testid="undefined-options"]',
    'nav button[aria-label*="对话选项"]',
    'aside button[aria-label*="对话选项"]',
    'nav button[aria-label*="conversation options" i]',
    'aside button[aria-label*="conversation options" i]',
  ];
  for (const selector of sidebarFallbackSelectors) {
    const buttons = tab.playwright.locator(selector);
    const count = await buttons.count().catch(() => 0);
    const visible = [];
    for (let i = 0; i < count; i += 1) {
      try {
        const button = buttons.nth(i);
        if (await button.isVisible()) visible.push(button);
      } catch {
        // Ignore stale candidate.
      }
    }
    if (visible.length !== 1) continue;
    try {
      await visible[0].click({ timeout: 10000, force: true });
      await sleep(900);
      const hasMenu = await tab.playwright
        .evaluate(() => {
          return [...document.querySelectorAll('[role="menu"], [role="menuitem"]')]
            .some((node) => {
              const text = node.innerText || node.textContent || "";
              return /(重命名|Rename)/.test(text);
            });
        }, undefined, { timeoutMs: 1500 })
        .catch(() => false);
      if (hasMenu) return { ok: true, status: "menu_opened", selector, currentName, fallback: "single_visible_sidebar_options" };
    } catch {
      // Try next fallback selector.
    }
  }
  const topMenu = await clickTopConversationOptions(tab);
  if (topMenu.ok) return { ...topMenu, currentName };
  return { ok: false, status: "conversation_options_unavailable", currentName };
}

async function clickMenuItemByText(tab, labels) {
  const items = tab.playwright.locator('[role="menuitem"], button');
  const count = await items.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i -= 1) {
    const item = items.nth(i);
    try {
      const text = await item.innerText({ timeoutMs: 500 });
      if (!text) continue;
      if (labels.some((label) => text.trim() === label || text.includes(label))) {
        await item.click({ timeout: 10000, force: true });
        return true;
      }
    } catch {
      // Try next menu item.
    }
  }
  return false;
}

async function hasRenameMenu(tab) {
  return tab.playwright
    .evaluate(() => {
      return [...document.querySelectorAll('[role="menu"], [role="menuitem"]')]
        .some((node) => {
          const text = node.innerText || node.textContent || "";
          return /(重命名|Rename)/.test(text);
        });
    }, undefined, { timeoutMs: 1500 })
    .catch(() => false);
}

async function clickConversationOptionsByConversationId(tab, status) {
  const url = isConversationUrl(status.conversation_url)
    ? String(status.conversation_url)
    : (await tab.url().catch(() => ""));
  const conversationId = conversationIdFromUrl(url);
  if (!conversationId) return { ok: false, status: "conversation_id_unavailable" };
  const clicked = await tab.playwright
    .evaluate((id) => {
      const links = [...document.querySelectorAll("a[href]")]
        .filter((anchor) => String(anchor.href || "").includes(`/c/${id}`));
      for (const link of links) {
        let row = link;
        for (let depth = 0; row && depth < 8; depth += 1, row = row.parentElement) {
          const buttons = [...row.querySelectorAll("button")];
          for (const button of buttons) {
            const descriptor = [
              button.getAttribute("aria-label") || "",
              button.getAttribute("data-testid") || "",
              button.textContent || "",
            ].join(" ");
            if (!/(undefined-options|对话选项|conversation options|Open .*options|打开.*选项)/i.test(descriptor)) continue;
            if (/(backend-api\/estuary\/content|download|save|upload_bundle|下载|保存)/i.test(descriptor)) continue;
            const eventOptions = { bubbles: true, cancelable: true, view: window };
            row.dispatchEvent(new MouseEvent("mouseover", eventOptions));
            row.dispatchEvent(new MouseEvent("mouseenter", eventOptions));
            button.dispatchEvent(new MouseEvent("mouseover", eventOptions));
            button.click();
            return { ok: true, status: "clicked", linkCount: links.length, descriptor: descriptor.slice(0, 160) };
          }
        }
      }
      return { ok: false, status: "no_conversation_options_button", linkCount: links.length };
    }, conversationId, { timeoutMs: 5000 })
    .catch((error) => ({ ok: false, status: "conversation_link_click_error", error: error?.message || String(error) }));
  if (!clicked.ok) return { ...clicked, conversationId };
  await sleep(900);
  if (await hasRenameMenu(tab)) return { ok: true, status: "menu_opened", selector: `a[href*="/c/${conversationId}"]`, fallback: "conversation_link", conversationId };
  return { ok: false, status: "conversation_link_menu_missing", conversationId };
}

async function clickTopConversationOptions(tab) {
  const clicked = await tab.playwright
    .evaluate(() => {
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const buttons = [...document.querySelectorAll("button")];
      const candidates = [];
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        if (!rect || rect.width < 8 || rect.height < 8) continue;
        if (rect.bottom < 0 || rect.top > 320) continue;
        if (viewportWidth && rect.left < viewportWidth * 0.62) continue;
        const descriptor = [
          button.getAttribute("aria-label") || "",
          button.getAttribute("title") || "",
          button.getAttribute("data-testid") || "",
          button.innerText || button.textContent || "",
        ].join(" ").trim();
        if (/(backend-api\/estuary\/content|download|save|upload_bundle|attach|attachment|file|下载|保存|上传|附件|文件|分享|Share)/i.test(descriptor)) continue;
        const looksLikeMore = /(更多|More|options|menu|ellipsis|^\s*\.{3}\s*$|^\s*…\s*$)/i.test(descriptor);
        const compactIcon = rect.width <= 56 && rect.height <= 56 && button.querySelector("svg");
        if (!looksLikeMore && !compactIcon) continue;
        candidates.push({ button, descriptor, left: rect.left, top: rect.top });
      }
      candidates.sort((a, b) => (b.left - a.left) || (a.top - b.top));
      for (const candidate of candidates) {
        candidate.button.click();
        return {
          ok: true,
          status: "clicked",
          descriptor: String(candidate.descriptor || "").slice(0, 160),
          left: Math.round(candidate.left),
          top: Math.round(candidate.top),
        };
      }
      return { ok: false, status: "no_header_options_candidate" };
    }, undefined, { timeoutMs: 5000 })
    .catch((error) => ({ ok: false, status: "header_options_click_error", error: error?.message || String(error) }));
  if (!clicked.ok) return clicked;
  await sleep(900);
  if (await hasRenameMenu(tab)) return { ok: true, status: "menu_opened", fallback: "top_conversation_options", descriptor: clicked.descriptor };
  await tab.playwright.locator("body").press("Escape", { timeout: 2000 }).catch(() => false);
  return { ok: false, status: "header_options_menu_missing", descriptor: clicked.descriptor, left: clicked.left, top: clicked.top };
}

async function renameConversationIfPossible(tab, runDir, status, options = {}) {
  const desired = String(status.conversation_title || "").trim();
  if (!desired) return { ok: false, status: "rename_skipped_no_title" };
  if (!shouldAutoRename(status, options)) {
    await writeStatus(runDir, { rename_status: "rename_skipped_disabled", rename_target: desired });
    return { ok: false, status: "rename_skipped_disabled" };
  }
  await installDownloadClickGuard(tab).catch(() => false);
  try {
    const deadline = Date.now() + (options.renameMenuTimeoutMs || 30000);
    let menu = { ok: false, status: "rename_menu_not_attempted" };
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      menu = await clickCurrentConversationOptions(tab, status);
      if (menu.ok) break;
      await sleep(2000);
    }
    if (!menu.ok) {
      await writeStatus(runDir, {
        rename_status: "rename_unavailable_no_sidebar_button",
        rename_target: desired,
        rename_menu_status: menu.status || "",
        rename_menu_current_name: menu.currentName || "",
        rename_menu_detail: menu.error || menu.descriptor || "",
        rename_menu_attempts: attempts,
      });
      return { ok: false, status: "rename_unavailable_no_sidebar_button" };
    }
    if (!(await clickMenuItemByText(tab, ["重命名", "Rename"]))) {
      await writeStatus(runDir, { rename_status: "rename_unavailable_no_menu_item", rename_target: desired });
      return { ok: false, status: "rename_unavailable_no_menu_item" };
    }
    await sleep(800);
    const titleInput = tab.playwright.locator('input[aria-label="聊天标题"], input[aria-label="Chat title"], input[type="text"]');
    if ((await titleInput.count().catch(() => 0)) === 0) {
      await writeStatus(runDir, { rename_status: "rename_unavailable_no_input", rename_target: desired });
      return { ok: false, status: "rename_unavailable_no_input" };
    }
    const input = titleInput.first();
    await input.click({ timeout: 10000 });
    await input.press("Meta+A", { timeout: 5000 });
    await input.press("Backspace", { timeout: 5000 });
    await pressText(input, desired);
    await input.press("Enter", { timeout: 5000 });
    await sleep(2500);
    const observedTitle = (await tab.title()) || "";
    const visible = await visibleText(tab);
    const ok = visible.includes(desired) || observedTitle.includes(desired);
    await writeStatus(runDir, {
      rename_status: ok ? "renamed" : "rename_verification_failed",
      rename_target: desired,
      browser_title_observed: sanitizeText(observedTitle),
    });
    if (ok) await updateRegistryFromStatus(runDir, { title: desired }).catch(() => false);
    return { ok, status: ok ? "renamed" : "rename_verification_failed", observedTitle };
  } catch (error) {
    const message = sanitizeText(error && error.message ? error.message : String(error));
    await writeStatus(runDir, { rename_status: "rename_error", rename_target: desired, rename_error: message });
    return { ok: false, status: "rename_error", error: message };
  }
}

async function saveConversation(runDir, tab, titleOverride = "") {
  const url = (await tab.url()) || "";
  const actualTitle = (await tab.title()) || "";
  const payload = {
    url: sanitizeText(url),
    title: sanitizeText(actualTitle),
    intended_title: sanitizeText(titleOverride || ""),
    saved_at: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(runDir, "conversation.json"), payload);
  const patch = {
    browser_title: payload.title,
    intended_conversation_title: payload.intended_title,
    last_browser_url: payload.url,
  };
  if (isConversationUrl(payload.url)) patch.conversation_url = payload.url;
  const currentStatus = await writeStatus(runDir, patch);
  if (patch.conversation_url && isProjectConversationUrl(patch.conversation_url, currentStatus.project_url || "")) {
    await updateRegistryFromStatus(runDir, { conversationUrl: patch.conversation_url, title: payload.intended_title || payload.title }).catch(() => false);
  }
  return payload;
}

async function runOne(browser, runDir, options = {}) {
  runDir = path.resolve(runDir);
  const status = await readJson(path.join(runDir, "status.json"));
  const canReuseExisting = status.conversation_policy === "reuse_existing" || status.reuse_existing === true;
  const rawExistingConversationUrl = canReuseExisting && isConversationUrl(status.conversation_url) ? String(status.conversation_url) : "";
  const existingConversationUrl = rawExistingConversationUrl &&
    (!status.project_url || isProjectConversationUrl(rawExistingConversationUrl, status.project_url))
    ? rawExistingConversationUrl
    : "";
  let tab = existingConversationUrl ? await claimMatchingRunTab(browser, status).catch(() => null) : null;
  if (!tab) tab = await browser.tabs.new();
  const keepTabs = [];
  const answer = {
    runDir,
    run_id: status.run_id,
    status: "started",
    conversation_url: "",
    kept: false,
  };
  try {
    await writeStatus(runDir, { state: "opening_chrome_tab" });
    if (rawExistingConversationUrl && !existingConversationUrl) {
      await writeStatus(runDir, {
        state: "conversation_project_stale",
        stale_conversation_url: rawExistingConversationUrl,
        conversation_url: "",
        registry_conversation_available: false,
        registry_conversation_stale: true,
        stale_reason: "conversation_project_mismatch",
      });
    }
    if (existingConversationUrl) {
      await tab.goto(existingConversationUrl);
      await waitForLoad(tab, 20000);
      const currentConversationUrl = await tab.url().catch(() => "");
      if (status.project_url && !isProjectConversationUrl(currentConversationUrl, status.project_url)) {
        await writeStatus(runDir, {
          state: "conversation_project_stale",
          stale_conversation_url: existingConversationUrl,
          non_project_conversation_url: currentConversationUrl,
          conversation_url: "",
          registry_conversation_available: false,
          registry_conversation_stale: true,
          stale_reason: "conversation_project_mismatch_after_open",
        });
      } else {
      const text = await visibleText(tab);
      const pageState = classifyChatGptPage(text);
      if (pageState !== "ok") {
        if (pageState === "login_required" || pageState === "human_verification_required") {
          answer.status = pageState;
          keepTabs.push(keepEntryForStatus(tab, answer.status));
          await writeStatus(runDir, { state: answer.status, error: text?.slice(0, 2000) || "" });
          return { answer, keepTabs };
        }
        await writeStatus(runDir, {
          state: "conversation_url_rejected",
          stale_conversation_url: existingConversationUrl,
          conversation_url: "",
          error: text?.slice(0, 2000) || pageState,
        });
      } else if (looksLikeMissingConversation(text)) {
        await writeStatus(runDir, {
          state: "conversation_missing",
          stale_conversation_url: existingConversationUrl,
          conversation_url: "",
          error: text.slice(0, 2000),
        });
      } else {
        await writeStatus(runDir, { state: "conversation_reused", expected_conversation_url: existingConversationUrl });
        const mode = await ensureMode(tab, status.required_mode_label || DEFAULT_MODE_LABEL);
        if (!mode.ok) {
          answer.status = mode.status;
          keepTabs.push(keepEntryForStatus(tab, answer.status));
          await writeStatus(runDir, { state: answer.status, error: mode.detail || "" });
          return { answer, keepTabs };
        }
        const zipPath = status.upload_bundle;
        if (zipPath) {
          await writeStatus(runDir, { state: "uploading" });
          const upload = await uploadBundleWithRetry(tab, zipPath);
          if (!upload.ok) {
            answer.status = upload.status || "upload_failed";
            keepTabs.push(keepEntryForStatus(tab, answer.status));
            await writeStatus(runDir, { state: answer.status, upload_attempts: upload.attempt || 1, error: upload.text?.slice(0, 4000) || "" });
            return { answer, keepTabs };
          }
          await writeStatus(runDir, { upload_confirmed: true, upload_attempts: upload.attempt || 1, state: "upload_confirmed", error: "" });
        }
        const submitted = await submitPromptAndMaybeWatch(tab, runDir, status, options);
        answer.status = submitted.status;
        answer.conversation_url = await latestConversationUrlForRun(runDir, answer.conversation_url);
        keepTabs.push(...submitted.keepTabs);
        if (answer.status === "success" && !shouldKeepOpen(status, options)) await closeTabQuietly(tab);
        return { answer, keepTabs };
      }
      }
    }

    {
      const { startup, project } = await openProjectForStatus(tab, status);
      if (!startup.ok) {
        answer.status = startup.status;
        keepTabs.push(keepEntryForStatus(tab, answer.status));
        await writeStatus(runDir, { state: answer.status, error: startup.text?.slice(0, 2000) || "" });
        return { answer, keepTabs };
      }
      if (!project.ok) {
        answer.status = project.status;
        keepTabs.push(keepEntryForStatus(tab, answer.status));
        await writeStatus(runDir, { state: answer.status, error: project.detail || "" });
        return { answer, keepTabs };
      }
      if (project.href) {
        await writeStatus(runDir, { project_url: project.href, project_slug: projectSlugFromProjectUrl(project.href) });
      }
    }

    const mode = await ensureMode(tab, status.required_mode_label || DEFAULT_MODE_LABEL);
    if (!mode.ok) {
      answer.status = mode.status;
      keepTabs.push(keepEntryForStatus(tab, answer.status));
      await writeStatus(runDir, { state: answer.status, error: mode.detail || "" });
      return { answer, keepTabs };
    }

    const zipPath = status.upload_bundle;
    if (zipPath) {
      await writeStatus(runDir, { state: "uploading" });
      const upload = await uploadBundleWithRetry(tab, zipPath);
      if (!upload.ok) {
        answer.status = upload.status || "upload_failed";
        keepTabs.push(keepEntryForStatus(tab, answer.status));
        await writeStatus(runDir, { state: answer.status, upload_attempts: upload.attempt || 1, error: upload.text?.slice(0, 4000) || "" });
        return { answer, keepTabs };
      }
      await writeStatus(runDir, { upload_confirmed: true, upload_attempts: upload.attempt || 1, state: "upload_confirmed", error: "" });
    }

    const submitted = await submitPromptAndMaybeWatch(tab, runDir, status, options);
    answer.status = submitted.status;
    answer.conversation_url = await latestConversationUrlForRun(runDir, answer.conversation_url);
    keepTabs.push(...submitted.keepTabs);
    if (answer.status === "success" && !shouldKeepOpen(status, options)) await closeTabQuietly(tab);
    return { answer, keepTabs };
  } catch (error) {
    answer.status = isTabNotFoundError(error) ? "tab_lost" : "error";
    answer.error = sanitizeText(error && error.message ? error.message : String(error));
    if (answer.status === "error") keepTabs.push(keepEntryForStatus(tab, "error"));
    await writeStatus(runDir, { state: answer.status, error: answer.error });
    return { answer, keepTabs };
  }
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = index;
      index += 1;
      try {
        results[current] = await worker(items[current], current);
      } catch (error) {
        results[current] = {
          item: items[current],
          status: "error",
          error: sanitizeText(error && error.message ? error.message : String(error)),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return results;
}

export async function runGptProReview(options) {
  const releaseSlot = await acquireChromeOperationSlot({ slots: options.chromeOperationSlots || DEFAULT_CHROME_OPERATION_SLOTS });
  let browser;
  try {
    browser = await setupChrome();
    const result = await withRunLock(path.resolve(options.runDir), () => runOne(browser, path.resolve(options.runDir), options));
    const kept = await finalizeBrowserTabs(browser, result.keepTabs);
    const status = await readJson(path.join(path.resolve(options.runDir), "status.json")).catch(() => ({}));
    await closeStrayProjectTabs(browser, status).catch(() => 0);
    const conversationUrl = await latestConversationUrlForRun(path.resolve(options.runDir), result.answer.conversation_url);
    return { ...result.answer, conversation_url: conversationUrl, keptTabs: kept };
  } finally {
    await releaseSlot();
  }
}

export async function runGptProReviewBatch(options) {
  const runDirs = (options.runDirs || []).map((item) => path.resolve(item));
  const concurrency = chooseConcurrency(runDirs, options.concurrency || DEFAULT_CONCURRENCY, options.maxConcurrency || MAX_CONCURRENCY);
  const setupReleaseSlot = await acquireChromeOperationSlot({ slots: options.chromeOperationSlots || DEFAULT_CHROME_OPERATION_SLOTS });
  let browser;
  try {
    browser = await setupChrome();
  } finally {
    await setupReleaseSlot();
  }
  const keepTabs = [];
  const results = await runPool(runDirs, concurrency, async (runDir) => {
    const releaseSlot = await acquireChromeOperationSlot({ slots: options.chromeOperationSlots || DEFAULT_CHROME_OPERATION_SLOTS });
    let result;
    try {
      result = await withRunLock(runDir, () => runOne(browser, runDir, options));
    } finally {
      await releaseSlot();
    }
    keepTabs.push(...result.keepTabs.filter(Boolean));
    result.answer.conversation_url = await latestConversationUrlForRun(runDir, result.answer.conversation_url);
    return result.answer;
  });
  const kept = await finalizeBrowserTabs(browser, keepTabs);
  return {
    runDirs,
    concurrency,
    maxConcurrency: MAX_CONCURRENCY,
    answers: results,
    keptTabs: kept,
  };
}

export async function resumeGptProReview(options) {
  const runDir = path.resolve(options.runDir);
  const status = await readJson(path.join(runDir, "status.json"));
  const release = await acquireRunLock(status);
  const releaseSlot = await acquireChromeOperationSlot({ slots: options.chromeOperationSlots || DEFAULT_CHROME_OPERATION_SLOTS });
  try {
  const browser = await setupChrome();
  const rawStatusConversationUrl = isConversationUrl(status.conversation_url) ? String(status.conversation_url) : "";
  const statusConversationUrl = rawStatusConversationUrl &&
    (!status.project_url || isProjectConversationUrl(rawStatusConversationUrl, status.project_url))
    ? rawStatusConversationUrl
    : "";
  const statusForClaim = { ...status, conversation_url: statusConversationUrl };
  const existingResponsePath = path.join(runDir, "response.md");
  const existingResponse = await fs.readFile(existingResponsePath, "utf8").catch(() => "");
  if (existingResponse && responseMatchesRun(existingResponse, status)) {
    const maybeTab = await claimMatchingRunTab(browser, statusForClaim).catch(() => null);
    if (maybeTab && !shouldKeepOpen(status, options)) await closeTabQuietly(maybeTab);
    const keepExisting = maybeTab && shouldKeepOpen(status, options) ? [keepEntryForStatus(maybeTab, "kept_open")] : [];
    await writeStatus(runDir, { state: "completed", error: "", resumed: true, completed_at: new Date().toISOString() });
    const kept = await finalizeBrowserTabs(browser, keepExisting);
    return { runDir, status: "success", keptTabs: kept, existingResponse: true };
  }
  if (rawStatusConversationUrl && !statusConversationUrl) {
    await writeStatus(runDir, {
      state: "conversation_project_stale",
      stale_conversation_url: rawStatusConversationUrl,
      conversation_url: "",
      registry_conversation_available: false,
      registry_conversation_stale: true,
      stale_reason: "conversation_project_mismatch_on_resume",
      resumed: true,
    });
  }
  let tab = await claimMatchingRunTab(browser, statusForClaim);
  if (!tab && statusConversationUrl) {
    tab = await browser.tabs.new();
    await tab.goto(statusConversationUrl);
    await waitForLoad(tab, 20000);
  }
  let openedFreshUploadRetry = false;
  if (!tab && status.upload_bundle && uploadRecoveryStates().has(String(status.state || ""))) {
    tab = await browser.tabs.new();
    const { startup, project } = await openProjectForStatus(tab, status);
    if (!startup.ok) {
      await writeStatus(runDir, { state: startup.status, error: startup.text?.slice(0, 2000) || "", resumed: true });
      await finalizeBrowserTabs(browser, [keepEntryForStatus(tab, startup.status)]);
      return { runDir, status: startup.status, keptTabs: 1, conversation_url: await latestConversationUrlForRun(runDir) };
    }
    if (!project.ok) {
      await writeStatus(runDir, { state: project.status, error: project.detail || "", resumed: true });
      await finalizeBrowserTabs(browser, [keepEntryForStatus(tab, project.status)]);
      return { runDir, status: project.status, keptTabs: 1, conversation_url: await latestConversationUrlForRun(runDir) };
    }
    if (project.href) {
      await writeStatus(runDir, { project_url: project.href, project_slug: projectSlugFromProjectUrl(project.href), resumed: true });
    }
    const mode = await ensureMode(tab, status.required_mode_label || DEFAULT_MODE_LABEL);
    if (!mode.ok) {
      await writeStatus(runDir, { state: mode.status, error: mode.detail || "", resumed: true });
      await finalizeBrowserTabs(browser, [keepEntryForStatus(tab, mode.status)]);
      return { runDir, status: mode.status, keptTabs: 1, conversation_url: await latestConversationUrlForRun(runDir) };
    }
    openedFreshUploadRetry = true;
    await writeStatus(runDir, { state: "upload_retry_new_tab", resumed: true, error: "" });
  }
  if (!tab) {
    throw new Error("No resumable ChatGPT tab was found through Chrome runtime. Open the saved conversation URL and retry.");
  }

  if (status.upload_bundle && uploadRecoveryStates().has(String(status.state || ""))) {
    const upload = status.upload_confirmed && !openedFreshUploadRetry
      ? await waitForUploadConfirmation(tab, status.upload_bundle, 30000)
      : await uploadBundleWithRetry(tab, status.upload_bundle, { timeoutMs: 60000 });
    if (!upload.ok && !status.upload_confirmed) {
      await writeStatus(runDir, { state: upload.status || "upload_failed", upload_attempts: upload.attempt || 1, resumed: true, error: upload.text?.slice(0, 4000) || "" });
      await finalizeBrowserTabs(browser, [keepEntryForStatus(tab, upload.status || "upload_failed")]);
      return { runDir, status: upload.status || "upload_failed", keptTabs: 1, conversation_url: await latestConversationUrlForRun(runDir) };
    }
    await writeStatus(runDir, { upload_confirmed: true, upload_attempts: upload.attempt || 1, state: "upload_confirmed", error: "", resumed: true });
    const submitted = await submitPromptAndMaybeWatch(tab, runDir, status, options);
    if (submitted.status === "success" && !shouldKeepOpen(status, options)) await closeTabQuietly(tab);
    await finalizeBrowserTabs(browser, submitted.keepTabs);
    return { runDir, status: submitted.status, keptTabs: submitted.keepTabs.length, conversation_url: await latestConversationUrlForRun(runDir) };
  }

  const result = await waitForCompletion(tab, runDir, effectiveWatchTimeout(options));
  if (!result.ok) {
    await fs.writeFile(path.join(runDir, "response.partial.md"), (result.response || "") + "\n");
    await writeStatus(runDir, { state: result.status, resumed: true });
    await finalizeBrowserTabs(browser, [keepEntryForStatus(tab, result.status)]);
    return { runDir, status: result.status, keptTabs: 1, conversation_url: await latestConversationUrlForRun(runDir) };
  }
  if (!responseMatchesRun(result.response, status)) {
    await fs.writeFile(path.join(runDir, "response.partial.md"), result.response + "\n");
    await writeStatus(runDir, {
      state: "extract_failed",
      error: "Extracted response did not match this run topic/run id.",
      resumed: true,
    });
    await finalizeBrowserTabs(browser, [keepEntryForStatus(tab, "extract_failed")]);
    return { runDir, status: "extract_failed", keptTabs: 1, conversation_url: await latestConversationUrlForRun(runDir) };
  }
  await fs.writeFile(path.join(runDir, "response.md"), result.response + "\n");
  await saveConversation(runDir, tab, status.conversation_title || "");
  const renameStatus = await readJson(path.join(runDir, "status.json"));
  await renameConversationIfPossible(tab, runDir, renameStatus, options);
  await writeStatus(runDir, { state: "completed", error: "", resumed: true, completed_at: new Date().toISOString() });
  const keepTabs = shouldKeepOpen(status, options) ? [keepEntryForStatus(tab, "kept_open")] : [];
  if (!shouldKeepOpen(status, options)) await closeTabQuietly(tab);
  const kept = await finalizeBrowserTabs(browser, keepTabs);
  return { runDir, status: "success", keptTabs: kept, conversation_url: await latestConversationUrlForRun(runDir) };
  } finally {
    await releaseSlot();
    await release();
  }
}

async function claimMatchingRunTab(browser, status) {
  const openTabs = await browser.user.openTabs();
  const runId = String(status.run_id || "");
  const topic = String(status.topic || "");
  const titleNeedle = String(status.conversation_title || "");
  const conversationUrl = String(status.conversation_url || "");
  const needles = titleSearchNeedles(status);
  const candidates = openTabs
    .filter((tab) => String(tab.url || "").includes("chatgpt.com") && !isChatGptFileContentUrl(tab.url || ""))
    .map((tab) => {
      const url = String(tab.url || "");
      const title = String(tab.title || "");
      let score = 1;
      if (String(tab.tabGroup || "").includes("GPT Pro review")) score += 50;
      if (conversationUrl && conversationUrl.includes("/c/") && url === conversationUrl) score += 200;
      if (titleNeedle && title.includes(titleNeedle)) score += 100;
      if (topic && title.includes(topic)) score += 60;
      if (needles.some((needle) => title.includes(needle))) score += 30;
      return { tab, score };
    })
    .sort((a, b) => b.score - a.score);

  let fallback = null;
  for (const { tab: info } of candidates) {
    const claimed = await browser.user.claimTab(info);
    const url = String((await claimed.url()) || "");
    const title = String((await claimed.title()) || "");
    if (conversationUrl && conversationUrl.includes("/c/") && url === conversationUrl) return claimed;
    const text = await visibleText(claimed).catch(() => "");
    if (
      (runId && text.includes(runId)) ||
      (topic && text.includes(topic)) ||
      (titleNeedle && title.includes(titleNeedle)) ||
      needles.some((needle) => title.includes(needle) || text.includes(needle))
    ) {
      return claimed;
    }
    if (!fallback) fallback = claimed;
  }
  return candidates.length === 1 ? fallback : null;
}

export async function doctorChrome() {
  const browser = await setupChrome();
  const tabs = await browser.tabs.list();
  const tab = await browser.tabs.new();
  try {
    await tab.goto(CHATGPT_URL);
    await waitForLoad(tab);
    const text = await visibleText(tab);
    const pageState = classifyChatGptPage(text);
    return {
      ok: pageState === "ok",
      browser: "extension",
      openAgentTabs: tabs.length,
      chatgpt_page_state: pageState,
      requiredModeLabel: DEFAULT_MODE_LABEL,
      defaultProjectName: DEFAULT_PROJECT_NAME,
      defaultProjectUrl: DEFAULT_PROJECT_URL,
    };
  } finally {
    await closeTabQuietly(tab);
  }
}

export async function neutralChromeSmoke(tabCount = 3) {
  const browser = await setupChrome();
  const tabs = [];
  for (let i = 0; i < tabCount; i += 1) {
    tabs.push(await browser.tabs.new());
  }
  const before = await browser.tabs.list();
  for (const tab of tabs) await closeTabQuietly(tab);
  const after = await browser.tabs.list();
  return {
    createdIds: tabs.map((tab) => tab.id),
    uniqueIds: new Set(tabs.map((tab) => tab.id)).size,
    beforeFinalize: before.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })),
    afterFinalize: after.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })),
  };
}

export const __testing = {
  chooseConcurrency,
  sanitizeText,
  redactValue,
  classifyChatGptPage,
  isConversationUrl,
  projectSlugFromProjectUrl,
  isProjectConversationUrl,
  shouldKeepOpen,
  shouldAutoRename,
  shouldAllowEnterSubmit,
  expectedConversationUrl,
  titleSearchNeedles,
  uploadRecoveryStates,
  latestConversationUrlForRun,
  submissionStateFromText,
  isChatGptFileContentUrl,
  isDangerousChatGptFileDescriptor,
  isTabNotFoundError,
  looksLikeSendButtonDescriptor,
  looksLikeComposerSendDescriptor,
  clickComposerScopedSubmitButton,
  clickSafeSendButtonWithWait,
  looksLikeUploadControlDescriptor,
  findProjectHref,
  uploadStateFromText,
  stripThinkingText,
  looksLikeFinalReviewResponse,
  responseMatchesRun,
  lockNameForStatus,
  pidAppearsAlive,
  lockHolderAppearsOrphaned,
  staleOrOrphanLockReason,
  removeLockIfStaleOrOrphaned,
  acquireRunLock,
  acquireChromeOperationSlot,
  finalizeKeepEntries,
  finalizeBrowserTabs,
  closeStrayProjectTabs,
  closeTabQuietly,
  keepEntryForStatus,
  runPool,
  defaultConcurrency: DEFAULT_CONCURRENCY,
  maxConcurrency: MAX_CONCURRENCY,
  defaultChromeOperationSlots: DEFAULT_CHROME_OPERATION_SLOTS,
  defaultProjectName: DEFAULT_PROJECT_NAME,
  defaultProjectUrl: DEFAULT_PROJECT_URL,
  doneStableChecks: DONE_STABLE_CHECKS,
  defaultWatchSliceMs: DEFAULT_WATCH_SLICE_MS,
  quickDoneMinChars: QUICK_DONE_MIN_CHARS,
  quickDoneAfterMs: QUICK_DONE_AFTER_MS,
  handoffStatuses: [...HANDOFF_STATUSES],
};
