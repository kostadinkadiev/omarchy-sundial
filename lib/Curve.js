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
function luxScore(lux, luxCeiling) {
  var ceiling = luxCeiling === undefined ? 10000 : luxCeiling;
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
  return Math.round(clamp(blended + (Number(s.offsetPercent) || 0), floor, ceiling));
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
