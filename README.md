# Adaptive Brightness for Omarchy

Display brightness that follows the sun, and the room.

Most auto-brightness implementations pick one input and live with its failure
mode. A clock-driven schedule is wrong every time the season or your longitude
changes. A sensor-driven controller chases every shadow that crosses the bezel.
This one uses **solar elevation as the baseline and the ambient light sensor as
a correction on top of it**, which means it degrades gracefully in both
directions: cover the sensor and you still get a sensible schedule; sit in a
dark room at noon and it still dims.

It works on machines with no light sensor at all — including desktops — because
the sun curve is the whole schedule there.

## Requirements

- Omarchy 4.0 or newer (the `omarchy-shell` plugin host).
- `brightnessctl` and `jq`, both shipped with Omarchy.
- A location. If you have already set one for the weather widget this plugin
  reuses it; otherwise it works one out from your IP address and caches it, so
  there is nothing to configure. To pin it by hand:
  `omarchy-weather-location --set "Skopje" 41.9961,21.4317`
- Optionally an ambient light sensor. Run `bin/ab-probe` to see whether your
  machine has one this plugin can read; if it does, room-light correction is on
  by default.

## Install

```sh
omarchy plugin add https://github.com/kostadinkadiev/omarchy-adaptive-brightness.git --enable
```

The repository is `omarchy-adaptive-brightness`; the plugin id is
`kokd.adaptive-brightness`. That is deliberate, not a mismatch. `omarchy plugin
add` reads the id out of the manifest and installs to
`~/.config/omarchy/plugins/<id>/`, so the repo name is only ever the thing you
paste once — every command afterwards takes the id:

```sh
omarchy plugin update kokd.adaptive-brightness
omarchy plugin remove kokd.adaptive-brightness
```

The id carries an author prefix because ids are unique across every plugin a
user has installed, and `omarchy plugin add` refuses one that is already taken.

## How it decides

**1. Solar elevation, not wall-clock time.** A low-precision NOAA solar
position algorithm turns the current instant plus your latitude and longitude
into the sun's angle above the horizon. Elevation self-corrects for season,
latitude, daylight saving, and travel — 21:00 is broad daylight in June and
long dark in December, and a clock-driven curve gets both wrong.

**2. A smoothstep across the twilight band.** Above +10° is flat daytime
brightness; below -6° (the end of civil twilight) is flat night brightness;
between them is a Hermite ease whose derivative is zero at both ends, so the
ramp has no visible knee at either edge.

**3. The sensor corrects, it does not command.**

```
target = solarBaseline(elevation)
       + gain × (measuredLuxScore − expectedLuxScore(elevation))
       + yourPreferenceOffset
```

Illuminance is normalized logarithmically, because perceived brightness is
logarithmic: 10 → 100 lux is the same perceptual step as 100 → 1000, and a
linear lux table spends most of its resolution on daylight nobody can tell
apart. `gain` defaults to 30 on a machine that has a sensor and 0 on one that does
not, so the sensor is used out of the box rather than waiting to be discovered.
It has no control in the popup — see **The panel** below.

**4. Filtering tuned for how the failure feels.** Samples are reduced with a
**median**, not a mean — one camera flash or passing headlight destroys a mean.
Response is deliberately **asymmetric**: brightening is fast, dimming is slow,
because being left in the dark when you walk into sunlight is a usability
failure while a cloud briefly dimming the room is not. A deadband stops the
plugin writing at all for changes too small to see.

**5. Manual overrides are detected exactly.** The backlight sysfs value is
compared against the last value this plugin wrote, so reaching for the
brightness keys is unambiguous — no threshold to tune, no polling race. Control
resumes once the schedule has moved somewhere clearly different from where you
set it, or immediately from the popup.

## Cost

The control loop runs in QML, not a child process. Current brightness, maximum
brightness, and the sensor are all plain sysfs files read through Quickshell's
`FileView`, so **a tick costs no fork at all**. A subprocess is spawned only
when the brightness actually has to change, which the deadband makes rare. The
hardware probe runs once, at startup.

## Hardware support

### Location

| Order | Source |
|---|---|
| 1 | `~/.local/state/omarchy/settings/weather.json`, if you have set one |
| 2 | A cached IP lookup, so an offline boot still has a schedule |
| 3 | A fresh IP lookup via wttr.in, cached for next time |

```sh
bin/ab-locate | jq
```

Nothing is written to the backlight until a location resolves, so a machine
that is offline with no cache is left alone rather than driven to a guess.

### Sensor

| Tier | Detection | Lux |
|---|---|---|
| `acpi` | device named `acpi-als`, or any `in_illuminance_input` | already lux |
| `hid`  | any IIO device with `in_illuminance_raw` | raw × `in_illuminance_scale` |
| `none` | no sensor | solar curve only |

Tier `hid` covers the Intel sensor hub found in recent Dell, Lenovo and
Framework laptops; tier `acpi` covers Intel MacBooks and older ACPI laptops.

```sh
bin/ab-probe | jq
```


## The panel

Two controls: an on/off toggle, and one **Overall** slider from dimmer to
brighter. Above them, a sentence — *"Following the sun in Skopje. Your room is
dark, so it's dimmer than usual."*

An earlier version led with three stat cards reporting sun elevation in
degrees, raw lux, and a target percentage, then offered the toggle, two curve
anchors and a three-way sensor strength. That is a readout of the controller's
internals; it existed because it was useful to the person writing the
controller. Someone opening a brightness panel is asking "why is my screen like
this, and how do I change it", and that is a sentence and a slider.

The **Overall** slider is a standing preference. The brightness keys still work
and still give a temporary override on top of it; the difference is that this
one persists. Dragging it previews the resulting brightness on the screen while
you hold it.

`dayBrightness`, `nightBrightness` and `ambientGain` remain settings — they are
simply not controls. Edit them in `shell.json` if the defaults are wrong for
you.

## Settings

Stored inline on the widget's entry in `~/.config/omarchy/shell.json`, per the
shell's storage rules. All are editable from the popup.

| Key | Default | Meaning |
|---|---|---|
| `automatic` | `true` | Adaptive control on |
| `dayBrightness` | `85` | Flat brightness with the sun up |
| `nightBrightness` | `25` | Flat brightness after civil twilight |
| `ambientGain` | sensor: `30`, none: `0` | How far room light may pull away from the sun curve |
| `offsetPercent` | `0` | A flat shift applied to the whole curve |

`offsetPercent` is the popup's **Overall** slider. The other three have no
control; they are defaults that are right for most people and editable here for
everyone else.

## IPC

```sh
omarchy-shell kokd.adaptive-brightness-backend status | jq
omarchy-shell kokd.adaptive-brightness-backend resume
omarchy-shell kokd.adaptive-brightness-backend refresh

omarchy-shell kokd.adaptive-brightness toggle    # the popup itself
```

Both targets are namespaced because IPC targets are global to the one
`omarchy-shell` process every installed plugin shares.

## Development

```sh
node test/run.js                                   # curve and solar maths
bash -n bin/ab-probe
omarchy plugin validate .
/usr/lib/qt6/bin/qmllint -I "$OMARCHY_PATH/shell" Service.qml Panel.qml
```

`qmllint` reports `Service.qml` cleanly. On `Panel.qml` it cannot resolve
`qs.Commons` / `qs.Ui` — the shell registers those under a `qs` root at runtime,
which `qmllint` has no way to reproduce — so it emits a cascade of "was not
found" warnings and one spurious inheritance cycle. Read past those; warnings
that are *not* about a missing `qs.*` type are real.

Saving `Panel.qml` hot-reloads it, so widget work needs no restart.

**`Service.qml` does not hot-reload.** The shell instantiates a `service`
plugin once and `_syncServices` skips any id already in `_services`, so neither
saving the file, nor `omarchy-shell shell rescanPlugins`, nor a full
disable/enable cycle re-creates it — the old instance keeps running, with its
old IPC targets still registered. After editing the service:

```sh
omarchy-restart-shell
```

Running stale service code while believing a change took effect is the easiest
way to lose an hour on this plugin.

## Roadmap

- Learned manual overrides: a per-lux-decade offset table so a correction in a
  given lighting condition persists, rather than merely pausing.
- Adaptive colour temperature on the same elevation curve, and True Tone-style
  white point from the colour sensor where one exists. Held back because
  `omarchy.nightlight` already owns `hyprsunset` and two writers would fight
  over it; this will require explicitly handing over.
- External monitors over DDC/CI, with coarse infrequent steps — DDC writes are
  slow and monitor EEPROMs have finite write endurance.

## Licence

MIT. Written from scratch; it shares no code with any GPL auto-brightness
plugin.
