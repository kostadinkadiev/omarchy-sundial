// Sun position. The plugin schedules on solar elevation rather than wall-clock
// time because elevation self-corrects for season, latitude, DST, and travel —
// 21:00 in Skopje is broad daylight in June and long dark in December, and a
// clock-driven curve gets both wrong.
//
// Low-precision NOAA/Astronomical-Almanac algorithm: about 0.01 degrees, which
// is three orders of magnitude better than this needs (the twilight band we
// interpolate across is 16 degrees wide).
//
// Pure functions, no QML imports — everything here is unit-testable with
// plain `qjsc`/`node` against `test/solar.test.js`.

var DEG = Math.PI / 180;

// Days since the J2000.0 epoch (2000-01-01 12:00 UTC), fractional.
function daysSinceJ2000(date) {
  return date.getTime() / 86400000 + 2440587.5 - 2451545.0;
}

function normalizeDegrees(value) {
  var wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

// Apparent ecliptic longitude and obliquity for the given instant.
function eclipticPosition(n) {
  var meanLongitude = normalizeDegrees(280.460 + 0.9856474 * n);
  var meanAnomaly = normalizeDegrees(357.528 + 0.9856003 * n) * DEG;
  var eclipticLongitude = (meanLongitude
    + 1.915 * Math.sin(meanAnomaly)
    + 0.020 * Math.sin(2 * meanAnomaly)) * DEG;
  var obliquity = (23.439 - 0.0000004 * n) * DEG;
  return { longitude: eclipticLongitude, obliquity: obliquity };
}

// Greenwich mean sidereal time, in hours.
function greenwichMeanSiderealTime(n) {
  var hours = (18.697374558 + 24.06570982441908 * n) % 24;
  return hours < 0 ? hours + 24 : hours;
}

// Sun elevation above the horizon, in degrees. Negative is below.
//
//   date       JS Date (any timezone; only the absolute instant matters)
//   latitude   degrees north, negative south
//   longitude  degrees east, negative west
function elevation(date, latitude, longitude) {
  var lat = Number(latitude);
  var lon = Number(longitude);
  if (!isFinite(lat) || !isFinite(lon)) return NaN;

  var n = daysSinceJ2000(date);
  var ecliptic = eclipticPosition(n);

  var declination = Math.asin(Math.sin(ecliptic.obliquity) * Math.sin(ecliptic.longitude));
  var rightAscension = Math.atan2(
    Math.cos(ecliptic.obliquity) * Math.sin(ecliptic.longitude),
    Math.cos(ecliptic.longitude)
  );

  // Local mean sidereal time, converted to degrees, minus the sun's right
  // ascension gives the hour angle.
  var localSidereal = greenwichMeanSiderealTime(n) * 15 + lon;
  var hourAngle = (localSidereal - rightAscension / DEG) * DEG;

  var latRad = lat * DEG;
  var sinElevation = Math.sin(latRad) * Math.sin(declination)
    + Math.cos(latRad) * Math.cos(declination) * Math.cos(hourAngle);

  return Math.asin(Math.max(-1, Math.min(1, sinElevation))) / DEG;
}

// Short label for the widget's stat card, which has about a third of a popup
// to work with. The precise angle is a developer's unit, not a user's — it
// belongs in the tooltip, not on the face of the panel.
function phaseShort(elevationDegrees) {
  if (!isFinite(elevationDegrees)) return "Unknown";
  if (elevationDegrees >= 10) return "Day";
  if (elevationDegrees >= 0) return "Golden";
  if (elevationDegrees >= -6) return "Dusk";
  return "Night";
}

// Coarse label for the widget, so the popup can say why it picked a target.
function phase(elevationDegrees) {
  if (!isFinite(elevationDegrees)) return "unknown";
  if (elevationDegrees >= 10) return "day";
  if (elevationDegrees >= 0) return "golden hour";
  if (elevationDegrees >= -6) return "civil twilight";
  if (elevationDegrees >= -12) return "nautical twilight";
  return "night";
}

// Stable keys for the four bands the plugin learns against, kept separate from
// phase() and phaseShort() because those are prose: they exist to be read, and
// rewording one should never silently orphan everything a user has taught the
// plugin. These strings are storage, so they never change.
//
// Four bands rather than phase()'s five: nautical twilight and night are the
// same thing to a screen. The sun is below the horizon and the room is lit by
// whatever you switched on.
function phaseKey(elevationDegrees) {
  if (!isFinite(elevationDegrees)) return "";
  if (elevationDegrees >= 10) return "day";
  if (elevationDegrees >= 0) return "golden";
  if (elevationDegrees >= -6) return "dusk";
  return "night";
}
