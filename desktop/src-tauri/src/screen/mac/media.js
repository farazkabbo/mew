// Fixed JXA program. No source is constructed from player text, argv or clipboard data.
// Application(pid) is documented by Apple WWDC 2014 session 306, unlike bundle targeting
// it cannot launch an app that disappeared. AppKit discovery itself sends no AppleEvents.
ObjC.import("AppKit");
function run(argv) {
  function result(value) {
    return JSON.stringify(value);
  }
  function discover(id) {
    var list = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id);
    if (Number(list.count) > 1) throw new Error("ambiguous");
    if (Number(list.count) === 0) return null;
    var process = list.objectAtIndex(0);
    if (process.isTerminated) throw new Error("changed");
    var launched = Number(process.launchDate.timeIntervalSince1970);
    var pid = Number(process.processIdentifier);
    if (
      !isFinite(launched) ||
      launched <= 0 ||
      !isFinite(pid) ||
      pid <= 0 ||
      Math.floor(pid) !== pid
    )
      throw new Error("changed");
    return { app: id, pid: pid, launch: String(launched) };
  }
  function equal(a, b) {
    return a && b && a.app === b.app && a.pid === b.pid && a.launch === b.launch;
  }
  function read(identity) {
    var app = Application(identity.pid);
    var state = String(app.playerState());
    if (state === "stopped") return null;
    if (state !== "playing" && state !== "paused") throw new Error("unavailable");
    var track = app.currentTrack();
    var key = String(identity.app === "com.spotify.client" ? track.id() : track.persistentID());
    var title = String(track.name()).slice(0, 512);
    var artist = String(track.artist()).slice(0, 512);
    var artwork = null;
    if (identity.app === "com.spotify.client") {
      try {
        artwork = String(track.artworkUrl()).slice(0, 512);
      } catch (_) {}
    }
    if (!equal(identity, discover(identity.app))) throw new Error("changed");
    return {
      app: identity.app,
      pid: identity.pid,
      launch: identity.launch,
      track: key.slice(0, 512),
      title: title,
      artist: artist,
      playing: state === "playing",
      artwork_url: artwork,
    };
  }
  try {
    var all = [];
    var ids = ["com.spotify.client", "com.apple.Music"];
    for (var i = 0; i < ids.length; i++) {
      var identity = discover(ids[i]);
      if (identity) {
        var track = read(identity);
        if (track) all.push(track);
      }
    }
    var playing = all.filter(function (t) {
      return t.playing;
    });
    var selected = playing.length === 1 ? playing[0] : all.length === 1 ? all[0] : null;
    if (all.length > 1 && playing.length !== 1) return result({ error: "ambiguous" });
    if (argv[0] === "read") return result({ now: selected });
    if (argv[0] !== "control") return result({ error: "unavailable" });
    var expected = JSON.parse(argv[1]);
    if (
      !equal(selected, expected) ||
      selected.track !== expected.track ||
      selected.playing !== expected.playing
    )
      return result({ error: "changed" });
    if (!equal(selected, discover(selected.app))) return result({ error: "changed" });
    // Inspecting another player may have blocked on AppleEvents. Re-read the selected
    // PID's track and playback state after all cross-player discovery, immediately before
    // issuing the explicit control. Never act on the earlier Spotify snapshot.
    var fresh = read(selected);
    if (
      !equal(fresh, selected) ||
      !equal(fresh, expected) ||
      fresh.track !== selected.track ||
      fresh.track !== expected.track ||
      fresh.playing !== selected.playing ||
      fresh.playing !== expected.playing
    )
      return result({ error: "changed" });
    var target = Application(selected.pid);
    // No dynamic property lookup, eval, UI scripting, activation, URL open or launch.
    if (argv[2] === "play_pause") target.playpause();
    else if (argv[2] === "next") target.nextTrack();
    else if (argv[2] === "previous") target.previousTrack();
    else return result({ error: "unavailable" });
    return result({ now: null });
  } catch (error) {
    // Never return a native message: it may contain student track data.
    var code = Number(error.errorNumber || error.number || 0);
    if (code === -1743 || code === -1744) return result({ error: "denied" });
    if (code === -1712) return result({ error: "timeout" });
    return result({ error: error.message === "ambiguous" ? "ambiguous" : "unavailable" });
  }
}
