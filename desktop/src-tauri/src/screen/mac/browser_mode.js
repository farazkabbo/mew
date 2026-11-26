// Fixed, read-only JXA; argv is data. No browser content, tabs, URLs or titles.
// Application(pid): Apple WWDC 2014 session 306, JavaScript for Automation.
// Chrome's shipped scripting.sdef exposes windows (front-to-back), id, mode.
// Its id is a browser session ID, NOT a proven CGWindowID. Always UNBOUND.
ObjC.import("AppKit");
function run(argv) {
  try {
    if (argv.length !== 3 || argv[1] !== "com.google.Chrome") return "unknown";
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
    return mode + "\t" + id;
  } catch (_) {
    // Native exceptions may contain private content. Return no exception text.
    return "unknown";
  }
}
