import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-review-runner-test-"));
process.env.GPT_REVIEW_STATE_ROOT = stateRoot;
const runner = await import(`../scripts/gpt_chrome_runner.mjs?test=${Date.now()}`);
const t = runner.__testing;

assert.equal(t.defaultConcurrency, 5);
assert.equal(t.maxConcurrency, 6);
assert.equal(t.defaultChromeOperationSlots, 5);
assert.equal(t.defaultProjectName, "your ChatGPT Project");
assert.equal(t.defaultProjectUrl, "https://chatgpt.com/g/g-p-your-project/project");
assert.equal(t.quickDoneMinChars, 300);
assert.equal(t.defaultWatchSliceMs, 75 * 1000);
assert.equal(t.chooseConcurrency([1, 2, 3, 4, 5], "auto"), 5);
assert.equal(t.chooseConcurrency([1, 2, 3, 4, 5], 4), 4);
assert.equal(t.chooseConcurrency([1, 2, 3, 4, 5], 4, 2), 2);
assert.equal(t.chooseConcurrency([1], 4), 1);

assert.equal(t.classifyChatGptPage("Log in to ChatGPT"), "login_required");
assert.equal(t.classifyChatGptPage("Please verify you are human"), "human_verification_required");
assert.equal(t.classifyChatGptPage("Ask anything"), "ok");
assert.equal(t.classifyChatGptPage("进阶专业\n无法加载订阅：Something went wrong.\n你在忙什么？"), "ok");
assert.equal(t.classifyChatGptPage("Something went wrong. Network error."), "page_error");
assert.equal(t.isConversationUrl("https://chatgpt.com/g/g-p-demo/project"), false);
assert.equal(t.isConversationUrl("https://chatgpt.com/g/g-p-demo/c/abc123"), true);
assert.equal(t.isChatGptFileContentUrl("https://chatgpt.com/backend-api/estuary/content?id=file_123"), true);
assert.equal(t.isChatGptFileContentUrl("https://chatgpt.com/g/g-p-demo/c/abc123"), false);
assert.equal(t.projectSlugFromProjectUrl("https://chatgpt.com/g/g-p-demo/project"), "g-p-demo");
assert.equal(t.isProjectConversationUrl("https://chatgpt.com/g/g-p-demo/c/abc123", "https://chatgpt.com/g/g-p-demo/project"), true);
assert.equal(t.isProjectConversationUrl("https://chatgpt.com/g/g-p-demo/c/abc123", "https://chatgpt.com/g/g-p-demo-codex-reviews/project"), true);
assert.equal(t.isProjectConversationUrl("https://chatgpt.com/c/abc123", "https://chatgpt.com/g/g-p-demo/project"), false);
assert.equal(t.shouldKeepOpen({ keep_open: true }, {}), true);
assert.equal(t.shouldKeepOpen({ keep_open: false }, { keepOpen: true }), true);
assert.equal(t.shouldKeepOpen({ keep_open: false }, {}), false);
assert.equal(t.shouldAutoRename({ auto_rename: true }, {}), true);
assert.equal(t.shouldAutoRename({ auto_rename: false }, { autoRename: true }), true);
assert.equal(t.shouldAutoRename({ auto_rename: false }, {}), false);
assert.equal(t.shouldAllowEnterSubmit({ allow_enter_submit: true }, {}), true);
assert.equal(t.shouldAllowEnterSubmit({ allow_enter_submit: false }, { allowEnterSubmit: true }), true);
assert.equal(t.shouldAllowEnterSubmit({ allow_enter_submit: false }, {}), false);
assert.equal(t.expectedConversationUrl({ conversation_policy: "reuse_existing", expected_conversation_url: "https://chatgpt.com/c/abc" }), "https://chatgpt.com/c/abc");
assert.equal(t.expectedConversationUrl({ conversation_policy: "reuse_existing", registry_conversation_available: true, conversation_url: "https://chatgpt.com/c/def" }), "https://chatgpt.com/c/def");
assert.equal(t.expectedConversationUrl({ registry_conversation_available: false, conversation_url: "https://chatgpt.com/c/ghi" }), "");
assert.equal(t.expectedConversationUrl({
  expected_conversation_url: "https://chatgpt.com/g/g-p-old-codex-reviews/c/abc",
  project_url: "https://chatgpt.com/g/g-p-your-project/project",
  conversation_policy: "reuse_existing",
}), "");
assert.equal(t.expectedConversationUrl({
  expected_conversation_url: "https://chatgpt.com/g/g-p-your-project/c/abc",
  project_url: "https://chatgpt.com/g/g-p-your-project/project",
  conversation_policy: "reuse_existing",
}), "https://chatgpt.com/g/g-p-your-project/c/abc");
assert.deepEqual(t.titleSearchNeedles({
  conversation_title: "Project Review",
  topic: "topic_a",
  stable_topic: "",
  registry_key: "rk",
}), ["Project Review", "topic_a", "rk"]);
assert.ok(t.uploadRecoveryStates().has("upload_confirmed"));
assert.ok(t.uploadRecoveryStates().has("submit_pending_conversation_url"));
assert.equal(t.uploadRecoveryStates().has("detached"), false);
assert.equal(t.submissionStateFromText("Review Project\nupload_bundle.zip\n压缩归档\n聊天\n来源\n尚无聊天", "upload_bundle.zip"), "not_sent");
assert.equal(t.submissionStateFromText("已思考 1m 53s\nGPT Pro web review", "upload_bundle.zip"), "generating");
assert.equal(t.looksLikeSendButtonDescriptor("aria-label=Send message\ndata-testid=send-button"), true);
assert.equal(t.looksLikeSendButtonDescriptor("aria-label=发送消息\ndata-testid=send-button"), true);
assert.equal(t.looksLikeSendButtonDescriptor("upload_bundle.zip\naria-label=Download file\ntype=submit"), false);
assert.equal(t.looksLikeSendButtonDescriptor("downloadLink.href=https://chatgpt.com/backend-api/estuary/content?id=file_123\naria-label=Send message"), false);
assert.equal(t.isDangerousChatGptFileDescriptor("href=https://chatgpt.com/backend-api/estuary/content?id=file_123"), true);
assert.equal(t.isDangerousChatGptFileDescriptor("aria-label=Send message\ndata-testid=send-button"), false);
assert.equal(t.isDangerousChatGptFileDescriptor("text=upload_bundle.zip"), true);
assert.equal(t.isTabNotFoundError(new Error("Tab not found: 123. Existing tabs: none")), true);
assert.equal(t.isTabNotFoundError(new Error("Network error")), false);
assert.equal(t.looksLikeSendButtonDescriptor("aria-label=上传文件\ntype=submit"), false);
assert.equal(t.looksLikeSendButtonDescriptor("type=submit"), false);
assert.equal(t.looksLikeComposerSendDescriptor("type=submit"), false);
assert.equal(t.looksLikeComposerSendDescriptor("closestRisky.href=https://chatgpt.com/backend-api/estuary/content?id=file_123\ntype=submit"), false);
assert.equal(t.looksLikeComposerSendDescriptor("aria-label=Send message\ndata-testid=send-button"), true);
assert.equal(t.looksLikeComposerSendDescriptor("aria-label=发送消息\ndata-testid=send-button"), true);
assert.equal(t.looksLikeUploadControlDescriptor("aria-label=Add files\ndata-testid=composer-plus-btn"), true);
assert.equal(t.looksLikeUploadControlDescriptor("aria-label=Attach files"), true);
assert.equal(t.looksLikeUploadControlDescriptor("aria-label=上传文件"), true);
assert.equal(t.looksLikeUploadControlDescriptor("upload_bundle.zip\naria-label=Download file"), false);
assert.equal(t.looksLikeUploadControlDescriptor("downloadLink.href=https://chatgpt.com/backend-api/estuary/content?id=file_123\naria-label=Upload file"), false);
assert.equal(t.looksLikeUploadControlDescriptor("aria-label=Remove upload_bundle.zip"), false);
assert.equal(t.uploadStateFromText("old failure chat\nupload_bundle.zip\n压缩归档", "upload_bundle.zip"), "confirmed");
assert.equal(t.uploadStateFromText("upload_bundle.zip\n上传中", "upload_bundle.zip"), "uploading");
assert.equal(t.uploadStateFromText("upload_bundle.zip\n上传失败", "upload_bundle.zip"), "failed");
assert.equal(
  t.stripThinkingText("思考\nprivate chain\nGPT Pro web review\nBlockers\nNone"),
  "GPT Pro web review\nBlockers\nNone",
);
assert.equal(t.responseMatchesRun("GPT Pro web review\nReview State\nTopic alpha", { topic: "alpha", run_id: "run-x" }), true);
assert.equal(t.responseMatchesRun("GPT Pro web review\nReview State", { topic: "alpha", run_id: "run-x" }), false);
assert.equal(t.responseMatchesRun("GPT Pro web review\nReview State", { topic: "default", run_id: "" }), false);
assert.equal(t.responseMatchesRun("GPT Pro web review\nReview State\nTopic default", { topic: "default", run_id: "" }), true);
assert.equal(t.looksLikeFinalReviewResponse("GPT Pro web review\nBlockers\nNone\nReview State\nTopic a"), true);
assert.equal(
  t.looksLikeFinalReviewResponse("GPT Pro web review format.\nThen provide:\n1. Blockers\n5. Review State"),
  false,
);
assert.equal(t.lockNameForStatus({ registry_key: "project/topic", run_id: "run" }), "project_topic");
assert.equal(t.pidAppearsAlive(999999999), false);

assert.match(t.sanitizeText("token=abcdef1234567890abcdef1234567890"), /<redacted>/);
assert.match(t.sanitizeText("bearer abcdef1234567890abcdef1234567890"), /<redacted>/);
assert.deepEqual(t.redactValue({
  session_root: "/tmp/gpt-session-root",
  session_id: "sensitive-session-id",
  auth_token: "sensitive-auth-token",
}), {
  session_root: "/tmp/gpt-session-root",
  session_id: "<redacted>",
  auth_token: "<redacted>",
});

const tabA = { id: 101 };
const tabB = { id: 102 };
assert.deepEqual(t.finalizeKeepEntries([{ tab: tabA, status: "handoff" }, tabB]), [
  { tab: tabA, status: "handoff", reason: "", tabId: 101 },
  { tab: tabB, status: "handoff", tabId: 102 },
]);
assert.equal(t.keepEntryForStatus(tabA, "success"), null);
assert.deepEqual(t.keepEntryForStatus(tabA, "login_required"), {
  tab: tabA,
  status: "handoff",
  reason: "login_required",
  tabId: 101,
});
assert.ok(t.handoffStatuses.includes("detached"));
assert.ok(t.handoffStatuses.includes("project_mismatch"));
assert.ok(t.handoffStatuses.includes("kept_open"));
assert.ok(t.handoffStatuses.includes("tab_lost"));
assert.ok(t.handoffStatuses.includes("submit_pending_conversation_url"));

let captured = null;
const fakeBrowser = {
  tabs: {
    async finalize(options) {
      captured = options;
    },
  },
};
const kept = await t.finalizeBrowserTabs(fakeBrowser, [{ tab: tabA, status: "handoff" }]);
assert.equal(kept, 1);
assert.equal(captured, null);
const keptAfterFinalizeError = await t.finalizeBrowserTabs({
  tabs: {
    async finalize() {
      throw new Error("No tab with id: 123");
    },
  },
}, []);
assert.equal(keptAfterFinalizeError, 0);

const lockStatus = {
  registry_key: `unit-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  run_id: "unit-run",
};
const releaseLock = await t.acquireRunLock(lockStatus, { timeoutMs: 1000, staleMs: 60_000 });
let contentionFailed = false;
try {
  await t.acquireRunLock(lockStatus, { timeoutMs: 50, staleMs: 60_000 });
} catch {
  contentionFailed = true;
}
assert.equal(contentionFailed, true);
await releaseLock();
const releaseLockAgain = await t.acquireRunLock(lockStatus, { timeoutMs: 1000, staleMs: 60_000 });
await releaseLockAgain();

const orphanStatus = {
  registry_key: `unit-orphan-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  run_id: "unit-orphan",
};
const orphanLockPath = path.join(
  stateRoot,
  "locks",
  `${t.lockNameForStatus(orphanStatus)}.chrome.lock`,
);
await fs.mkdir(orphanLockPath, { recursive: true });
await fs.writeFile(path.join(orphanLockPath, "holder.json"), JSON.stringify({
  pid: 999999999,
  runtime_instance_id: "dead-test-runtime",
  heartbeat_at: new Date().toISOString(),
}) + "\n");
assert.equal(await t.lockHolderAppearsOrphaned(orphanLockPath), true);
const releaseOrphanLock = await t.acquireRunLock(orphanStatus, { timeoutMs: 1000, staleMs: 60_000 });
await releaseOrphanLock();

const releaseSlotA = await t.acquireChromeOperationSlot({ slots: 2, timeoutMs: 1000, staleMs: 60_000 });
const releaseSlotB = await t.acquireChromeOperationSlot({ slots: 2, timeoutMs: 1000, staleMs: 60_000 });
let slotContentionFailed = false;
try {
  await t.acquireChromeOperationSlot({ slots: 2, timeoutMs: 50, staleMs: 60_000 });
} catch {
  slotContentionFailed = true;
}
assert.equal(slotContentionFailed, true);
await releaseSlotA();
await releaseSlotB();

const poolResults = await t.runPool([1, 2, 3], 2, async (item) => {
  if (item === 2) throw new Error("boom token=secret");
  return { item, status: "success" };
});
assert.deepEqual(poolResults[0], { item: 1, status: "success" });
assert.equal(poolResults[1].status, "error");
assert.doesNotMatch(poolResults[1].error, /secret/);
assert.deepEqual(poolResults[2], { item: 3, status: "success" });

console.log("ok");
