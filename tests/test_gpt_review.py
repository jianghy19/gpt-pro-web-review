import importlib.util
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "gpt_review.py"
spec = importlib.util.spec_from_file_location("gpt_review", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)


class GptReviewTests(unittest.TestCase):
    def setUp(self):
        self.config_tmp = tempfile.TemporaryDirectory()
        self.old_config_path = mod.CONFIG_PATH
        mod.CONFIG_PATH = Path(self.config_tmp.name) / "config.json"

    def tearDown(self):
        mod.CONFIG_PATH = self.old_config_path
        self.config_tmp.cleanup()

    def test_concurrency_defaults_and_limits(self):
        self.assertEqual(mod.choose_concurrency(None), 5)
        self.assertEqual(mod.choose_concurrency("auto"), 5)
        self.assertEqual(mod.choose_concurrency("4"), 4)
        self.assertEqual(mod.choose_concurrency("2", max_value=2), 2)
        with self.assertRaises(SystemExit):
            mod.choose_concurrency("7")
        with self.assertRaises(SystemExit):
            mod.choose_concurrency("3", max_value=2)

    def test_registry_key_is_project_and_topic_stable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "project"
            root.mkdir()
            key1 = mod.registry_key(root, "fig3")
            key2 = mod.registry_key(root, "fig3")
            key3 = mod.registry_key(root, "other")
        self.assertEqual(key1, key2)
        self.assertNotEqual(key1, key3)
        self.assertIn("fig3", key1)

    def test_default_registry_key_is_session_root_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "repo"
            project.mkdir()
            args_a = mod.build_parser().parse_args(["--project-root", str(project), "--topic", "fig3", "Review"])
            args_b = mod.build_parser().parse_args(["--project-root", str(project), "--topic", "fig4", "Review"])
            session_a = mod.resolve_session(args_a)
            session_b = mod.resolve_session(args_b)
        self.assertEqual(mod.registry_key_for_session(session_a), mod.registry_key_for_session(session_b))
        self.assertIn("session", mod.registry_key_for_session(session_a))

    def test_exact_topic_registry_key_remains_topic_specific(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "repo"
            project.mkdir()
            args_a = mod.build_parser().parse_args(
                ["--project-root", str(project), "--topic", "fig3", "--exact-topic", "Review"]
            )
            args_b = mod.build_parser().parse_args(
                ["--project-root", str(project), "--topic", "fig4", "--exact-topic", "Review"]
            )
            session_a = mod.resolve_session(args_a)
            session_b = mod.resolve_session(args_b)
        self.assertNotEqual(mod.registry_key_for_session(session_a), mod.registry_key_for_session(session_b))

    def test_example_workstream_session_root_and_topic(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "example_project"
            bundle = root / "workstreams" / "other_experiment" / "review_queue" / "gpt_fig1_bundle"
            bundle.mkdir(parents=True)
            args = mod.build_parser().parse_args(
                ["--project-root", str(bundle), "--topic", "example_fig1_viability_round3", "Review"]
            )
            session = mod.resolve_session(args)
        self.assertEqual(session["session_root"], (root / "workstreams" / "other_experiment").resolve())
        self.assertEqual(session["topic"], "example_other_experiment")
        self.assertIn("example_fig1_viability_round3", session["subtopics"])

    def test_fixed_project_route_for_example_and_default(self):
        cornea = Path("~/projects/example_project/workstreams/single_cell")
        args = mod.build_parser().parse_args(["--project-root", str(cornea), "Review"])
        session = mod.resolve_session(args)
        config = mod.effective_config(args, session)
        self.assertEqual(config["project_key"], "default-project")
        self.assertEqual(config["chatgpt_project"], "your ChatGPT Project")
        self.assertEqual(config["project_url"], mod.DEFAULT_CHATGPT_PROJECT_URL)
        self.assertEqual(config["project_route_source"], "fixed_default")

        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "other_repo"
            project.mkdir()
            args = mod.build_parser().parse_args(["--project-root", str(project), "Review"])
            session = mod.resolve_session(args)
            config = mod.effective_config(args, session)
        self.assertEqual(config["project_key"], "default-project")
        self.assertEqual(config["chatgpt_project"], "your ChatGPT Project")
        self.assertEqual(config["project_url"], mod.DEFAULT_CHATGPT_PROJECT_URL)

    def test_config_can_override_default_project(self):
        custom_default = "https://chatgpt.com/g/g-p-custom-default/project"
        mod.write_json(
            mod.CONFIG_PATH,
            {
                "default_project_name": "Configured Reviews",
                "default_project_key": "configured-reviews",
                "default_project_url": custom_default,
            },
        )
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "repo"
            project.mkdir()
            args = mod.build_parser().parse_args(["--project-root", str(project), "Review"])
            session = mod.resolve_session(args)
            config = mod.effective_config(args, session)
        self.assertEqual(config["project_key"], "configured-reviews")
        self.assertEqual(config["chatgpt_project"], "Configured Reviews")
        self.assertEqual(config["project_url"], custom_default)

    def test_project_url_override_requires_explicit_non_default_confirmation(self):
        custom_url = "https://chatgpt.com/g/g-p-custom123456789-custom-project/project"
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "other_repo"
            project.mkdir()
            args = mod.build_parser().parse_args(
                ["--project-root", str(project), "--project-name", "custom", "--project-url", custom_url, "Review"]
            )
            session = mod.resolve_session(args)
            with self.assertRaises(SystemExit):
                mod.effective_config(args, session)
            args = mod.build_parser().parse_args(
                [
                    "--project-root",
                    str(project),
                    "--project-name",
                    "custom",
                    "--project-url",
                    custom_url,
                    "--allow-non-codex-project",
                    "Review",
                ]
            )
            config = mod.effective_config(args, session)
        self.assertEqual(config["project_key"], "custom")
        self.assertEqual(config["chatgpt_project"], "custom")
        self.assertEqual(config["project_url"], custom_url)

    def test_mode_label_override_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "repo"
            project.mkdir()
            args = mod.build_parser().parse_args(["--project-root", str(project), "--mode-label", "快速", "Review"])
            session = mod.resolve_session(args)
        with self.assertRaises(SystemExit):
            mod.effective_config(args, session)

    def test_doctor_reports_strict_resume_policy(self):
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            mod.doctor()
        self.assertIn("resume_missing_tab_policy: fail_closed_no_auto_reopen", out.getvalue())
        self.assertIn("fallback_import_response: gpt-review --import-response RUN_DIR --from-file PATH", out.getvalue())
        self.assertIn("Computer Use disabled by default", out.getvalue())

    def test_resume_reports_recovery_hint_for_terminal_extract_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "repo"
            project.mkdir()
            state = Path(tmp) / "state"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                args = mod.build_parser().parse_args(["--project-root", str(project), "--resume"])
                session = mod.resolve_session(args)
                key = mod.registry_key_for_session(session)
                (state / "registry").mkdir(parents=True)
                mod.write_json(
                    state / "registry" / f"{key}.json",
                    {
                        "project_root": str(project),
                        "session_root": str(project),
                        "topic": "default",
                        "registry_key": key,
                        "project_url": mod.DEFAULT_CHATGPT_PROJECT_URL,
                        "conversation_url": "https://chatgpt.com/g/g-p-your-project/c/recover",
                        "last_run_id": "run-recover",
                        "last_state": "manual_copy_required",
                    },
                )
                out = io.StringIO()
                with mock.patch("sys.stdout", out):
                    self.assertEqual(mod.resume_run(args), 0)
                payload = json.loads(out.getvalue())
                self.assertEqual(payload["recovery_hint"]["state"], "manual_copy_required")
                self.assertIn("--import-response", payload["recovery_hint"]["next_action"])

    def test_import_response_writes_completed_manual_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            run_dir.mkdir()
            mod.write_json(
                run_dir / "status.json",
                {
                    "run_id": "run-import",
                    "state": "extract_failed",
                    "topic": "CBE_Review",
                    "conversation_url": "https://chatgpt.com/g/g-p-demo/c/import-ok",
                },
            )
            answer = Path(tmp) / "answer.txt"
            answer.write_text(
                "\n".join(
                    [
                        "GPT Pro web review",
                        "Blockers",
                        "None.",
                        "Important findings",
                        "CBE_Review finished for run-import.",
                        "Direct answer",
                        "Manual import is valid.",
                        "Review State: complete",
                    ]
                )
                + "\n"
            )
            with mock.patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(mod.import_response_run(str(run_dir), answer), 0)
            self.assertIn("Manual import is valid", (run_dir / "response.md").read_text())
            status = json.loads((run_dir / "status.json").read_text())
            self.assertEqual(status["state"], "completed_manual_import")
            self.assertEqual(status["manual_import"], True)

    def test_import_response_rejects_mismatched_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp) / "run"
            run_dir.mkdir()
            mod.write_json(run_dir / "status.json", {"run_id": "run-import", "topic": "CBE_Review"})
            answer = Path(tmp) / "answer.txt"
            answer.write_text("GPT Pro web review\nBlockers\nNone\nReview State: complete\n")
            with mock.patch("sys.stderr", new_callable=io.StringIO) as err:
                self.assertEqual(mod.import_response_run(str(run_dir), answer), 2)
            self.assertIn("does not match this run", err.getvalue())
            self.assertFalse((run_dir / "response.md").exists())

    def test_exact_topic_disables_workstream_canonicalization(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "example_project"
            bundle = root / "workstreams" / "EIT"
            bundle.mkdir(parents=True)
            args = mod.build_parser().parse_args(
                ["--project-root", str(bundle), "--topic", "custom_eit_topic", "--exact-topic", "Review"]
            )
            session = mod.resolve_session(args)
        self.assertEqual(session["session_root"], bundle.resolve())
        self.assertEqual(session["topic"], "custom_eit_topic")

    def test_opening_context_line_contains_session_identity(self):
        title = "[Codex] demo review"
        line = mod.opening_context_line(title, Path("/tmp/project"), "topic_a", ["round1"], "run123")
        self.assertIn("Conversation identity: [Codex] demo review.", line)
        self.assertIn("Work location: /tmp/project.", line)
        self.assertIn("Stable topic: topic_a.", line)
        self.assertIn("Current subtopic: round1.", line)
        self.assertIn("Run ID: run123.", line)

    def test_prepared_run_marks_registry_available_not_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "repo"
            project.mkdir()
            (project / "README.md").write_text("# Test\n")
            state = root / "state"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                key = mod.registry_key(project.resolve(), "fig3")
                registry_dir = state / "registry"
                registry_dir.mkdir(parents=True)
                mod.write_json(
                    registry_dir / f"{key}.json",
                    {
                        "conversation_title": "Existing Fig3 Review",
                        "conversation_url": "https://chatgpt.com/c/existing",
                        "part": 1,
                    },
                )
                args = mod.build_parser().parse_args(["--project-root", str(project), "--topic", "fig3", "Review"])
                run_dir = mod.prepare_run(args)
                status = json.loads((run_dir / "status.json").read_text())
                self.assertEqual(status["expected_conversation_url"], "")
                self.assertFalse(status["registry_conversation_available"])
                self.assertFalse(status.get("registry_conversation_stale", False))
                self.assertFalse(status["conversation_reused"])
                self.assertFalse(status["registry_migrated_from_legacy_topic"])

    def test_adopt_url_rejects_non_conversation_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "repo"
            project.mkdir()
            state = Path(tmp) / "state"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                args = mod.build_parser().parse_args(
                    [
                        "--project-root",
                        str(project),
                        "--topic",
                        "fig3",
                        "--adopt-url",
                        "https://chatgpt.com/g/g-project/project",
                    ]
                )
                with self.assertRaises(SystemExit):
                    mod.adopt_conversation(args)

                args = mod.build_parser().parse_args(
                    [
                        "--project-root",
                        str(project),
                        "--topic",
                        "fig3",
                        "--adopt-url",
                        "https://evilchatgpt.com/c/not-a-real-chatgpt-url",
                    ]
                )
                with self.assertRaises(SystemExit):
                    mod.adopt_conversation(args)

                args = mod.build_parser().parse_args(
                    [
                        "--project-root",
                        str(project),
                        "--topic",
                        "fig3",
                        "--adopt-url",
                        "https://chatgpt.com/g/g-p-6a1398218fb08191ba82dfac1a54b6b8-codex-common/c/wrong-project",
                    ]
                )
                with self.assertRaises(SystemExit):
                    mod.adopt_conversation(args)

    def test_adopt_url_writes_registry_for_later_reuse(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "repo"
            project.mkdir()
            (project / "README.md").write_text("# Test\n")
            state = Path(tmp) / "state"
            adopted_url = "https://chatgpt.com/g/g-p-your-project/c/abc123"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                args = mod.build_parser().parse_args(
                    [
                        "--project-root",
                        str(project),
                        "--topic",
                        "fig3",
                        "--title",
                        "Existing Fig3 Review",
                        "--adopt-url",
                        adopted_url,
                    ]
                )
                with mock.patch("sys.stdout", new_callable=io.StringIO):
                    self.assertEqual(mod.adopt_conversation(args), 0)
                key = mod.registry_key(project.resolve(), "__session__")
                registry = json.loads((state / "registry" / f"{key}.json").read_text())
                self.assertEqual(registry["conversation_url"], adopted_url)
                self.assertEqual(registry["project_url"], mod.DEFAULT_CHATGPT_PROJECT_URL)
                self.assertEqual(registry["project_key"], "default-project")
                self.assertEqual(registry["conversation_title"], "Existing Fig3 Review")
                self.assertTrue(registry["adopted_manually"])

                prepare_args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig3", "Review"]
                )
                run_dir = mod.prepare_run(prepare_args)
                status = json.loads((run_dir / "status.json").read_text())
                self.assertEqual(status["expected_conversation_url"], "")
                self.assertFalse(status["registry_conversation_available"])
                self.assertFalse(status["conversation_reused"])

                reuse_args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig3", "--reuse-existing", "Review"]
                )
                reuse_run_dir = mod.prepare_run(reuse_args)
                reuse_status = json.loads((reuse_run_dir / "status.json").read_text())
                self.assertEqual(reuse_status["expected_conversation_url"], adopted_url)
                self.assertTrue(reuse_status["registry_conversation_available"])
                self.assertEqual(reuse_status["conversation_policy"], "reuse_existing")

                other_topic_args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig4", "--reuse-existing", "Review"]
                )
                other_run_dir = mod.prepare_run(other_topic_args)
                other_status = json.loads((other_run_dir / "status.json").read_text())
                self.assertEqual(other_status["expected_conversation_url"], adopted_url)
                self.assertEqual(other_status["registry_key"], reuse_status["registry_key"])

    def test_exact_topic_does_not_reuse_default_session_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "repo"
            project.mkdir()
            (project / "README.md").write_text("# Test\n")
            state = Path(tmp) / "state"
            adopted_url = "https://chatgpt.com/g/g-p-your-project/c/default-adopted"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                adopt_args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig3", "--adopt-url", adopted_url]
                )
                with mock.patch("sys.stdout", new_callable=io.StringIO):
                    self.assertEqual(mod.adopt_conversation(adopt_args), 0)

                prepare_args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig4", "--exact-topic", "Review"]
                )
                run_dir = mod.prepare_run(prepare_args)
                status = json.loads((run_dir / "status.json").read_text())
                self.assertEqual(status["expected_conversation_url"], "")
                self.assertFalse(status["registry_conversation_available"])

    def test_fresh_bypasses_adopted_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "repo"
            project.mkdir()
            (project / "README.md").write_text("# Test\n")
            state = Path(tmp) / "state"
            adopted_url = "https://chatgpt.com/g/g-p-your-project/c/adopted"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                adopt_args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig3", "--adopt-url", adopted_url]
                )
                with mock.patch("sys.stdout", new_callable=io.StringIO):
                    self.assertEqual(mod.adopt_conversation(adopt_args), 0)

                prepare_args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig3", "--fresh", "Review"]
                )
                run_dir = mod.prepare_run(prepare_args)
                status = json.loads((run_dir / "status.json").read_text())
                self.assertEqual(status["expected_conversation_url"], "")
                self.assertFalse(status["registry_conversation_available"])

    def test_log_issue_writes_maintenance_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            run_dir = state / "runs" / "run-issue"
            run_dir.mkdir(parents=True)
            mod.write_json(
                run_dir / "status.json",
                {
                    "run_id": "run-issue",
                    "state": "chrome_handoff_required",
                    "topic": "fig3",
                    "conversation_url": "https://chatgpt.com/g/g-p-demo/c/abc",
                    "error": "upload button did not open token=secret-value",
                    "upload_bundle": str(run_dir / "upload_bundle.zip"),
                },
            )
            (run_dir / "response.partial.md").write_text("partial\n")
            issue_log = state / "plugin_issue_log.jsonl"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "ISSUE_LOG_PATH", issue_log):
                with mock.patch("sys.stdout", new_callable=io.StringIO):
                    self.assertEqual(mod.log_issue_run(str(run_dir), "file chooser did not open"), 0)
                data = json.loads(issue_log.read_text().splitlines()[-1])
                self.assertEqual(data["run_id"], "run-issue")
                self.assertEqual(data["state"], "chrome_handoff_required")
                self.assertEqual(data["issue"], "file chooser did not open")
                self.assertTrue(data["partial_response_exists"])
                self.assertIn("must not modify plugin code", data["policy"])
                self.assertIn("Computer Use is disabled by default", data["policy"])
                self.assertNotIn("secret-value", json.dumps(data))

    def test_reuse_finalize_replaces_session_default_registry(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "repo"
            project.mkdir()
            (project / "README.md").write_text("# Test\n")
            state = Path(tmp) / "state"
            old_url = "https://chatgpt.com/g/g-p-your-project/c/old-default"
            new_url = "https://chatgpt.com/g/g-p-your-project/c/new-default"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                adopt_args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig3", "--adopt-url", old_url]
                )
                with mock.patch("sys.stdout", new_callable=io.StringIO):
                    self.assertEqual(mod.adopt_conversation(adopt_args), 0)
                reuse_args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig4", "--reuse-existing", "Review"]
                )
                run_dir = mod.prepare_run(reuse_args)
                (run_dir / "response.md").write_text("GPT Pro web review\n\nReview State: complete\n")
                mod.write_json(run_dir / "conversation.json", {"url": new_url, "title": "New default"})
                with mock.patch("sys.stdout", new_callable=io.StringIO):
                    self.assertEqual(mod.finalize_run(run_dir), 0)
                registry = json.loads((state / "registry" / f"{mod.registry_key(project.resolve(), '__session__')}.json").read_text())
                self.assertEqual(registry["conversation_url"], new_url)
                self.assertEqual(registry["last_run_id"], run_dir.name)

    def test_marketplace_payload_adds_plugin_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            market = Path(tmp) / "marketplace.json"
            mod.write_json(market, {"name": "local", "plugins": [{"name": "other"}]})
            payload = mod.marketplace_payload_with_plugin(market)
            names = [item["name"] for item in payload["plugins"]]
        self.assertEqual(names.count("gpt-pro-web-review"), 1)
        self.assertIn("other", names)

    def test_path_exclusions(self):
        self.assertTrue(mod.path_is_excluded(Path(".git/config"))[0])
        self.assertTrue(mod.path_is_excluded(Path("node_modules/pkg/index.js"))[0])
        self.assertTrue(mod.path_is_excluded(Path("rawdata/matrix.h5"))[0])
        self.assertEqual(mod.path_is_excluded(Path("scripts/run.py")), (False, ""))

    def test_secret_scan_blocks_high_confidence(self):
        critical, low = mod.scan_text_for_secrets("API_KEY='sk-abcdefghijklmnopqrstuvwxyz123456'")
        self.assertTrue(critical)
        self.assertIsInstance(low, list)

    def test_prepare_run_creates_manifest_and_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "repo"
            project.mkdir()
            (project / "README.md").write_text("# Test\n")
            (project / "scripts").mkdir()
            (project / "scripts" / "run.py").write_text("print('ok')\n")
            (project / "rawdata").mkdir()
            (project / "rawdata" / "matrix.h5").write_bytes(b"binary")
            state = root / "state"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                args = mod.build_parser().parse_args(
                    [
                        "--project-root",
                        str(project),
                        "--topic",
                        "fig3",
                        "--keep-open",
                        "--max-bundle-bytes",
                        "1000000",
                        "Review this.",
                    ]
                )
                run_dir = mod.prepare_run(args)
                self.assertTrue((run_dir / "review_packet.md").exists())
                self.assertTrue((run_dir / "bundle_manifest.json").exists())
                self.assertTrue((run_dir / "upload_bundle.zip").exists())
                manifest = json.loads((run_dir / "bundle_manifest.json").read_text())
                status = json.loads((run_dir / "status.json").read_text())
                archives = {row["archive"] for row in manifest["files"]}
                self.assertIn("README.md", archives)
                self.assertIn("scripts/run.py", archives)
                self.assertEqual(status["bundle_root"], str(project.resolve()))
                self.assertEqual(status["session_root"], str(project.resolve()))
                self.assertEqual(status["project_key"], "default-project")
                self.assertEqual(status["project_url"], mod.DEFAULT_CHATGPT_PROJECT_URL)
                self.assertTrue(status["keep_open"])
                self.assertFalse(status["auto_rename"])
                self.assertFalse(status["allow_enter_submit"])
                self.assertFalse(status["conversation_reused"])
                self.assertFalse(status["registry_conversation_available"])
                self.assertEqual(status["expected_conversation_url"], "")
                self.assertFalse(any("rawdata/matrix.h5" in row.get("archive", "") for row in manifest["files"]))
                with zipfile.ZipFile(run_dir / "upload_bundle.zip") as zf:
                    names = set(zf.namelist())
                self.assertIn("_codex_review/review_packet.md", names)
                self.assertIn("_codex_review/bundle_manifest.json", names)

    def test_auto_rename_is_explicit_opt_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "repo"
            project.mkdir()
            (project / "README.md").write_text("# Test\n")
            state = root / "state"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig3", "--auto-rename", "Review this."]
                )
                run_dir = mod.prepare_run(args)
                status = json.loads((run_dir / "status.json").read_text())
                self.assertTrue(status["auto_rename"])

    def test_enter_submit_is_explicit_opt_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "repo"
            project.mkdir()
            (project / "README.md").write_text("# Test\n")
            state = root / "state"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                args = mod.build_parser().parse_args(
                    ["--project-root", str(project), "--topic", "fig3", "--allow-enter-submit", "Review this."]
                )
                run_dir = mod.prepare_run(args)
                status = json.loads((run_dir / "status.json").read_text())
                self.assertTrue(status["allow_enter_submit"])

    def test_prepare_run_stops_on_critical_secret(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / "repo"
            project.mkdir()
            (project / "README.md").write_text("secret='sk-abcdefghijklmnopqrstuvwxyz123456'\n")
            state = root / "state"
            with mock.patch.object(mod, "STATE_ROOT", state), mock.patch.object(
                mod, "RUN_DIR", state / "runs"
            ), mock.patch.object(mod, "REGISTRY_DIR", state / "registry"), mock.patch.object(
                mod, "LOCK_DIR", state / "locks"
            ):
                args = mod.build_parser().parse_args(["--project-root", str(project), "--topic", "x", "Review"])
                with self.assertRaises(SystemExit):
                    mod.prepare_run(args)


if __name__ == "__main__":
    unittest.main()
