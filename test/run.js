// Pure-function tests. The curve and the sun position are the parts that must
// be right on hardware this plugin will never run on here, so they are kept
// free of QML imports and checked with plain node:
//
//   node test/run.js

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
var Sensor = load("Sensor.js");
var Status = load("Status.js");

var failures = 0;
function check(name, condition, detail) {
  if (condition) return;
  failures++;
  console.error("FAIL  " + name + (detail === undefined ? "" : "  (" + detail + ")"));
}
function near(actual, expected, tolerance, name) {
  check(name, Math.abs(actual - expected) <= tolerance, actual + " vs " + expected + " +/-" + tolerance);
}

// ---------------------------------------------------------------- Solar.js
// Skopje, 41.9961 N 21.4317 E. Reference elevations from NOAA's solar
// calculator; the low-precision algorithm should land within a tenth of a degree.
var SKOPJE = [41.9961, 21.4317];

// Solstice maxima for this latitude are 90 - 41.996 +/- 23.44, and 10:00 UTC
// is ~34 minutes before solar noon at 21.43 E, so both sit just under the peak.
near(Solar.elevation(new Date("2026-06-21T10:00:00Z"), SKOPJE[0], SKOPJE[1]), 70.0, 0.5,
  "summer solstice midday elevation is high");
near(Solar.elevation(new Date("2026-12-21T10:00:00Z"), SKOPJE[0], SKOPJE[1]), 24.5, 1.0,
  "winter solstice midday elevation is low");
check("midnight is below the horizon",
  Solar.elevation(new Date("2026-06-21T00:00:00Z"), SKOPJE[0], SKOPJE[1]) < 0);
check("no location yields NaN", isNaN(Solar.elevation(new Date(), NaN, NaN)));

// The same instant is a different elevation at a different latitude — this is
// the whole reason for scheduling on the sun rather than on the clock.
check("latitude changes the answer",
  Math.abs(Solar.elevation(new Date("2026-12-21T10:00:00Z"), 41.99, 21.43)
    - Solar.elevation(new Date("2026-12-21T10:00:00Z"), -33.86, 151.2)) > 20);

check("phase labels day", Solar.phase(45) === "day");
check("phase labels civil twilight", Solar.phase(-3) === "civil twilight");
check("phase labels night", Solar.phase(-30) === "night");

check("short phase is card-sized", Solar.phaseShort(45) === "Day");
check("short phase collapses both twilights", Solar.phaseShort(-3) === "Dusk"
  && Solar.phaseShort(-10) === "Night");
check("short phase handles no location", Solar.phaseShort(NaN) === "Unknown");

// ---------------------------------------------------------------- Curve.js
var opts = { dayBrightness: 85, nightBrightness: 25 };
check("high sun gives day brightness", Curve.solarBaseline(45, opts) === 85);
check("deep night gives night brightness", Curve.solarBaseline(-30, opts) === 25);
check("twilight is strictly between",
  Curve.solarBaseline(2, opts) > 25 && Curve.solarBaseline(2, opts) < 85);
check("baseline is monotonic in elevation",
  Curve.solarBaseline(-2, opts) < Curve.solarBaseline(5, opts));
check("smoothstep is flat at the edges",
  Math.abs(Curve.solarBaseline(9.9, opts) - Curve.solarBaseline(10, opts)) < 0.5);

check("lux score is 0 in the dark", Curve.luxScore(0) === 0);
check("lux score is 1 at the ceiling", Curve.luxScore(10000) === 1);
check("lux score is logarithmic",
  Math.abs((Curve.luxScore(100) - Curve.luxScore(10)) - (Curve.luxScore(1000) - Curve.luxScore(100))) < 0.01);

check("zero gain ignores the sensor", Curve.blend(50, 9999, 0, 0) === 50);
check("bright room at night raises brightness", Curve.blend(25, 5000, -20, 40) > 25);
check("dark room at noon lowers brightness", Curve.blend(85, 0, 45, 40) < 85);
check("null lux is a no-op", Curve.blend(50, null, 0, 40) === 50);

// The curve's fallback for an unreadable elevation is daytime brightness, so
// Service.qml must refuse to act on it rather than driving an unconfigured
// machine up to full. Pinning the fallback here keeps that contract visible.
check("unknown elevation falls back to day, and must not be acted on",
  Curve.solarBaseline(NaN, opts) === 85);

check("target respects the floor",
  Curve.target(-30, null, { nightBrightness: 1, offsetPercent: -50, minBrightness: 5 }) === 5);
check("target respects the ceiling",
  Curve.target(45, null, { dayBrightness: 100, offsetPercent: 50, maxBrightness: 100 }) === 100);

check("median ignores a single spike", Curve.median([10, 11, 10, 9000, 12]) === 11);
check("median of empty is null", Curve.median([]) === null);

// ---------------------------------------------------------------- learning
check("phase keys match the bands phaseShort reports",
  Solar.phaseKey(30) === "day" && Solar.phaseKey(5) === "golden"
  && Solar.phaseKey(-3) === "dusk" && Solar.phaseKey(-20) === "night");
check("no phase key without a sun angle", Solar.phaseKey(NaN) === "");

check("an empty table reads as zero everywhere",
  Curve.learnedOffset(null, "night") === 0 && !Curve.hasLearned(null));
check("learning one band leaves the others alone", function () {
  var table = Curve.learn(null, "night", -18);
  return table.night === -18 && table.day === 0 && table.golden === 0 && table.dusk === 0;
}());
check("learning accumulates within a band",
  Curve.learn(Curve.learn(null, "day", 5), "day", 4).day === 9);
check("an unknown band teaches nothing",
  !Curve.hasLearned(Curve.learn(null, "", -20)));
check("a garbage table degrades to zero rather than NaN",
  Curve.learnedOffset({ night: "nonsense" }, "night") === 0);
check("stored offsets are bounded",
  Curve.learn(null, "day", 5000).day === 100 && Curve.learn(null, "day", -5000).day === -100);
check("forgetting clears every band", !Curve.hasLearned(Curve.forgetLearned()));
check("sub-1% is rounding, not a preference", !Curve.hasLearned({ night: 0.4 }));

check("a learned offset moves the target", function () {
  var plain = Curve.target(-20, null, {});
  return Curve.target(-20, null, { learnedOffset: -18 }) === plain - 18;
}());

// The property the whole design rests on: after absorbing an adjustment the
// target equals what the user set, so the loop has nothing left to correct.
// Anything less than full absorption leaves a residual the slew would chase,
// which is the fighting the manual override existed to paper over.
check("absorbing an adjustment leaves nothing to correct", function () {
  var settings = { learnedOffset: 0 };
  var wanted = Curve.target(-20, null, settings);   // 25
  var user = 12;                                    // user dims to 12%
  settings.learnedOffset = Curve.learn(null, "night", user - wanted).night;
  return Curve.target(-20, null, settings) === user;
}());

check("absorption survives a band the schedule ramps through", function () {
  var settings = { learnedOffset: 0 };
  var wanted = Curve.target(-3, null, settings);
  settings.learnedOffset = Curve.learn(null, "dusk", 70 - wanted).dusk;
  return Curve.target(-3, null, settings) === 70;
}());

check("deadband suppresses small moves", Curve.withinDeadband(50, 52, 3));
check("deadband allows real moves", !Curve.withinDeadband(50, 60, 3));

check("brightening is faster than dimming",
  Curve.stepLimit(20, 80) > Curve.stepLimit(80, 20));
check("slew does not overshoot up", Curve.slewToward(50, 52, 10) === 52);
check("slew does not overshoot down", Curve.slewToward(50, 48, 10) === 48);
check("slew advances by one step", Curve.slewToward(0, 100, 4) === 4);

// --------------------------------------------------------------- Sensor.js
// The tier this machine is on: raw counts scaled to lux.
check("hid scaling", Sensor.luxFromReading("250000", "hid", 0.001, 0) === 250);
// The tier the MacBook plugin assumes: already lux.
check("acpi passthrough", Sensor.luxFromReading("240", "acpi", 1, 0) === 240);
check("garbage reading is null", Sensor.luxFromReading("n/a", "hid", 0.001, 0) === null);
check("missing scale falls back to 1", Sensor.luxFromReading("42", "hid", 0, 0) === 42);
check("negative clamps to zero", Sensor.luxFromReading("-5", "acpi", 1, 0) === 0);

var probe = Sensor.parseProbe('{"backlight":{"device":"intel_backlight","max":512},"sensor":{"path":"/x","kind":"hid","scale":0.001,"offset":0},"error":""}');
check("probe parses device", probe.backlightDevice === "intel_backlight");
check("probe parses max", probe.maxRaw === 512);
check("probe parses sensor kind", probe.sensorKind === "hid");
check("bad probe degrades to no sensor", Sensor.parseProbe("not json").sensorKind === "none");

check("percent from raw", Sensor.percentFromRaw(256, 512) === 50);
check("percent guards zero max", Sensor.percentFromRaw(10, 0) === null);
check("no sensor reads as such", Sensor.lightName(null) === "No sensor");

// ---------------------------------------------------------------- Status.js
var base = { hasLocation: true, automatic: true, manualOverride: false,
             locationName: "Skopje", hasSensor: true, ambientActive: true, ambientDelta: 0 };
function withState(extra) {
  var out = {};
  for (var k in base) out[k] = base[k];
  for (var k2 in extra) out[k2] = extra[k2];
  return out;
}

check("names the place", Status.sentence(base).indexOf("in Skopje") !== -1);
check("dark room is explained",
  Status.sentence(withState({ ambientDelta: -0.3 })).indexOf("dark") !== -1);
check("bright room is explained",
  Status.sentence(withState({ ambientDelta: 0.3 })).indexOf("bright") !== -1);
check("a small delta is not dressed up as dark",
  Status.sentence(withState({ ambientDelta: -0.02 })).indexOf("dark") === -1);
check("paused says so",
  Status.sentence(withState({ automatic: false })).indexOf("Paused") === 0);
check("paused outranks the room",
  Status.sentence(withState({ automatic: false, ambientDelta: -0.9 })).indexOf("dark") === -1);
check("what was learned is said out loud",
  Status.sentence(withState({ phaseKey: "night", learnedOffset: -12 }))
    .indexOf("You keep nights 12% dimmer") !== -1);
check("the direction of learning is reported",
  Status.sentence(withState({ phaseKey: "day", learnedOffset: 8 }))
    .indexOf("days 8% brighter") !== -1);
check("nothing learned adds no clause",
  Status.sentence(withState({ phaseKey: "night", learnedOffset: 0 }))
    .indexOf("You keep") === -1);
check("rounding is not reported as a preference",
  Status.sentence(withState({ phaseKey: "night", learnedOffset: 0.4 }))
    .indexOf("You keep") === -1);
check("learning is not claimed without a sun angle",
  Status.sentence(withState({ phaseKey: "", learnedOffset: -12 }))
    .indexOf("You keep") === -1);
check("paused says nothing about learning",
  Status.sentence(withState({ automatic: false, phaseKey: "night", learnedOffset: -12 }))
    .indexOf("You keep") === -1);
check("no location outranks everything",
  Status.sentence(withState({ hasLocation: false, automatic: false })).indexOf("no sun to follow") !== -1);
check("no location quotes the reason",
  Status.sentence(withState({ hasLocation: false, locationError: "offline" })).indexOf("offline") !== -1);
check("no sensor stops at the sun",
  Status.sentence(withState({ hasSensor: false, ambientDelta: -0.9 })).indexOf("room") === -1);
check("sun-only stops at the sun",
  Status.sentence(withState({ ambientActive: false, ambientDelta: -0.9 })).indexOf("room") === -1);
check("never returns empty", Status.sentence({}).length > 0);

if (failures) {
  console.error("\n" + failures + " test(s) failed");
  process.exit(1);
}
console.log("all tests passed");
