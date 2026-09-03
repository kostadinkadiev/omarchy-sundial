// The brightness curve, as pure functions.
//
// Two inputs, deliberately asymmetric in authority:
//
//   solar elevation  the baseline. Always available, on every machine,
//                    including desktops with no sensor at all.
//   ambient lux      a correction on top of it, never a replacement.
//
// Making the sensor a correction rather than the source is what keeps this
// stable. An ALS sits behind bezel glass and is routinely shadowed by a hand,
// a lid angle, or a dark shirt; a sensor-driven controller chases every one of
// those. Here an occluded sensor degrades to "the sun says it is 14:00", which
// is never badly wrong.

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

// Hermite ease. Used across the twilight band so the day->night ramp has no
// visible knee at either end — the derivative is zero at both edges.
function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  var t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

var NIGHT_ELEVATION = -6;   // end of civil twilight
var DAY_ELEVATION = 10;     // sun comfortably up

// Flat during the day, flat at night, one smooth ~50-minute ramp between.
function solarBaseline(elevationDegrees, options) {
  var o = options || {};
  var night = o.nightBrightness === undefined ? 25 : o.nightBrightness;
  var day = o.dayBrightness === undefined ? 85 : o.dayBrightness;
  var low = o.nightElevation === undefined ? NIGHT_ELEVATION : o.nightElevation;
  var high = o.dayElevation === undefined ? DAY_ELEVATION : o.dayElevation;
  if (!isFinite(elevationDegrees)) return day;
  return night + (day - night) * smoothstep(low, high, elevationDegrees);
}

// Perceived brightness is logarithmic (Weber-Fechner), so normalize lux on a
// log scale: 10 -> 100 lux is the same perceptual step as 100 -> 1000, and a
// linear lux->percent table (what most naive implementations use) spends most
// of its resolution on daylight nobody can distinguish.
// The reading that counts as "as bright as this sensor will ever usefully
// see". Set to indoor daylight, not outdoor: a laptop ambient sensor lives on
// a desk, and the illuminances it actually meets are a living room at 50-200
// lux, an office at 300-500, a window seat on an overcast day at maybe 1000.
// Full outdoor daylight is 10,000-25,000 and a laptop screen is unreadable
// there anyway.
//
// It was 10,000 to begin with, which quietly meant the model expected outdoor
// light while the sensor measured a room. Every reading indoors then scored
// far below what the sun implied, so the correction was permanently negative
// and the day sat 13 points below its own schedule -- 72% where the curve said
// 85% -- for every user with a sensor, all day, forever. Measured at 165-229
// lux at solar noon on a normal desk, which is not an unusual room.
//
// 2000 keeps headroom above a bright room without treating an ordinary lit one
// as a cave.
function luxScore(lux, luxCeiling) {
  var ceiling = luxCeiling === undefined ? 2000 : luxCeiling;
  var value = Math.max(0, Number(lux) || 0);
  return clamp(Math.log10(value + 1) / Math.log10(ceiling + 1), 0, 1);
}

// What the sun curve alone implies the room should be measuring. The ambient
// correction is the gap between this and reality — a dark room at noon reads
// well below it, a lit room at midnight well above.
function expectedLuxScore(elevationDegrees, options) {
  var o = options || {};
  var low = o.nightElevation === undefined ? NIGHT_ELEVATION : o.nightElevation;
  var high = o.dayElevation === undefined ? DAY_ELEVATION : o.dayElevation;
  if (!isFinite(elevationDegrees)) return 0.5;
  return smoothstep(low, high, elevationDegrees);
}

// baseline + gain * (measured - expected), clamped. gain 0 disables the sensor
// entirely and leaves a pure solar schedule, which is the v0 default and the
// permanent behaviour on machines with no ALS.
function blend(baseline, lux, elevationDegrees, gain, options) {
  var g = Number(gain) || 0;
  if (g === 0 || lux === null || lux === undefined || !isFinite(Number(lux))) return baseline;
  var delta = luxScore(lux, (options || {}).luxCeiling) - expectedLuxScore(elevationDegrees, options);
  return baseline + g * delta;
}

// Full target, including the user's standing preference offset and floor/ceiling.
function target(elevationDegrees, lux, settings) {
  var s = settings || {};
  var baseline = solarBaseline(elevationDegrees, s);
  var blended = blend(baseline, lux, elevationDegrees, s.ambientGain, s);
  var floor = s.minBrightness === undefined ? 5 : s.minBrightness;
  var ceiling = s.maxBrightness === undefined ? 100 : s.maxBrightness;
  var adjusted = blended + (Number(s.offsetPercent) || 0) + (Number(s.learnedOffset) || 0);
  return Math.round(clamp(adjusted, floor, ceiling));
}

// Median, not mean. A single sample of a camera flash, a passing headlight, or
// a white window scrolling past ruins a mean; the median ignores it outright.
function median(values) {
  if (!values || values.length === 0) return null;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Asymmetric response. Walking into sunlight and being left in the dark is a
// usability failure; a cloud briefly dimming the room is not. So brighten
// promptly and dim reluctantly.
function stepLimit(current, target, options) {
  var o = options || {};
  var up = o.brightenStep === undefined ? 4 : o.brightenStep;
  var down = o.dimStep === undefined ? 1 : o.dimStep;
  return target > current ? up : down;
}

// Move one tick toward the target without overshooting.
function slewToward(current, target, maxStep) {
  if (current === target) return current;
  var step = Math.max(1, Math.abs(maxStep));
  return current < target
    ? Math.min(target, current + step)
    : Math.max(target, current - step);
}

// Nothing is written at all inside the deadband, so a target hovering one
// percent away cannot produce a permanent trickle of backlight writes.
function withinDeadband(current, target, deadband) {
  var band = deadband === undefined ? 3 : deadband;
  return Math.abs(target - current) <= band;
}

// Whether a standing manual override should give way to the schedule again.
// Undoing it the moment the target twitches would make the brightness keys
// useless; keeping it forever would mean one evening tap disables the plugin
// until reboot. Yielding once the schedule has genuinely moved on splits the
// difference: an afternoon override survives the afternoon and is released by
// the evening ramp.
// ------------------------------------------------------------------ learning
//
// What replaced the manual override. The override was a timer in disguise: an
// adjustment stood until the schedule had drifted some threshold away, which
// meant the same press lasted five minutes at dusk and six hours on a flat
// afternoon. Nothing on screen said which, so the only honest description of
// the feature was "it comes back eventually".
//
// So an adjustment is not something to expire. It is the only direct statement
// of preference the user ever makes, and the right thing to do with it is keep
// it. Each of the four solar bands carries its own offset from the schedule;
// dimming at midnight teaches the night and leaves the afternoon alone.
//
// Absorption is total, and that is the load-bearing decision. A partial blend
// -- learn half the difference, as a smoothing filter would -- means the screen
// keeps moving after the user has stopped adjusting it, which is precisely the
// fighting the override existed to prevent. Halfway is the one setting that is
// worse than either end.
var PHASE_KEYS = ["day", "golden", "dusk", "night"];

// Wide enough that any reachable brightness can be expressed as an offset from
// any baseline. A tighter bound would silently cap the offset, leaving a
// residual the loop would immediately slew away -- fighting the user through
// the back door, exactly what full absorption is here to avoid.
var LEARN_LIMIT = 100;

// Where each band's offset is fully in force, with the same smoothstep used
// between them that the baseline uses within them.
//
// Bands are how a person talks about this -- "nights are too bright" -- but a
// band is a step function, and stepping is exactly what the rest of the curve
// goes to some trouble to avoid. Applied naively, a preference taught at dusk
// and not at night lands as a cliff at the boundary: the schedule moves about
// a point a minute there, and a twenty-point offset appearing in one of those
// minutes is twenty times faster than anything else the plugin does. It reads
// as the screen lurching for no reason, at a moment when nothing outside
// changed. (test/day.js measures this; it is how the cliff was found.)
//
// Night and day anchor at the edges of their bands rather than the middle
// because the solar baseline is already flat beyond those points -- below -6
// it is night whatever the sun does next, and the offset should be flat there
// too.
var LEARN_ANCHORS = [
  { key: "night", elevation: -6 },
  { key: "dusk", elevation: -3 },
  { key: "golden", elevation: 5 },
  { key: "day", elevation: 10 }
];

function learnedTable(learned) {
  var table = {};
  for (var i = 0; i < PHASE_KEYS.length; i++) {
    var value = learned && typeof learned === "object" ? Number(learned[PHASE_KEYS[i]]) : 0;
    table[PHASE_KEYS[i]] = isFinite(value) ? clamp(value, -LEARN_LIMIT, LEARN_LIMIT) : 0;
  }
  return table;
}

function learnedOffset(learned, phaseKey) {
  if (PHASE_KEYS.indexOf(phaseKey) < 0) return 0;
  return learnedTable(learned)[phaseKey];
}

// Which bands have a say at this sun angle, and how much. At most two, summing
// to one.
function learnedWeights(elevationDegrees) {
  if (!isFinite(elevationDegrees)) return [];

  var first = LEARN_ANCHORS[0];
  if (elevationDegrees <= first.elevation) return [{ key: first.key, weight: 1 }];

  var last = LEARN_ANCHORS[LEARN_ANCHORS.length - 1];
  if (elevationDegrees >= last.elevation) return [{ key: last.key, weight: 1 }];

  for (var i = 1; i < LEARN_ANCHORS.length; i++) {
    var low = LEARN_ANCHORS[i - 1];
    var high = LEARN_ANCHORS[i];
    if (elevationDegrees <= high.elevation) {
      var t = smoothstep(low.elevation, high.elevation, elevationDegrees);
      return [{ key: low.key, weight: 1 - t }, { key: high.key, weight: t }];
    }
  }
  return [];
}

// The band a correction made here should be filed under, and how much of the
// current offset it accounts for.
function dominantBand(elevationDegrees) {
  var weights = learnedWeights(elevationDegrees);
  var best = null;
  for (var i = 0; i < weights.length; i++) {
    if (best === null || weights[i].weight > best.weight) best = weights[i];
  }
  return best;
}

// The offset actually in force at this sun angle: continuous, so it can be
// added to a continuous baseline without putting a step back in.
function learnedOffsetAt(learned, elevationDegrees) {
  var table = learnedTable(learned);
  var weights = learnedWeights(elevationDegrees);
  var total = 0;
  for (var i = 0; i < weights.length; i++) {
    total += table[weights[i].key] * weights[i].weight;
  }
  return total;
}

// File a correction against the band that owns this sun angle.
//
// Divided by that band's weight because the band is only partly in force
// between anchors: storing the residual raw would move the effective offset by
// less than the user asked for, leaving a remainder the loop slews away --
// which is the fighting that total absorption exists to prevent, reintroduced
// through the interpolation. The dominant weight is at least a half by
// definition, so the division never scales by more than two.
function learnAt(learned, elevationDegrees, residual) {
  var table = learnedTable(learned);
  var delta = Number(residual);
  var band = dominantBand(elevationDegrees);
  if (!band || !isFinite(delta)) return table;
  // Rounded because this lands in the user's shell.json, where
  // 26.003873626408364 is noise pretending to be precision. Hundredths are
  // far finer than a backlight can resolve.
  var next = clamp(table[band.key] + delta / band.weight, -LEARN_LIMIT, LEARN_LIMIT);
  table[band.key] = Math.round(next * 100) / 100;
  return table;
}

function forgetLearned() {
  return learnedTable(null);
}

// Whether there is anything worth offering to forget. Sub-1% is rounding, not
// a preference.
function hasLearned(learned) {
  var table = learnedTable(learned);
  for (var i = 0; i < PHASE_KEYS.length; i++) {
    if (Math.abs(table[PHASE_KEYS[i]]) >= 1) return true;
  }
  return false;
}

// brightnessctl percentages are linear in PWM duty, not in perceived
// brightness. The percentage stays the unit everywhere the user can see it
// (it has to match the OSD and the brightness keys), but interpolation happens
// here so a ramp reads as even rather than crawling at the top and lurching at
// the bottom.
function perceptualToLinear(percent) {
  var p = clamp(Number(percent) || 0, 0, 100) / 100;
  return Math.round(Math.pow(p, 2.2) * 100);
}

function linearToPerceptual(percent) {
  var p = clamp(Number(percent) || 0, 0, 100) / 100;
  return Math.round(Math.pow(p, 1 / 2.2) * 100);
}
