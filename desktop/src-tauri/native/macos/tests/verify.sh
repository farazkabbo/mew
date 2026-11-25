#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out=$(mktemp -d "${TMPDIR:-/tmp}/neb-capture-tests.XXXXXX")
trap 'rm -rf "$out"' EXIT HUP INT TERM
arch=$(uname -m)
target="$arch-apple-macosx14.0"
xcrun swiftc -parse-as-library -O -DNEB_NATIVE_TESTS -target "$target" \
  -module-cache-path "$out/modules" -emit-object "$base/ScreenCapture.swift" -o "$out/capture.o"
xcrun clang -target "$target" -Wall -Wextra -Werror -c "$base/tests/ffi.c" -o "$out/ffi.o"
# swiftc supplies its SDK/runtime/autolink search paths while linking these C + Swift objects.
xcrun swiftc -target "$target" "$out/capture.o" "$out/ffi.o" -framework CoreText -o "$out/ffi"
"$out/ffi"
# Cross-compile the production bridge too; no test hooks/capture execution.
xcrun swiftc -parse-as-library -O -target x86_64-apple-macosx14.0 \
  -module-cache-path "$out/modules-intel" -emit-object "$base/ScreenCapture.swift" -o "$out/intel.o"
