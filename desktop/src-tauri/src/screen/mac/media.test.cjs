// Pure VM tests: never executes osascript, opens a player or requests OS permissions.
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const script = readFileSync(require("node:path").join(__dirname, "media.js"), "utf8");
function fixture(players = [], onDiscover = () => {}) {
  const commands = [];
  const calls = [];
  const context = {
    ObjC: {
      import(name) {
        assert.equal(name, "AppKit");
      },
    },
    $: {
      NSRunningApplication: {
        runningApplicationsWithBundleIdentifier(id) {
          onDiscover(id);
          const matches = players.filter((p) => p.app === id);
          return {
            count: matches.length,
            objectAtIndex(i) {
              const p = matches[i];
              return {
                processIdentifier: p.pid,
                launchDate: { timeIntervalSince1970: p.launch },
                isTerminated: false,
              };
            },
          };
        },
      },
    },
    Application(pid) {
      assert.equal(typeof pid, "number");
      calls.push(pid);
      const p = players.find((p) => p.pid === pid);
      if (!p) throw Error("gone");
      return {
        playerState() {
          if (p.error) throw { errorNumber: p.error };
          return p.state;
        },
        currentTrack() {
          return {
            id: () => p.track,
            persistentID: () => p.track,
            name: () => p.title,
            artist: () => p.artist,
          };
        },
        playpause() {
          commands.push([pid, "play_pause"]);
        },
        nextTrack() {
          commands.push([pid, "next"]);
        },
        previousTrack() {
          commands.push([pid, "previous"]);
        },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  return {
    run(...args) {
      return JSON.parse(context.run(args));
    },
    commands,
    calls,
  };
}
const spotify = () => ({
  app: "com.spotify.client",
  pid: 12,
  launch: "100.5",
  track: "track-a",
  title: "Song",
  artist: "Artist",
  state: "playing",
});
const music = () => ({ ...spotify(), app: "com.apple.Music", pid: 13 });
test("no running player sends no AppleEvents and never launches", () => {
  const f = fixture();
  assert.equal(f.run("read").now, null);
  assert.deepEqual(f.calls, []);
});
test("metadata selects one playing native player and controls its PID", () => {
  const m = music();
  m.state = "paused";
  const f = fixture([spotify(), m]);
  const selected = f.run("read").now;
  assert.equal(selected.app, "com.spotify.client");
  assert.equal(f.run("control", JSON.stringify(selected), "next").now, null);
  assert.deepEqual(f.commands, [[12, "next"]]);
});
test("multiple playing or paused players fail closed", () => {
  for (const state of ["playing", "paused"]) {
    const s = spotify(),
      m = music();
    s.state = state;
    m.state = state;
    const f = fixture([s, m]);
    assert.equal(f.run("read").error, "ambiguous");
    assert.deepEqual(f.commands, []);
  }
});
test("duplicate bundle identity is refused without AppleEvents", () => {
  const f = fixture([spotify(), { ...spotify(), pid: 99 }]);
  assert.equal(f.run("read").error, "ambiguous");
  assert.deepEqual(f.calls, []);
});
test("permission denial and event timeout return truthful errors", () => {
  for (const [code, expected] of [
    [-1743, "denied"],
    [-1744, "denied"],
    [-1712, "timeout"],
  ]) {
    const f = fixture([{ ...spotify(), error: code }]);
    assert.equal(f.run("read").error, expected);
    assert.deepEqual(f.commands, []);
  }
});
test("changed PID, launch, track and playback reject stale control", () => {
  for (const key of ["pid", "launch", "track", "playing"]) {
    const f = fixture([spotify()]);
    const selected = f.run("read").now;
    selected[key] = key === "pid" ? 99 : key === "playing" ? false : "different";
    assert.equal(f.run("control", JSON.stringify(selected), "play_pause").error, "changed");
    assert.deepEqual(f.commands, []);
  }
});
test("arbitrary text is JSON data and cannot execute", () => {
  const s = spotify();
  s.track = '"; target.playpause(); //\n$(touch /tmp/never)';
  const f = fixture([s]);
  const selected = f.run("read").now;
  assert.equal(selected.track, s.track);
  assert.equal(f.run("control", JSON.stringify(selected), "evil();").error, "unavailable");
  assert.deepEqual(f.commands, []);
});
test("unknown or stopped playback never appears as playing", () => {
  const stopped = fixture([{ ...spotify(), state: "stopped" }]);
  assert.equal(stopped.run("read").now, null);
  const unknown = fixture([{ ...spotify(), state: "buffering" }]);
  assert.equal(unknown.run("read").error, "unavailable");
});

test("nonfinite, missing and nonpositive launch identity is refused", () => {
  for (const launch of [undefined, NaN, Infinity, 0, -1]) {
    const f = fixture([{ ...spotify(), launch }]);
    assert.equal(f.run("read").error, "unavailable");
    assert.deepEqual(f.calls, []);
  }
});

test("a selected player changing during the second player's discovery rejects control", () => {
  for (const change of [
    (s) => {
      s.track = "track-b";
    },
    (s) => {
      s.state = "paused";
    },
  ]) {
    const s = spotify();
    const m = music();
    m.state = "paused";
    let armed = false;
    const f = fixture([s, m], (id) => {
      if (armed && id === "com.apple.Music") {
        armed = false;
        change(s);
      }
    });
    const selected = f.run("read").now;
    armed = true;
    assert.equal(f.run("control", JSON.stringify(selected), "play_pause").error, "changed");
    assert.deepEqual(f.commands, []);
  }
});
