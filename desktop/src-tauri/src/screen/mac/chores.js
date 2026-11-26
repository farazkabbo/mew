/* Fixed native-only DO IT adapter. No shell, eval, dynamic scripts or model-selected URLs. */
ObjC.import("Foundation");
ObjC.import("AppKit");
ObjC.import("ImageIO");
function run(argv) {
  const op = argv[0];
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  if (op === "choose") {
    const items = JSON.parse(argv[2]);
    if (
      !Array.isArray(items) ||
      items.length > 10 ||
      items.some((x) => typeof x !== "string" || x.length > 2048)
    )
      throw Error("invalid choices");
    const choice = app.chooseFromList(items, {
      withTitle: argv[1],
      withPrompt: "Choose the file you meant.",
      multipleSelectionsAllowed: false,
      emptySelectionAllowed: false,
    });
    return JSON.stringify({ index: choice === false ? null : items.indexOf(choice[0]) });
  }
  if (op === "confirm") {
    const result = app.displayDialog(argv[1], {
      withTitle: "Neb · Rename photos",
      buttons: ["Cancel", "Rename"],
      defaultButton: "Rename",
      cancelButton: "Cancel",
    });
    return JSON.stringify({ confirmed: result.buttonReturned === "Rename" });
  }
  if (op === "dialog") {
    const result = app.displayDialog(argv[2], {
      withTitle: argv[1],
      buttons: ["Cancel", argv[3]],
      defaultButton: argv[3],
      cancelButton: "Cancel",
    });
    return JSON.stringify({ confirmed: result.buttonReturned === argv[3] });
  }
  if (op === "copy") {
    const board = $.NSPasteboard.generalPasteboard;
    board.clearContents;
    return JSON.stringify({
      ok: Boolean(board.setStringForType(argv[1], $.NSPasteboardTypeString)),
    });
  }
  if (op === "open_url") {
    if (!argv[1].startsWith("https://")) throw Error("invalid URL");
    return JSON.stringify({
      ok: Boolean($.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(argv[1]))),
    });
  }
  if (op === "photos") {
    const finder = Application("com.apple.finder");
    if (!finder.running() || !finder.frontmost()) throw Error("Finder must be in front");
    const selection = finder.selection();
    if (selection.length > 500) throw Error("Select at most 500 photos");
    const photos = [];
    for (const item of selection) {
      const url = $.NSURL.URLWithString(item.url());
      const path = ObjC.unwrap(url.path);
      if (!/\.(jpe?g|png|heic|tiff?|webp|gif|bmp)$/i.test(path)) continue;
      let taken = null;
      try {
        const image = $.CGImageSourceCreateWithURL(url, null);
        if (image) {
          const raw = $.CGImageSourceCopyPropertiesAtIndex(image, 0, null);
          const properties = raw ? ObjC.deepUnwrap(raw) : {};
          const exif = properties["{Exif}"] || {};
          const tiff = properties["{TIFF}"] || {};
          const date = exif.DateTimeOriginal || exif.DateTimeDigitized || tiff.DateTime;
          if (typeof date === "string" && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/.test(date))
            taken = date.slice(0, 10).replace(/:/g, "-") + "T" + date.slice(11, 19);
        }
      } catch (_) {
        /* Modification time is the documented fallback. */
      }
      photos.push({ path, taken });
    }
    return JSON.stringify({ photos });
  }
  if (op === "open") {
    const url = $.NSURL.fileURLWithPath(argv[1]);
    const ok =
      argv[2] === "reveal"
        ? ($.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs([url]), true)
        : Boolean($.NSWorkspace.sharedWorkspace.openURL(url));
    return JSON.stringify({ ok });
  }
  if (op === "settings") {
    if (!argv[1].startsWith("x-apple.systempreferences:")) throw Error("invalid settings URI");
    return JSON.stringify({
      ok: Boolean($.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(argv[1]))),
    });
  }
  throw Error("unknown native chore");
}
