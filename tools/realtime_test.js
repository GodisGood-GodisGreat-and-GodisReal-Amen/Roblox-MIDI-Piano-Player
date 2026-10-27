// The real-time half of tools/realtime_test.sh: plays 40 notes with the REAL
// playback engine (real clock, real Quartz key events) into the process given,
// while another process doubles the speed at 2.1 s, pauses at 4.1 s and
// resumes at 5.6 s through the control file, exactly as the window does.
//
//   osascript -l JavaScript tools/realtime_test.js /path/to/main.js SUPPORT_DIR TARGET_PID DONE_FILE
//
// Prints a JSON line with the start time; the shell script checks the timing.
ObjC.import('Foundation');

function run(argv) {
  var mainPath = String(argv[0]);
  var supportDir = String(argv[1]);
  var targetPid = Number(argv[2]);
  var doneFile = String(argv[3] || "");
  var src = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(mainPath), $.NSUTF8StringEncoding, null));
  // Keep this script's own entry point: main.js's run() becomes mainRun().
  src = src.replace(/function run\(argv\)/, "function mainRun(argv)");
  (0, eval)(src);

  // 40 sixteenth-ish notes, 0.25 s apart at 1x, on five white and black keys.
  var notes = [];
  for (var i = 0; i < 40; i++) notes.push({ tick: i * 240, note: 60 + (i % 5), durTicks: 120 });
  var cfg = sanitizeConfig({ keyboardProfile: "us", keySendMethod: "quartz", speed: 1, startDelaySeconds: 0 });
  var profile = resolveKeyboardProfile(cfg);
  var playbackCfg = clone(cfg);
  playbackCfg.savedBaseMIDINote = 36;
  var built = buildSchedule(notes, [], 480, playbackCfg, profile);
  var job = { jobId: "realtime-test", supportDir: supportDir, songName: "realtime test", midiPath: "", createdAt: nowSeconds(), schedule: built.schedule, quiet: true };
  writePlaybackControl(supportDir, { jobId: job.jobId, speed: 1, paused: false });

  // The "window": a shell that rewrites the control file on a timer.
  var control = supportDir + "/" + PLAYBACK_CONTROL_FILE;
  function write(json) {
    return "printf '%s' " + shellQuote(json) + " > " + shellQuote(control + ".tmp") + " && mv " + shellQuote(control + ".tmp") + " " + shellQuote(control);
  }
  var script = [
    "sleep 2.1", write('{"jobId":"realtime-test","speed":2,"paused":false}'),
    "sleep 2.0", write('{"jobId":"realtime-test","speed":2,"paused":true}'),
    "sleep 1.5", write('{"jobId":"realtime-test","speed":2,"paused":false}')
  ].join("; ");
  var task = $.NSTask.alloc.init;
  task.setLaunchPath($("/bin/sh"));
  task.setArguments($(["-c", script]));

  var start = nowSeconds();
  task.launch;
  performPlaybackToPid(built.schedule, targetPid, supportDir, job);
  var end = nowSeconds();
  if (doneFile) writeTextFile(doneFile, "done");
  return JSON.stringify({ start: start, end: end });
}
