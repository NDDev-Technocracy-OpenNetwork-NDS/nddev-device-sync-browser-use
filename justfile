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

# Real-browser acceptance in an isolated profile. Requires NDS_TEST_CHROME
# (Chrome for Testing); on AppArmor-restricted hosts also CHROME_DEVEL_SANDBOX.
browser-check:
    cargo build --locked
    NDS_TEST_HOST="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')/debug/nds-browser-use" bun run acceptance
