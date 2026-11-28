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
            director: () => p.artist,
            artworkUrl: () => {
              if (!p.artwork) throw Error("absent");
              return p.artwork;
            },
          };
        },
        playing: () => p.state === "playing",
        nameOfCurrentItem: () => p.title,
        pathOfCurrentItem: () => p.source,
        durationOfCurrentItem: () => p.duration,
        playbackShowsMenu: () => Boolean(p.menu),
        play() {
          commands.push([pid, "play_pause"]);
        },
        next() {
          commands.push([pid, "next"]);
        },
        previous() {
          commands.push([pid, "previous"]);
        },
        documents() {
          return (p.documents || []).map((d) => ({
            name: () => d.title,
            file: () => d.file,
            modified: () => Boolean(d.modified),
            duration: () => d.duration,
            dataSize: () => d.size,
            playing: () => d.playing,
            set rate(value) {
              assert.equal(value, 0);
              d.playing = false;
              commands.push([pid, "play_pause"]);
            },
            play() {
              d.playing = true;
              commands.push([pid, "play_pause"]);
            },
            stop() {
              throw Error("recording stop must never be invoked");
            },
            pause() {
              throw Error("recording pause must never be invoked");
            },
          }));
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

test("optional Spotify artwork remains bounded data and never changes control target", () => {
  const p = spotify();
  p.artwork = "https://i.scdn.co/image/" + "a".repeat(40);
  const f = fixture([p]);
  const selected = f.run("read").now;
  assert.equal(selected.artwork_url, p.artwork);
  assert.equal(f.run("control", JSON.stringify(selected), "play_pause").now, null);
  assert.deepEqual(f.commands, [[12, "play_pause"]]);
  p.artwork = "x".repeat(2000);
  assert.equal(f.run("read").now.artwork_url.length, 512);
});

const tv = () => ({ ...music(), app: "com.apple.TV", pid: 31 });
const vlc = () => ({
  ...spotify(),
  app: "org.videolan.vlc",
  pid: 32,
  source: "file:///Users/synthetic/Movie.mp4",
  duration: 120,
});
const quicktime = () => ({
  ...spotify(),
  app: "com.apple.QuickTimePlayerX",
  pid: 33,
  documents: [
    {
      title: "Movie",
      file: "file:///Users/synthetic/Movie.mov",
      modified: false,
      duration: 120,
      size: 2000,
      playing: true,
    },
  ],
});
test("public TV dictionary metadata and commands bind its own running PID", () => {
  const f = fixture([tv()]);
  const selected = f.run("read").now;
  assert.equal(selected.app, "com.apple.TV");
  assert.equal(selected.artist, "Artist");
  assert.equal(f.run("control", JSON.stringify(selected), "next").now, null);
  assert.deepEqual(f.commands, [[31, "next"]]);
});
test("VLC public player source is hashed and native next/previous are explicit", () => {
  const f = fixture([vlc()]);
  const selected = f.run("read").now;
  assert.equal(selected.app, "org.videolan.vlc");
  assert.match(selected.track, /^vlc:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(selected).includes("/Users/"));
  assert.equal(f.run("control", JSON.stringify(selected), "previous").now, null);
  assert.deepEqual(f.commands, [[32, "previous"]]);
});
test("VLC refuses capture sources, DVD menus, invalid duration and path-like titles", () => {
  for (const change of [
    { source: "screen://" },
    { source: "avcapture://" },
    { menu: true },
    { duration: NaN },
    { title: "/Users/synthetic/private.mp4" },
  ]) {
    const f = fixture([{ ...vlc(), ...change }]);
    const result = f.run("read");
    assert.ok(result.now == null);
    assert.deepEqual(f.commands, []);
  }
});
test("QuickTime controls only an unmodified file-backed movie and never a recording command", () => {
  const f = fixture([quicktime()]);
  const selected = f.run("read").now;
  assert.match(selected.track, /^quicktime:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(selected).includes("/Users/"));
  assert.equal(f.run("control", JSON.stringify(selected), "play_pause").now, null);
  assert.deepEqual(f.commands, [[33, "play_pause"]]);
  const paused = f.run("read", JSON.stringify(selected)).now;
  assert.equal(paused.playing, false);
  assert.equal(f.run("control", JSON.stringify(paused), "next").error, "unavailable");
  assert.equal(f.run("control", JSON.stringify(paused), "play_pause").now, null);
  assert.deepEqual(f.commands, [
    [33, "play_pause"],
    [33, "play_pause"],
  ]);
});
test("QuickTime live, modified, nonmovie and ambiguous documents cannot become controls", () => {
  for (const change of [
    { file: null },
    { modified: true },
    { duration: 0 },
    { size: 0 },
    { playing: false },
    { file: "screen://" },
    { file: "file:///dev/video.mov" },
    { file: "https://example.com/recording.mov" },
  ]) {
    const p = quicktime();
    Object.assign(p.documents[0], change);
    const f = fixture([p]);
    assert.ok(f.run("read").now == null);
    assert.deepEqual(f.commands, []);
  }
  const p = quicktime();
  p.documents.push({ ...p.documents[0], file: "file:///Users/synthetic/Other.mov" });
  assert.equal(fixture([p]).run("read").error, "ambiguous");
});
test("new native sources changing after selection reject stale commands", () => {
  const p = vlc();
  const f = fixture([p]);
  const selected = f.run("read").now;
  assert.equal(selected.app, "org.videolan.vlc");
  p.source = "file:///Users/synthetic/Different.mp4";
  assert.equal(f.run("control", JSON.stringify(selected), "play_pause").error, "changed");
  assert.deepEqual(f.commands, []);
});

test("native media source hashes match standard SHA256 including Unicode", () => {
  const { createHash } = require("node:crypto");
  const context = { ObjC: { import() {} } };
  vm.createContext(context);
  vm.runInContext(script, context);
  for (const value of ["", "abc", "/Users/synthetic/é😀 Movie.mov", "x".repeat(2000)])
    assert.equal(context.mediaHash(value), createHash("sha256").update(value).digest("hex"));
});

test("local media filenames with spaces remain private hashed identities", () => {
  const p = vlc();
  p.source = "/Users/synthetic/My Movies/é.mp4";
  const selected = fixture([p]).run("read").now;
  assert.match(selected.track, /^vlc:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(selected).includes("My Movies"));
});

test("QuickTime cached movie approval is scoped to exact PID launch and source", () => {
  const p = quicktime(),
    f = fixture([p]);
  const selected = f.run("read").now;
  p.documents[0].playing = false;
  for (const change of [
    { pid: 99 },
    { launch: "99" },
    { track: "quicktime:" + "0".repeat(64) },
    { app: "org.videolan.vlc" },
  ])
    assert.equal(f.run("read", JSON.stringify({ ...selected, ...change })).now, null);
  assert.equal(f.run("read", JSON.stringify(selected)).now.playing, false);
  assert.deepEqual(f.commands, []);
});
test("QuickTime denial and timeout remain truthful failures", () => {
  for (const code of [-1743, -1744, -1712]) {
    const p = quicktime(),
      f = fixture([p]);
    p.documents[0].title = {
      toString() {
        throw { errorNumber: code };
      },
    };
    const result = f.run("read");
    assert.equal(result.error, code === -1712 ? "timeout" : "denied");
    assert.deepEqual(f.commands, []);
  }
});
