#!/bin/sh
# Synthetic local processes only. Never starts Neb, a browser, screen capture or a provider.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test_dir=$(mktemp -d /tmp/neb-browser-auth.XXXXXX)
trap 'rm -rf -- "$test_dir"' EXIT HUP INT TERM
rustc --edition 2021 "$here/browser_auth.rs" -o "$test_dir/mew-desktop"
cp "$test_dir/mew-desktop" "$test_dir/neb-browser-host"
cp "$test_dir/mew-desktop" "$test_dir/impostor"
codesign --force --sign - --identifier app.mew.desktop "$test_dir/mew-desktop"
codesign --force --sign - --identifier neb-browser-host "$test_dir/neb-browser-host"
codesign --force --sign - --identifier impostor "$test_dir/impostor"
"$test_dir/mew-desktop" server
"$test_dir/impostor" server
