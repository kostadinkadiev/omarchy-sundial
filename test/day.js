// A whole day of the curve, offline and instantly.
//
//   node test/day.js [latitude] [YYYY-MM-DD]
//
// The live plugin can only ever be tested at whatever the sun is doing right
// now, and the interesting parts -- the twilight ramp, the band boundaries --
// last twenty minutes a day. This runs the same pure functions across a full
// 24 hours at one-minute resolution, so a change can be checked against dawn,
// dusk, midsummer and midwinter before it is ever installed.

var fs = require("fs");
var path = require("path");
var vm = require("vm");

function load(name) {
  var sandbox = { Math: Math, Date: Date, isFinite: isFinite, JSON: JSON, Number: Number, String: String };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "lib", name), "utf8"), sandbox);
  return sandbox;
}

var Solar = load("Solar.js");
var Curve = load("Curve.js");

var latitude = Number(process.argv[2] || 41.9965);
var longitude = 21.4314;
var date = process.argv[3] || "2026-03-20";

var settings = { dayBrightness: 85, nightBrightness: 25, ambientGain: 0 };

// A plausible set of taught preferences: dusk and night pulled well down, the
// day left alone. This is the shape that exposes boundary behaviour.
var learned = Curve.learnAt(Curve.learnAt(null, -20, -14), -3, -20);

function sample(minute) {
  var at = new Date(date + "T00:00:00Z");
  at.setUTCMinutes(at.getUTCMinutes() + minute);
  var elevation = Solar.elevation(at, latitude, longitude);
  var key = Solar.phaseKey(elevation);
  var withLearning = Object.create(settings);
  withLearning.learnedOffset = Curve.learnedOffsetAt(learned, elevation);
  return {
    at: at,
    minute: minute,
    elevation: elevation,
    key: key,
    plain: Curve.target(elevation, null, settings),
    taught: Curve.target(elevation, null, withLearning)
  };
}

var day = [];
for (var m = 0; m < 24 * 60; m++) day.push(sample(m));

function hhmm(d) {
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}

// ------------------------------------------------------------------ profile
console.log("latitude " + latitude + ", " + date + ", times UTC");
console.log("plain = schedule alone, taught = with dusk -20 and night -14 learned");
console.log();
console.log("        sun    band    plain  taught");
for (var i = 0; i < day.length; i += 20) {
  var s = day[i];
  var bar = "#".repeat(Math.round(s.taught / 2));
  console.log(
    hhmm(s.at) + "  " + s.elevation.toFixed(1).padStart(6) + "  "
    + (s.key || "-").padEnd(7) + " " + String(s.plain).padStart(4) + "   "
    + String(s.taught).padStart(4) + "  " + bar
  );
}

// ------------------------------------------------------------------- checks
var problems = [];

function biggestStep(field) {
  var worst = { size: 0 };
  for (var i = 1; i < day.length; i++) {
    var size = Math.abs(day[i][field] - day[i - 1][field]);
    if (size > worst.size) worst = { size: size, at: day[i], from: day[i - 1] };
  }
  return worst;
}

var plainJump = biggestStep("plain");
var taughtJump = biggestStep("taught");

console.log();
console.log("largest one-minute change, schedule alone: " + plainJump.size + " points"
  + (plainJump.at ? " at " + hhmm(plainJump.at.at) : ""));
console.log("largest one-minute change, with learning:  " + taughtJump.size + " points"
  + (taughtJump.at ? " at " + hhmm(taughtJump.at.at) + " (" + taughtJump.from.key
     + " -> " + taughtJump.at.key + ")" : ""));

// Relative, not absolute. Near the equator the sun crosses twilight almost
// vertically and the schedule alone moves two points a minute; at sixty
// degrees the same ramp is spread over hours and moves one. Neither is a
// defect, so the question is not how fast the taught curve moves but whether
// learning made it move faster than the schedule it rides on. One point of
// slack for rounding.
if (taughtJump.size > plainJump.size + 1) {
  problems.push("learning moves " + taughtJump.size + " points a minute where the schedule moves "
    + plainJump.size + ": a band boundary is showing through");
}

console.log();
if (problems.length === 0) {
  console.log("no discontinuities");
} else {
  problems.forEach(function (p) { console.log("PROBLEM: " + p); });
}
process.exitCode = problems.length ? 1 : 0;
