#!/usr/bin/env python3
"""Validate and normalize an untrusted Next.js source ZIP."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import stat
import struct
import sys
import tarfile
import tempfile
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, NoReturn
from urllib.parse import urlsplit


MIB = 1024 * 1024
MAX_COMPRESSED_BYTES = 50 * MIB
MAX_EXPANDED_BYTES = 1024 * MIB
MAX_ENTRIES = 50_000
MAX_DEPTH = 32
MAX_COMPRESSION_RATIO = 100
MAX_PACKAGE_JSON_BYTES = 2 * MIB
MAX_PACKAGE_LOCK_BYTES = 32 * MIB
COPY_CHUNK_BYTES = MIB

ARCHIVE_SUFFIXES = (
    ".a",
    ".7z",
    ".apk",
    ".ar",
    ".br",
    ".bz2",
    ".cab",
    ".cpio",
    ".deb",
    ".dmg",
    ".ear",
    ".gz",
    ".img",
    ".ipa",
    ".iso",
    ".jar",
    ".lz",
    ".lz4",
    ".lzma",
    ".nupkg",
    ".pkg",
    ".rar",
    ".rpm",
    ".tar",
    ".tar.br",
    ".tar.bz2",
    ".tar.gz",
    ".tar.lz",
    ".tar.lz4",
    ".tar.lzma",
    ".tar.xz",
    ".tar.zst",
    ".taz",
    ".tbz",
    ".tbz2",
    ".tgz",
    ".tlz",
    ".txz",
    ".tzst",
    ".war",
    ".whl",
    ".xz",
    ".xpi",
    ".z",
    ".zip",
    ".zipx",
    ".zst",
)
SAFE_TEMPLATE_SUFFIXES = ("example", "sample", "template", "dist")
CREDENTIAL_FILENAMES = frozenset(
    {
        ".credentials",
        ".credentials.json",
        ".dockerconfigjson",
        ".netrc",
        ".pypirc",
        ".secrets",
        "auth.json",
        "credentials",
        "credentials.json",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        "id_rsa",
        "kubeconfig",
        "secret.json",
        "secrets.json",
        "service-account.json",
        "service-account-key.json",
        "service_account.json",
        "service_account_key.json",
    }
)
DEPENDENCY_SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")
DEPENDENCY_MAP_KEYS = (*DEPENDENCY_SECTIONS, "requires")
DRIVE_PATH = re.compile(r"^[A-Za-z]:")
STRUCTURED_CREDENTIAL = re.compile(r"^(.*)\.(?:json|ya?ml|toml|ini|conf|config)$")
CREDENTIAL_TOKEN = re.compile(r"(?:^|[._-])(?:credential|credentials|secret|secrets)(?:[._-]|$)")
PRIVATE_KEY_SUFFIX = re.compile(r"\.(?:key|pem|p12|pfx|jks|keystore)$")
LOCAL_DEPENDENCY_PREFIX = re.compile(r"^(?:workspace|file|link):", re.IGNORECASE)
CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")
URL_CONTROL_OR_SPACE = re.compile(r"[\x00-\x20\x7f]")
SPECIAL_FILE_TYPES = frozenset(
    {
        stat.S_IFLNK,
        stat.S_IFCHR,
        stat.S_IFBLK,
        stat.S_IFIFO,
        stat.S_IFSOCK,
    }
)


class SourceArchiveError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message


class DuplicateJsonKey(ValueError):
    pass


@dataclass(frozen=True)
class ArchiveEntry:
    info: zipfile.ZipInfo
    path: str
    segments: tuple[str, ...]
    kind: str


@dataclass(frozen=True)
class ArchiveInspection:
    entries: tuple[ArchiveEntry, ...]
    root: str
    package_json: ArchiveEntry
    package_lock: ArchiveEntry
    entry_count: int
    file_count: int
    directory_count: int
    compressed_bytes: int
    uncompressed_bytes: int


def fail(code: str, message: str) -> NoReturn:
    raise SourceArchiveError(code, message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate and normalize a trusted-boundary source ZIP",
        allow_abbrev=False,
    )
    parser.add_argument("--input", required=True, help="input ZIP path")
    parser.add_argument("--output", required=True, help="normalized tar.gz path")
    parser.add_argument("--result", required=True, help="result JSON path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        input_path, output_path, result_path = validated_cli_paths(args.input, args.output, args.result)
    except SourceArchiveError as error:
        emit_error(error)
        return 2

    try:
        prepare_source(input_path, output_path, result_path)
        return 0
    except SourceArchiveError as error:
        remove_path(output_path)
        write_error_result(result_path, error)
        emit_error(error)
        return 2
    except Exception:
        error = SourceArchiveError("INTERNAL_ERROR", "Source preparation failed safely")
        remove_path(output_path)
        write_error_result(result_path, error)
        emit_error(error)
        return 1


def validated_cli_paths(input_value: str, output_value: str, result_value: str) -> tuple[Path, Path, Path]:
    paths = tuple(Path(os.path.abspath(value)) for value in (input_value, output_value, result_value))
    real_paths = tuple(os.path.realpath(path) for path in paths)
    if len(set(real_paths)) != 3:
        fail("INVALID_ARGUMENT", "Input, output, and result paths must be distinct")

    for left_index in range(len(paths)):
        for right_index in range(left_index + 1, len(paths)):
            try:
                if os.path.samefile(paths[left_index], paths[right_index]):
                    fail("INVALID_ARGUMENT", "Input, output, and result paths must not alias")
            except FileNotFoundError:
                continue
    return paths[0], paths[1], paths[2]


def prepare_source(input_path: Path, output_path: Path, result_path: Path) -> None:
    source_hash: str
    archive_temporary: Path | None = None
    result_temporary: Path | None = None

    with snapshot_source(input_path) as snapshot:
        source_hash = snapshot.digest
        try:
            with zipfile.ZipFile(snapshot.file, mode="r", allowZip64=True) as archive:
                inspection = inspect_archive(archive)
                package_bytes, _ = read_member_bounded(archive, inspection.package_json, MAX_PACKAGE_JSON_BYTES)
                lock_bytes, lock_hash = read_member_bounded(archive, inspection.package_lock, MAX_PACKAGE_LOCK_BYTES)
                package_json = parse_json_document(package_bytes, "INVALID_PACKAGE_JSON")
                package_lock = parse_json_document(lock_bytes, "INVALID_PACKAGE_LOCK")
                app_name, next_spec = validate_package_json(package_json)
                validate_package_lock(package_lock, app_name, next_spec)

                manifest = {
                    "root": inspection.root,
                    "appName": app_name,
                    "sourceHash": f"sha256:{source_hash}",
                    "lockHash": f"sha256:{lock_hash}",
                    "entryCount": inspection.entry_count,
                    "fileCount": inspection.file_count,
                    "directoryCount": inspection.directory_count,
                    "compressedBytes": inspection.compressed_bytes,
                    "uncompressedBytes": inspection.uncompressed_bytes,
                }

                del package_bytes, lock_bytes, package_json, package_lock
                with tempfile.TemporaryDirectory(prefix="source-archive-") as extraction_directory:
                    extraction_root = Path(extraction_directory)
                    extract_archive(archive, inspection, extraction_root)
                    archive_temporary = build_normalized_archive(output_path, extraction_root, inspection)

                result_temporary = stage_bytes(
                    result_path,
                    json.dumps(manifest, ensure_ascii=True, separators=(",", ":")).encode("utf-8"),
                )
        except SourceArchiveError:
            raise
        except (zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, NotImplementedError, EOFError, UnicodeError, struct.error):
            fail("INVALID_ARCHIVE", "Input is not a supported, internally consistent ZIP archive")

    try:
        if archive_temporary is None or result_temporary is None:
            raise RuntimeError("source preparation did not stage outputs")
        os.replace(archive_temporary, output_path)
        archive_temporary = None
        os.replace(result_temporary, result_path)
        result_temporary = None
        sync_parent(output_path)
        if output_path.parent != result_path.parent:
            sync_parent(result_path)
    finally:
        if archive_temporary is not None:
            remove_path(archive_temporary)
        if result_temporary is not None:
            remove_path(result_temporary)


@dataclass
class SourceSnapshot:
    file: BinaryIO
    digest: str

    def __enter__(self) -> SourceSnapshot:
        return self

    def __exit__(self, *_: object) -> None:
        self.file.close()


def snapshot_source(input_path: Path) -> SourceSnapshot:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(input_path, flags)
    except OSError:
        fail("INVALID_ARCHIVE", "Input ZIP must be an accessible regular file")

    source = os.fdopen(descriptor, "rb")
    try:
        source_stat = os.fstat(source.fileno())
        if not stat.S_ISREG(source_stat.st_mode):
            fail("INVALID_ARCHIVE", "Input ZIP must be a regular file")
        if source_stat.st_size > MAX_COMPRESSED_BYTES:
            fail("COMPRESSED_SIZE_EXCEEDED", f"Input ZIP exceeds {MAX_COMPRESSED_BYTES} compressed bytes")

        snapshot = tempfile.TemporaryFile(mode="w+b")
        digest = hashlib.sha256()
        copied = 0
        try:
            while True:
                chunk = source.read(COPY_CHUNK_BYTES)
                if not chunk:
                    break
                copied += len(chunk)
                if copied > MAX_COMPRESSED_BYTES:
                    fail("COMPRESSED_SIZE_EXCEEDED", f"Input ZIP exceeds {MAX_COMPRESSED_BYTES} compressed bytes")
                digest.update(chunk)
                snapshot.write(chunk)
            snapshot.flush()
            snapshot.seek(0)
            return SourceSnapshot(snapshot, digest.hexdigest())
        except Exception:
            snapshot.close()
            raise
    finally:
        source.close()


def inspect_archive(archive: zipfile.ZipFile) -> ArchiveInspection:
    infos = archive.infolist()
    if len(infos) > MAX_ENTRIES:
        fail("ENTRY_LIMIT_EXCEEDED", f"Archive exceeds the {MAX_ENTRIES} entry limit")

    entries: list[ArchiveEntry] = []
    explicit_paths: set[str] = set()
    tree_kinds: dict[str, str] = {}
    folded_paths: dict[str, str] = {}
    header_offsets: set[int] = set()
    package_json_entries: list[ArchiveEntry] = []
    package_lock_entries: list[ArchiveEntry] = []
    compressed_bytes = 0
    uncompressed_bytes = 0
    file_count = 0
    directory_count = 0

    for index, info in enumerate(infos):
        if info.flag_bits & 0x41:
            fail("ENCRYPTED_ENTRY", "Encrypted ZIP entries are not supported")
        if info.header_offset in header_offsets:
            fail("UNSUPPORTED_ENTRY_KIND", "ZIP entries may not alias the same local file record")
        header_offsets.add(info.header_offset)

        path, segments, trailing_slash = normalize_path(info, index)
        validate_local_header(archive, info)
        kind = classify_entry(info, trailing_slash)
        entry = ArchiveEntry(info=info, path=path, segments=segments, kind=kind)
        register_path(entry, explicit_paths, tree_kinds, folded_paths)
        validate_allowed_path(entry)

        if info.compress_size < 0 or info.file_size < 0:
            fail("INVALID_ENTRY", "ZIP entry sizes must be non-negative")
        if compressed_bytes > MAX_COMPRESSED_BYTES - info.compress_size:
            fail("COMPRESSED_SIZE_EXCEEDED", f"Archive entries exceed {MAX_COMPRESSED_BYTES} compressed bytes")
        if uncompressed_bytes > MAX_EXPANDED_BYTES - info.file_size:
            fail("EXPANDED_SIZE_EXCEEDED", f"Archive entries exceed {MAX_EXPANDED_BYTES} expanded bytes")
        compressed_bytes += info.compress_size
        uncompressed_bytes += info.file_size

        if info.file_size > 0 and (info.compress_size == 0 or info.file_size > info.compress_size * MAX_COMPRESSION_RATIO):
            fail("COMPRESSION_RATIO_EXCEEDED", f"A ZIP entry exceeds the {MAX_COMPRESSION_RATIO}:1 compression ratio limit")

        if kind == "file":
            file_count += 1
            if segments[-1] == "package.json":
                package_json_entries.append(entry)
            if segments[-1] == "package-lock.json":
                package_lock_entries.append(entry)
        else:
            directory_count += 1
        entries.append(entry)

    if uncompressed_bytes > 0 and (
        compressed_bytes == 0 or uncompressed_bytes > compressed_bytes * MAX_COMPRESSION_RATIO
    ):
        fail("COMPRESSION_RATIO_EXCEEDED", f"Archive exceeds the {MAX_COMPRESSION_RATIO}:1 aggregate compression ratio limit")

    root, package_json, package_lock = resolve_root(entries, package_json_entries, package_lock_entries)
    return ArchiveInspection(
        entries=tuple(entries),
        root=root,
        package_json=package_json,
        package_lock=package_lock,
        entry_count=len(entries),
        file_count=file_count,
        directory_count=directory_count,
        compressed_bytes=compressed_bytes,
        uncompressed_bytes=uncompressed_bytes,
    )


def validate_local_header(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> None:
    source = archive.fp
    if source is None:
        fail("INVALID_ARCHIVE", "ZIP local file records are unavailable")
    try:
        previous_offset = source.tell()
        source.seek(info.header_offset)
        header = source.read(30)
        if len(header) != 30:
            fail("INVALID_ARCHIVE", "ZIP contains a truncated local file record")
        (
            signature,
            _version,
            flags,
            compression,
            _time,
            _date,
            _crc,
            _compressed_size,
            _uncompressed_size,
            name_length,
            extra_length,
        ) = struct.unpack("<4s5H3I2H", header)
        if signature != b"PK\x03\x04":
            fail("INVALID_ARCHIVE", "ZIP contains an invalid local file record")
        if flags & 0x41:
            fail("ENCRYPTED_ENTRY", "Encrypted ZIP entries are not supported")
        if flags != info.flag_bits or compression != info.compress_type:
            fail("INVALID_ARCHIVE", "ZIP local and central file metadata do not match")

        encoded_name = source.read(name_length)
        local_extra = source.read(extra_length)
        if len(encoded_name) != name_length or len(local_extra) != extra_length:
            fail("INVALID_ARCHIVE", "ZIP contains a truncated local file record")
        encoding = "utf-8" if flags & 0x800 else "cp437"
        if encoded_name.decode(encoding, errors="strict") != info.orig_filename:
            fail("INVALID_ARCHIVE", "ZIP local and central paths do not match")
        validate_extra_fields(local_extra)
    except SourceArchiveError:
        raise
    except (OSError, UnicodeError, struct.error):
        fail("INVALID_ARCHIVE", "ZIP local file record could not be validated")
    finally:
        try:
            source.seek(previous_offset)
        except (OSError, UnboundLocalError):
            pass


def normalize_path(info: zipfile.ZipInfo, index: int) -> tuple[str, tuple[str, ...], bool]:
    raw_path = info.orig_filename
    if not isinstance(raw_path, str) or not raw_path:
        fail("INVALID_PATH", f"ZIP entry {index} has an empty path")
    if "\x00" in raw_path:
        fail("INVALID_PATH", f"ZIP entry {index} path contains NUL")
    if "\\" in raw_path:
        fail("INVALID_PATH", f"ZIP entry {index} path contains a backslash")
    try:
        raw_path.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        fail("INVALID_PATH", f"ZIP entry {index} path is not valid Unicode")
    if raw_path.startswith("/") or DRIVE_PATH.match(raw_path):
        fail("INVALID_PATH", f"ZIP entry {index} path is absolute")

    trailing_slash = raw_path.endswith("/")
    path = raw_path[:-1] if trailing_slash else raw_path
    segments = tuple(path.split("/"))
    if any(not segment or segment == "." for segment in segments):
        fail("INVALID_PATH", f"ZIP entry {index} path is not canonical")
    if ".." in segments:
        fail("INVALID_PATH", f"ZIP entry {index} path contains traversal")
    if len(segments) > MAX_DEPTH:
        fail("PATH_DEPTH_EXCEEDED", f"ZIP entry {index} exceeds path depth {MAX_DEPTH}")
    return path, segments, trailing_slash


def classify_entry(info: zipfile.ZipInfo, trailing_slash: bool) -> str:
    if info.compress_type == 99:
        fail("ENCRYPTED_ENTRY", "Encrypted ZIP entries are not supported")
    validate_extra_fields(info.extra)
    mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    if file_type in SPECIAL_FILE_TYPES:
        fail("UNSUPPORTED_ENTRY_KIND", "ZIP links, devices, sockets, and pipes are not supported")
    if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
        fail("UNSUPPORTED_ENTRY_KIND", "ZIP entry has an unsupported file type")

    dos_directory = bool(info.external_attr & 0x10)
    if file_type == stat.S_IFDIR and not trailing_slash:
        fail("INVALID_PATH", "ZIP directory paths must end with a slash")
    if file_type == stat.S_IFREG and trailing_slash:
        fail("UNSUPPORTED_ENTRY_KIND", "ZIP entry type conflicts with its path")
    if dos_directory and not trailing_slash:
        fail("INVALID_PATH", "ZIP directory paths must end with a slash")

    kind = "directory" if trailing_slash else "file"
    if kind == "directory" and (info.file_size != 0 or info.compress_size != 0):
        fail("INVALID_ENTRY", "ZIP directories must not contain file data")
    return kind


def validate_extra_fields(extra: bytes) -> None:
    offset = 0
    while offset < len(extra):
        if len(extra) - offset < 4:
            fail("INVALID_ENTRY", "ZIP entry contains malformed extra metadata")
        field_id, field_size = struct.unpack_from("<HH", extra, offset)
        offset += 4
        if field_size > len(extra) - offset:
            fail("INVALID_ENTRY", "ZIP entry contains malformed extra metadata")
        payload = extra[offset : offset + field_size]
        offset += field_size

        if field_id in {0x0017, 0x9901}:
            fail("ENCRYPTED_ENTRY", "Encrypted ZIP entries are not supported")

        # PKWARE Unix and ASi Unix extras can carry link targets independently
        # of the central-directory mode bits.
        if field_id == 0x000D:
            if len(payload) < 12:
                fail("INVALID_ENTRY", "ZIP entry contains malformed Unix metadata")
            if len(payload) > 12:
                fail("UNSUPPORTED_ENTRY_KIND", "ZIP hard links and symbolic links are not supported")
        if field_id == 0x756E:
            if len(payload) < 14:
                fail("INVALID_ENTRY", "ZIP entry contains malformed Unix metadata")
            extra_mode = struct.unpack_from("<H", payload, 4)[0]
            if stat.S_IFMT(extra_mode) in SPECIAL_FILE_TYPES or len(payload) > 14:
                fail("UNSUPPORTED_ENTRY_KIND", "ZIP hard links and symbolic links are not supported")


def register_path(
    entry: ArchiveEntry,
    explicit_paths: set[str],
    tree_kinds: dict[str, str],
    folded_paths: dict[str, str],
) -> None:
    current = ""
    for index, segment in enumerate(entry.segments):
        current = segment if not current else f"{current}/{segment}"
        folded = case_fold(current)
        existing_spelling = folded_paths.get(folded)
        if existing_spelling is not None and existing_spelling != current:
            fail("CASE_COLLISION", "ZIP contains paths that collide under Unicode case folding")
        folded_paths[folded] = current

        final_segment = index == len(entry.segments) - 1
        existing_kind = tree_kinds.get(current)
        if not final_segment:
            if existing_kind == "file":
                fail("DUPLICATE_PATH", "ZIP uses a file path as a directory")
            tree_kinds[current] = "directory"
            continue

        if current in explicit_paths:
            fail("DUPLICATE_PATH", "ZIP contains a duplicate path")
        if existing_kind == "file" or (existing_kind == "directory" and entry.kind == "file"):
            fail("DUPLICATE_PATH", "ZIP path is used as both a file and a directory")
        explicit_paths.add(current)
        tree_kinds[current] = entry.kind


def validate_allowed_path(entry: ArchiveEntry) -> None:
    folded_segments = tuple(case_fold(segment) for segment in entry.segments)
    if any(segment in {"node_modules", ".git", ".npmrc"} for segment in folded_segments):
        fail("FORBIDDEN_PATH", "ZIP contains a forbidden source path")
    if entry.kind != "file":
        return

    filename = folded_segments[-1]
    if any(filename.endswith(suffix) for suffix in ARCHIVE_SUFFIXES):
        fail("NESTED_ARCHIVE", "ZIP contains a nested archive")
    if is_credential_path(folded_segments):
        fail("FORBIDDEN_CREDENTIAL", "ZIP contains a credential or environment file")


def is_credential_path(segments: tuple[str, ...]) -> bool:
    filename = segments[-1]
    parent = segments[-2] if len(segments) > 1 else None
    if is_environment_secret(filename, ".env") or is_environment_secret(filename, ".dev.vars"):
        return True
    if filename in CREDENTIAL_FILENAMES or PRIVATE_KEY_SUFFIX.search(filename):
        return True
    structured = STRUCTURED_CREDENTIAL.match(filename)
    if structured and CREDENTIAL_TOKEN.search(structured.group(1)):
        return True
    if parent == ".aws" and filename == "credentials":
        return True
    if parent == ".docker" and filename == "config.json":
        return True
    return False


def is_environment_secret(filename: str, prefix: str) -> bool:
    if filename == prefix:
        return True
    if not filename.startswith(f"{prefix}."):
        return False
    return not any(filename.endswith(f".{suffix}") for suffix in SAFE_TEMPLATE_SUFFIXES)


def resolve_root(
    entries: list[ArchiveEntry],
    package_json_entries: list[ArchiveEntry],
    package_lock_entries: list[ArchiveEntry],
) -> tuple[str, ArchiveEntry, ArchiveEntry]:
    if len(package_json_entries) != 1 or len(package_lock_entries) != 1:
        fail("AMBIGUOUS_ROOT", "ZIP must contain exactly one package.json and one package-lock.json")
    package_json = package_json_entries[0]
    package_lock = package_lock_entries[0]
    package_root = dirname(package_json.path)
    if package_root != dirname(package_lock.path):
        fail("AMBIGUOUS_ROOT", "package.json and package-lock.json must share one project root")

    if package_root != ".":
        for entry in entries:
            inside_root = entry.path == package_root or entry.path.startswith(f"{package_root}/")
            root_ancestor = entry.kind == "directory" and package_root.startswith(f"{entry.path}/")
            if not inside_root and not root_ancestor:
                fail("AMBIGUOUS_ROOT", "ZIP contains payload outside its project root")
    return package_root, package_json, package_lock


def read_member_bounded(archive: zipfile.ZipFile, entry: ArchiveEntry, limit: int) -> tuple[bytes, str]:
    if entry.info.file_size > limit:
        fail("METADATA_SIZE_EXCEEDED", "Project metadata file exceeds its trusted parsing limit")
    digest = hashlib.sha256()
    chunks: list[bytes] = []
    actual_size = 0
    stream = open_zip_member(archive, entry.info)
    try:
        while True:
            chunk = read_zip_chunk(stream)
            if not chunk:
                break
            actual_size += len(chunk)
            if actual_size > limit or actual_size > entry.info.file_size:
                fail("INVALID_ARCHIVE", "ZIP entry expanded beyond its declared size")
            digest.update(chunk)
            chunks.append(chunk)
    finally:
        stream.close()
    if actual_size != entry.info.file_size:
        fail("INVALID_ARCHIVE", "ZIP entry size does not match its central-directory metadata")
    return b"".join(chunks), digest.hexdigest()


def parse_json_document(data: bytes, code: str) -> Any:
    try:
        text = data.decode("utf-8-sig", errors="strict")
        return json.loads(
            text,
            object_pairs_hook=unique_json_object,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("non-finite JSON number")),
        )
    except (UnicodeError, json.JSONDecodeError, DuplicateJsonKey, ValueError, RecursionError):
        fail(code, "Project metadata must be strict UTF-8 JSON without duplicate keys")


def unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKey(key)
        result[key] = value
    return result


def validate_package_json(value: Any) -> tuple[str, str]:
    if not isinstance(value, dict):
        fail("INVALID_PACKAGE_JSON", "package.json must contain a JSON object")
    if "workspaces" in value:
        fail("WORKSPACES_NOT_SUPPORTED", "npm workspaces are not supported")

    app_name = value.get("name")
    if (
        not isinstance(app_name, str)
        or not app_name
        or len(app_name) > 214
        or app_name.strip() != app_name
        or CONTROL_CHARACTER.search(app_name)
    ):
        fail("INVALID_PACKAGE_JSON", "package.json must contain a valid application name")

    for section in DEPENDENCY_SECTIONS:
        dependencies = value.get(section)
        if not isinstance(dependencies, dict):
            continue
        for spec in dependencies.values():
            if isinstance(spec, str) and is_local_dependency(spec):
                fail("WORKSPACES_NOT_SUPPORTED", "package.json contains a local or workspace dependency")

    dependencies = value.get("dependencies")
    next_spec = dependencies.get("next") if isinstance(dependencies, dict) else None
    if not isinstance(next_spec, str) or not next_spec.strip():
        fail("INVALID_PACKAGE_JSON", "package.json must declare next in production dependencies")
    return app_name, next_spec


def validate_package_lock(value: Any, app_name: str, next_spec: str) -> None:
    if not isinstance(value, dict):
        fail("INVALID_PACKAGE_LOCK", "package-lock.json must contain a JSON object")
    lockfile_version = value.get("lockfileVersion")
    if type(lockfile_version) is not int or lockfile_version not in (2, 3):
        fail("INVALID_PACKAGE_LOCK", "package-lock.json lockfileVersion must be 2 or 3")
    if "workspaces" in value:
        fail("WORKSPACES_NOT_SUPPORTED", "package-lock.json workspaces are not supported")
    if "name" in value and value["name"] != app_name:
        fail("INVALID_PACKAGE_LOCK", "package-lock.json name does not match package.json")

    packages = value.get("packages")
    if not isinstance(packages, dict):
        fail("INVALID_PACKAGE_LOCK", "package-lock.json must contain a packages object")
    root_package = packages.get("")
    if not isinstance(root_package, dict):
        fail("INVALID_PACKAGE_LOCK", "package-lock.json must contain its root package entry")
    if "workspaces" in root_package:
        fail("WORKSPACES_NOT_SUPPORTED", "package-lock.json root package contains workspaces")
    if "name" in root_package and root_package["name"] != app_name:
        fail("INVALID_PACKAGE_LOCK", "package-lock.json root package name does not match package.json")
    root_dependencies = root_package.get("dependencies")
    if not isinstance(root_dependencies, dict) or root_dependencies.get("next") != next_spec:
        fail("INVALID_PACKAGE_LOCK", "package-lock.json does not lock the declared next dependency")

    for package_path, metadata in packages.items():
        if package_path and not is_node_modules_lock_path(package_path):
            fail("WORKSPACES_NOT_SUPPORTED", "package-lock.json contains a local or workspace package")
        if not isinstance(metadata, dict):
            fail("INVALID_PACKAGE_LOCK", "package-lock.json package entries must be objects")
        if metadata.get("link") is True:
            fail("WORKSPACES_NOT_SUPPORTED", "package-lock.json contains a local link")

    next_package = packages.get("node_modules/next")
    if not isinstance(next_package, dict):
        fail("INVALID_PACKAGE_LOCK", "package-lock.json must contain node_modules/next")
    next_resolved = next_package.get("resolved")
    if not isinstance(next_resolved, str) or not next_resolved:
        fail("INVALID_PACKAGE_LOCK", "package-lock.json must resolve node_modules/next")

    validate_lockfile_values(value)


def validate_lockfile_values(lockfile: dict[str, Any]) -> None:
    pending: list[Any] = [lockfile]
    while pending:
        current = pending.pop()
        if isinstance(current, dict):
            for key, child in current.items():
                if key == "workspaces":
                    fail("WORKSPACES_NOT_SUPPORTED", "package-lock.json contains workspace metadata")
                if key == "resolved":
                    validate_resolved_url(child)
                if key in {"version", "from"} and isinstance(child, str) and is_local_dependency(child):
                    fail("WORKSPACES_NOT_SUPPORTED", "package-lock.json contains a local dependency")
                if key == "link" and child is True:
                    fail("WORKSPACES_NOT_SUPPORTED", "package-lock.json contains a local link")
                if key in DEPENDENCY_MAP_KEYS and isinstance(child, dict):
                    for spec in child.values():
                        if isinstance(spec, str) and is_local_dependency(spec):
                            fail("WORKSPACES_NOT_SUPPORTED", "package-lock.json contains a local dependency")
                if isinstance(child, (dict, list)):
                    pending.append(child)
        elif isinstance(current, list):
            pending.extend(child for child in current if isinstance(child, (dict, list)))


def validate_resolved_url(value: Any) -> None:
    if value == "":
        return
    if not isinstance(value, str) or URL_CONTROL_OR_SPACE.search(value) or "\\" in value:
        fail("UNTRUSTED_RESOLVED_URL", "Every nonempty resolved value must use the public npm registry")
    try:
        resolved = urlsplit(value)
        port = resolved.port
    except ValueError:
        fail("UNTRUSTED_RESOLVED_URL", "Every nonempty resolved value must use the public npm registry")
    if (
        resolved.scheme.lower() != "https"
        or resolved.hostname is None
        or resolved.hostname.lower() != "registry.npmjs.org"
        or resolved.netloc.lower() != "registry.npmjs.org"
        or resolved.username is not None
        or resolved.password is not None
        or port is not None
    ):
        fail("UNTRUSTED_RESOLVED_URL", "Every nonempty resolved value must use the public npm registry")


def is_local_dependency(spec: str) -> bool:
    candidate = spec.lstrip()
    return bool(
        LOCAL_DEPENDENCY_PREFIX.match(candidate)
        or candidate in {".", "..", "~"}
        or candidate.startswith(("./", "../", "/", "~/", "\\"))
        or DRIVE_PATH.match(candidate)
    )


def is_node_modules_lock_path(path: Any) -> bool:
    if not isinstance(path, str) or not path.startswith("node_modules/"):
        return False
    return all(segment and segment not in {".", ".."} and "\\" not in segment for segment in path.split("/"))


def extract_archive(archive: zipfile.ZipFile, inspection: ArchiveInspection, destination_root: Path) -> None:
    actual_total = 0
    for entry in sorted(inspection.entries, key=lambda item: item.path.encode("utf-8")):
        destination = destination_root.joinpath(*entry.segments)
        if entry.kind == "directory":
            destination.mkdir(parents=True, exist_ok=True, mode=0o700)
            continue

        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(destination, flags, 0o600)
        actual_entry_size = 0
        stream = open_zip_member(archive, entry.info)
        try:
            with os.fdopen(descriptor, "wb") as output:
                descriptor = -1
                while True:
                    chunk = read_zip_chunk(stream)
                    if not chunk:
                        break
                    actual_entry_size += len(chunk)
                    actual_total += len(chunk)
                    if actual_entry_size > entry.info.file_size:
                        fail("INVALID_ARCHIVE", "ZIP entry expanded beyond its declared size")
                    if actual_total > MAX_EXPANDED_BYTES:
                        fail("EXPANDED_SIZE_EXCEEDED", f"Archive exceeds {MAX_EXPANDED_BYTES} expanded bytes")
                    output.write(chunk)
        finally:
            stream.close()
            if descriptor >= 0:
                os.close(descriptor)

        if actual_entry_size != entry.info.file_size:
            fail("INVALID_ARCHIVE", "ZIP entry size does not match its central-directory metadata")
        if actual_entry_size > 0 and (
            entry.info.compress_size == 0 or actual_entry_size > entry.info.compress_size * MAX_COMPRESSION_RATIO
        ):
            fail("COMPRESSION_RATIO_EXCEEDED", f"A ZIP entry exceeds the {MAX_COMPRESSION_RATIO}:1 compression ratio limit")

    if actual_total != inspection.uncompressed_bytes:
        fail("INVALID_ARCHIVE", "ZIP expanded size does not match its central-directory metadata")
    if actual_total > 0 and (
        inspection.compressed_bytes == 0
        or actual_total > inspection.compressed_bytes * MAX_COMPRESSION_RATIO
    ):
        fail("COMPRESSION_RATIO_EXCEEDED", f"Archive exceeds the {MAX_COMPRESSION_RATIO}:1 aggregate compression ratio limit")


def open_zip_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> BinaryIO:
    try:
        return archive.open(info, mode="r")
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, UnicodeError, ValueError, OSError):
        fail("INVALID_ARCHIVE", "ZIP member could not be read safely")


def read_zip_chunk(stream: BinaryIO) -> bytes:
    try:
        return stream.read(COPY_CHUNK_BYTES)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, UnicodeError, ValueError, OSError):
        fail("INVALID_ARCHIVE", "ZIP member failed integrity validation")


def build_normalized_archive(output_path: Path, extraction_root: Path, inspection: ArchiveInspection) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent)
    temporary_path = Path(temporary_name)
    file_entries: dict[str, ArchiveEntry] = {}
    directory_names: set[str] = set()

    for entry in inspection.entries:
        relative_name = relative_to_project_root(entry.path, inspection.root)
        if relative_name is None:
            continue
        if entry.kind == "directory":
            directory_names.add(relative_name)
        else:
            file_entries[relative_name] = entry
        parts = relative_name.split("/")
        for index in range(1, len(parts)):
            directory_names.add("/".join(parts[:index]))

    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "wb") as raw_output:
            descriptor = -1
            with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=raw_output, mtime=0) as gzip_output:
                with tarfile.open(fileobj=gzip_output, mode="w|", format=tarfile.PAX_FORMAT) as normalized:
                    member_names = sorted(directory_names | set(file_entries), key=lambda name: name.encode("utf-8"))
                    for member_name in member_names:
                        if member_name in directory_names:
                            normalized.addfile(normalized_tar_info(member_name, "directory", 0))
                            continue

                        entry = file_entries[member_name]
                        source_path = extraction_root.joinpath(*entry.segments)
                        source_stat = os.lstat(source_path)
                        if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_size != entry.info.file_size:
                            fail("INVALID_ARCHIVE", "Extracted source tree changed before normalization")
                        source_descriptor = os.open(
                            source_path,
                            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
                        )
                        with os.fdopen(source_descriptor, "rb") as source:
                            normalized.addfile(normalized_tar_info(member_name, "file", entry.info.file_size), source)
            raw_output.flush()
            os.fsync(raw_output.fileno())
        return temporary_path
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        remove_path(temporary_path)
        raise


def normalized_tar_info(name: str, kind: str, size: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name=name)
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.pax_headers = {}
    if kind == "directory":
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        info.size = 0
    else:
        info.type = tarfile.REGTYPE
        info.mode = 0o644
        info.size = size
    return info


def relative_to_project_root(path: str, root: str) -> str | None:
    if root == ".":
        return path
    if path == root or root.startswith(f"{path}/"):
        return None
    return path[len(root) + 1 :]


def stage_bytes(destination: Path, data: bytes) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "wb") as output:
            descriptor = -1
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        return temporary_path
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        remove_path(temporary_path)
        raise


def write_error_result(result_path: Path, error: SourceArchiveError) -> None:
    payload = json.dumps(
        {"error": {"code": error.code, "message": error.public_message}},
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("utf-8")
    temporary: Path | None = None
    try:
        temporary = stage_bytes(result_path, payload)
        os.replace(temporary, result_path)
        temporary = None
        sync_parent(result_path)
    except Exception:
        pass
    finally:
        if temporary is not None:
            remove_path(temporary)


def emit_error(error: SourceArchiveError) -> None:
    sys.stderr.write(
        json.dumps(
            {"error": {"code": error.code, "message": error.public_message}},
            ensure_ascii=True,
            separators=(",", ":"),
        )
        + "\n"
    )


def remove_path(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def sync_parent(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path.parent, flags)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        pass


def case_fold(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def dirname(path: str) -> str:
    separator = path.rfind("/")
    return "." if separator == -1 else path[:separator]


if __name__ == "__main__":
    raise SystemExit(main())
