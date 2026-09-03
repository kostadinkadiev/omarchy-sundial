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
check("lux score is 1 at the ceiling", Curve.luxScore(2000) === 1);
check("outdoor light saturates rather than overflowing", Curve.luxScore(50000) === 1);
// The number that made the default wrong: an ordinary lit room at solar noon.
check("an ordinary room is not read as a cave", function () {
  var indoors = Curve.target(50, 200, { ambientGain: 30 });
  return indoors >= 74 && indoors <= 80;
}(), "200 lux at noon");
// Approximately, not exactly: the +1 that keeps log(0) finite also bends the
// scale where lux is small, and log10(11) is 4% above log10(10). The tolerance
// has to carry that -- it was 0.01 when the ceiling was 10000, and the same
// absolute error is a larger share of a smaller range.
check("lux score is logarithmic",
  Math.abs((Curve.luxScore(100) - Curve.luxScore(10)) - (Curve.luxScore(1000) - Curve.luxScore(100))) < 0.02);

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

// ------------------------------------------------------- sunrise and sunset
var SKOPJE = [41.9965, 21.4314];

function crossings(iso, count, latitude, longitude) {
  var at = new Date(iso);
  var out = [];
  for (var i = 0; i < count; i++) {
    var event = Solar.nextHorizonCrossing(at, latitude, longitude);
    if (!event) break;
    out.push(event);
    at = event.time;
  }
  return out;
}

check("a mid-latitude day has a crossing to find",
  Solar.nextHorizonCrossing(new Date("2026-03-20T00:00:00Z"), SKOPJE[0], SKOPJE[1]) !== null);

// The solver has to agree with the elevation() the rest of the plugin runs on,
// which is the reason it searches that function rather than using a closed
// form that could quietly disagree with it near the equinoxes.
check("the sun really is at the horizon at the reported time", function () {
  var event = Solar.nextHorizonCrossing(new Date("2026-03-20T00:00:00Z"), SKOPJE[0], SKOPJE[1]);
  return Math.abs(Solar.elevation(event.time, SKOPJE[0], SKOPJE[1]) + 0.833) < 0.01;
}());

check("crossings alternate rise and set", function () {
  var found = crossings("2026-03-20T00:00:00Z", 4, SKOPJE[0], SKOPJE[1]);
  return found.length === 4 && found[0].rising && !found[1].rising
    && found[2].rising && !found[3].rising;
}());

// Asking at the exact moment of a crossing must return the following one, not
// the one that has just happened. The horizon test lands on a coin flip there,
// so this is the case that broke first on real data.
check("a crossing is strictly after the moment asked about", function () {
  var first = Solar.nextHorizonCrossing(new Date("2026-06-21T00:00:00Z"), SKOPJE[0], SKOPJE[1]);
  var second = Solar.nextHorizonCrossing(first.time, SKOPJE[0], SKOPJE[1]);
  return second.time.getTime() > first.time.getTime() && second.rising !== first.rising;
}());

// Skopje sees about 15h05m at the solstice and about 9h05m at midwinter.
check("day length matches the latitude across the year", function () {
  function hours(iso) {
    var found = crossings(iso, 2, SKOPJE[0], SKOPJE[1]);
    return (found[1].time.getTime() - found[0].time.getTime()) / 3600000;
  }
  var summer = hours("2026-06-21T00:00:00Z");
  var winter = hours("2026-12-21T00:00:00Z");
  return Math.abs(summer - 15.15) < 0.3 && Math.abs(winter - 9.1) < 0.3;
}, "summer/winter day length");

check("no crossing above the arctic circle in midsummer",
  Solar.nextHorizonCrossing(new Date("2026-06-21T00:00:00Z"), 80, 0) === null);
check("no crossing without a location",
  Solar.nextHorizonCrossing(new Date("2026-06-21T00:00:00Z"), NaN, NaN) === null);

check("an empty table reads as zero everywhere",
  Curve.learnedOffset(null, "night") === 0 && !Curve.hasLearned(null));
check("learning one band leaves the others alone", function () {
  var table = Curve.learnAt(null, -20, -18);
  return table.night === -18 && table.day === 0 && table.golden === 0 && table.dusk === 0;
}());
check("learning accumulates within a band",
  Curve.learnAt(Curve.learnAt(null, 30, 5), 30, 4).day === 9);
check("no sun angle teaches nothing",
  !Curve.hasLearned(Curve.learnAt(null, NaN, -20)));
check("a garbage table degrades to zero rather than NaN",
  Curve.learnedOffset({ night: "nonsense" }, "night") === 0);
check("stored offsets are bounded",
  Curve.learnAt(null, 30, 5000).day === 100 && Curve.learnAt(null, 30, -5000).day === -100);
check("forgetting clears every band", !Curve.hasLearned(Curve.forgetLearned()));
check("sub-1% is rounding, not a preference", !Curve.hasLearned({ night: 0.4 }));

check("a learned offset moves the target", function () {
  var plain = Curve.target(-20, null, {});
  return Curve.target(-20, null, { learnedOffset: -18 }) === plain - 18;
}());

// ------------------------------------------------------ blending the bands
//
// A band is a step function and the rest of the curve goes to some trouble to
// avoid steps, so the offsets are interpolated between anchors. Applied
// naively a preference taught at dusk and not at night lands as a cliff at the
// boundary -- twenty points in the minute the schedule itself moves one.

check("weights sum to one wherever the sun is", function () {
  for (var elevation = -30; elevation <= 40; elevation += 0.5) {
    var total = 0;
    var weights = Curve.learnedWeights(elevation);
    for (var i = 0; i < weights.length; i++) total += weights[i].weight;
    if (Math.abs(total - 1) > 1e-9) return false;
  }
  return true;
}());
check("no band has a say without a sun angle",
  Curve.learnedWeights(NaN).length === 0 && Curve.dominantBand(NaN) === null);
check("the plateaus belong to one band outright",
  Curve.learnedOffsetAt({ night: -14 }, -40) === -14
  && Curve.learnedOffsetAt({ day: 9 }, 60) === 9);
check("between anchors the neighbours share it", function () {
  var table = { night: -14, dusk: 0, golden: 0, day: 0 };
  var midway = Curve.learnedOffsetAt(table, -4.5);
  return midway < -1 && midway > -13;
}());

// The check test/day.js makes across a whole day, as a unit test: the offset
// in force must never move faster than the schedule it rides on.
check("a taught offset stays within a bounded multiple of the schedule", function () {
  // A realistic worst case: a large preference taught in one band and nothing
  // in its neighbour, which is what a single evening of adjusting produces.
  var table = { night: 0, dusk: 26, golden: 0, day: 0 };
  var taught = 0;
  var schedule = 0;
  for (var elevation = -30; elevation <= 40; elevation += 0.01) {
    var offsetStep = Math.abs(Curve.learnedOffsetAt(table, elevation)
      - Curve.learnedOffsetAt(table, elevation - 0.01));
    var baselineStep = Math.abs(Curve.solarBaseline(elevation, {})
      - Curve.solarBaseline(elevation - 0.01, {}));
    if (offsetStep > taught) taught = offsetStep;
    if (baselineStep > schedule) schedule = baselineStep;
  }

  // Not 1x, and the geometry says why: the baseline spreads its whole 60-point
  // range over the 16 degrees from -6 to +10, while an offset taught at dusk
  // and absent at night has the 3 degrees between those two anchors to unwind
  // in. Roughly five times less room, so a little over twice the gradient.
  //
  // What matters to someone looking at the screen is points per minute, not
  // per degree, and that depends on how fast the sun sweeps those degrees --
  // which varies with latitude and season. test/day.js is the authority there:
  // it measures the real thing across a whole day and holds the taught curve
  // to within a point a minute of the schedule, from the equator to 60 degrees.
  return taught / schedule < 2.5;
}());

// The property the whole design rests on: after absorbing an adjustment the
// target equals what the user set, so the loop has nothing left to correct.
// Anything less than full absorption leaves a residual the slew would chase,
// which is the fighting the manual override existed to paper over.
//
// Interpolation is where this nearly broke: between anchors a band is only
// partly in force, so filing the residual raw would land short. Checked at the
// exact midpoint, where a band carries half the weight and the correction has
// to be doubled to arrive whole.
[-20, -6, -4.5, -3, 0, 5, 10, 30].forEach(function (elevation) {
  check("absorption is exact at " + elevation + " degrees", function () {
    var settings = { learnedOffset: 0 };
    var wanted = Curve.target(elevation, null, settings);
    var user = wanted >= 50 ? 20 : 70;
    var table = Curve.learnAt(null, elevation, user - wanted);
    settings.learnedOffset = Curve.learnedOffsetAt(table, elevation);
    return Curve.target(elevation, null, settings) === user;
  }(), "elevation " + elevation);
});

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
  Status.sentence(withState({ learnedBand: "night", learnedOffset: -12 }))
    .indexOf("You keep nights 12% dimmer") !== -1);
check("the direction of learning is reported",
  Status.sentence(withState({ learnedBand: "day", learnedOffset: 8 }))
    .indexOf("days 8% brighter") !== -1);
check("nothing learned adds no clause",
  Status.sentence(withState({ learnedBand: "night", learnedOffset: 0 }))
    .indexOf("You keep") === -1);
check("rounding is not reported as a preference",
  Status.sentence(withState({ learnedBand: "night", learnedOffset: 0.4 }))
    .indexOf("You keep") === -1);
check("learning is not claimed without a sun angle",
  Status.sentence(withState({ learnedBand: "", learnedOffset: -12 }))
    .indexOf("You keep") === -1);
check("paused says nothing about learning",
  Status.sentence(withState({ automatic: false, learnedBand: "night", learnedOffset: -12 }))
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
