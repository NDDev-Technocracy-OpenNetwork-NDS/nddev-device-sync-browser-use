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

# Requires NDS_TEST_CHROME (Chrome for Testing); on AppArmor-restricted hosts
# also CHROME_DEVEL_SANDBOX.
# Real-browser acceptance in an isolated profile.
browser-check:
    bun install --frozen-lockfile --ignore-scripts
    cargo build --locked
    NDS_TEST_HOST="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')/debug/nds-browser-use" bun run e2e

# Loading `<prefix>/extension` as an unpacked extension in that browser
# remains the owner's action. `bun` defaults to the one on PATH.
# Install a release build into one stable prefix and register the native host.
install browser="chrome" prefix=(env_var("HOME") / ".local/share/nds-browser-use") bun="":
    cargo build --locked --release
    bun="{{bun}}"; \
    target="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"; \
    stage="{{prefix}}.stage"; rm -rf "$stage"; mkdir -p "$stage/bin" "$stage/extension" "$stage/executor"; \
    install -m 0755 "$target/release/nds-browser-use" "$stage/bin/"; \
    cp packages/extension/manifest.json packages/extension/background.js packages/extension/popup.html packages/extension/popup.js "$stage/extension/"; \
    cp packages/executor/executor.ts "$stage/executor/"; cp package.json bun.lock "$stage/"; \
    (cd "$stage" && bun install --frozen-lockfile --production --ignore-scripts); \
    rm -rf "{{prefix}}.previous"; if [ -e "{{prefix}}" ]; then mv "{{prefix}}" "{{prefix}}.previous"; fi; mv "$stage" "{{prefix}}"; rm -rf "{{prefix}}.previous"; \
    "{{prefix}}/bin/nds-browser-use" install --bun "${bun:-$(command -v bun)}" --executor "{{prefix}}/executor/executor.ts" --browser {{browser}}
