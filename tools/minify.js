// Makes the compact copy of src/main.js that goes into the app bundle:
// comments, indentation and blank lines are removed, and a space is kept only
// where two tokens would otherwise run together. Line breaks between tokens
// are kept, so automatic semicolon insertion works exactly as in the source.
//
//   osascript -l JavaScript tools/minify.js src/main.js OUT.js "banner line"
//
// The result is checked before it is written: read back, it must give the
// same tokens as the source, one for one, with a line break before exactly
// the same ones. Anything this tokenizer does not understand (a template
// literal, an unterminated string or regular expression) stops the build.
ObjC.import('Foundation');

var WORD = new RegExp("[A-Za-z0-9_$" + String.fromCharCode(0x80) + "-" + String.fromCharCode(0xffff) + "]");
var NBSP = String.fromCharCode(0xa0), BOM = String.fromCharCode(0xfeff);
var LINE_BREAK = new RegExp("[\\n\\r" + String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + "]");
// After these, a "/" starts a regular expression rather than a division.
var REGEX_AFTER_WORDS = { "return": 1, "typeof": 1, "instanceof": 1, "in": 1, "of": 1, "new": 1, "delete": 1,
  "void": 1, "throw": 1, "case": 1, "do": 1, "else": 1 };
var PUNCTUATORS = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "&&", "||", "??", "?.", "==", "!=", "<=", ">=", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=",
  "^=", "<<", ">>", "=>", "**"];

function tokenize(src) {
  var tokens = [];
  var i = 0, n = src.length, newlineBefore = false;
  function fail(what) {
    var line = src.slice(0, i).split("\n").length;
    throw new Error(what + " at line " + line);
  }
  function regexAllowed() {
    var prev = tokens.length ? tokens[tokens.length - 1] : null;
    if (!prev) return true;
    if (prev.type === "word") return REGEX_AFTER_WORDS.hasOwnProperty(prev.text);
    if (prev.type === "punct") return !(prev.text === ")" || prev.text === "]" || prev.text === "}");
    return false;   // after a number, a string or a regular expression: a division
  }
  function push(type, text) {
    tokens.push({ type: type, text: text, nl: newlineBefore });
    newlineBefore = false;
  }
  while (i < n) {
    var c = src.charAt(i);
    if (LINE_BREAK.test(c)) { newlineBefore = true; i++; continue; }
    if (c === " " || c === "\t" || c === "\v" || c === "\f" || c === NBSP || c === BOM) { i++; continue; }
    if (c === "/" && src.charAt(i + 1) === "/") {
      while (i < n && !LINE_BREAK.test(src.charAt(i))) i++;
      continue;
    }
    if (c === "/" && src.charAt(i + 1) === "*") {
      var end = src.indexOf("*/", i + 2);
      if (end < 0) fail("Unterminated comment");
      if (LINE_BREAK.test(src.slice(i, end))) newlineBefore = true;   // a comment with a line break counts as one
      i = end + 2;
      continue;
    }
    if (c === "`") fail("Template literal (not supported by tools/minify.js)");
    if (c === "'" || c === '"') {
      var j = i + 1;
      while (j < n && src.charAt(j) !== c) {
        if (src.charAt(j) === "\\") j++;
        else if (LINE_BREAK.test(src.charAt(j))) { i = j; fail("Unterminated string"); }
        j++;
      }
      if (j >= n) fail("Unterminated string");
      push("string", src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === "/" && regexAllowed()) {
      var k = i + 1, inClass = false;
      while (k < n) {
        var d = src.charAt(k);
        if (LINE_BREAK.test(d)) { i = k; fail("Unterminated regular expression"); }
        if (d === "\\") { k += 2; continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        k++;
      }
      if (k >= n) fail("Unterminated regular expression");
      k++;
      while (k < n && /[A-Za-z]/.test(src.charAt(k))) k++;   // flags
      push("regex", src.slice(i, k));
      i = k;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src.charAt(i + 1)))) {
      var m = /^(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
      push("number", m[0]);
      i += m[0].length;
      continue;
    }
    if (WORD.test(c)) {
      var w = i;
      while (w < n && WORD.test(src.charAt(w))) w++;
      push("word", src.slice(i, w));
      i = w;
      continue;
    }
    var p = null;
    for (var q = 0; q < PUNCTUATORS.length; q++) {
      if (src.substr(i, PUNCTUATORS[q].length) === PUNCTUATORS[q]) { p = PUNCTUATORS[q]; break; }
    }
    if (!p) p = c;
    push("punct", p);
    i += p.length;
  }
  if (tokens.length) tokens[0].nl = false;   // a line break before the first token means nothing
  return tokens;
}

// Whether two tokens written side by side would be read as something else.
function needsSpace(a, b) {
  var last = a.text.charAt(a.text.length - 1), first = b.text.charAt(0);
  if (WORD.test(last) && WORD.test(first)) return true;
  if ((last === "+" && first === "+") || (last === "-" && first === "-")) return true;
  if (last === "/" && (first === "/" || first === "*")) return true;
  if (a.type === "number" && first === ".") return true;
  if (last === "<" && first === "!") return true;
  if (b.type === "punct" && PUNCTUATORS.some(function(op) { return op.length > b.text.length && a.text.slice(-1) + b.text === op.slice(0, b.text.length + 1); })) {
    // e.g. "=" followed by "==": keep them apart
    return a.type === "punct";
  }
  return false;
}

function minify(src) {
  var tokens = tokenize(src);
  var out = [];
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (i > 0) {
      if (t.nl) out.push("\n");
      else if (needsSpace(tokens[i - 1], t)) out.push(" ");
    }
    out.push(t.text);
  }
  var result = out.join("") + "\n";
  // Read the result back: it must be the very same token stream.
  var again = tokenize(result);
  if (again.length !== tokens.length) throw new Error("minify check failed: " + tokens.length + " tokens became " + again.length);
  for (var k = 0; k < tokens.length; k++) {
    var x = tokens[k], y = again[k];
    if (x.type !== y.type || x.text !== y.text || x.nl !== y.nl) {
      throw new Error("minify check failed at token " + k + ": " + JSON.stringify(x) + " vs " + JSON.stringify(y));
    }
  }
  return { text: result, tokens: tokens.length };
}

function run(argv) {
  var input = String(argv[0]), output = String(argv[1]), banner = argv.length > 2 ? String(argv[2]) : "";
  var src = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(input), $.NSUTF8StringEncoding, null));
  if (src == null) throw new Error("Could not read " + input);
  var result = minify(src);
  var text = (banner ? "// " + banner + "\n" : "") + result.text;
  if (!$(text).writeToFileAtomicallyEncodingError($(output), true, $.NSUTF8StringEncoding, null)) throw new Error("Could not write " + output);
  return input + ": " + src.length + " -> " + text.length + " characters, " + result.tokens + " tokens checked";
}
