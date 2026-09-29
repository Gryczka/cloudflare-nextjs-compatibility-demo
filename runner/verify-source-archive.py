#!/usr/bin/env python3
"""Generate benign and hostile ZIPs and verify the trusted source runner."""

from __future__ import annotations

import hashlib
import json
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import warnings
import zipfile
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "runner" / "prepare-source.py"
MAX_COMPRESSED_BYTES = 50 * 1024 * 1024
NEXT_RESOLVED = "https://registry.npmjs.org/next/-/next-16.0.0.tgz"
CONTENT_MARKER = b"source-content-must-not-appear-in-runner-output"


@dataclass(frozen=True)
class Entry:
    name: str
    data: bytes = b""
    mode: int = stat.S_IFREG | 0o644
    extra: bytes = b""
    compression: int = zipfile.ZIP_DEFLATED


def package_json(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "name": "safe-next-app",
        "version": "1.0.0",
        "dependencies": {"next": "16.0.0"},
    }
    value.update(overrides)
    return value


def package_lock(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "name": "safe-next-app",
        "lockfileVersion": 3,
        "packages": {
            "": {"name": "safe-next-app", "version": "1.0.0", "dependencies": {"next": "16.0.0"}},
            "node_modules/next": {"version": "16.0.0", "resolved": NEXT_RESOLVED},
            "node_modules/react": {"version": "19.0.0", "resolved": ""},
        },
    }
    value.update(overrides)
    return value


def json_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def base_entries(package: object | None = None, lock: object | None = None) -> list[Entry]:
    return [
        directory("project/"),
        Entry("project/package.json", json_bytes(package if package is not None else package_json())),
        Entry("project/package-lock.json", json_bytes(lock if lock is not None else package_lock())),
        directory("project/app/"),
        Entry("project/app/page.tsx", b"export default function Page() { return 'ok'; }"),
        Entry("project/app/content.txt", CONTENT_MARKER),
        Entry("project/.env.production.example", b"SAFE_TEMPLATE=true\n"),
        directory("project/empty/"),
    ]


def directory(name: str) -> Entry:
    return Entry(name=name, mode=stat.S_IFDIR | 0o755, compression=zipfile.ZIP_STORED)


def write_zip(path: Path, entries: list[Entry], *, reverse: bool = False, timestamp: tuple[int, int, int, int, int, int] = (2020, 1, 1, 0, 0, 0)) -> None:
    ordered = list(reversed(entries)) if reverse else entries
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(path, "w", allowZip64=True) as archive:
            for entry in ordered:
                info = zipfile.ZipInfo(entry.name, date_time=timestamp)
                info.create_system = 3
                info.external_attr = entry.mode << 16
                if stat.S_ISDIR(entry.mode):
                    info.external_attr |= 0x10
                info.compress_type = entry.compression
                info.extra = entry.extra
                archive.writestr(info, entry.data)


def run_runner(source: Path, output: Path, result: Path) -> subprocess.CompletedProcess[bytes]:
    completed = subprocess.run(
        [sys.executable, str(RUNNER), "--input", str(source), "--output", str(output), "--result", str(result)],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=30,
    )
    combined_output = completed.stdout + completed.stderr
    if CONTENT_MARKER in combined_output:
        raise AssertionError("runner disclosed source content")
    if completed.stdout:
        raise AssertionError("runner unexpectedly wrote to stdout")
    return completed


def verify_benign(workspace: Path) -> None:
    source_a = workspace / "benign-a.zip"
    source_b = workspace / "benign-b.zip"
    entries = base_entries()
    write_zip(source_a, entries)
    write_zip(source_b, entries, reverse=True, timestamp=(2030, 2, 2, 2, 2, 2))

    output_a = workspace / "benign-a.tar.gz"
    output_b = workspace / "benign-b.tar.gz"
    result_a = workspace / "benign-a.json"
    result_b = workspace / "benign-b.json"
    first = run_runner(source_a, output_a, result_a)
    second = run_runner(source_b, output_b, result_b)
    if first.returncode != 0 or second.returncode != 0:
        raise AssertionError("benign ZIP was rejected")
    if first.stderr or second.stderr:
        raise AssertionError("successful runner invocation wrote to stderr")
    if output_a.read_bytes() != output_b.read_bytes():
        raise AssertionError("normalized archives are not deterministic")

    manifest = json.loads(result_a.read_bytes())
    lock_bytes = next(entry.data for entry in entries if entry.name == "project/package-lock.json")
    with zipfile.ZipFile(source_a) as source_archive:
        source_infos = source_archive.infolist()
    expected = {
        "root": "project",
        "appName": "safe-next-app",
        "sourceHash": f"sha256:{hashlib.sha256(source_a.read_bytes()).hexdigest()}",
        "lockHash": f"sha256:{hashlib.sha256(lock_bytes).hexdigest()}",
        "entryCount": len(entries),
        "fileCount": 5,
        "directoryCount": 3,
        "compressedBytes": sum(info.compress_size for info in source_infos),
        "uncompressedBytes": sum(info.file_size for info in source_infos),
    }
    if manifest != expected:
        raise AssertionError(f"unexpected source manifest: {manifest!r}")
    if b"\n" in result_a.read_bytes():
        raise AssertionError("result JSON is not compact")
    if output_a.read_bytes()[4:8] != b"\x00\x00\x00\x00":
        raise AssertionError("gzip timestamp was not normalized")

    with tarfile.open(output_a, "r:gz") as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        expected_names = [
            ".env.production.example",
            "app",
            "app/content.txt",
            "app/page.tsx",
            "empty",
            "package-lock.json",
            "package.json",
        ]
        if names != expected_names:
            raise AssertionError(f"unexpected normalized members: {names!r}")
        if any(name == "project" or name.startswith("project/") for name in names):
            raise AssertionError("project wrapper leaked into normalized archive")
        for member in members:
            expected_mode = 0o755 if member.isdir() else 0o644
            if member.uid != 0 or member.gid != 0 or member.mtime != 0 or member.mode != expected_mode:
                raise AssertionError("tar metadata was not normalized")
            if not (member.isdir() or member.isfile()):
                raise AssertionError("normalized archive contains a link or special entry")
        extracted = archive.extractfile("app/content.txt")
        if extracted is None or extracted.read() != CONTENT_MARKER:
            raise AssertionError("normalized source content changed")
    print("[verify-source] benign deterministic normalization: passed")

    archive_root_entries = [
        replace(entry, name=entry.name[len("project/") :])
        for entry in base_entries(lock=package_lock(lockfileVersion=2))
        if entry.name not in {"project/", "project/app/"}
    ]
    archive_root_source = workspace / "archive-root.zip"
    archive_root_output = workspace / "archive-root.tar.gz"
    archive_root_result = workspace / "archive-root.json"
    write_zip(archive_root_source, archive_root_entries)
    completed = run_runner(archive_root_source, archive_root_output, archive_root_result)
    if completed.returncode != 0 or json.loads(archive_root_result.read_bytes())["root"] != ".":
        raise AssertionError("archive-root project or lockfile v2 was rejected")
    with tarfile.open(archive_root_output, "r:gz") as archive:
        if "app" not in [member.name for member in archive.getmembers() if member.isdir()]:
            raise AssertionError("normalization did not materialize an implicit directory")
    print("[verify-source] archive-root and implicit-directory normalization: passed")


def expect_rejected(
    workspace: Path,
    name: str,
    code: str,
    *,
    entries: list[Entry] | None = None,
    mutate: Callable[[Path], None] | None = None,
    raw: bytes | None = None,
) -> None:
    case_directory = workspace / name
    case_directory.mkdir()
    source = case_directory / "source.zip"
    output = case_directory / "source.tar.gz"
    result = case_directory / "result.json"
    if raw is not None:
        source.write_bytes(raw)
    else:
        write_zip(source, entries if entries is not None else base_entries())
    if mutate is not None:
        mutate(source)

    completed = run_runner(source, output, result)
    if completed.returncode == 0:
        raise AssertionError(f"{name}: hostile ZIP was accepted")
    if output.exists():
        raise AssertionError(f"{name}: rejected ZIP left a normalized archive")
    try:
        error = json.loads(result.read_bytes())["error"]
    except (FileNotFoundError, KeyError, json.JSONDecodeError) as caught:
        raise AssertionError(f"{name}: runner did not write a usable error result") from caught
    if error.get("code") != code:
        raise AssertionError(f"{name}: expected {code}, received {error!r}")
    if not completed.stderr:
        raise AssertionError(f"{name}: runner did not report failure on stderr")
    print(f"[verify-source] {name}: {code}")


def verify_adversarial(workspace: Path) -> None:
    expect_rejected(workspace, "malformed-zip", "INVALID_ARCHIVE", raw=b"not-a-zip " + CONTENT_MARKER)
    expect_rejected(workspace, "encrypted-entry", "ENCRYPTED_ENTRY", mutate=lambda path: set_encrypted(path, "project/app/page.tsx"))
    expect_rejected(
        workspace,
        "local-header-encryption",
        "ENCRYPTED_ENTRY",
        mutate=lambda path: set_local_encrypted(path, "project/app/page.tsx"),
    )
    expect_rejected(
        workspace,
        "aes-encryption-metadata",
        "ENCRYPTED_ENTRY",
        entries=base_entries() + [Entry("project/aes.dat", b"ciphertext", extra=aes_extra())],
    )
    expect_rejected(workspace, "compressed-limit", "COMPRESSED_SIZE_EXCEEDED", mutate=exceed_physical_limit)
    expect_rejected(workspace, "expanded-limit", "EXPANDED_SIZE_EXCEEDED", mutate=lambda path: set_uncompressed_size(path, "project/app/page.tsx", 1024 * 1024 * 1024 + 1))

    many_entries = base_entries() + [
        Entry(f"project/many/{index:05d}", b"", compression=zipfile.ZIP_STORED) for index in range(50_000)
    ]
    expect_rejected(workspace, "entry-limit", "ENTRY_LIMIT_EXCEEDED", entries=many_entries)
    deep_path = "project/" + "/".join(f"d{index}" for index in range(32)) + "/file.txt"
    expect_rejected(workspace, "depth-limit", "PATH_DEPTH_EXCEEDED", entries=base_entries() + [Entry(deep_path, b"x")])
    expect_rejected(
        workspace,
        "compression-ratio",
        "COMPRESSION_RATIO_EXCEEDED",
        entries=base_entries() + [Entry("project/app/bomb.txt", b"A" * 100_000)],
    )

    unsafe_paths = {
        "absolute-path": "/absolute.txt",
        "drive-path": "C:/absolute.txt",
        "traversal": "project/../escape.txt",
        "backslash": "project\\escape.txt",
        "dot-segment": "project/./escape.txt",
        "empty-segment": "project//escape.txt",
    }
    for name, path in unsafe_paths.items():
        expect_rejected(workspace, name, "INVALID_PATH", entries=base_entries() + [Entry(path, b"x")])

    nul_entries = base_entries() + [Entry("project/nulXname.txt", b"x")]
    expect_rejected(
        workspace,
        "nul-path",
        "INVALID_PATH",
        entries=nul_entries,
        mutate=lambda path: replace_filename_byte(path, "project/nulXname.txt", b"X", b"\x00"),
    )
    expect_rejected(
        workspace,
        "duplicate-path",
        "DUPLICATE_PATH",
        entries=base_entries() + [Entry("project/app/page.tsx", b"duplicate")],
    )
    expect_rejected(
        workspace,
        "case-collision",
        "CASE_COLLISION",
        entries=base_entries() + [Entry("project/App/other.tsx", b"x")],
    )
    expect_rejected(
        workspace,
        "symlink",
        "UNSUPPORTED_ENTRY_KIND",
        entries=base_entries() + [Entry("project/link", b"target", mode=stat.S_IFLNK | 0o777)],
    )
    expect_rejected(
        workspace,
        "hardlink-extra",
        "UNSUPPORTED_ENTRY_KIND",
        entries=base_entries()
        + [Entry("project/hardlink", b"", extra=unix_link_extra(b"project/app/page.tsx"), compression=zipfile.ZIP_STORED)],
    )
    hardlink_alias = base_entries() + [Entry("project/hardlink-copy.txt", b"placeholder", compression=zipfile.ZIP_STORED)]
    expect_rejected(
        workspace,
        "hardlink-alias",
        "UNSUPPORTED_ENTRY_KIND",
        entries=hardlink_alias,
        mutate=lambda path: alias_local_record(path, "project/hardlink-copy.txt", "project/app/page.tsx"),
    )
    expect_rejected(
        workspace,
        "device",
        "UNSUPPORTED_ENTRY_KIND",
        entries=base_entries() + [Entry("project/device", b"", mode=stat.S_IFCHR | 0o600, compression=zipfile.ZIP_STORED)],
    )

    forbidden = {
        "nested-archive": ("project/vendor.TAR.GZ", "NESTED_ARCHIVE"),
        "node-modules": ("project/node_modules/evil.js", "FORBIDDEN_PATH"),
        "git-directory": ("project/.Git/config", "FORBIDDEN_PATH"),
        "npmrc": ("project/.npmrc", "FORBIDDEN_PATH"),
        "environment-secret": ("project/.env.local", "FORBIDDEN_CREDENTIAL"),
        "credential": ("project/client-credentials.yml", "FORBIDDEN_CREDENTIAL"),
        "private-key": ("project/server.pem", "FORBIDDEN_CREDENTIAL"),
    }
    for name, (path, code) in forbidden.items():
        expect_rejected(workspace, name, code, entries=base_entries() + [Entry(path, b"x")])

    expect_rejected(
        workspace,
        "multiple-roots",
        "AMBIGUOUS_ROOT",
        entries=base_entries() + [Entry("other/package.json", json_bytes(package_json()))],
    )
    expect_rejected(
        workspace,
        "sibling-payload",
        "AMBIGUOUS_ROOT",
        entries=base_entries() + [Entry("outside.txt", b"x")],
    )
    expect_rejected(
        workspace,
        "workspace-package",
        "WORKSPACES_NOT_SUPPORTED",
        entries=base_entries(package_json(workspaces=["packages/*"])),
    )
    expect_rejected(
        workspace,
        "local-package-dependency",
        "WORKSPACES_NOT_SUPPORTED",
        entries=base_entries(package_json(dependencies={"next": "16.0.0", "local": "file:../local"})),
    )

    local_lock = package_lock()
    local_packages = dict(local_lock["packages"])
    local_packages["packages/local"] = {"version": "1.0.0"}
    local_lock["packages"] = local_packages
    expect_rejected(
        workspace,
        "local-lock-package",
        "WORKSPACES_NOT_SUPPORTED",
        entries=base_entries(lock=local_lock),
    )
    expect_rejected(
        workspace,
        "lockfile-v1",
        "INVALID_PACKAGE_LOCK",
        entries=base_entries(lock=package_lock(lockfileVersion=1)),
    )
    expect_rejected(
        workspace,
        "missing-production-next",
        "INVALID_PACKAGE_JSON",
        entries=base_entries(package_json(dependencies={}, devDependencies={"next": "16.0.0"})),
    )

    for name, resolved in {
        "resolved-http": "http://registry.npmjs.org/next/-/next.tgz",
        "resolved-host": "https://registry.example.test/next.tgz",
        "resolved-credentials": "https://user@registry.npmjs.org/next.tgz",
        "resolved-port": "https://registry.npmjs.org:443/next.tgz",
    }.items():
        lock = package_lock()
        packages = dict(lock["packages"])
        packages["node_modules/next"] = {"version": "16.0.0", "resolved": resolved}
        lock["packages"] = packages
        expect_rejected(workspace, name, "UNTRUSTED_RESOLVED_URL", entries=base_entries(lock=lock))

    recursive_lock = package_lock(
        dependencies={"transitive": {"version": "1.0.0", "resolved": "https://packages.example.test/transitive.tgz"}}
    )
    expect_rejected(
        workspace,
        "recursive-resolved-host",
        "UNTRUSTED_RESOLVED_URL",
        entries=base_entries(lock=recursive_lock),
    )

    corrupt_entries = base_entries() + [Entry("project/app/corrupt.txt", b"integrity", compression=zipfile.ZIP_STORED)]
    expect_rejected(
        workspace,
        "crc-corruption",
        "INVALID_ARCHIVE",
        entries=corrupt_entries,
        mutate=lambda path: corrupt_stored_data(path, "project/app/corrupt.txt"),
    )


def central_records(data: bytearray) -> dict[str, tuple[int, int]]:
    records: dict[str, tuple[int, int]] = {}
    offset = 0
    signature = b"PK\x01\x02"
    while True:
        offset = data.find(signature, offset)
        if offset < 0:
            break
        if offset + 46 > len(data):
            raise AssertionError("truncated generated central directory")
        name_length, extra_length, comment_length = struct.unpack_from("<HHH", data, offset + 28)
        local_offset = struct.unpack_from("<I", data, offset + 42)[0]
        name_start = offset + 46
        name = bytes(data[name_start : name_start + name_length]).decode("utf-8")
        records[name] = (offset, local_offset)
        offset = name_start + name_length + extra_length + comment_length
    return records


def mutate_zip(path: Path, change: Callable[[bytearray, dict[str, tuple[int, int]]], None]) -> None:
    data = bytearray(path.read_bytes())
    records = central_records(data)
    change(data, records)
    path.write_bytes(data)


def set_encrypted(path: Path, name: str) -> None:
    def change(data: bytearray, records: dict[str, tuple[int, int]]) -> None:
        central, local = records[name]
        struct.pack_into("<H", data, central + 8, struct.unpack_from("<H", data, central + 8)[0] | 1)
        struct.pack_into("<H", data, local + 6, struct.unpack_from("<H", data, local + 6)[0] | 1)

    mutate_zip(path, change)


def set_local_encrypted(path: Path, name: str) -> None:
    def change(data: bytearray, records: dict[str, tuple[int, int]]) -> None:
        _, local = records[name]
        struct.pack_into("<H", data, local + 6, struct.unpack_from("<H", data, local + 6)[0] | 1)

    mutate_zip(path, change)


def exceed_physical_limit(path: Path) -> None:
    with path.open("r+b") as archive:
        archive.seek(MAX_COMPRESSED_BYTES)
        archive.write(b"x")


def set_uncompressed_size(path: Path, name: str, size: int) -> None:
    def change(data: bytearray, records: dict[str, tuple[int, int]]) -> None:
        central, local = records[name]
        struct.pack_into("<I", data, central + 24, size)
        struct.pack_into("<I", data, local + 22, size)

    mutate_zip(path, change)


def replace_filename_byte(path: Path, name: str, old: bytes, new: bytes) -> None:
    def change(data: bytearray, records: dict[str, tuple[int, int]]) -> None:
        central, local = records[name]
        encoded = name.encode("utf-8")
        relative = encoded.index(old)
        central_name = central + 46
        local_name = local + 30
        data[central_name + relative : central_name + relative + 1] = new
        data[local_name + relative : local_name + relative + 1] = new

    mutate_zip(path, change)


def unix_link_extra(target: bytes) -> bytes:
    payload = b"\x00" * 12 + target
    return struct.pack("<HH", 0x000D, len(payload)) + payload


def aes_extra() -> bytes:
    payload = b"\x02\x00AE\x03\x08\x00"
    return struct.pack("<HH", 0x9901, len(payload)) + payload


def alias_local_record(path: Path, alias: str, target: str) -> None:
    def change(data: bytearray, records: dict[str, tuple[int, int]]) -> None:
        alias_central, _ = records[alias]
        _, target_local = records[target]
        struct.pack_into("<I", data, alias_central + 42, target_local)

    mutate_zip(path, change)


def corrupt_stored_data(path: Path, name: str) -> None:
    def change(data: bytearray, records: dict[str, tuple[int, int]]) -> None:
        _, local = records[name]
        name_length, extra_length = struct.unpack_from("<HH", data, local + 26)
        payload = local + 30 + name_length + extra_length
        data[payload] ^= 0x01

    mutate_zip(path, change)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="verify-source-archive-") as temporary_directory:
        workspace = Path(temporary_directory)
        verify_benign(workspace)
        verify_adversarial(workspace)
    print("[verify-source] all generated ZIP checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
