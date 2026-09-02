// Ambient light sensor plumbing, kept as pure functions so the hardware tiers
// this plugin claims to support can be tested without owning the hardware.
//
// Three tiers, because a community plugin cannot assume one laptop:
//
//   acpi   Intel MacBooks and older ACPI laptops. Device named `acpi-als`,
//          exposes `in_illuminance_input`, already scaled to lux.
//   hid    Intel HID sensor hub (recent Dell / Lenovo / Framework). Device
//          named `als`, exposes `in_illuminance_raw` plus `in_illuminance_scale`;
//          lux is the product of the two.
//   none   Desktops and most laptops. No sensor, no problem — the solar
//          baseline is the whole schedule.
//
// The existing community plugin only ever matches the first tier, which is why
// it spins forever on anything that is not a MacBook.

function luxFromReading(raw, kind, scale, offset) {
  var value = Number(String(raw).trim());
  if (!isFinite(value)) return null;
  if (kind === "acpi") return Math.max(0, Math.round(value));
  var s = Number(scale);
  var o = Number(offset) || 0;
  if (!isFinite(s) || s === 0) s = 1;
  return Math.max(0, Math.round((value + o) * s));
}

// Parse one JSON line from bin/ab-probe into the shape Service.qml holds.
function parseProbe(raw) {
  var empty = {
    backlightDevice: "",
    maxRaw: 0,
    sensorPath: "",
    sensorKind: "none",
    sensorScale: 1,
    sensorOffset: 0,
    error: ""
  };
  try {
    var data = JSON.parse(String(raw || ""));
    if (!data || typeof data !== "object") return empty;
    var backlight = data.backlight || {};
    var sensor = data.sensor || {};
    return {
      backlightDevice: String(backlight.device || ""),
      maxRaw: Math.max(0, Math.round(Number(backlight.max) || 0)),
      sensorPath: String(sensor.path || ""),
      sensorKind: String(sensor.kind || "none"),
      sensorScale: isFinite(Number(sensor.scale)) ? Number(sensor.scale) : 1,
      sensorOffset: isFinite(Number(sensor.offset)) ? Number(sensor.offset) : 0,
      error: String(data.error || "")
    };
  } catch (parseError) {
    empty.error = "unreadable probe output";
    return empty;
  }
}

// Human label for the popup. Thresholds follow the usual illuminance bands.
function lightName(lux) {
  if (lux === null || lux === undefined) return "No sensor";
  if (lux <= 0) return "Dark";
  if (lux < 20) return "Very dim";
  if (lux < 100) return "Indoor";
  if (lux < 400) return "Bright room";
  if (lux < 1000) return "Daylight";
  return "Strong daylight";
}

function percentFromRaw(rawValue, maxRaw) {
  var value = Number(rawValue);
  var max = Number(maxRaw);
  if (!isFinite(value) || !isFinite(max) || max <= 0) return null;
  return Math.round((value * 100) / max);
}
