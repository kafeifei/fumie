#!/usr/bin/env python3
"""Track the exact Git source state represented by the Fumie Debug package."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


VERSION = 1


def git_bytes(repo: Path, *args: str) -> bytes:
	return subprocess.check_output(
		["git", *args],
		cwd=repo,
		stderr=subprocess.DEVNULL,
	)


def nul_paths(payload: bytes) -> set[str]:
	return {
		os.fsdecode(item)
		for item in payload.split(b"\0")
		if item
	}


def dirty_paths(repo: Path) -> set[str]:
	tracked = nul_paths(git_bytes(repo, "diff", "HEAD", "--name-only", "--no-renames", "-z", "--"))
	untracked = nul_paths(git_bytes(repo, "ls-files", "--others", "--exclude-standard", "-z", "--"))
	return tracked | untracked


def path_state(repo: Path, relative: str) -> dict[str, str | int]:
	path = repo / relative
	try:
		info = path.lstat()
	except FileNotFoundError:
		return {"type": "missing"}

	mode = stat.S_IMODE(info.st_mode)
	if stat.S_ISLNK(info.st_mode):
		target = os.readlink(os.fsencode(path))
		return {
			"type": "symlink",
			"mode": mode,
			"sha256": hashlib.sha256(target).hexdigest(),
		}
	if stat.S_ISREG(info.st_mode):
		digest = hashlib.sha256()
		with path.open("rb", buffering=0) as handle:
			while chunk := handle.read(1024 * 1024):
				digest.update(chunk)
		return {
			"type": "file",
			"mode": mode,
			"sha256": digest.hexdigest(),
		}
	return {"type": "other", "mode": mode}


def snapshot(repo: Path) -> dict[str, object]:
	head = git_bytes(repo, "rev-parse", "HEAD").decode("ascii").strip()
	dirty = {
		path: path_state(repo, path)
		for path in sorted(dirty_paths(repo))
	}
	context = {
		"arch": os.environ.get("FUMIE_DEBUG_STATE_ARCH", ""),
		"node": os.environ.get("FUMIE_DEBUG_STATE_NODE_VERSION", ""),
	}
	return {"version": VERSION, "head": head, "dirty": dirty, "context": context}


def serialized_snapshot(repo: Path) -> str:
	return json.dumps(snapshot(repo), ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def tree_fingerprint(root: Path) -> str:
	digest = hashlib.sha256()
	root_bytes = os.fsencode(root)
	for directory, dirnames, filenames in os.walk(root_bytes, topdown=True, followlinks=False):
		dirnames.sort()
		filenames.sort()
		for name in [*dirnames, *filenames]:
			path = os.path.join(directory, name)
			info = os.lstat(path)
			relative = os.path.relpath(path, root_bytes)
			digest.update(relative + b"\0")
			digest.update(f"{stat.S_IMODE(info.st_mode):04o}".encode("ascii") + b"\0")
			if stat.S_ISLNK(info.st_mode):
				digest.update(b"L\0" + os.readlink(path) + b"\0")
			elif stat.S_ISREG(info.st_mode):
				digest.update(b"F\0" + str(info.st_size).encode("ascii") + b"\0")
				with open(path, "rb", buffering=0) as handle:
					while chunk := handle.read(1024 * 1024):
						digest.update(chunk)
			elif stat.S_ISDIR(info.st_mode):
				digest.update(b"D\0")
			else:
				digest.update(b"O\0")
	return digest.hexdigest()


def classify(repo: Path, state_file: Path) -> tuple[str, list[str]]:
	try:
		previous = json.loads(state_file.read_text(encoding="utf-8"))
	except (FileNotFoundError, OSError, json.JSONDecodeError):
		return "full", []
	current = snapshot(repo)
	if previous.get("version") != VERSION:
		return "full", []
	if previous.get("context") != current.get("context"):
		return "full", []
	previous_head = previous.get("head")
	if not isinstance(previous_head, str):
		return "full", []
	try:
		committed = nul_paths(git_bytes(repo, "diff", "--name-only", "--no-renames", "-z", previous_head, str(current["head"]), "--"))
	except subprocess.CalledProcessError:
		return "full", []

	previous_dirty = previous.get("dirty")
	if not isinstance(previous_dirty, dict):
		return "full", []
	current_dirty = current["dirty"]
	assert isinstance(current_dirty, dict)
	dirty_changes = {
		path
		for path in set(previous_dirty) | set(current_dirty)
		if previous_dirty.get(path) != current_dirty.get(path)
	}
	changed = sorted(committed | dirty_changes)
	if not changed:
		return "unchanged", changed

	package_changes = [path for path in changed if not path.startswith("scripts/")]
	if not package_changes:
		return "unchanged", changed
	if all(path.startswith("src/") and not path.startswith("src/vscode-dts/") for path in package_changes):
		return "core", changed
	return "full", changed


def write_state(repo: Path, state_file: Path) -> None:
	state_file.parent.mkdir(parents=True, exist_ok=True)
	payload = f"{serialized_snapshot(repo)}\n"
	fd, temporary_name = tempfile.mkstemp(prefix=f".{state_file.name}.", dir=state_file.parent, text=True)
	try:
		with os.fdopen(fd, "w", encoding="utf-8") as handle:
			handle.write(payload)
			handle.flush()
			os.fsync(handle.fileno())
		os.replace(temporary_name, state_file)
	finally:
		try:
			os.unlink(temporary_name)
		except FileNotFoundError:
			pass


def main() -> int:
	if len(sys.argv) < 3:
		print(f"Usage: {sys.argv[0]} <snapshot|classify|write|fingerprint> PATH [STATE_FILE]", file=sys.stderr)
		return 2
	command = sys.argv[1]
	repo = Path(sys.argv[2]).resolve()
	if command == "snapshot" and len(sys.argv) == 3:
		print(serialized_snapshot(repo))
		return 0
	if command == "fingerprint" and len(sys.argv) == 3:
		print(tree_fingerprint(repo))
		return 0
	if command == "classify" and len(sys.argv) == 4:
		mode, paths = classify(repo, Path(sys.argv[3]))
		print(mode)
		for path in paths:
			print(f"[fumie-debug] package input changed: {path}", file=sys.stderr)
		return 0
	if command == "write" and len(sys.argv) == 4:
		write_state(repo, Path(sys.argv[3]))
		return 0
	print(f"Invalid arguments for {command!r}", file=sys.stderr)
	return 2


if __name__ == "__main__":
	raise SystemExit(main())
