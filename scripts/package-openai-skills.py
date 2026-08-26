#!/usr/bin/env python3
import argparse
import json
import re
import shutil
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


root = Path(__file__).resolve().parents[1]
plugin = root / "plugin"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the WebMCP Kit skills bundle")
    parser.add_argument(
        "--output",
        type=Path,
        help="write the ZIP here instead of dist/webmcp-kit-<version>.zip",
    )
    return parser.parse_args()


def runtime_references(source: str) -> set[str]:
    patterns = (
        r"\$\{plugin_root\}/([A-Za-z0-9._/-]+)",
        r'Join-Path\s+\$pluginRoot\s+"([^"]+)"',
        r"%plugin_root%\\([A-Za-z0-9._\\/-]+)",
    )
    return {
        match.group(1).replace("\\", "/")
        for pattern in patterns
        for match in re.finditer(pattern, source)
    }


def validate_archive(output: Path, bundle_name: str) -> None:
    with ZipFile(output) as archive:
        if bad_file := archive.testzip():
            raise SystemExit(f"Unreadable archive entry: {bad_file}")

        names = set(archive.namelist())
        prefix = f"{bundle_name}/"
        skill_entries = [
            name
            for name in names
            if re.fullmatch(rf"{prefix}skills/[^/]+/SKILL\.md", name)
        ]
        if not skill_entries:
            raise SystemExit("Package must contain at least one skills/<skill>/SKILL.md")

        references: set[str] = set()
        for name in names:
            if name.endswith((".md", ".sh", ".cmd")):
                references.update(runtime_references(archive.read(name).decode("utf-8")))
        missing = sorted(
            reference for reference in references if f"{prefix}{reference}" not in names
        )
        if missing:
            raise SystemExit(
                "Packaged instructions reference missing runtime files: "
                + ", ".join(missing)
            )


def main() -> None:
    args = parse_args()
    manifest = json.loads((plugin / ".codex-plugin/plugin.json").read_text())

    if any(field in manifest for field in ("mcpServers", "apps")):
        raise SystemExit("Skills-only packages cannot include MCP or app configuration")
    if "screenshots" in manifest.get("interface", {}):
        raise SystemExit("Skills-only packages cannot include screenshots")

    manifest.pop("hooks", None)
    output = args.output or root / "dist" / f"{manifest['name']}-{manifest['version']}.zip"
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as temporary:
        bundle = Path(temporary) / manifest["name"]
        for directory in ("skills", "assets", "cli", "scripts"):
            shutil.copytree(plugin / directory, bundle / directory)
        manifest_dir = bundle / ".codex-plugin"
        manifest_dir.mkdir()
        (manifest_dir / "plugin.json").write_text(json.dumps(manifest, indent=2) + "\n")

        with ZipFile(output, "w", ZIP_DEFLATED) as archive:
            for path in sorted(bundle.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(bundle.parent).as_posix())

    validate_archive(output, manifest["name"])
    print(output)


if __name__ == "__main__":
    main()
