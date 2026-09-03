# Sundial

Brightness that follows the sun, on any machine.

Most auto-brightness implementations pick one input and live with its failure
mode. A clock-driven schedule is wrong every time the season or your longitude
changes. A sensor-driven controller chases every shadow that crosses the bezel.
This one uses **solar elevation as the baseline and the ambient light sensor as
a correction on top of it**, which means it degrades gracefully in both
directions: cover the sensor and you still get a sensible schedule; sit in a
dark room at noon and it still dims.

It works on machines with no light sensor at all — including desktops — because
the sun curve is the whole schedule there.

Omarchy already has ambient-light plugins, and good ones —
[brukberhane](https://github.com/brukberhane/omarchy-auto-brightness) learns
per lux bucket and drives external displays over DDC,
[realgbbb](https://github.com/realgbbb/auto-brightness) adds the keyboard
backlight and refuses to learn on principle, and
[huangzuo](https://github.com/huangzuo/macbook-auto-brightness-plugin) keeps it
small for Intel MacBooks. Each does something this does not.

What none of them have is time. All three are pure ALS and need a sensor to do
anything at all; none of them knows where the sun is. Sundial schedules on
solar elevation, so it has an opinion about your screen at 22:00 in December
whether or not your laptop can see the room — and where there is a sensor, it
refines that opinion rather than replacing it.

## Status

Version 0.1.0, and honestly early. What has actually been exercised:

- The curve and the solar maths, across a full day at one-minute resolution,
  from the equator to 60 degrees, at solstice and equinox (`test/day.js`)
- Every solar phase on real hardware, by moving the location rather than the
  clock (`test/timeshift`)
- The ambient path end to end against real readings at 0, 1, 130 and 236 lux
- Learning: taught, held, persisted, forgotten, and blended across bands

What has not:

- **The `acpi` sensor tier.** Development hardware is HID-tier, so the six
  lines that read `in_illuminance_input` have unit tests and no real device.
  If you have an Intel MacBook, you are the first.
- A dawn or dusk observed live rather than simulated. The geometry is tested;
  the geometry plus a room genuinely darkening is not.
- External monitors. Internal panel only — see Roadmap.

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
omarchy plugin add https://github.com/kostadinkadiev/omarchy-sundial.git --enable
```

The repository is `omarchy-sundial`; the plugin id is `kokd.sundial`. The
names differ on purpose. `omarchy plugin
add` reads the id out of the manifest and installs to
`~/.config/omarchy/plugins/<id>/`, so the repo name is only ever the thing you
paste once — every command afterwards takes the id:

```sh
omarchy plugin update kokd.sundial
omarchy plugin remove kokd.sundial
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

**5. Adjusting it teaches it.** There is no override to wait out. The sun's
position falls into four bands — day, golden hour, dusk, night — and each
carries its own offset from the schedule. Dimming at midnight teaches the night
and leaves the afternoon exactly where it was.

The adjustment is absorbed whole, not blended. That is the load-bearing
decision: learning only half the difference would leave the screen still moving
after you had stopped adjusting it, which is the fighting the whole design
exists to prevent. Halfway is the one setting worse than either end.

Between bands the offsets are interpolated, with the same smoothstep used
inside them. A band is a step function, and a step is precisely what the rest
of the curve avoids: applied naively, a preference taught at dusk and not at
night arrives as a cliff at the boundary — twenty points in the minute the
schedule itself moves one, which reads as the screen lurching for no reason.
`test/day.js` measures this across a whole day, which is how it was found.

Interpolating has one consequence worth stating, because it nearly undid the
paragraph above: between anchors a band is only partly in force, so a
correction filed raw would land short and leave a remainder for the loop to
chase. It is divided by that band's weight instead, which is never less than a
half, so it arrives whole.

**6. Adjustments are attributed exactly.** The backlight sysfs value is compared
against the last value this plugin wrote, so reaching for the brightness keys is
unambiguous — no threshold to tune. Two races make that harder than it sounds:
a read issued before one of our own writes can arrive after it, so reads are
stamped with a write epoch and ignored if the ground moved underneath them.
Without that the plugin learns from its own writes and drifts a little further
on every adjustment.

Because absorption is exact, there is no settle timer. Every other
implementation of this needs one — they poll a value they cannot attribute, so
they pause a few seconds and hope you have finished. Here the target lands on
your value, so there is nothing to correct and no window to wait out. Holding a
brightness key just teaches the same band repeatedly, converging wherever you
let go.

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

The bar icon is the whole feature:

| | |
|---|---|
| **Click** | on / off. Dimmed means off, exactly like Night Light and DND |
| **Right-click** | the popup |

Adjusting is the brightness keys, or the Monitor widget's scroll — both write
the backlight through `brightnessctl`, which is what this watches. There is no
control of its own for that, and briefly there was: a scroll handler on this
icon. It turned out to duplicate a gesture already sitting five icons along on
the same bar, on the widget whose actual job is brightness, and to arrive at
learning by a second path when the first cannot be removed anyway.

Hovering gives the state and the next thing the sun will do:

```
Sundial · 28% · night · sunrise 06:01
Right-click for details
```

That last field used to be the sun's elevation in degrees — `sun -23.9°` —
which is a developer's unit pretending to be information. It reads as a
temperature, and Omarchy's own weather widget sits a few icons away on the same
bar reporting one. The time is formatted to match whatever the clock is using,
12- or 24-hour.

The popup holds no control the icon does not. It answers one question —
*"Following the sun in Skopje. Your room is dark, so it's dimmer than usual.
You keep nights 12% dimmer than the schedule."* — and offers to forget what it
has learned.

This is the third pass. The first led with three stat cards reporting sun
elevation in degrees, raw lux and a target percentage, then a toggle, two curve
anchors and a three-way sensor strength: a readout of the controller's
internals, useful to the person writing the controller and to nobody else. The
second cut it to a toggle and an offset slider. The slider is gone now too —
the brightness keys already do that job, and unlike a slider they land in a
band the plugin can attribute to a time of day.

Learning that cannot be seen is what people mean when they call an adaptive
backlight haunted, so the sentence names what was learned and the button takes
it back.

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
| `learned` | all zero | Per-band offsets, written by adjusting. Not hand-edited |

`learned` is maintained by pressing the brightness keys;
the popup's Forget button clears it. The others have no
control; they are defaults that are right for most people and editable here for
everyone else.

## IPC

```sh
omarchy-shell kokd.sundial-backend status | jq
omarchy-shell kokd.sundial-backend forget     # discard what it has learned
omarchy-shell kokd.sundial-backend refresh

omarchy-shell kokd.sundial toggle    # the popup itself
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

- Learning keyed on room light as well as sun position, so a correction made
  with the blinds shut is not applied when they are open. Solar band alone was
  the right first cut because it exists on every machine, sensor or not.
- Adaptive colour temperature on the same elevation curve, and True Tone-style
  white point from the colour sensor where one exists. Held back because
  `omarchy.nightlight` already owns `hyprsunset` and two writers would fight
  over it; this will require explicitly handing over.
- External monitors over DDC/CI, with coarse infrequent steps — DDC writes are
  slow and monitor EEPROMs have finite write endurance.

## Licence

MIT. Written from scratch; it shares no code with any GPL auto-brightness
plugin.
