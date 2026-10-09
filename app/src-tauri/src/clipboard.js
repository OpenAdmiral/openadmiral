// What the macOS pasteboard holds, for the terminal's paste (run with `osascript -l JavaScript`).
// Prints JSON: {"kind":"files","paths":[…]} | {"kind":"image"} | {"kind":"text"} | {"kind":"empty"}.
// Files win over everything (a Finder copy also carries the file's icon as an image),
// then an image with no text, then text.
ObjC.import("AppKit");
function run() {
  const pb = $.NSPasteboard.generalPasteboard;
  const fileOnly = $.NSDictionary.dictionaryWithObjectForKey(true, "NSPasteboardURLReadingFileURLsOnlyKey");
  const urls = pb.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), fileOnly);
  const paths = [];
  if (urls && !urls.isNil()) {
    for (let i = 0; i < urls.count; i++) paths.push(ObjC.unwrap(urls.objectAtIndex(i).path));
  }
  if (paths.length) return JSON.stringify({ kind: "files", paths });
  const types = ObjC.deepUnwrap(pb.types) || [];
  const hasText = types.includes("public.utf8-plain-text") || types.includes("NSStringPboardType");
  const hasImage = types.some((t) => t === "public.png" || t === "public.tiff" || t === "public.jpeg" || t === "com.apple.pict");
  if (hasImage && !hasText) return JSON.stringify({ kind: "image" });
  return JSON.stringify({ kind: hasText ? "text" : "empty" });
}
