set shell := ["bash", "-euo", "pipefail", "-c"]

# Structural, Rust and TypeScript checks; no browser is started.
check: ts-check
    cargo fmt -- --check
    cargo clippy --locked --all-targets -- -D warnings
    cargo test --locked

ts-check:
    bun install --frozen-lockfile --ignore-scripts
    bun run check
    bun run check:generated
    bun run test

# Requires NDS_TEST_CHROME (Chrome for Testing); on AppArmor-restricted hosts
# also CHROME_DEVEL_SANDBOX.
# Real-browser acceptance in an isolated profile.
browser-check:
    bun install --frozen-lockfile --ignore-scripts
    cargo build --locked
    NDS_TEST_HOST="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')/debug/nds-browser-use" bun run e2e

# Loading `<prefix>/extension` as an unpacked extension in that browser
# remains the owner's action; later installs reload it through the host.
# `bun` defaults to the one on PATH.
# Install a release build into one stable prefix and register the native host.
install browser="chrome" prefix=(env_var("HOME") / ".local/share/nds-browser-use") bun="":
    # The installed build reports its source commit; a modified tree reports none.
    commit="$(git rev-parse HEAD)"; git diff --quiet HEAD -- || commit=unknown; \
    NDS_SOURCE_COMMIT="$commit" cargo build --locked --release
    bun="{{bun}}"; \
    target="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"; \
    stage="{{prefix}}.stage"; rm -rf "$stage"; mkdir -p "$stage/bin" "$stage/extension" "$stage/executor"; \
    install -m 0755 "$target/release/nds-browser-use" "$stage/bin/"; \
    cp -r packages/extension/manifest.json packages/extension/background.js packages/extension/popup.html packages/extension/popup.js packages/extension/icons "$stage/extension/"; \
    cp -r packages/executor/executor.ts packages/executor/agent "$stage/executor/"; cp package.json bun.lock "$stage/"; \
    (cd "$stage" && bun install --frozen-lockfile --production --ignore-scripts); \
    rm -rf "{{prefix}}.previous"; if [ -e "{{prefix}}" ]; then mv "{{prefix}}" "{{prefix}}.previous"; fi; mv "$stage" "{{prefix}}"; rm -rf "{{prefix}}.previous"; \
    "{{prefix}}/bin/nds-browser-use" install --bun "${bun:-$(command -v bun)}" --executor "{{prefix}}/executor/executor.ts" --browser {{browser}}; \
    "{{prefix}}/bin/nds-browser-use" update || echo "extension not connected; it loads the new files when Chrome starts it"

# The store assigns its own extension ID, so the pinned `key` is omitted.
# Package the extension for the Chrome Web Store into dist/.
package:
    bun install --frozen-lockfile --ignore-scripts
    bun run check:generated
    python3 -c 'import json, pathlib, zipfile; root = pathlib.Path("packages/extension"); version = json.loads((root / "manifest.json").read_text())["version"]; out = pathlib.Path("dist") / f"nds-browser-use-extension-{version}.zip"; out.parent.mkdir(exist_ok=True); manifest = json.loads((root / "manifest.json").read_text()); manifest.pop("key"); files = sorted(["background.js", "popup.html", "popup.js", *(str(p.relative_to(root)) for p in (root / "icons").glob("*.png"))]); archive = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED); entry = lambda name, data: archive.writestr(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)), data); entry("manifest.json", json.dumps(manifest, indent=2) + "\n"); [entry(name, (root / name).read_bytes()) for name in files]; archive.close(); print(out)'
