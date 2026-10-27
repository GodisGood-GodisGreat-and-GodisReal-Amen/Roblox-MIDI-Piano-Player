// A stand-in for Roblox in tools/realtime_test.sh: a background app that only
// records the key events it receives, with the time each one arrived.
//
//   osascript -l JavaScript tools/key_receiver.js OUT.log [max-seconds]
//
// It writes its process id to OUT.log.pid at once, and stops when OUT.log.done
// appears (or after max-seconds), then writes one JSON line per key event to
// OUT.log.
ObjC.import('Cocoa');

function run(argv) {
  var out = String(argv[0]);
  var maxSeconds = Number(argv[1] || 30);
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);   // no Dock icon, never in front
  app.finishLaunching;
  writeText(out + ".pid", String($.NSProcessInfo.processInfo.processIdentifier));

  var fm = $.NSFileManager.defaultManager;
  var lines = [];
  var mask = (1 << 10) | (1 << 11) | (1 << 12);   // key down, key up, modifiers changed
  var end = now() + maxSeconds;
  var doneAt = 0;
  while (now() < end) {
    var event = app.nextEventMatchingMaskUntilDateInModeDequeue(mask, $.NSDate.dateWithTimeIntervalSinceNow(0.02), $.NSDefaultRunLoopMode, true);
    if (event && !event.isNil()) {
      lines.push(JSON.stringify({ wall: now(), type: Number(event.type), code: Number(event.keyCode) }));
    }
    // A short grace period after "done" collects the last key-ups.
    if (!doneAt && fm.fileExistsAtPath($(out + ".done"))) doneAt = now();
    if (doneAt && now() - doneAt > 0.3) break;
  }
  writeText(out, lines.join("\n") + "\n");
  return lines.length + " key events";
}

function now() {
  return Number($.NSDate.date.timeIntervalSince1970);
}

function writeText(path, text) {
  $(text).writeToFileAtomicallyEncodingError($(path), true, $.NSUTF8StringEncoding, null);
}
