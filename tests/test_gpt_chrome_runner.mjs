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
assert.equal((await t.probeChatGptPageState({
  async url() {
    return "https://chatgpt.com/g/g-p-demo/c/existing";
  },
  playwright: {
    async evaluate() {
      return {
        bodyText: "Log in to ChatGPT\nGPT Pro web review\nBlockers\nNone\nReview State: complete",
        articleCount: 2,
        hasAssistantArticle: true,
        hasComposer: true,
        hasConversationStructure: true,
        hasLoginForm: false,
        hasHumanVerification: false,
        hasPageError: false,
      };
    },
  },
})).status, "ok");
assert.equal(typeof t.probeChatGptSurface, "function");
assert.equal(typeof t.completeRunWithResponse, "function");
assert.equal(typeof t.recordExtractionFailure, "function");
assert.equal((await t.probeChatGptPageState({
  async url() {
    return "https://chatgpt.com/g/g-p-demo/c/existing";
  },
  playwright: {
    async evaluate() {
      return {
        bodyText: "The review says a user may log in again after a network error.",
        articleCount: 1,
        hasAssistantArticle: true,
        hasComposer: true,
        hasConversationStructure: true,
        hasLoginForm: false,
        hasHumanVerificationControl: false,
        hasHumanVerificationBody: false,
        hasPageError: false,
      };
    },
  },
})).status, "ok");
assert.equal((await t.probeChatGptPageState({
  async url() {
    return "https://chatgpt.com/";
  },
  playwright: {
    async evaluate() {
      return {
        bodyText: "Welcome",
        articleCount: 0,
        hasAssistantArticle: false,
        hasComposer: false,
        hasConversationStructure: false,
        hasLoginForm: true,
        hasHumanVerificationControl: false,
        hasHumanVerificationBody: false,
        hasPageError: false,
      };
    },
  },
})).status, "login_required");
assert.equal((await t.probeChatGptPageState({
  async url() {
    return "https://chatgpt.com/";
  },
  playwright: {
    async evaluate() {
      return {
        bodyText: "Please verify you are human before continuing.",
        articleCount: 0,
        hasAssistantArticle: false,
        hasComposer: false,
        hasConversationStructure: false,
        hasLoginForm: false,
        hasHumanVerificationControl: false,
        hasHumanVerificationBody: true,
        hasPageError: false,
      };
    },
  },
})).status, "human_verification_required");
assert.equal(t.isConversationUrl("https://chatgpt.com/g/g-p-demo/project"), false);
assert.equal(t.isConversationUrl("https://chatgpt.com/g/g-p-demo/c/abc123"), true);
assert.equal(t.conversationIdFromUrl("https://chatgpt.com/g/g-p-demo/c/abc123?x=1"), "abc123");
assert.equal(
  t.sameConversationUrl(
    "https://chatgpt.com/g/g-p-demo/c/abc123?x=1",
    "https://chatgpt.com/g/g-p-demo-codex-common/c/abc123",
  ),
  true,
);
assert.equal(t.sameConversationUrl("https://chatgpt.com/g/g-p-demo/c/abc123", "https://chatgpt.com/g/g-p-demo/c/def456"), false);
{
  const runDir = await fs.mkdtemp(path.join(stateRoot, "strict-current-resume-miss-"));
  const conversationUrl = "https://chatgpt.com/g/g-p-your-project/c/6a153f09-57b4-83e8-bed1-e464e70e44d7";
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({
    state: "timeout",
    run_id: "strict-current-resume-miss",
    run_dir: runDir,
    topic: "live_smoke_strict_resume",
    conversation_policy: "new_per_run",
    project_url: t.defaultProjectUrl,
    conversation_url: conversationUrl,
    actual_conversation_url: conversationUrl,
    submit_confirmed: true,
  }, null, 2) + "\n");
  assert.equal(t.shouldStrictResumeRecordedRun(JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"))), true);
  let newTabCalled = false;
  const fakeBrowser = {
    async nameSession() {},
    tabs: {
      async new() {
        newTabCalled = true;
        throw new Error("tabs.new must not be called for submitted current-run resume");
      },
    },
    user: {
      async openTabs() {
        return [];
      },
      async claimTab() {
        throw new Error("no tabs to claim");
      },
    },
  };
  const result = await t.runOne(fakeBrowser, runDir, { watchTimeoutMs: 1 });
  assert.equal(result.answer.status, "resume_tab_missing");
  assert.equal(result.answer.conversation_url, conversationUrl);
  assert.equal(newTabCalled, false);
  const status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
  assert.equal(status.state, "resume_tab_missing");
  assert.equal(status.expected_conversation_url, conversationUrl);
}
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
assert.match(t.runSessionNameForStatus({ topic: "CBE Review", run_id: "20260526-130706-42851-c547d1" }), /^GPT Pro review CBE Review 20260526-130706-42851-/);
assert.equal(t.submittedStatePatch({ status: "generating" }).state, "generating");
assert.equal(t.submittedStatePatch({ status: "submitted" }).state, "submitted");
assert.equal(t.expectedConversationUrl({ expected_conversation_url: "https://chatgpt.com/c/abc" }), "");
assert.equal(t.expectedConversationUrl({ conversation_policy: "reuse_existing", expected_conversation_url: "https://chatgpt.com/c/abc" }), "https://chatgpt.com/c/abc");
assert.equal(t.expectedConversationUrl({ conversation_policy: "reuse_existing", registry_conversation_available: true, conversation_url: "https://chatgpt.com/c/def" }), "https://chatgpt.com/c/def");
assert.equal(t.expectedConversationUrl({ registry_conversation_available: false, conversation_url: "https://chatgpt.com/c/ghi" }), "");
assert.equal(t.expectedConversationUrl({
  conversation_policy: "reuse_existing",
  expected_conversation_url: "https://chatgpt.com/g/g-p-old-codex-reviews/c/abc",
  project_url: "https://chatgpt.com/g/g-p-your-project/project",
}), "");
assert.equal(t.expectedConversationUrl({
  conversation_policy: "reuse_existing",
  expected_conversation_url: "https://chatgpt.com/g/g-p-your-project/c/abc",
  project_url: "https://chatgpt.com/g/g-p-your-project/project",
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
assert.equal(t.submissionStateFromText("Codex Reviews\nupload_bundle.zip\n压缩归档\n聊天\n来源\n尚无聊天", "upload_bundle.zip"), "not_sent");
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
assert.ok(t.handoffStatuses.includes("chrome_handoff_required"));

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

{
  const claimed = [];
  const fakeBrowser = {
    user: {
      async openTabs() {
        return [
          { id: "wrong-active", url: "https://chatgpt.com/g/g-p-demo/c/other", title: "Other", tabGroup: "GPT Pro review" },
        ];
      },
      async claimTab(info) {
        claimed.push(info.id);
        return {
          id: info.id,
          async url() {
            return info.url;
          },
          async title() {
            return info.title;
          },
          playwright: {
            async evaluate() {
              return "unrelated page text";
            },
          },
        };
      },
    },
  };
  const strictMissing = await t.claimMatchingRunTab(fakeBrowser, {
    run_id: "run-1",
    topic: "topic-a",
    conversation_url: "https://chatgpt.com/g/g-p-demo/c/expected",
    active_tab_id: "wrong-active",
  });
  assert.equal(strictMissing, null);
  assert.deepEqual(claimed, ["wrong-active"]);
}

{
  const fakeBrowser = {
    user: {
      async openTabs() {
        return [
          { id: "wrong-active", url: "https://chatgpt.com/g/g-p-demo/c/other", title: "Other", tabGroup: "GPT Pro review" },
          { id: "expected", url: "https://chatgpt.com/g/g-p-demo/c/expected?model=gpt-5", title: "Expected", tabGroup: "GPT Pro review" },
        ];
      },
      async claimTab(info) {
        return {
          id: info.id,
          async url() {
            return info.url;
          },
          async title() {
            return info.title;
          },
          playwright: {
            async evaluate() {
              return "";
            },
          },
        };
      },
    },
  };
  const tab = await t.claimMatchingRunTab(fakeBrowser, {
    run_id: "run-1",
    topic: "topic-a",
    conversation_url: "https://chatgpt.com/g/g-p-demo/c/expected",
    active_tab_id: "wrong-active",
  });
  assert.equal(tab.id, "expected");
}

{
  const runDir = await fs.mkdtemp(path.join(stateRoot, "extract-existing-"));
  const conversationUrl = "https://chatgpt.com/g/g-p-demo/c/extract-ok";
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({
    state: "login_required",
    run_id: "extract-run",
    run_dir: runDir,
    topic: "CBE_Review",
    conversation_url: conversationUrl,
    active_tab_id: "expected",
  }, null, 2) + "\n");
  const finalResponse = [
    "GPT Pro web review",
    "Blockers",
    "None.",
    "Important findings",
    "CBE_Review result is complete for extract-run.",
    "Direct answer",
    "Use the existing conversation.",
    "Review State: complete",
  ].join("\n");
  let newTabCalled = false;
  const fakeTab = {
    id: "expected",
    async url() {
      return conversationUrl;
    },
    async title() {
      return "ChatGPT - codex";
    },
    playwright: {
      locator() {
        return {
          async allTextContents() {
            return [finalResponse];
          },
        };
      },
      async evaluate() {
        return "Log in to ChatGPT\n" + finalResponse;
      },
    },
  };
  const fakeBrowser = {
    async nameSession() {},
    tabs: {
      async new() {
        newTabCalled = true;
        throw new Error("tabs.new must not be called");
      },
    },
    user: {
      async openTabs() {
        return [{ id: "expected", url: conversationUrl, title: "ChatGPT - codex", tabGroup: "GPT Pro review" }];
      },
      async claimTab() {
        return fakeTab;
      },
    },
  };
  const result = await runner.extractExistingGptResponse({ runDir, browser: fakeBrowser, keepOpen: true });
  assert.equal(result.status, "success");
  assert.equal(newTabCalled, false);
  assert.match(await fs.readFile(path.join(runDir, "response.md"), "utf8"), /CBE_Review result is complete/);
  const status = JSON.parse(await fs.readFile(path.join(runDir, "status.json"), "utf8"));
  assert.equal(status.state, "completed");
  assert.equal(status.extracted_existing_tab, true);
}

{
  const runDir = await fs.mkdtemp(path.join(stateRoot, "extract-existing-close-"));
  const conversationUrl = "https://chatgpt.com/g/g-p-demo/c/extract-close";
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({
    state: "extract_failed",
    run_id: "extract-close-run",
    run_dir: runDir,
    topic: "CBE_Review",
    conversation_url: conversationUrl,
  }, null, 2) + "\n");
  const finalResponse = [
    "GPT Pro web review",
    "Blockers",
    "None.",
    "Important findings",
    "CBE_Review result is complete for extract-close-run.",
    "Direct answer",
    "Close only the claimed tab.",
    "Review State: complete",
  ].join("\n");
  let claimedClosed = 0;
  let unrelatedClosed = 0;
  const fakeTab = {
    id: "claimed",
    async url() {
      return conversationUrl;
    },
    async title() {
      return "ChatGPT - codex";
    },
    async close() {
      claimedClosed += 1;
    },
    playwright: {
      locator() {
        return {
          async allTextContents() {
            return [finalResponse];
          },
        };
      },
      async evaluate() {
        return finalResponse;
      },
    },
  };
  const fakeBrowser = {
    async nameSession() {},
    user: {
      async openTabs() {
        return [
          { id: "claimed", url: conversationUrl, title: "ChatGPT - codex", tabGroup: "GPT Pro review" },
          { id: "other", url: "https://chatgpt.com/g/g-p-demo/c/other", title: "Other", tabGroup: "GPT Pro review" },
        ];
      },
      async claimTab(info) {
        if (info.id === "other") {
          return {
            id: "other",
            async url() { return info.url; },
            async close() { unrelatedClosed += 1; },
          };
        }
        return fakeTab;
      },
    },
  };
  const result = await runner.extractExistingGptResponse({ runDir, browser: fakeBrowser, keepOpen: false });
  assert.equal(result.status, "success");
  assert.equal(claimedClosed, 1);
  assert.equal(unrelatedClosed, 0);
}

{
  const runDir = await fs.mkdtemp(path.join(stateRoot, "extract-existing-mismatch-"));
  const conversationUrl = "https://chatgpt.com/g/g-p-demo/c/extract-mismatch";
  await fs.writeFile(path.join(runDir, "status.json"), JSON.stringify({
    state: "extract_failed",
    run_id: "expected-run",
    run_dir: runDir,
    topic: "ExpectedTopic",
    conversation_url: conversationUrl,
  }, null, 2) + "\n");
  const mismatchedResponse = [
    "GPT Pro web review",
    "Blockers",
    "None.",
    "Important findings",
    "DifferentTopic result for other-run.",
    "Direct answer",
    "Wrong run.",
    "Review State: complete",
  ].join("\n");
  const fakeTab = {
    id: "claimed",
    async url() { return conversationUrl; },
    async title() { return "ChatGPT - codex"; },
    playwright: {
      locator() {
        return {
          async allTextContents() {
            return [mismatchedResponse];
          },
        };
      },
      async evaluate() {
        return mismatchedResponse;
      },
    },
  };
  const fakeBrowser = {
    async nameSession() {},
    user: {
      async openTabs() {
        return [{ id: "claimed", url: conversationUrl, title: "ChatGPT - codex", tabGroup: "GPT Pro review" }];
      },
      async claimTab() {
        return fakeTab;
      },
    },
  };
  const result = await runner.extractExistingGptResponse({ runDir, browser: fakeBrowser, keepOpen: true });
  assert.equal(result.status, "extract_failed");
  assert.equal(await fs.readFile(path.join(runDir, "response.partial.md"), "utf8"), mismatchedResponse + "\n");
  await assert.rejects(fs.access(path.join(runDir, "response.md")));
}

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
