// Fixed JXA program. No source is constructed from player text, argv or clipboard data.
// Application(pid) is documented by Apple WWDC 2014 session 306, unlike bundle targeting
// it cannot launch an app that disappeared. AppKit discovery itself sends no AppleEvents.
ObjC.import("AppKit");
// SHA-256 identities keep native file/stream paths out of replies and control argv.
// Fixed pure code, not page/browser JavaScript, crypto or a runtime dependency.
function mediaHash(value) {
  var utf8 = unescape(encodeURIComponent(value)),
    words = [],
    i,
    j;
  for (i = 0; i < utf8.length; i++)
    words[i >> 2] = (words[i >> 2] || 0) | (utf8.charCodeAt(i) << (24 - (i % 4) * 8));
  words[utf8.length >> 2] = (words[utf8.length >> 2] || 0) | (0x80 << (24 - (utf8.length % 4) * 8));
  words[(((utf8.length + 8) >> 6) + 1) * 16 - 1] = utf8.length * 8;
  var h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  var k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  function r(v, n) {
    return (v >>> n) | (v << (32 - n));
  }
  for (i = 0; i < words.length; i += 16) {
    var w = [],
      a = h[0],
      b = h[1],
      c = h[2],
      d = h[3],
      e = h[4],
      f = h[5],
      g = h[6],
      hh = h[7];
    for (j = 0; j < 64; j++) {
      if (j < 16) w[j] = words[i + j] | 0;
      else {
        var x = w[j - 15],
          y = w[j - 2];
        w[j] =
          ((r(x, 7) ^ r(x, 18) ^ (x >>> 3)) +
            w[j - 16] +
            (r(y, 17) ^ r(y, 19) ^ (y >>> 10)) +
            w[j - 7]) |
          0;
      }
      var t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + k[j] + w[j]) | 0;
      var t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    var v = [a, b, c, d, e, f, g, hh];
    for (j = 0; j < 8; j++) h[j] = (h[j] + v[j]) | 0;
  }
  return h
    .map(function (v) {
      return ("00000000" + (v >>> 0).toString(16)).slice(-8);
    })
    .join("");
}
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
  function mediaSource(raw) {
    if (typeof raw !== "string" || raw.length > 2000 || /[\x00-\x1f\x7f]/.test(raw)) return null;
    var source = raw;
    if (source.indexOf("file:///") === 0) {
      try {
        source = decodeURIComponent(source.slice(7));
      } catch (_) {
        return null;
      }
    }
    var local = /^\/(Users|Volumes)\//.test(source);
    var remote = /^https:\/\/[A-Za-z0-9.-]+\//.test(source) && !/\s/.test(source);
    if ((!local && !remote) || /(?:^|\/)\.\.(?:\/|$)|[\x00-\x1f\x7f]/.test(source)) return null;
    return /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|m4v|mov|mkv|webm|avi|mpeg|mpg|aiff|aif|caf|wma|wmv)(?:\?[^#]*)?$/i.test(
      source,
    )
      ? source
      : null;
  }
  function privateTitle(value) {
    var name = String(value).slice(0, 512);
    return !name || /file:|https?:\/\/|\/Users\/|\/Volumes\/|[\x00-\x1f\x7f]/.test(name)
      ? null
      : name;
  }
  function base(identity, key, title, artist, playing) {
    if (!equal(identity, discover(identity.app))) throw new Error("changed");
    return {
      app: identity.app,
      pid: identity.pid,
      launch: identity.launch,
      track: key,
      title: title,
      artist: artist,
      playing: playing,
      artwork_url: null,
    };
  }
  function choose(all) {
    var playing = all.filter(function (t) {
      return t.playing;
    });
    if (all.length > 1 && playing.length !== 1) throw new Error("ambiguous");
    return playing.length === 1 ? playing[0] : all.length === 1 ? all[0] : null;
  }
  function readVlc(identity, app) {
    var playing = app.playing(),
      duration = Number(app.durationOfCurrentItem());
    var source = mediaSource(app.pathOfCurrentItem()),
      title = privateTitle(app.nameOfCurrentItem());
    if (
      typeof playing !== "boolean" ||
      !isFinite(duration) ||
      duration <= 0 ||
      !source ||
      !title ||
      app.playbackShowsMenu() !== false
    )
      return null;
    return base(
      identity,
      "vlc:" + mediaHash(JSON.stringify([source, title, duration])),
      title,
      "",
      playing,
    );
  }
  function readQuickTime(identity, app) {
    var documents = app.documents();
    if (documents.length > 32) throw new Error("ambiguous");
    var tracks = [];
    for (var i = 0; i < documents.length; i++) {
      var document = documents[i];
      try {
        var source = mediaSource(String(document.file())),
          title = privateTitle(document.name());
        var duration = Number(document.duration()),
          size = Number(document.dataSize()),
          playing = document.playing();
        // Never control live/unsaved/modified recording documents. Only an ordinary file
        // movie with positive fixed media properties participates; no recording commands.
        if (
          !source ||
          source.charAt(0) !== "/" ||
          !title ||
          document.modified() !== false ||
          !isFinite(duration) ||
          duration <= 0 ||
          !isFinite(size) ||
          size <= 0 ||
          typeof playing !== "boolean"
        )
          continue;
        var value = base(
          identity,
          "quicktime:" + mediaHash(JSON.stringify([source, title, duration, size])),
          title,
          "",
          playing,
        );
        // A public `playing` movie is positive playback evidence. An unseen paused
        // document might be a recorder; only the already selected exact movie may resume.
        if (
          !playing &&
          (!approvedMovie || !equal(value, approvedMovie) || value.track !== approvedMovie.track)
        )
          continue;
        Object.defineProperty(value, "document", { value: document, enumerable: false });
        tracks.push(value);
      } catch (error) {
        if (
          error.message === "changed" ||
          error.message === "ambiguous" ||
          [-1743, -1744, -1712].indexOf(Number(error.errorNumber || error.number || 0)) !== -1
        )
          throw error;
      }
    }
    return choose(tracks);
  }
  function read(identity) {
    var app = Application(identity.pid);
    if (identity.app === "org.videolan.vlc") return readVlc(identity, app);
    if (identity.app === "com.apple.QuickTimePlayerX") return readQuickTime(identity, app);
    var state = String(app.playerState());
    if (state === "stopped") return null;
    if (state !== "playing" && state !== "paused") throw new Error("unavailable");
    var track = app.currentTrack();
    var key = String(identity.app === "com.spotify.client" ? track.id() : track.persistentID());
    var title = String(track.name()).slice(0, 512);
    var artist = String(identity.app === "com.apple.TV" ? track.director() : track.artist()).slice(
      0,
      512,
    );
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
  var approvedMovie = null;
  try {
    if ((argv[0] === "control" || argv[0] === "read") && argv[1]) {
      var approval = JSON.parse(argv[1]);
      if (approval && approval.app === "com.apple.QuickTimePlayerX") approvedMovie = approval;
    }
    var all = [];
    var ids = [
      "com.spotify.client",
      "com.apple.Music",
      "com.apple.TV",
      "org.videolan.vlc",
      "com.apple.QuickTimePlayerX",
    ];
    for (var i = 0; i < ids.length; i++) {
      var identity = discover(ids[i]);
      if (identity) {
        var track = read(identity);
        if (track) all.push(track);
      }
    }
    var selected = choose(all);
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
    if (selected.app === "com.apple.QuickTimePlayerX") {
      if (argv[2] !== "play_pause") return result({ error: "unavailable" });
      // `stop` and `pause` also stop recordings in QuickTime and are intentionally absent.
      // Public movie `rate` and `play` are the only mutated document operations.
      if (fresh.playing) fresh.document.rate = 0;
      else fresh.document.play();
      return result({ now: null });
    }
    if (selected.app === "org.videolan.vlc") {
      if (argv[2] === "play_pause") target.play();
      else if (argv[2] === "next") target.next();
      else if (argv[2] === "previous") target.previous();
      else return result({ error: "unavailable" });
      return result({ now: null });
    }
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
