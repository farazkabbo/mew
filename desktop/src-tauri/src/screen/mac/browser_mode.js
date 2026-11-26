// Fixed, read-only JXA; argv is data. No browser content, tabs, URLs or titles.
// Application(pid): Apple WWDC 2014 session 306, JavaScript for Automation.
// Chrome's shipped scripting.sdef exposes windows (front-to-back), id, mode.
// Its id is a browser session ID, NOT a proven CGWindowID. Always UNBOUND.
ObjC.import("AppKit");
function run(argv) {
  try {
    if ((argv.length !== 3 && argv.length !== 7) || argv[1] !== "com.google.Chrome")
      return "unknown";
    var pid = Number(argv[0]);
    if (!Number.isInteger(pid) || pid <= 0 || !/^[0-9]+(?:\.[0-9]+)?$/.test(argv[2]))
      return "unknown";
    function identity() {
      var process = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      if (!process || process.isTerminated || !front || !process.isEqual(front))
        throw new Error("changed");
      if (
        ObjC.unwrap(process.bundleIdentifier) !== argv[1] ||
        String(Number(process.launchDate.timeIntervalSince1970)) !== argv[2]
      )
        throw new Error("changed");
      return process;
    }
    var before = identity();
    var app = Application(pid);
    var window = app.windows[0];
    var id = String(window.id());
    if (!/^[1-9][0-9]{0,19}$/.test(id)) return "unknown";
    var mode = String(window.mode());
    if (mode !== "normal" && mode !== "incognito") return "unknown";
    if (String(app.windows[0].id()) !== id || !before.isEqual(identity())) return "unknown";
    if (argv.length === 7) {
      var expected = argv.slice(3).map(Number);
      if (!expected.every(Number.isFinite) || expected[2] <= 0 || expected[3] <= 0)
        return "unknown";
      function bounds(w) {
        var b = w.bounds();
        // JXA maps the public rectangle descriptor into named x/y/width/height fields.
        // An unexpected representation is unknown; never guess array coordinate meanings.
        if (!b || Array.isArray(b)) throw new Error("geometry");
        var r = [b.x, b.y, b.width, b.height];
        if (
          !r.every(function (v) {
            return typeof v === "number" && Number.isFinite(v);
          })
        )
          throw new Error("geometry");
        return r;
      }
      function equal(a, b) {
        return a.every(function (v, i) {
          return v === b[i];
        });
      }
      var all = typeof app.windows === "function" ? app.windows() : app.windows;
      if (!all || all.length < 1 || all.length > 512 || !equal(bounds(all[0]), expected))
        return "unknown";
      var matches = 0;
      for (var i = 0; i < all.length; i++) if (equal(bounds(all[i]), expected)) matches++;
      if (
        matches !== 1 ||
        String(app.windows[0].id()) !== id ||
        !equal(bounds(app.windows[0]), expected) ||
        String(app.windows[0].mode()) !== mode ||
        !before.isEqual(identity())
      )
        return "unknown";
      return mode === "normal" ? "bound-normal" : "bound-private";
    }
    return mode + "\t" + id;
  } catch (_) {
    // Native exceptions may contain private content. Return no exception text.
    return "unknown";
  }
}
