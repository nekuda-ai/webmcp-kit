#!/usr/bin/env python3
import json
import shutil
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


root = Path(__file__).resolve().parents[1]
plugin = root / "plugin"
manifest = json.loads((plugin / ".codex-plugin/plugin.json").read_text())

if any(field in manifest for field in ("mcpServers", "apps")):
    raise SystemExit("Skills-only packages cannot include MCP or app configuration")
if "screenshots" in manifest.get("interface", {}):
    raise SystemExit("Skills-only packages cannot include screenshots")

manifest.pop("hooks", None)
output = root / "dist" / f"{manifest['name']}-{manifest['version']}.zip"

with tempfile.TemporaryDirectory() as temporary:
    bundle = Path(temporary) / manifest["name"]
    shutil.copytree(plugin / "skills", bundle / "skills")
    shutil.copytree(plugin / "assets", bundle / "assets")
    manifest_dir = bundle / ".codex-plugin"
    manifest_dir.mkdir()
    (manifest_dir / "plugin.json").write_text(json.dumps(manifest, indent=2) + "\n")

    if not list((bundle / "skills").glob("*/SKILL.md")):
        raise SystemExit("Package must contain at least one skills/<skill>/SKILL.md")

    output.parent.mkdir(exist_ok=True)
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for path in sorted(bundle.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(bundle.parent).as_posix())

with ZipFile(output) as archive:
    if bad_file := archive.testzip():
        raise SystemExit(f"Unreadable archive entry: {bad_file}")

print(output)
