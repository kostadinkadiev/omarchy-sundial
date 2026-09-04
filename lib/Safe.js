// Values that came from somewhere else, made safe to put in a label.
//
// Everything bin/ab-locate prints is such a value -- the place name it found
// and the reason it failed both arrive from the weather widget's location
// file, from a cache on disk, or from an IP lookup. bin/ab-locate
// already filters it, and Panel.qml renders every label with
// textFormat: Text.PlainText, which is the defence that actually decides the
// outcome. This is the layer in between: QML does not have to trust that the
// helper it just ran is the helper it shipped with, or that the cache file on
// disk is the one it wrote.
//
// Pure, so the rules are testable without a shell or a running shell process.

// Sixty-four characters is longer than any real place name, and short enough
// that a label cannot be used to push the rest of the panel off screen.
var MAX_NAME = 64;

// Two rules for two engines, deliberately.
//
// ab-locate can afford a strict allowlist -- letters, marks and digits in any
// script, plus the punctuation place names use -- because jq's Oniguruma
// implements \p{L} and friends. QML's V4 does not: on Qt 6.11,
// /\p{L}/u.test("a") is false and /[^\p{L}]/gu removes nothing at all, with no
// exception raised. A whitelist written that way here would look right, pass
// review, and strip nothing. So this side names what it removes instead, using
// only ASCII ranges V4 is certain to honour:
//
//   controls      C0, DEL and C1 -- terminal escapes, NUL, anything invisible
//   invisibles    zero-width and bidi overrides, which can reorder a label
//   markup        < > & \ / -- the punctuation a tag is made of, which is
//                 what turns a label into markup at a sink that renders rich
//                 text. Qt's own rich-text sniffing keys on '<'. bin/ab-locate
//                 drops the same five, so the two layers agree on this set.
//
// Everything else passes through untouched, so no alphabet is second class.
var CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
var INVISIBLES = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
var MARKUP = /[<>&\\\/]/g;

function plain(value) {
  if (typeof value !== "string") return "";
  return value
    // Whitespace first: deleting a newline between two words before this would
    // fuse them into one. Same ordering as clean_name in bin/ab-locate.
    .replace(/\s+/g, " ")
    .replace(CONTROLS, "")
    .replace(INVISIBLES, "")
    .replace(MARKUP, "")
    .replace(/ +/g, " ")
    .replace(/^ | $/g, "")
    .slice(0, MAX_NAME);
}
