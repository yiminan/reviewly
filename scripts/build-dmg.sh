#!/usr/bin/env bash
# Build a local-use DMG for this Mac and copy it to the project root.
# Usage: bun run build:dmg (or run this script from any directory).
set -euo pipefail
cd "$(dirname "$0")/.."
project_dir="$PWD"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "DMG builds require macOS." >&2
  exit 1
fi

# rustup may be installed but not loaded in the current shell.
if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi
for tool in bun cargo rustc xcrun hdiutil; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing $tool. Install Bun, Rust stable and the Xcode command line tools." >&2
    exit 1
  fi
done
xcrun --find clang >/dev/null

build_target=$(rustc -vV | sed -n 's/^host: //p')
case "$build_target" in
  aarch64-apple-darwin) dmg_arch=aarch64 ;;
  x86_64-apple-darwin) dmg_arch=x64 ;;
  *) echo "Unsupported Mac target: $build_target" >&2; exit 1 ;;
esac

bun install --frozen-lockfile
version=$(bun -p 'require("./src-tauri/tauri.conf.json").version')
target_dir=$(cargo metadata --manifest-path src-tauri/Cargo.toml --locked --no-deps --format-version 1 \
  | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).target_directory)')

# Ad-hoc signing needs no Apple certificate; skip updater signing artifacts.
bun run tauri build --target "$build_target" --bundles dmg \
  --config '{"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-"}}}' \
  -- --locked

dmg="$target_dir/$build_target/release/bundle/dmg/Reviewly_${version}_${dmg_arch}.dmg"
if [[ ! -f "$dmg" ]]; then
  echo "Build completed, but the expected DMG was not found: $dmg" >&2
  exit 1
fi
hdiutil verify "$dmg"
destination="$project_dir/$(basename "$dmg")"
cp -f "$dmg" "$destination"
printf '\nDMG created: %s\n' "$destination"
