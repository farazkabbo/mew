// VM-only: no browser, AppleEvents, Automation permissions or osascript execution.
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const script = readFileSync(require("node:path").join(__dirname, "browser_mode.js"), "utf8");
function fixture(options = {}) {
  const calls = [];
  let reads = 0;
  const process = {
    bundleIdentifier: options.bundle || "com.google.Chrome",
    launchDate: { timeIntervalSince1970: options.launch || 100.5 },
    isTerminated: !!options.terminated,
    isEqual: (other) => other === process,
  };
  const workspace = { frontmostApplication: process };
  const context = {
    ObjC: { import: (name) => assert.equal(name, "AppKit"), unwrap: (x) => x },
    $: {
      NSRunningApplication: {
        runningApplicationWithProcessIdentifier(pid) {
          assert.equal(pid, 123);
          return options.gone ? null : process;
        },
      },
      NSWorkspace: { sharedWorkspace: workspace },
    },
    Application(pid) {
      calls.push(pid);
      assert.equal(typeof pid, "number");
      return {
        windows: [
          {
            id() {
              reads++;
              return options.switchWindow && reads > 1 ? "43" : "42";
            },
            bounds() {
              return options.bounds || { x: -1440, y: -200, width: 1200, height: 800 };
            },
            mode() {
              if (options.error) throw options.error;
              if (options.switchFocus) workspace.frontmostApplication = {};
              if (options.restart) process.launchDate.timeIntervalSince1970 = 101;
              return options.mode || "normal";
            },
          },
        ],
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return { run: (args = ["123", "com.google.Chrome", "100.5"]) => context.run(args), calls };
}
test("positive normal and private modes return only mode and script ID", () => {
  for (const mode of ["normal", "incognito"]) {
    const f = fixture({ mode });
    assert.equal(f.run(), mode + "\t42");
    assert.deepEqual(f.calls, [123]);
  }
});
test("unsupported browser and arbitrary argument data never reach Application", () => {
  for (const args of [
    ["123", "com.apple.Safari", "100.5"],
    ["123", "com.microsoft.edgemac", "100.5"],
    ["123; activate()", "com.google.Chrome", "100.5"],
    ["123", "com.google.Chrome", '100.5; Application("Safari").activate()'],
    ["123", "com.google.Chrome", "100.5", "extra"],
  ]) {
    const f = fixture();
    assert.equal(f.run(args), "unknown");
    assert.deepEqual(f.calls, []);
  }
});
test("gone, terminated, bundle mismatch and restarted identity do not query", () => {
  for (const options of [
    { gone: true },
    { terminated: true },
    { bundle: "other" },
    { launch: 102 },
  ]) {
    const f = fixture(options);
    assert.equal(f.run(), "unknown");
    assert.deepEqual(f.calls, []);
  }
});
test("focus, front window, or launch changes during reads are unknown", () => {
  for (const options of [{ switchFocus: true }, { switchWindow: true }, { restart: true }])
    assert.equal(fixture(options).run(), "unknown");
});
test("unsupported mode, permission errors and native text never escape", () => {
  for (const options of [
    { mode: "private" },
    { mode: "UNKNOWN" },
    { error: { errorNumber: -1743, message: "synthetic secret" } },
    { error: { errorNumber: -1712, message: "synthetic secret" } },
  ])
    assert.equal(fixture(options).run(), "unknown");
});

test("bound mode requires exact geometry in separate native/script ID namespaces", () => {
  const argv = ["123", "com.google.Chrome", "100.5", "-1440", "-200", "1200", "800"];
  assert.equal(fixture().run(argv), "bound-normal");
  assert.equal(fixture({ mode: "incognito" }).run(argv), "bound-private");
  assert.equal(
    fixture({ bounds: { x: -1439, y: -200, width: 1200, height: 800 } }).run(argv),
    "unknown",
  );
  assert.equal(fixture({ bounds: [-1440, -200, -240, 600] }).run(argv), "unknown");
  assert.equal(fixture({ switchWindow: true }).run(argv), "unknown");
  assert.equal(fixture({ switchFocus: true }).run(argv), "unknown");
  assert.equal(fixture({ restart: true }).run(argv), "unknown");
});
