// Draws the app icon (a Roblox-style piano with one lit key and the "Ctrl dot"
// motif) and writes it as a 1024x1024 PNG.  Usage: osascript -l JavaScript make_icon.js out.png
ObjC.import('Cocoa');
function run(argv) {
  var out = String(argv[0]);
  var S = 1024;
  var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, S, S, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0);
  rep.setSize($.NSMakeSize(S, S));
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  function rgb(r, g, b, a) { return $.NSColor.colorWithCalibratedRedGreenBlueAlpha(r, g, b, a == null ? 1 : a); }
  // macOS icon shape: rounded square with margins (the system adds no mask itself).
  var m = 100;                       // transparent margin
  var body = $.NSMakeRect(m, m, S - 2 * m, S - 2 * m);
  var shape = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(body, 186, 186);
  // soft shadow
  var shadow = $.NSShadow.alloc.init;
  shadow.setShadowColor(rgb(0, 0, 0, 0.35));
  shadow.setShadowOffset($.NSMakeSize(0, -14));
  shadow.setShadowBlurRadius(28);
  shadow.set;
  var grad = $.NSGradient.alloc.initWithStartingColorEndingColor(rgb(0.16, 0.18, 0.26), rgb(0.07, 0.08, 0.13));
  grad.drawInBezierPathAngle(shape, -90);
  $.NSShadow.alloc.init.set;   // shadow off
  // subtle top highlight
  var hl = $.NSGradient.alloc.initWithStartingColorEndingColor(rgb(1, 1, 1, 0.10), rgb(1, 1, 1, 0));
  var hlRect = $.NSMakeRect(m, S - m - 300, S - 2 * m, 300);
  $.NSGraphicsContext.saveGraphicsState;
  shape.addClip;
  hl.drawInRectAngle(hlRect, -90);
  $.NSGraphicsContext.restoreGraphicsState;

  // Piano keys: 7 white keys across the lower 62% of the body, black keys on top.
  $.NSGraphicsContext.saveGraphicsState;
  shape.addClip;
  var keysTop = m + (S - 2 * m) * 0.60;
  var keysBottom = m;
  var kw = (S - 2 * m) / 7;
  var lit = 3;   // the lit (green) white key: F
  for (var i = 0; i < 7; i++) {
    var x = m + i * kw;
    var isLit = (i === lit);
    var fill = isLit ? rgb(0.36, 0.85, 0.36) : rgb(0.96, 0.96, 0.97);
    fill.setFill;
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(x + 5, keysBottom - 40, kw - 10, keysTop - keysBottom + 40), 14, 14).fill;
  }
  // black keys between C-D, D-E, F-G, G-A, A-B (white indexes 0,1,3,4,5)
  var blackAfter = [0, 1, 3, 4, 5];
  for (var b = 0; b < blackAfter.length; b++) {
    var bx = m + (blackAfter[b] + 1) * kw - kw * 0.31;
    rgb(0.09, 0.09, 0.11).setFill;
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(bx, keysTop - (keysTop - keysBottom) * 0.58, kw * 0.62, (keysTop - keysBottom) * 0.58 + 8), 10, 10).fill;
  }
  $.NSGraphicsContext.restoreGraphicsState;

  // The "Ctrl dot" above the lit key, and a small green glow.
  var cx = m + (lit + 0.5) * kw;
  var cy = keysTop + 120;
  var glow = $.NSGradient.alloc.initWithStartingColorEndingColor(rgb(0.36, 0.85, 0.36, 0.55), rgb(0.36, 0.85, 0.36, 0));
  glow.drawInRectRelativeCenterPosition($.NSMakeRect(cx - 150, cy - 150, 300, 300), $.NSMakePoint(0, 0));
  rgb(0.36, 0.85, 0.36).setFill;
  $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(cx - 40, cy - 40, 80, 80)).fill;

  $.NSGraphicsContext.restoreGraphicsState;
  var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return "wrote=" + png.writeToFileAtomically($(out), true);
}
