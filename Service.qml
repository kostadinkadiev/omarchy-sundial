import QtQuick
import Quickshell
import Quickshell.Io
import "lib/Solar.js" as Solar
import "lib/Curve.js" as Curve
import "lib/Sensor.js" as Sensor

// Singleton backend. Owns the control loop, the hardware handles, and the
// settings read out of shell.json; the bar widget is a pure view onto it.
//
// The whole loop lives here in QML rather than in a child process on purpose.
// Current and maximum backlight are plain sysfs files and the sensor is one
// more, so a tick costs three FileView reads and no fork. A subprocess is
// spawned only when the brightness actually needs to change, which the
// deadband makes rare — the steady state is zero processes, which matters on
// a laptop that runs this for eight hours on battery.
Item {
  id: root
  visible: false

  // Injected by omarchy-shell's service loader.
  property var shell: null
  property var manifest: null

  readonly property string pluginId: manifest ? String(manifest.id) : "kokd.adaptive-brightness"

  // ------------------------------------------------------------- settings
  property bool automatic: true
  property int dayBrightness: 85
  property int nightBrightness: 25
  property int ambientGain: 0
  property int offsetPercent: 0
  property bool settingsReady: false

  // ---------------------------------------------------------- live state
  property real latitude: NaN
  property real longitude: NaN
  property string locationName: ""
  property real elevation: NaN
  readonly property string phase: Solar.phase(elevation)

  property string backlightDevice: ""
  property int maxRaw: 0
  property int currentRaw: -1
  property int lastWrittenRaw: -1
  readonly property int current: Sensor.percentFromRaw(currentRaw, maxRaw) === null
    ? 0 : Sensor.percentFromRaw(currentRaw, maxRaw)

  property string sensorPath: ""
  property string sensorKind: "none"
  property real sensorScale: 1
  property real sensorOffset: 0
  readonly property bool hasSensor: sensorPath !== "" && sensorKind !== "none"
  property var lux: null
  property var luxSamples: []

  property int target: 0
  property bool manualOverride: false
  property int overrideTarget: 0
  property bool probeReady: false
  property string error: ""

  readonly property int deadband: 3
  readonly property int sampleWindow: 5
  readonly property int resumeThreshold: 15

  // ------------------------------------------------------------- settings
  //
  // Settings live inline on the widget's entry in shell.json, per the shell's
  // storage rules; there is no separate config file to keep in sync.
  function currentSettings() {
    var config = shell ? shell.barConfig : null
    var layout = config && config.layout ? config.layout : null
    if (!layout) return ({})

    var sections = ["left", "center", "right"]
    for (var s = 0; s < sections.length; s++) {
      var entries = layout[sections[s]]
      if (!Array.isArray(entries)) continue
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i]
        var id = typeof entry === "object" && entry !== null ? entry.id : entry
        if (String(id || "") === pluginId)
          return typeof entry === "object" && entry !== null ? entry : ({})
      }
    }
    return ({})
  }

  function clampSetting(value, minimum, maximum, fallback) {
    var number = Math.round(Number(value))
    if (!isFinite(number)) number = fallback
    return Math.max(minimum, Math.min(maximum, number))
  }

  function applySettings() {
    if (!shell) return
    var settings = currentSettings()
    automatic = settings.automatic === undefined ? true : settings.automatic === true
    dayBrightness = clampSetting(settings.dayBrightness, 10, 100, 85)
    nightBrightness = clampSetting(settings.nightBrightness, 1, 100, 25)
    ambientGain = clampSetting(settings.ambientGain, 0, 60, 0)
    offsetPercent = clampSetting(settings.offsetPercent, -30, 30, 0)
    settingsReady = true
    evaluate()
  }

  function curveSettings() {
    return {
      dayBrightness: dayBrightness,
      nightBrightness: nightBrightness,
      ambientGain: ambientGain,
      offsetPercent: offsetPercent,
      minBrightness: 5,
      maxBrightness: 100
    }
  }

  // ------------------------------------------------------------ the loop
  function updateElevation() {
    elevation = Solar.elevation(new Date(), latitude, longitude)
  }

  function applyLux(rawText) {
    var value = Sensor.luxFromReading(rawText, sensorKind, sensorScale, sensorOffset)
    if (value === null) return
    var samples = luxSamples.slice()
    samples.push(value)
    while (samples.length > sampleWindow) samples.shift()
    luxSamples = samples
    lux = Curve.median(samples)
  }

  function evaluate() {
    if (!settingsReady || !probeReady) return

    target = Curve.target(elevation, ambientGain > 0 ? lux : null, curveSettings())

    // A manual override stands until the schedule has moved somewhere clearly
    // different from where the user made it — otherwise every override would
    // be undone within the minute, and pinning it forever would mean one
    // evening tap disables the plugin until reboot.
    if (manualOverride) {
      if (Math.abs(target - overrideTarget) < resumeThreshold) return
      resume()
    }

    if (!automatic) return

    // No location means no schedule. The curve's own fallback is daytime
    // brightness, which is the right answer for a missing reading mid-run but
    // exactly the wrong thing to act on at startup — an unconfigured machine
    // would have its backlight driven up to `dayBrightness` for no reason.
    // Nothing is written until there is a real sun angle to write from.
    if (!isFinite(elevation)) return

    if (currentRaw < 0 || maxRaw <= 0) return
    if (Curve.withinDeadband(current, target, deadband)) return

    var next = Curve.slewToward(current, target, Curve.stepLimit(current, target))
    write(next)
  }

  function write(percent) {
    if (writeProcess.running || maxRaw <= 0 || backlightDevice === "") return
    // Written as a raw value rather than a percentage so the number that lands
    // in sysfs is exactly the number compared against on the next read —
    // brightnessctl's own rounding would otherwise look like a manual change.
    var raw = Math.max(1, Math.min(maxRaw, Math.round((percent * maxRaw) / 100)))
    lastWrittenRaw = raw
    writeProcess.command = ["brightnessctl", "-d", backlightDevice, "-q", "set", String(raw)]
    writeProcess.running = true
  }

  function noteBacklight(rawText) {
    var raw = Math.round(Number(String(rawText).trim()))
    if (!isFinite(raw)) return

    // Anything that moved the backlight other than this plugin is the user,
    // reaching for the brightness keys. Comparing against the last value
    // written here detects that exactly, with no polling race and no
    // threshold to tune.
    if (lastWrittenRaw >= 0 && raw !== lastWrittenRaw && !writeProcess.running && !manualOverride) {
      manualOverride = true
      overrideTarget = target
    }

    currentRaw = raw
    if (lastWrittenRaw < 0) lastWrittenRaw = raw
  }

  function resume() {
    manualOverride = false
    lastWrittenRaw = currentRaw
  }

  function tick() {
    updateElevation()
    if (hasSensor) sensorFile.reload()
    backlightFile.reload()
    evaluate()
  }

  // -------------------------------------------------------------- sources
  Process {
    id: probeProcess
    command: [Qt.resolvedUrl("bin/ab-probe").toString().replace(/^file:\/\//, "")]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var probe = Sensor.parseProbe(text)
        root.backlightDevice = probe.backlightDevice
        root.maxRaw = probe.maxRaw
        root.sensorPath = probe.sensorPath
        root.sensorKind = probe.sensorKind
        root.sensorScale = probe.sensorScale
        root.sensorOffset = probe.sensorOffset
        root.error = probe.error
        root.probeReady = true
        root.tick()
      }
    }
  }

  Process { id: writeProcess }

  FileView {
    id: backlightFile
    path: root.backlightDevice === "" ? "" : "/sys/class/backlight/" + root.backlightDevice + "/brightness"
    printErrors: false
    onLoaded: root.noteBacklight(text())
  }

  FileView {
    id: sensorFile
    path: root.sensorPath
    printErrors: false
    onLoaded: root.applyLux(text())
  }

  // Location for the solar curve, reusing the location the weather widget
  // already owns rather than asking for it twice. Absent means the curve
  // cannot run, and the widget says so.
  FileView {
    id: locationFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        var data = JSON.parse(String(text() || "{}"))
        root.latitude = parseFloat(data.latitude)
        root.longitude = parseFloat(data.longitude)
        root.locationName = String(data.name || "")
      } catch (parseError) {
        root.latitude = NaN
        root.longitude = NaN
      }
      root.tick()
    }
    onLoadFailed: {
      root.latitude = NaN
      root.longitude = NaN
    }
  }

  // Two cadences: the sensor needs a few seconds to track a room, the sun
  // needs nothing like that. Polling the sun every two seconds would be pure
  // wakeups for a value that moves a quarter of a degree per minute.
  Timer {
    interval: root.hasSensor ? 2000 : 60000
    running: root.probeReady
    repeat: true
    triggeredOnStart: true
    onTriggered: root.tick()
  }

  onShellChanged: if (shell) Qt.callLater(applySettings)

  Connections {
    target: root.shell
    function onBarConfigChanged() { root.applySettings() }
  }

  Component.onCompleted: probeProcess.running = true

  IpcHandler {
    target: "adaptive-brightness"

    function status(): string {
      return JSON.stringify({
        automatic: root.automatic,
        elevation: isFinite(root.elevation) ? Math.round(root.elevation * 100) / 100 : null,
        phase: root.phase,
        location: root.locationName,
        lux: root.lux,
        sensor: root.sensorKind,
        current: root.current,
        target: root.target,
        manualOverride: root.manualOverride,
        ambientGain: root.ambientGain,
        offsetPercent: root.offsetPercent,
        error: root.error
      })
    }

    function refresh(): void { root.tick() }

    function resume(): string {
      root.resume()
      return "resumed"
    }
  }
}
