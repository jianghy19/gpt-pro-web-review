#!/usr/bin/env python3
"""Prepare and manage Chrome-backed ChatGPT Pro review runs.

The Python CLI owns deterministic local work: bundle selection, manifesting,
locking, run state, and artifact finalization. Browser automation is performed
by scripts/gpt_chrome_runner.mjs inside the trusted Codex Chrome runtime.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import zipfile
from dataclasses import dataclass
from types import SimpleNamespace
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


STATE_ROOT = Path.home() / ".codex" / "gpt-review"
RUN_DIR = STATE_ROOT / "runs"
REGISTRY_DIR = STATE_ROOT / "registry"
LOCK_DIR = STATE_ROOT / "locks"
CONFIG_PATH = STATE_ROOT / "config.json"
PLUGIN_ROOT = Path(__file__).resolve().parents[1]
CHROME_PLUGIN_ROOT = Path.home() / ".codex" / "plugins" / "cache" / "openai-bundled" / "chrome"
MARKETPLACE_PATH = Path.home() / ".agents" / "plugins" / "marketplace.json"
CODEX_SKILL_DIR = Path.home() / ".codex" / "skills" / "gpt-pro-web-review"
AGENTS_SKILL_DIR = Path.home() / ".agents" / "skills" / "gpt-pro-web-review"
PLUGIN_CACHE_SKILL_DIR = (
    Path.home()
    / ".codex"
    / "plugins"
    / "cache"
    / "local-codex-plugins"
    / "gpt-pro-web-review"
    / "0.1.0"
    / "skills"
    / "gpt-pro-web-review"
)

DEFAULT_CHATGPT_PROJECT = "your ChatGPT Project"
DEFAULT_CHATGPT_PROJECT_KEY = "default_project"
DEFAULT_CHATGPT_PROJECT_URL = "https://chatgpt.com/g/g-p-your-project/project"
EXAMPLE_CHATGPT_PROJECT = "example project"
EXAMPLE_CHATGPT_PROJECT_KEY = "example_project"
EXAMPLE_CHATGPT_PROJECT_URL = "https://chatgpt.com/g/g-p-example-project/project"
EXAMPLE_PROJECT_PREFIX = Path("~/projects/example_project")
DEFAULT_MODE_LABEL = "进阶专业"
DEFAULT_TOPIC = "default"
SESSION_REGISTRY_TOPIC = "__session__"
DEFAULT_CONVERSATION_POLICY = "new_per_run"
REUSE_CONVERSATION_POLICY = "reuse_existing"
DEFAULT_CONCURRENCY = 5
MAX_CONCURRENCY = 6
DEFAULT_MAX_FILE_BYTES = 3 * 1024 * 1024
DEFAULT_MAX_BUNDLE_BYTES = 80 * 1024 * 1024

EXAMPLE_WORKSTREAM_TOPICS = {
    "analysis": "example_analysis",
    "figures": "example_figures",
    "experiments": "example_experiments",
    "literature": "example_literature",
}
EXAMPLE_WORKSTREAM_TITLES = {
    "example_analysis": "example analysis review",
    "example_figures": "example figures review",
    "example_experiments": "example experiments review",
    "example_literature": "example literature review",
    "example_root_policy": "example root policy review",
}

TEXT_SUFFIXES = {
    ".c",
    ".cc",
    ".cfg",
    ".conf",
    ".cpp",
    ".csv",
    ".css",
    ".h",
    ".hpp",
    ".html",
    ".ipynb",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".m",
    ".md",
    ".mjs",
    ".py",
    ".qmd",
    ".r",
    ".rmd",
    ".rs",
    ".sh",
    ".sql",
    ".svg",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
FIGURE_SUFFIXES = {".png", ".jpg", ".jpeg", ".pdf", ".svg", ".tif", ".tiff"}
ALLOWED_BINARY_SUFFIXES = FIGURE_SUFFIXES | {".xlsx", ".xls", ".docx", ".pptx"}
EXCLUDED_NAMES = {
    ".git",
    ".hg",
    ".svn",
    ".DS_Store",
    ".env",
    ".env.local",
    ".envrc",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    "env",
    "rawdata",
    "refdata",
    "cellranger",
    "server_sync/logs",
}
EXCLUDED_SUFFIXES = {
    ".bam",
    ".bai",
    ".fastq",
    ".fq",
    ".gz",
    ".h5",
    ".h5ad",
    ".loom",
    ".mtx",
    ".npz",
    ".rds",
    ".rda",
    ".rdata",
    ".sqlite",
    ".sqlite3",
    ".tar",
    ".tgz",
    ".zip",
}
CRITICAL_SECRET_PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}\b"),
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{30,}\b"),
    re.compile(r"(?i)\b(?:bearer|authorization)\s*[:=]\s*[A-Za-z0-9._\-]{32,}"),
    re.compile(r"(?i)\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{16,}['\"]"),
]
LOW_CONFIDENCE_PRIVATE_PATTERNS = [
    re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I),
]


def slugify(value: str, max_len: int = 48) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value).strip("-").lower()
    return (slug or "default")[:max_len].strip("-") or "default"


def make_run_id() -> str:
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"{stamp}-{os.getpid()}-{secrets.token_hex(3)}"


def now_iso() -> str:
    return dt.datetime.now().isoformat()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def chrome_helper_path() -> Path | None:
    candidates = sorted(CHROME_PLUGIN_ROOT.glob("*/scripts/browser-client.mjs"))
    return candidates[-1] if candidates else None


def project_root(cwd: Path) -> Path:
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            check=True,
        )
        return Path(result.stdout.strip()).resolve()
    except Exception:
        return cwd.resolve()


def registry_key(project: Path, topic: str) -> str:
    project = project.expanduser().resolve()
    digest = hashlib.sha256(str(project).encode("utf-8")).hexdigest()[:10]
    return f"{slugify(project.name, 36)}-{digest}__{slugify(topic, 64)}"


def registry_key_for_session(session: dict[str, Any]) -> str:
    registry_topic = session["topic"] if session.get("exact_topic") else SESSION_REGISTRY_TOPIC
    return registry_key(Path(session["session_root"]), registry_topic)


def legacy_topic_registry_key_for_session(session: dict[str, Any]) -> str:
    return registry_key(Path(session["session_root"]), session["topic"])


def conversation_title(project: Path, topic: str, part: int = 1) -> str:
    suffix = "" if part <= 1 else f" - part {part}"
    return f"[Codex] {slugify(project.name, 28)} {slugify(topic, 42)} - active review{suffix}"


def conversation_title_phrase(title: str) -> str:
    return re.sub(r"\s+", " ", str(title or "")).strip()


def opening_context_line(title: str, session_root: Path, topic: str, subtopics: list[str], run_id: str) -> str:
    subtitle = "; ".join(subtopics) if subtopics else "general"
    return (
        f"Conversation identity: {conversation_title_phrase(title)}. "
        f"Work location: {session_root}. "
        f"Stable topic: {topic}. Current subtopic: {subtitle}. Run ID: {run_id}."
    )


def is_conversation_url(url: str | None) -> bool:
    value = str(url or "")
    try:
        parsed = urlparse(value)
    except Exception:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    if parsed.netloc.lower() not in {"chatgpt.com", "www.chatgpt.com"}:
        return False
    return bool(re.search(r"^/(?:g/[^/]+/)?c/[^/\s]+", parsed.path))


def is_project_url(url: str | None) -> bool:
    value = str(url or "").strip()
    try:
        parsed = urlparse(value)
    except Exception:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    if parsed.netloc.lower() not in {"chatgpt.com", "www.chatgpt.com"}:
        return False
    return bool(re.search(r"^/g/[^/]+/project/?$", parsed.path))


def normalize_project_url(url: str | None) -> str:
    value = str(url or "").strip()
    if not is_project_url(value):
        raise SystemExit("--project-url must be a ChatGPT Project URL containing /g/.../project .")
    parsed = urlparse(value)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"


def project_slug_from_project_url(url: str | None) -> str:
    match = re.search(r"chatgpt\.com/g/([^/]+)/project", str(url or ""))
    return match.group(1) if match else ""


def project_slug_aliases(project_url: str | None) -> list[str]:
    slug = project_slug_from_project_url(project_url)
    if not slug:
        return []
    aliases = [slug]
    match = re.match(r"^(g-p-[A-Za-z0-9]+)", slug)
    if match and match.group(1) != slug:
        aliases.append(match.group(1))
    return aliases


def conversation_belongs_to_project(conversation_url: str | None, project_url: str | None) -> bool:
    if not is_conversation_url(conversation_url):
        return False
    aliases = project_slug_aliases(project_url)
    if not aliases:
        return True
    value = str(conversation_url or "")
    return any(f"/g/{alias}/c/" in value for alias in aliases)


def normalize_conversation_url(url: str | None) -> str:
    value = str(url or "").strip()
    if not is_conversation_url(value):
        raise SystemExit("--adopt-url must be a ChatGPT conversation URL containing /c/ .")
    return value


def configured_project_routes(config: dict[str, Any]) -> list[dict[str, str]]:
    routes: list[dict[str, str]] = []
    raw_routes = config.get("project_routes") or []
    if isinstance(raw_routes, list):
        for idx, item in enumerate(raw_routes):
            if not isinstance(item, dict):
                continue
            prefix = str(item.get("path_prefix") or "").strip()
            project_url = str(item.get("project_url") or "").strip()
            if not prefix or not project_url:
                continue
            routes.append(
                {
                    "path_prefix": str(Path(prefix).expanduser().resolve()),
                    "project_url": normalize_project_url(project_url),
                    "project_name": str(item.get("project_name") or item.get("name") or f"project_{idx + 1}").strip(),
                    "project_key": slugify(str(item.get("project_key") or item.get("key") or item.get("project_name") or f"project_{idx + 1}")),
                    "source": "config",
                }
            )
    return routes


def route_matches_path(route: dict[str, str], *paths: Path) -> bool:
    prefix = Path(route["path_prefix"]).expanduser().resolve()
    for path in paths:
        resolved = Path(path).expanduser().resolve()
        if resolved == prefix or prefix in resolved.parents:
            return True
    return False


def resolve_chatgpt_project(
    session: dict[str, Any],
    args: argparse.Namespace | SimpleNamespace,
    config: dict[str, Any],
) -> dict[str, str]:
    explicit_url = str(getattr(args, "project_url", "") or "").strip()
    explicit_name = str(getattr(args, "project_name", "") or "").strip()
    if explicit_url:
        project_url = normalize_project_url(explicit_url)
        return {
            "chatgpt_project": explicit_name or config.get("default_project_name") or "custom project",
            "project_key": slugify(explicit_name or project_slug_from_project_url(project_url) or "custom_project"),
            "project_url": project_url,
            "project_slug": project_slug_from_project_url(project_url),
            "project_route_source": "cli",
        }

    routes = configured_project_routes(config)
    bundle_root = Path(session["bundle_root"])
    session_root = Path(session["session_root"])
    matching = [route for route in routes if route_matches_path(route, bundle_root, session_root)]
    if matching:
        matching.sort(key=lambda route: len(route["path_prefix"]), reverse=True)
        route = matching[0]
        return {
            "chatgpt_project": route["project_name"],
            "project_key": route["project_key"],
            "project_url": route["project_url"],
            "project_slug": project_slug_from_project_url(route["project_url"]),
            "project_route_source": route["source"],
        }

    default_url = str(config.get("default_project_url") or config.get("chatgpt_project_url") or DEFAULT_CHATGPT_PROJECT_URL)
    project_url = normalize_project_url(default_url)
    project_name = str(config.get("default_project_name") or DEFAULT_CHATGPT_PROJECT)
    return {
        "chatgpt_project": project_name,
        "project_key": str(config.get("default_project_key") or DEFAULT_CHATGPT_PROJECT_KEY),
        "project_url": project_url,
        "project_slug": project_slug_from_project_url(project_url),
        "project_route_source": "default",
    }


def find_example_workstream(path: Path) -> tuple[Path | None, str | None]:
    resolved = path.expanduser().resolve()
    parts = resolved.parts
    for idx, part in enumerate(parts):
        if part != "example_project":
            continue
        if idx + 2 < len(parts) and parts[idx + 1] == "workstreams":
            workstream = parts[idx + 2]
            root = Path(*parts[: idx + 3])
            return root, workstream
        return Path(*parts[: idx + 1]), "root_policy"
    return None, None


def infer_session_root(bundle_root: Path) -> Path:
    workstream_root, workstream = find_example_workstream(bundle_root)
    if workstream_root and workstream != "root_policy":
        return workstream_root
    if workstream_root:
        return workstream_root
    return project_root(bundle_root)


def stable_topic_for_session(session_root: Path) -> str | None:
    _, workstream = find_example_workstream(session_root)
    if not workstream:
        return None
    if workstream == "root_policy":
        return "example_root_policy"
    return EXAMPLE_WORKSTREAM_TOPICS.get(workstream.lower())


def display_title_for_session(session_root: Path, topic: str, part: int = 1) -> str:
    suffix = "" if part <= 1 else f" part {part}"
    if topic in EXAMPLE_WORKSTREAM_TITLES:
        return f"{EXAMPLE_WORKSTREAM_TITLES[topic]}{suffix}"
    return conversation_title(session_root, topic, part)


def resolve_session(args: argparse.Namespace) -> dict[str, Any]:
    bundle_root = Path(args.project_root).expanduser().resolve() if args.project_root else project_root(Path.cwd())
    session_root = Path(args.session_root).expanduser().resolve() if args.session_root else infer_session_root(bundle_root)
    requested_topic = args.topic or DEFAULT_TOPIC
    stable_topic = stable_topic_for_session(session_root)
    subtopics = list(args.subtopic or [])
    if stable_topic and not args.exact_topic:
        topic = stable_topic
        if requested_topic not in {DEFAULT_TOPIC, stable_topic} and requested_topic not in subtopics:
            subtopics.insert(0, requested_topic)
    else:
        topic = requested_topic
    return {
        "bundle_root": bundle_root,
        "session_root": session_root,
        "topic": topic,
        "requested_topic": requested_topic,
        "subtopics": subtopics,
        "stable_topic": stable_topic or "",
        "exact_topic": bool(args.exact_topic),
    }


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


class FileLock:
    def __init__(self, path: Path, wait: bool = True):
        self.path = path
        self.wait = wait
        self.file = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = self.path.open("a+")
        flags = fcntl.LOCK_EX if self.wait else fcntl.LOCK_EX | fcntl.LOCK_NB
        try:
            fcntl.flock(self.file, flags)
        except BlockingIOError as exc:
            raise SystemExit(f"Review topic is locked by another run: {self.path}") from exc
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.file:
            fcntl.flock(self.file, fcntl.LOCK_UN)
            self.file.close()


def effective_config(args: argparse.Namespace | SimpleNamespace, session: dict[str, Any] | None = None) -> dict[str, Any]:
    config = load_json(CONFIG_PATH) or {}
    session_for_route = session or {
        "bundle_root": project_root(Path.cwd()),
        "session_root": infer_session_root(project_root(Path.cwd())),
    }
    project = resolve_chatgpt_project(session_for_route, args, config)
    return {
        **project,
        "mode_label": args.mode_label or config.get("mode_label") or DEFAULT_MODE_LABEL,
        "default_concurrency": int(config.get("default_concurrency") or DEFAULT_CONCURRENCY),
        "max_concurrency": int(config.get("max_concurrency") or MAX_CONCURRENCY),
    }


def registry_conversation_for_project(
    registry: dict[str, Any] | None,
    config: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    if not registry:
        return "", {}
    conversation_url = registry.get("conversation_url", "")
    if not is_conversation_url(conversation_url):
        return "", {}
    project_url = config.get("project_url", "")
    if conversation_belongs_to_project(conversation_url, project_url):
        return str(conversation_url), {}
    return "", {
        "registry_conversation_stale": True,
        "stale_conversation_url": conversation_url,
        "stale_registry_project_url": registry.get("project_url", ""),
        "stale_registry_project_key": registry.get("project_key", ""),
        "stale_reason": "conversation_project_mismatch",
    }


def choose_concurrency(
    requested: int | str | None,
    default_value: int = DEFAULT_CONCURRENCY,
    max_value: int = MAX_CONCURRENCY,
) -> int:
    value = default_value if requested in (None, "auto") else int(requested)
    max_value = max(1, min(MAX_CONCURRENCY, int(max_value)))
    if value < 1:
        raise SystemExit("Concurrency must be >= 1.")
    if value > max_value:
        raise SystemExit(f"Concurrency {value} exceeds max {max_value}.")
    return value


def path_is_excluded(rel: Path) -> tuple[bool, str]:
    parts = set(rel.parts)
    rel_text = rel.as_posix()
    for name in EXCLUDED_NAMES:
        if name in parts or rel_text.startswith(name.rstrip("/") + "/"):
            return True, f"excluded_name:{name}"
    if any(part.startswith(".") and part not in {".github"} for part in rel.parts):
        return True, "hidden_path"
    if rel.suffix.lower() in EXCLUDED_SUFFIXES:
        return True, f"excluded_suffix:{rel.suffix.lower()}"
    if "logs" in parts and "review_queue" not in parts:
        return True, "logs"
    return False, ""


def looks_text(path: Path) -> bool:
    if path.suffix.lower() in TEXT_SUFFIXES:
        return True
    try:
        with path.open("rb") as f:
            chunk = f.read(4096)
        if b"\x00" in chunk:
            return False
        chunk.decode("utf-8")
        return True
    except Exception:
        return False


def scan_text_for_secrets(text: str) -> tuple[list[str], list[str]]:
    critical = []
    low = []
    for pattern in CRITICAL_SECRET_PATTERNS:
        if pattern.search(text):
            critical.append(pattern.pattern)
    for pattern in LOW_CONFIDENCE_PRIVATE_PATTERNS:
        if pattern.search(text):
            low.append(pattern.pattern)
    return critical, low


@dataclass
class Candidate:
    source: Path
    archive: str
    size: int
    sha256: str
    kind: str


def iter_project_files(root: Path, exclusions: list[dict[str, Any]] | None = None) -> list[Path]:
    output: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            rel = path.relative_to(root)
        except ValueError:
            continue
        excluded, _ = path_is_excluded(rel)
        if excluded:
            if exclusions is not None:
                exclusions.append({"path": str(path), "archive": rel.as_posix(), "reason": path_is_excluded(rel)[1]})
            continue
        output.append(path)
    return sorted(output)


def collect_candidates(
    root: Path,
    run_dir: Path,
    packet_paths: list[Path],
    file_paths: list[Path],
    *,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_bundle_bytes: int = DEFAULT_MAX_BUNDLE_BYTES,
) -> tuple[list[Candidate], list[dict[str, Any]], list[dict[str, Any]]]:
    candidates: list[Candidate] = []
    exclusions: list[dict[str, Any]] = []
    low_private: list[dict[str, Any]] = []
    seen: set[Path] = set()
    total = 0

    def add_file(path: Path, archive: str, force: bool = False) -> None:
        nonlocal total
        resolved = path.expanduser().resolve()
        if resolved in seen:
            return
        seen.add(resolved)
        if not resolved.exists() or not resolved.is_file():
            exclusions.append({"path": str(resolved), "reason": "missing_or_not_file"})
            return
        size = resolved.stat().st_size
        rel_for_policy = Path(archive)
        excluded, reason = path_is_excluded(rel_for_policy)
        if excluded and not force:
            exclusions.append({"path": str(resolved), "archive": archive, "reason": reason})
            return
        suffix = resolved.suffix.lower()
        is_text = looks_text(resolved)
        allowed_binary = suffix in ALLOWED_BINARY_SUFFIXES
        if not is_text and not allowed_binary and not force:
            exclusions.append({"path": str(resolved), "archive": archive, "reason": "unsupported_binary"})
            return
        if size > max_file_bytes and not force:
            exclusions.append({"path": str(resolved), "archive": archive, "reason": "max_file_bytes", "size": size})
            return
        if is_text:
            text = resolved.read_text(errors="replace")
            critical, low = scan_text_for_secrets(text[:2_000_000])
            if critical:
                raise SystemExit(
                    "High-confidence secret pattern found before upload; refusing to create bundle:\n"
                    + "\n".join(f"- {resolved}: {item}" for item in critical)
                )
            if low:
                low_private.append({"path": str(resolved), "archive": archive, "signals": low[:3]})
        if total + size > max_bundle_bytes and not force:
            exclusions.append({"path": str(resolved), "archive": archive, "reason": "max_bundle_bytes", "size": size})
            return
        total += size
        kind = "text" if is_text else "binary"
        candidates.append(Candidate(resolved, archive, size, file_sha256(resolved), kind))

    generated = [
        run_dir / "review_packet.md",
        run_dir / "bundle_file_tree.txt",
        run_dir / "excluded_files_report.md",
    ]
    for path in generated:
        if path.exists():
            add_file(path, f"_codex_review/{path.name}", force=True)

    for path in packet_paths:
        add_file(path, f"packets/{path.expanduser().resolve().name}", force=True)
    for path in file_paths:
        resolved = path.expanduser().resolve()
        archive = f"explicit_files/{resolved.name}" if not resolved.is_relative_to(root) else resolved.relative_to(root).as_posix()
        add_file(resolved, archive, force=True)

    for path in iter_project_files(root, exclusions):
        rel = path.relative_to(root).as_posix()
        add_file(path, rel, force=False)
    return candidates, exclusions, low_private


def file_tree_lines(candidates: list[Candidate]) -> list[str]:
    lines = []
    for item in sorted(candidates, key=lambda x: x.archive):
        lines.append(f"{item.archive}\t{item.kind}\t{item.size}\t{item.sha256}")
    return lines


def mode_instructions(mode: str) -> str:
    common = (
        "Stay independent. Do not merely agree with Codex or the user. "
        "Surface blockers, evidence gaps, tradeoffs, and alternatives. "
        "Treat the uploaded bundle as the authoritative current state; older ChatGPT Project files and older chats are historical only."
    )
    modes = {
        "project-review": common + " Perform a broad high-context project review and focus on risks that affect execution quality.",
        "discussion": common + " Give open-ended discussion feedback and challenge the framing when warranted.",
        "independent-plan": common + " Propose your own independent plan from the facts before critiquing any existing plan.",
        "final-review": common + " Act as a final gate before execution or freeze; look for unresolved blockers and missing verification.",
        "figure-review": common + " Review figure visual packets and uploaded figures for overlap, clipping, layout, labels, legends, and claim ceiling.",
    }
    return modes[mode]


def build_review_packet(
    args: argparse.Namespace,
    bundle_root: Path,
    session_root: Path,
    topic: str,
    subtopics: list[str],
    run_id: str,
    config: dict[str, Any],
    conversation: dict[str, Any],
) -> str:
    prompt = " ".join(args.prompt).strip() if args.prompt else "Review the uploaded project bundle."
    packet_sections = []
    for packet in args.packet or []:
        path = Path(packet).expanduser().resolve()
        packet_sections.append(f"## Packet: {path}\n\n{path.read_text(errors='replace')}")
    subtopic_text = "; ".join(subtopics) or "none"
    identity_line = opening_context_line(conversation["title"], session_root, topic, subtopics, run_id)
    return f"""{conversation['title']}

{identity_line}

# GPT Pro web review request

Reviewer label: GPT Pro web review
Run ID: {run_id}
Bundle root: {bundle_root}
Session root: {session_root}
Topic: {topic}
Subtopic(s): {subtopic_text}
ChatGPT Project: {config['chatgpt_project']}
ChatGPT Project URL: {config['project_url']}
Required mode label: {config['mode_label']}
Review mode: {args.mode}
Conversation title: {conversation['title']}

## Conversation identity

Use this exact identity for automatic ChatGPT conversation naming and future lookup:

{identity_line}

## Non-negotiable boundaries

- Act only as a read-only reviewer.
- Do not ask to edit, create, delete, stage, commit, SSH, browse external tools, or operate the user's machine.
- Uploaded bundle is the authoritative current state for this review.
- Older files and older conversations in this ChatGPT Project are historical archive only.
- If prior project memory conflicts with this uploaded bundle, follow the uploaded bundle.
- If facts are insufficient, state what is missing instead of assuming.

## Mode instructions

{mode_instructions(args.mode)}

## User request

{prompt}

{chr(10).join(packet_sections)}

## Required output format

Start with exactly:

GPT Pro web review

Then provide:

1. Blockers
2. Important findings
3. Optional comments
4. Direct answer to the user request
5. Review State

Keep Review State short. Include current topic, subtask, evidence reviewed,
decisions so far, open risks, and what a follow-up review should preserve.
"""


def create_zip(run_dir: Path, candidates: list[Candidate]) -> Path:
    zip_path = run_dir / "upload_bundle.zip"
    if zip_path.exists():
        zip_path.unlink()
    generated = [
        (run_dir / "review_packet.md", "_codex_review/review_packet.md"),
        (run_dir / "bundle_file_tree.txt", "_codex_review/bundle_file_tree.txt"),
        (run_dir / "excluded_files_report.md", "_codex_review/excluded_files_report.md"),
        (run_dir / "bundle_manifest.json", "_codex_review/bundle_manifest.json"),
    ]
    existing_archives = {item.archive for item in candidates}
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for item in candidates:
            zf.write(item.source, item.archive)
        for source, archive in generated:
            if source.exists() and archive not in existing_archives:
                zf.write(source, archive)
    return zip_path


def write_reports(
    run_dir: Path,
    candidates: list[Candidate],
    exclusions: list[dict[str, Any]],
    low_private: list[dict[str, Any]],
) -> None:
    (run_dir / "bundle_file_tree.txt").write_text("\n".join(file_tree_lines(candidates)) + "\n")
    lines = ["# Excluded files report", ""]
    for row in exclusions:
        lines.append(f"- {row.get('reason')}: {row.get('archive') or row.get('path')}")
    if low_private:
        lines.extend(["", "## Low-confidence private text signals", ""])
        for row in low_private:
            lines.append(f"- {row['archive']}: {', '.join(row['signals'])}")
    if len(lines) == 2:
        lines.append("- none")
    (run_dir / "excluded_files_report.md").write_text("\n".join(lines) + "\n")
    write_json(
        run_dir / "bundle_manifest.json",
        {
            "files": [item.__dict__ | {"source": str(item.source)} for item in candidates],
            "excluded": exclusions,
            "low_confidence_private_signals": low_private,
            "generated_at": now_iso(),
        },
    )


def prepare_run(args: argparse.Namespace) -> Path:
    session = resolve_session(args)
    bundle_root = session["bundle_root"]
    session_root = session["session_root"]
    topic = session["topic"]
    subtopics = session["subtopics"]
    config = effective_config(args, session)
    concurrency = choose_concurrency(args.concurrency, config["default_concurrency"], config["max_concurrency"])
    reuse_existing = bool(args.reuse_existing and not args.fresh)
    conversation_policy = REUSE_CONVERSATION_POLICY if reuse_existing else DEFAULT_CONVERSATION_POLICY
    key = registry_key_for_session(session)
    legacy_key = legacy_topic_registry_key_for_session(session)
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    registry_path = REGISTRY_DIR / f"{key}.json"
    registry = None
    registry_migrated_from_legacy_topic = False
    if reuse_existing:
        registry = load_json(registry_path)
        if not registry and not session.get("exact_topic") and legacy_key != key:
            registry = load_json(REGISTRY_DIR / f"{legacy_key}.json")
            registry_migrated_from_legacy_topic = bool(registry)
    registry_url, stale_registry = registry_conversation_for_project(registry, config)
    usable_registry = registry if registry_url else None
    part = int(usable_registry.get("part", 1)) if usable_registry else 1
    conversation = {
        "title": usable_registry.get("conversation_title") if usable_registry else display_title_for_session(session_root, topic, part),
        "url": registry_url,
        "part": part,
        "registry_key": key,
    }
    run_id = make_run_id()
    run_dir = RUN_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    packet = build_review_packet(args, bundle_root, session_root, topic, subtopics, run_id, config, conversation)
    (run_dir / "review_packet.md").write_text(packet)
    packet_paths = [Path(p).expanduser().resolve() for p in args.packet or []]
    file_paths = [Path(p).expanduser().resolve() for p in args.file or []]
    candidates, exclusions, low_private = collect_candidates(
        bundle_root,
        run_dir,
        packet_paths,
        file_paths,
        max_file_bytes=args.max_file_bytes,
        max_bundle_bytes=args.max_bundle_bytes,
    )
    write_reports(run_dir, candidates, exclusions, low_private)
    zip_path = None if args.dry_run else create_zip(run_dir, candidates)
    status = {
        "state": "prepared",
        "run_id": run_id,
        "run_dir": str(run_dir),
        "project_root": str(bundle_root),
        "bundle_root": str(bundle_root),
        "session_root": str(session_root),
        "topic": topic,
        "requested_topic": session["requested_topic"],
        "stable_topic": session["stable_topic"],
        "exact_topic": session["exact_topic"],
        "subtopics": subtopics,
        "mode": args.mode,
        "run_mode": "detach" if args.detach else "watch",
        "keep_open": bool(args.keep_open),
        "auto_rename": bool(args.auto_rename),
        "allow_enter_submit": bool(args.allow_enter_submit),
        "created_at": now_iso(),
        "registry_key": key,
        "run_lock_key": key if reuse_existing else run_id,
        "legacy_topic_registry_key": legacy_key,
        "registry_path": str(registry_path),
        "registry_scope": "topic" if session["exact_topic"] else "session_root",
        "registry_migrated_from_legacy_topic": registry_migrated_from_legacy_topic,
        "chatgpt_project": config["chatgpt_project"],
        "project_key": config["project_key"],
        "project_url": config["project_url"],
        "project_slug": config["project_slug"],
        "project_route_source": config["project_route_source"],
        "required_mode_label": config["mode_label"],
        "conversation_title": conversation["title"],
        "conversation_url": conversation["url"],
        "expected_conversation_url": conversation["url"],
        "conversation_part": conversation["part"],
        "conversation_reused": False,
        "registry_conversation_available": bool(conversation["url"]),
        "conversation_policy": conversation_policy,
        "reuse_existing": reuse_existing,
        "registry_update_enabled": reuse_existing,
        **stale_registry,
        "concurrency": concurrency,
        "max_concurrency": MAX_CONCURRENCY,
        "upload_bundle": str(zip_path) if zip_path else "",
        "upload_confirmed": False,
        "local_zip_deleted": False,
        "remote_files_retained": True,
        "chrome_runner": str(PLUGIN_ROOT / "scripts" / "gpt_chrome_runner.mjs"),
        "prompt_sha256": sha256_text(packet),
    }
    write_json(run_dir / "status.json", status)
    write_json(
        run_dir / "meta.json",
        {
            **status,
            "file_count": len(candidates),
            "excluded_count": len(exclusions),
            "low_confidence_private_signal_count": len(low_private),
            "bundle_size_bytes": zip_path.stat().st_size if zip_path else 0,
        },
    )
    return run_dir


def finalize_run(path: Path) -> int:
    run_dir = path.expanduser().resolve()
    status = load_json(run_dir / "status.json") or {}
    conversation = load_json(run_dir / "conversation.json") or {}
    response = run_dir / "response.md"
    if not response.exists():
        partial = run_dir / "response.partial.md"
        if partial.exists():
            print(f"Run is not complete; partial response exists: {partial}")
            return 2
        print(f"response.md not found: {run_dir}")
        return 1
    registry_path = Path(status.get("registry_path") or "")
    if registry_path and status.get("registry_update_enabled") is True:
        existing_registry = load_json(registry_path) or {}
        conversation_url = conversation.get("url") or status.get("conversation_url")
        if not is_conversation_url(conversation_url):
            conversation_url = existing_registry.get("conversation_url", "")
        if conversation_url and not conversation_belongs_to_project(conversation_url, status.get("project_url", "")):
            conversation_url = ""
        write_json(
            registry_path,
            {
                "project_root": status.get("session_root") or status.get("project_root"),
                "bundle_root": status.get("bundle_root") or status.get("project_root"),
                "session_root": status.get("session_root") or status.get("project_root"),
                "topic": status.get("topic"),
                "registry_key": status.get("registry_key"),
                "chatgpt_project": status.get("chatgpt_project", ""),
                "project_key": status.get("project_key", ""),
                "project_url": status.get("project_url", ""),
                "project_slug": status.get("project_slug", ""),
                "conversation_title": conversation.get("title") or status.get("conversation_title"),
                "conversation_url": conversation_url if is_conversation_url(conversation_url) else "",
                "part": status.get("conversation_part", 1),
                "last_run_id": status.get("run_id"),
                "last_response_sha256": file_sha256(response),
                "updated_at": now_iso(),
            },
        )
    status["state"] = "finalized"
    status["finalized_at"] = now_iso()
    write_json(run_dir / "status.json", status)
    print(run_dir)
    return 0


def list_runs() -> int:
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    rows = []
    for path in sorted(REGISTRY_DIR.glob("*.json")):
        data = load_json(path) or {}
        rows.append(
            (
                data.get("updated_at", ""),
                data.get("topic", ""),
                data.get("project_key", ""),
                data.get("chatgpt_project", ""),
                "manual_adopt" if data.get("adopted_manually") else "runner",
                data.get("last_run_id", ""),
                data.get("conversation_title", ""),
                data.get("conversation_url", ""),
                data.get("session_root") or data.get("project_root", ""),
            )
        )
    if not rows:
        print("No GPT Pro review sessions.")
        return 0
    for updated, topic, project_key, project_name, source, run_id, title, url, root in rows:
        print(f"{updated}\t{topic}\t{project_key}\t{project_name}\t{source}\t{run_id}\t{title}\t{url}\t{root}")
    return 0


def show_run(selector: str) -> int:
    if selector == "last":
        candidates = sorted((p for p in RUN_DIR.glob("*") if p.is_dir()), key=lambda p: p.stat().st_mtime)
        if not candidates:
            print("No GPT Pro review runs.")
            return 1
        run_dir = candidates[-1]
    else:
        run_dir = Path(selector).expanduser()
        if not run_dir.is_absolute():
            run_dir = RUN_DIR / selector
    target = run_dir / "response.md"
    if not target.exists():
        target = run_dir / "status.json"
    if not target.exists():
        print(f"No response/status found: {run_dir}")
        return 1
    print(target.read_text())
    return 0


def clean_runs(days: int) -> int:
    cutoff = time.time() - days * 24 * 60 * 60
    count = 0
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    for path in RUN_DIR.iterdir():
        if path.is_dir() and path.stat().st_mtime < cutoff:
            shutil.rmtree(path)
            count += 1
    print(f"Removed {count} GPT Pro review run packet(s) older than {days} day(s).")
    return 0


def marketplace_has_plugin(path: Path = MARKETPLACE_PATH) -> bool:
    data = load_json(path) or {}
    return any(item.get("name") == "gpt-pro-web-review" for item in data.get("plugins", []))


def marketplace_payload_with_plugin(path: Path = MARKETPLACE_PATH) -> dict[str, Any]:
    data = load_json(path) or {
        "name": "local-codex-plugins",
        "interface": {"displayName": "Local Codex Plugins"},
        "plugins": [],
    }
    plugins = [item for item in data.get("plugins", []) if item.get("name") != "gpt-pro-web-review"]
    plugins.append(
        {
            "name": "gpt-pro-web-review",
            "source": {"source": "local", "path": "./plugins/gpt-pro-web-review"},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
            "category": "Productivity",
        }
    )
    data["plugins"] = plugins
    return data


def repair_install() -> int:
    source_skill = PLUGIN_ROOT / "skills" / "gpt-pro-web-review"
    MARKETPLACE_PATH.parent.mkdir(parents=True, exist_ok=True)
    write_json(MARKETPLACE_PATH, marketplace_payload_with_plugin())
    for target in (CODEX_SKILL_DIR, AGENTS_SKILL_DIR, PLUGIN_CACHE_SKILL_DIR):
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_skill, target, dirs_exist_ok=True)
    bin_path = Path("/opt/homebrew/bin/gpt-review")
    if bin_path.parent.exists():
        try:
            if bin_path.is_symlink() or bin_path.exists():
                bin_path.unlink()
            bin_path.symlink_to(PLUGIN_ROOT / "scripts" / "gpt_review.py")
        except PermissionError:
            print(f"bin_symlink: permission denied: {bin_path}")
    print(f"marketplace: {MARKETPLACE_PATH}")
    print(f"codex_skill: {CODEX_SKILL_DIR}")
    print(f"agents_skill: {AGENTS_SKILL_DIR}")
    print(f"cache_skill: {PLUGIN_CACHE_SKILL_DIR}")
    print(f"bin: {bin_path if bin_path.exists() else 'missing'}")
    return 0


def repair_registry(dry_run: bool) -> int:
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    rows = []
    for path in sorted(REGISTRY_DIR.glob("*.json")):
        data = load_json(path) or {}
        root_text = data.get("session_root") or data.get("project_root") or ""
        if not root_text:
            continue
        session_root = infer_session_root(Path(root_text))
        stable_topic = stable_topic_for_session(session_root) or data.get("topic") or DEFAULT_TOPIC
        route_session = {"bundle_root": session_root, "session_root": session_root}
        route = effective_config(SimpleNamespace(project_name=None, project_url=None, mode_label=None), route_session)
        new_key = registry_key(session_root, SESSION_REGISTRY_TOPIC)
        rows.append(
            {
                "registry": str(path),
                "current_key": path.stem,
                "suggested_key": new_key,
                "session_root": str(session_root),
                "topic": stable_topic,
                "registry_scope": "session_root",
                "conversation_url_valid": is_conversation_url(data.get("conversation_url")),
                "resolved_project_key": route["project_key"],
                "resolved_project_url": route["project_url"],
                "conversation_project_match": conversation_belongs_to_project(data.get("conversation_url"), route["project_url"]),
            }
        )
    print(json.dumps({"dry_run": dry_run, "suggestions": rows}, ensure_ascii=False, indent=2))
    if not dry_run:
        print("repair-registry is report-only for now; rerun with --dry-run to audit existing sessions.")
    return 0


def doctor() -> int:
    helper = chrome_helper_path()
    bin_path = Path("/opt/homebrew/bin/gpt-review")
    cwd_session = {
        "bundle_root": project_root(Path.cwd()),
        "session_root": infer_session_root(project_root(Path.cwd())),
    }
    route = effective_config(SimpleNamespace(project_name=None, project_url=None, mode_label=None), cwd_session)
    checks = {
        "plugin_root": str(PLUGIN_ROOT),
        "state_root": str(STATE_ROOT),
        "runs": str(RUN_DIR),
        "registry": str(REGISTRY_DIR),
        "locks": str(LOCK_DIR),
        "current_session_root": str(cwd_session["session_root"]),
        "current_project_key": route["project_key"],
        "current_project": route["chatgpt_project"],
        "current_project_url": route["project_url"],
        "current_project_route_source": route["project_route_source"],
        "default_project": DEFAULT_CHATGPT_PROJECT,
        "default_project_url": DEFAULT_CHATGPT_PROJECT_URL,
        "example_project": EXAMPLE_CHATGPT_PROJECT,
        "example_project_url": EXAMPLE_CHATGPT_PROJECT_URL,
        "default_mode_label": DEFAULT_MODE_LABEL,
        "mode_label_aliases": "深入",
        "conversation_policy": DEFAULT_CONVERSATION_POLICY,
        "reuse_existing_flag": "--reuse-existing",
        "default_concurrency": DEFAULT_CONCURRENCY,
        "max_concurrency": MAX_CONCURRENCY,
        "chrome_helper": str(helper or "missing"),
        "chrome_runner": str(PLUGIN_ROOT / "scripts" / "gpt_chrome_runner.mjs"),
        "bin": str(bin_path) if bin_path.exists() else "missing",
        "marketplace_entry": "ok" if marketplace_has_plugin() else "missing",
        "codex_skill": str(CODEX_SKILL_DIR) if (CODEX_SKILL_DIR / "SKILL.md").exists() else "missing",
        "agents_skill": str(AGENTS_SKILL_DIR) if (AGENTS_SKILL_DIR / "SKILL.md").exists() else "missing",
        "plugin_cache_skill": str(PLUGIN_CACHE_SKILL_DIR) if (PLUGIN_CACHE_SKILL_DIR / "SKILL.md").exists() else "missing",
        "mcp_tool": "not_applicable_skill_and_cli",
        "trusted_chrome_runtime": "requires Codex Chrome skill / node_repl",
        "browser_control_policy": "Chrome plugin first; Computer Use only for last-resort manual handoff",
    }
    for key, value in checks.items():
        print(f"{key}: {value}")
    try:
        with FileLock(LOCK_DIR / ".doctor.lock"):
            pass
        print("fcntl_lock: ok")
    except Exception as exc:
        print(f"fcntl_lock: failed ({exc})")
        return 1
    return 0 if helper else 1


def resume_run(args: argparse.Namespace) -> int:
    session = resolve_session(args)
    config = effective_config(args, session)
    key = registry_key_for_session(session)
    registry = load_json(REGISTRY_DIR / f"{key}.json")
    if not registry and not session.get("exact_topic"):
        legacy_key = legacy_topic_registry_key_for_session(session)
        registry = load_json(REGISTRY_DIR / f"{legacy_key}.json")
    if not registry:
        print(f"No registry found for {key}")
        print(json.dumps({
            "conversation_policy": DEFAULT_CONVERSATION_POLICY,
            "note": "Default submissions create a new ChatGPT Project conversation. Registry URLs are used only with --reuse-existing.",
            "session_root": str(session["session_root"]),
            "project": config,
        }, ensure_ascii=False, indent=2))
        return 1
    registry_url, stale = registry_conversation_for_project(registry, config)
    print(json.dumps({
        "conversation_policy": DEFAULT_CONVERSATION_POLICY,
        "reuse_existing_flag": "--reuse-existing",
        "note": "Default submissions create a new ChatGPT Project conversation. The registry URL below is advisory unless --reuse-existing is passed.",
        "resolved_project": config,
        "registry": registry,
        "usable_conversation_url": registry_url,
        **stale,
    }, ensure_ascii=False, indent=2))
    return 0


def adopt_conversation(args: argparse.Namespace) -> int:
    session = resolve_session(args)
    config = effective_config(args, session)
    conversation_url = normalize_conversation_url(args.adopt_url)
    if not conversation_belongs_to_project(conversation_url, config["project_url"]):
        raise SystemExit(
            "The adopted conversation URL does not belong to the resolved ChatGPT Project:\n"
            f"- resolved project: {config['chatgpt_project']} ({config['project_url']})\n"
            f"- adopt URL: {conversation_url}"
        )
    key = registry_key_for_session(session)
    registry_path = REGISTRY_DIR / f"{key}.json"
    existing = load_json(registry_path) or {}
    title = conversation_title_phrase(args.title or "") or display_title_for_session(
        session["session_root"],
        session["topic"],
        int(existing.get("part", 1) or 1),
    )
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    write_json(
        registry_path,
        {
            **existing,
            "project_root": str(session["session_root"]),
            "bundle_root": str(session["bundle_root"]),
            "session_root": str(session["session_root"]),
            "topic": session["topic"],
            "requested_topic": session["requested_topic"],
            "stable_topic": session["stable_topic"],
            "subtopics": session["subtopics"],
            "registry_key": key,
            "legacy_topic_registry_key": legacy_topic_registry_key_for_session(session),
            "registry_scope": "topic" if session["exact_topic"] else "session_root",
            "chatgpt_project": config["chatgpt_project"],
            "project_key": config["project_key"],
            "project_url": config["project_url"],
            "project_slug": config["project_slug"],
            "project_route_source": config["project_route_source"],
            "conversation_title": title,
            "conversation_url": conversation_url,
            "part": int(existing.get("part", 1) or 1),
            "adopted_manually": True,
            "updated_at": now_iso(),
        },
    )
    print(json.dumps(load_json(registry_path), ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prepare and manage ChatGPT Pro web review runs.")
    parser.add_argument("prompt", nargs="*", help="Review prompt.")
    parser.add_argument("--project-root", help="Project root to bundle. Defaults to Git root or cwd.")
    parser.add_argument("--session-root", help="Stable root for routing and optional explicit reuse. Defaults to an example_project workstream root or Git root.")
    parser.add_argument("--topic", default=DEFAULT_TOPIC, help="Stable session topic. Default: default.")
    parser.add_argument("--exact-topic", action="store_true", help="Use --topic exactly instead of workstream-level canonicalization.")
    parser.add_argument("--subtopic", action="append", help="Current task label added to the prompt but not session key.")
    parser.add_argument("--file", action="append", help="Explicit file to force-include in the bundle.")
    parser.add_argument("--packet", action="append", help="Markdown/text packet to inline and force-include.")
    parser.add_argument(
        "--mode",
        choices=["project-review", "discussion", "independent-plan", "final-review", "figure-review"],
        default="project-review",
        help="Review mode. Default: project-review.",
    )
    parser.add_argument("--project-name", help="ChatGPT Project display name. Defaults to fixed path-based routing.")
    parser.add_argument("--project-url", help="Exact ChatGPT Project URL. Overrides fixed path-based routing.")
    parser.add_argument("--mode-label", help=f"Required ChatGPT mode label. Default: {DEFAULT_MODE_LABEL}.")
    parser.add_argument(
        "--concurrency",
        default=None,
        help=f"Parallel Chrome tab concurrency, 1-{MAX_CONCURRENCY}. Default: {DEFAULT_CONCURRENCY}.",
    )
    parser.add_argument("--detach", action="store_true", help="Submit for later extraction. The tab closes after submit unless --keep-open is also set.")
    parser.add_argument("--keep-open", action="store_true", help="Keep a successful conversation tab open for multi-round review; omit on the final round to close it.")
    parser.add_argument(
        "--auto-rename",
        action="store_true",
        help="Attempt to rename the ChatGPT conversation after completion. Disabled by default to avoid mis-clicking attachment/file controls.",
    )
    parser.add_argument(
        "--allow-enter-submit",
        action="store_true",
        help="Allow Enter-key submit when no safe send button is found. Disabled by default to avoid triggering file-card downloads.",
    )
    parser.add_argument("--resume", action="store_true", help="Print registry state for the current project/topic.")
    parser.add_argument("--fresh", action="store_true", help="Compatibility no-op: creating a new conversation is already the default.")
    parser.add_argument("--reuse-existing", action="store_true", help="Explicitly reuse an adopted/registry ChatGPT conversation instead of creating a new one.")
    parser.add_argument("--dry-run", action="store_true", help="Build manifest/reports but do not create upload zip.")
    parser.add_argument("--max-file-bytes", type=int, default=DEFAULT_MAX_FILE_BYTES)
    parser.add_argument("--max-bundle-bytes", type=int, default=DEFAULT_MAX_BUNDLE_BYTES)
    parser.add_argument("--finalize", help="Finalize a run directory after Chrome runner wrote response.md.")
    parser.add_argument("--show", metavar="RUN_ID|last", help="Show a saved response or status.")
    parser.add_argument("--list", action="store_true", help="List known GPT Pro review sessions.")
    parser.add_argument("--clean", action="store_true", help="Remove old run packets.")
    parser.add_argument("--days", type=int, default=30, help="Age threshold for --clean.")
    parser.add_argument("--doctor", action="store_true", help="Check local setup.")
    parser.add_argument("--repair-install", action="store_true", help="Repair marketplace, skill copies, and CLI symlink.")
    parser.add_argument("--repair-registry", action="store_true", help="Report legacy registry entries and suggested stable-session keys.")
    parser.add_argument("--adopt-url", help="Adopt an existing ChatGPT /c/... conversation URL into the local registry without opening Chrome.")
    parser.add_argument("--title", help="Optional human title for --adopt-url registry entries.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.repair_install:
        return repair_install()
    if args.repair_registry:
        return repair_registry(args.dry_run)
    if args.doctor:
        return doctor()
    if args.list:
        return list_runs()
    if args.clean:
        return clean_runs(args.days)
    if args.show:
        return show_run(args.show)
    if args.finalize:
        return finalize_run(Path(args.finalize))
    if args.resume:
        return resume_run(args)
    if args.adopt_url:
        session = resolve_session(args)
        key = registry_key_for_session(session)
        with FileLock(LOCK_DIR / f"{key}.lock"):
            return adopt_conversation(args)
    session = resolve_session(args)
    key = registry_key_for_session(session)
    if args.reuse_existing:
        with FileLock(LOCK_DIR / f"{key}.lock"):
            run_dir = prepare_run(args)
    else:
        run_dir = prepare_run(args)
    print(run_dir)
    if args.dry_run:
        print("Dry run prepared. No upload bundle zip was created.")
    else:
        print("Prepared upload_bundle.zip. Run the Codex Chrome runner to submit this review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
