"""Build an installable plugin zip without Docker / the Decky CLI.

Usage (after `pnpm run build`):  python scripts/package_zip.py

Produces out/Game Theme Music.zip with the same layout as the CI release:
  Game Theme Music/{dist/index.js, main.py, plugin.json, package.json, LICENSE, README.md, bin/yt-dlp}
The yt-dlp binary is downloaded from package.json's remote_binary entry and
verified against its sha256 before it is added.
"""

import hashlib
import json
import pathlib
import sys
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
# Decky names the install folder AND the plugin's data/settings folders after this
# top-level folder, so it must stay "Game Theme Music" or downloads are "lost".
TOP = "Game Theme Music"
FILES = ["dist/index.js", "main.py", "plugin.json", "package.json", "LICENSE", "README.md"]


def fetch_binary(entry: dict) -> bytes:
    cache = OUT / "bin-cache" / f"{entry['sha256hash']}-{entry['name']}"
    if cache.exists():
        data = cache.read_bytes()
    else:
        print(f"Downloading {entry['url']}")
        with urllib.request.urlopen(entry["url"]) as res:
            data = res.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != entry["sha256hash"]:
        sys.exit(f"sha256 mismatch for {entry['name']}: got {digest}, expected {entry['sha256hash']}")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(data)
    return data


def add(zf: zipfile.ZipFile, arcname: str, data: bytes, executable: bool = False):
    info = zipfile.ZipInfo(f"{TOP}/{arcname}", date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3  # Unix, so the permission bits below are honoured
    info.external_attr = (0o100755 if executable else 0o100644) << 16
    zf.writestr(info, data)


def main():
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    plugin = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    for f in FILES:
        if not (ROOT / f).exists():
            sys.exit(f"Missing {f}. Run the frontend build first.")
    OUT.mkdir(exist_ok=True)
    target = OUT / f"{plugin['name']}.zip"
    with zipfile.ZipFile(target, "w") as zf:
        for f in FILES:
            add(zf, f, (ROOT / f).read_bytes())
        for entry in package.get("remote_binary", []):
            add(zf, f"bin/{entry['name']}", fetch_binary(entry), executable=True)
    print(f"Wrote {target} ({target.stat().st_size // 1024} KiB), version {package['version']}")


if __name__ == "__main__":
    main()
