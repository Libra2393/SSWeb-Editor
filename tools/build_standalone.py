#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Part of SSWeb Editor. See LICENSE and CREDITS.md.
"""
Builds dist/SSWeb-Editor.html: the whole editor in one file that works offline.

Double-clicking the result opens it in a browser straight from disk. Browsers won't load separate JavaScript
modules or fetch JSON from file:// pages, so this inlines the stylesheet, the JS modules (each wrapped in its own
scope, standing in for a module) and every definition file under defs/. The GPL text and the credits are embedded
too, so each copy carries its license.

    python3 tools/build_standalone.py            # writes dist/SSWeb-Editor.html
    python3 tools/build_standalone.py --out X    # somewhere else

Only the standard library is used.
"""

import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO_URL = "https://github.com/Libra2393/SSWeb-Editor"

# Dependency order: a module only imports from modules listed before it.
MODULES = ["codec", "wiisd", "defs", "app"]

IMPORT_RE = re.compile(r'^import\s*\{([^}]*)\}\s*from\s*"\./(\w+)\.js";\s*$', re.M)
EXPORT_RE = re.compile(r"^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)", re.M)


def bundle_module(name: str, source: str) -> str:
    """Turns one ES module into a scoped block that registers its exports in __ssweb."""
    exports = EXPORT_RE.findall(source)

    def imp(m):
        names = ", ".join(n.strip() for n in m.group(1).split(",") if n.strip())
        if m.group(2) not in MODULES[: MODULES.index(name)]:
            sys.exit(f"{name}.js imports {m.group(2)}.js, which isn't built before it; fix MODULES order")
        return f"const {{ {names} }} = __ssweb.{m.group(2)};"

    body = IMPORT_RE.sub(imp, source)
    body = re.sub(r"^export\s+", "", body, flags=re.M)
    if re.search(r"^\s*(import|export)\b", body, re.M):
        sys.exit(f"{name}.js has an import/export form this script doesn't handle")
    return (f"// ---- js/{name}.js\n__ssweb.{name} = (() => {{\n\"use strict\";\n{body}\n"
            f"return {{ {', '.join(exports)} }};\n}})();\n")


def script_safe(text: str) -> str:
    """Keeps embedded text from closing its <script> element early."""
    return re.sub(r"</(script)", r"<\\/\1", text, flags=re.I)


def collect_defs() -> dict:
    defs = {}
    for path in sorted((ROOT / "defs").rglob("*.json")):
        rel = path.relative_to(ROOT / "defs").as_posix()
        defs[rel] = json.loads(path.read_text(encoding="utf-8"))
    return defs


def version() -> str:
    try:
        rev = subprocess.run(["git", "-C", str(ROOT), "describe", "--always", "--dirty"],
                             capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        rev = "unknown"
    return f"{rev}, built {datetime.date.today().isoformat()}"


def build(out: Path) -> None:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "style.css").read_text(encoding="utf-8")
    js = "".join(bundle_module(m, (ROOT / "js" / f"{m}.js").read_text(encoding="utf-8")) for m in MODULES)
    defs = collect_defs()
    ver = version()

    # Links to CREDITS.md, README.md and LICENSE already point at the repository (see index.html), so they
    # work from a single file too.
    for name in ("CREDITS.md", "README.md", "LICENSE"):
        if f'href="{name}' in html:
            sys.exit(f"index.html links to {name} relatively; point it at {REPO_URL}/blob/main/{name}")

    # The standalone page has its definitions built in.
    html = html.replace("Field definitions are loaded from <code>defs/</code>. Edit those JSON files to add fields.",
                        f"Standalone build ({ver}): the field definitions are built in. Use ⋯ → Add definition file to try new ones.")

    # The icon has to travel inside the file too: inline it as a data URI and drop the PNG touch icon.
    import base64
    icon = "data:image/svg+xml;base64," + base64.b64encode((ROOT / "assets" / "icon.svg").read_bytes()).decode()
    for needle in ('href="assets/icon.svg"', 'src="assets/icon.svg"'):
        if needle not in html:
            sys.exit(f"index.html no longer contains {needle}; update this script")
        html = html.replace(needle, needle.split("=")[0] + f'="{icon}"')
    html = re.sub(r'\s*<link rel="apple-touch-icon"[^>]*>', "", html)

    # In the offline file, say so instead of offering the download.
    note = re.search(r'<p id="offlineNote"[^>]*>.*?</p>', html, re.S)
    if not note:
        sys.exit('index.html no longer has <p id="offlineNote">; update this script')
    html = html.replace(note.group(0), '<p id="offlineNote" class="offline-note"><b>This is the offline version.</b> '
                        'It runs from this file with no internet. Newer versions: '
                        f'<a href="{REPO_URL}/releases">{REPO_URL.split("//")[1]}/releases</a></p>')

    head_note = (f"<!-- SSWeb Editor, standalone build ({ver}). Source: {REPO_URL}\n"
                 "     Licensed under the GNU GPL v3.0 or later; the full license text and the credits are embedded\n"
                 "     at the end of this file. This file is the complete, unminified source of the editor. -->\n")
    html = html.replace("<!doctype html>\n", "<!doctype html>\n" + head_note, 1)

    link = '<link rel="stylesheet" href="style.css">'
    script = '<script type="module" src="js/app.js"></script>'
    for needle in (link, script):
        if needle not in html:
            sys.exit(f"index.html no longer contains {needle!r}; update this script")
    html = html.replace(link, f"<style>\n{css}</style>")
    defs_js = "globalThis.SSWEB_EMBEDDED_DEFS = " + json.dumps(defs, ensure_ascii=False, separators=(",", ":")) + ";"
    html = html.replace(script, (
        f"<script>\n{script_safe(defs_js)}\n</script>\n"
        f"<script>\nconst __ssweb = {{}};\n{script_safe(js)}</script>\n"
        f'<script type="text/plain" id="ssweb-license">\n{script_safe((ROOT / "LICENSE").read_text(encoding="utf-8"))}</script>\n'
        f'<script type="text/plain" id="ssweb-credits">\n{script_safe((ROOT / "CREDITS.md").read_text(encoding="utf-8"))}</script>'))

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB, {len(defs)} definition files, {ver})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[1].strip())
    ap.add_argument("--out", type=Path, default=ROOT / "dist" / "SSWeb-Editor.html")
    build(ap.parse_args().out)
