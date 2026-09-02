// The one sentence the panel leads with.
//
// This replaces a row of stat cards that reported elevation in degrees, raw
// lux, and a target percentage. That is instrumentation: it tells you what the
// controller measured, not what it decided or why. A user opening a brightness
// panel is asking one question — "why is my screen like this?" — and the answer
// is a sentence, not a dashboard.
//
// Pure, so the phrasing is testable without a shell.

// How far the room has to sit from the sun's expectation before it is worth
// mentioning. Below this the correction exists but is not what a person would
// call "dark" or "bright", and claiming otherwise reads as noise.
var NOTABLE_DELTA = 0.08;

function sentence(state) {
  var s = state || {};

  if (!s.hasLocation) {
    return s.locationError
      ? "Could not work out where you are (" + s.locationError + "), so there is no sun to follow."
      : "No location yet, so there is no sun to follow.";
  }

  if (!s.automatic) return "Paused. Your brightness stays wherever you put it.";

  if (s.manualOverride) {
    return "You set this by hand, so the schedule is waiting. "
      + "It takes over again once the light changes enough.";
  }

  var where = s.locationName ? " in " + s.locationName : "";
  var lead = "Following the sun" + where + ".";

  if (!s.hasSensor || !s.ambientActive) return lead;

  var delta = Number(s.ambientDelta) || 0;
  if (delta <= -NOTABLE_DELTA) return lead + " Your room is dark, so it's dimmer than usual.";
  if (delta >= NOTABLE_DELTA) return lead + " Your room is bright, so it's brighter than usual.";
  return lead + " Your room is about as light as expected.";
}
