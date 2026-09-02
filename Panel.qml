import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui

// Bar widget and popup. A pure view onto the singleton service — every bar
// surface (one per monitor) reads the same state, so a second display cannot
// start a second controller.
Panel {
  id: root
  moduleName: "kokd.adaptive-brightness"
  ipcTarget: "kokd.adaptive-brightness"

  readonly property var backend: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null
  readonly property bool automatic: backend ? backend.automatic : false
  readonly property bool manualOverride: backend ? backend.manualOverride : false
  readonly property bool hasSensor: backend ? backend.hasSensor : false
  readonly property var lux: backend ? backend.lux : null
  readonly property int current: backend ? backend.current : 0
  readonly property int target: backend ? backend.target : 0
  readonly property real elevation: backend ? backend.elevation : NaN
  readonly property string phase: backend ? backend.phase : "unknown"
  readonly property string locationName: backend ? backend.locationName : ""
  readonly property int ambientGain: backend ? backend.ambientGain : 0
  readonly property int dayBrightness: backend ? backend.dayBrightness : 85
  readonly property int nightBrightness: backend ? backend.nightBrightness : 25
  readonly property bool hasLocation: backend ? isFinite(backend.latitude) && isFinite(backend.longitude) : false

  property var persistQueue: []

  readonly property string statusText: {
    if (!backend) return "STARTING"
    if (backend.error) return "HARDWARE UNAVAILABLE"
    if (!hasLocation) return "LOCATION NOT SET"
    if (!automatic) return "PAUSED"
    if (manualOverride) return "MANUAL OVERRIDE"
    return hasSensor && ambientGain > 0 ? "SUN + AMBIENT LIGHT" : "FOLLOWING THE SUN"
  }

  readonly property string elevationText: isFinite(elevation)
    ? (elevation >= 0 ? "+" : "") + elevation.toFixed(1) + "°"
    : "—"

  readonly property string luxText: {
    if (!hasSensor) return "No sensor"
    if (lux === null || lux === undefined) return "—"
    return lux + " lux"
  }

  function persistSetting(key, value) {
    persistQueue.push([key, value])
    runPersistQueue()
  }

  function runPersistQueue() {
    if (persistProc.running || persistQueue.length === 0 || !moduleName) return
    var item = persistQueue.shift()
    persistProc.command = [
      "omarchy-shell", "shell", "setBarWidget", moduleName,
      String(item[0]), JSON.stringify(item[1]), "{}"
    ]
    persistProc.running = true
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Process {
    id: persistProc
    stdout: StdioCollector { waitForEnd: true }
    onRunningChanged: if (!running) Qt.callLater(root.runPersistQueue)
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.automatic ? "󰃠" : "󰃞"
    // bar.active is the theme's attention colour — shell.toml reserves it for
    // "modules calling attention to themselves (recording, alerts, updates)".
    // Tracking the sun is the normal state and earns no highlight; being
    // paused, or sitting on a manual override, is worth noticing.
    active: !root.automatic || root.manualOverride
    tooltipText: root.automatic
      ? "Adaptive brightness · " + root.current + "% · " + root.phase
      : "Adaptive brightness paused"
    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton)
        root.persistSetting("automatic", !root.automatic)
      else
        root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(390))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(14)

        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight, heroPercent.implicitHeight)

          Text {
            id: heroIcon
            text: root.automatic ? "󰃠" : "󰃞"
            color: root.barForeground
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: heroPercent.left
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Adaptive brightness"
              color: root.barForeground
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              text: root.statusText
              color: Qt.darker(root.barForeground, 1.4)
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.1
              elide: Text.ElideRight
              width: parent.width
            }
          }

          Text {
            id: heroPercent
            text: root.current + "%"
            color: root.barForeground
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.displayLarge
            font.bold: true
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
          }
        }

        Row {
          width: parent.width
          spacing: Style.space(8)
          StatCard {
            width: (parent.width - parent.spacing * 2) / 3
            label: "SUN"; value: root.elevationText; detail: root.phase
          }
          StatCard {
            width: (parent.width - parent.spacing * 2) / 3
            label: "AMBIENT"; value: root.luxText
            detail: root.ambientGain > 0 ? "Correcting" : "Advisory"
          }
          StatCard {
            width: (parent.width - parent.spacing * 2) / 3
            label: "TARGET"; value: root.target + "%"
            detail: root.manualOverride ? "Waiting" : "Scheduled"
          }
        }

        Toggle {
          width: parent.width
          label: "Adaptive control"
          description: "Track the sun through the day and ease down after sunset"
          checked: root.automatic
          enabled: root.backend !== null && !persistProc.running
          foreground: root.barForeground
          onClicked: root.persistSetting("automatic", !root.automatic)
        }

        Button {
          visible: root.manualOverride && root.automatic
          enabled: root.backend !== null
          width: parent.width
          text: "Resume adaptive control"
          iconText: "󰑐"
          foreground: root.barForeground
          fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
          bordered: true
          onClicked: if (root.backend) root.backend.resume()
        }

        Text {
          visible: !root.hasLocation
          width: parent.width
          text: "No location set, so there is no sun to follow. Set one with:\n"
            + "omarchy-weather-location --set \"City\" 41.9965,21.4314"
          color: root.barForeground
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        PanelSeparator { foreground: root.barForeground }

        LabeledSlider {
          title: "DAYTIME BRIGHTNESS"
          value: root.dayBrightness
          minimum: 10
          maximum: 100
          tickCount: 10
          suffix: "%"
          enabled: root.backend !== null
          onCommitted: function(value) { root.persistSetting("dayBrightness", value) }
        }

        LabeledSlider {
          title: "NIGHT BRIGHTNESS"
          value: root.nightBrightness
          minimum: 1
          maximum: 100
          tickCount: 10
          suffix: "%"
          enabled: root.backend !== null
          onCommitted: function(value) { root.persistSetting("nightBrightness", value) }
        }

        PanelSeparator { foreground: root.barForeground }

        LabeledSlider {
          title: "AMBIENT CORRECTION"
          value: root.ambientGain
          minimum: 0
          maximum: 60
          tickCount: 7
          suffix: root.hasSensor ? "%" : " (no sensor)"
          enabled: root.backend !== null && root.hasSensor
          onCommitted: function(value) { root.persistSetting("ambientGain", value) }
        }

        Text {
          width: parent.width
          text: root.hasSensor
            ? "How far the room's measured light may pull brightness away from the sun schedule. Zero is a pure solar curve."
            : "This machine has no ambient light sensor, so the schedule follows the sun alone."
          color: Qt.darker(root.barForeground, 1.4)
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }

  component StatCard: BorderSurface {
    property string label: ""
    property string value: ""
    property string detail: ""
    implicitHeight: Style.space(72)
    radius: Style.cornerRadius
    color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, 0.07)
    borderSpec: Border.controlSpec("normal", root.barForeground, Color.accent)

    Column {
      anchors.centerIn: parent
      width: parent.width - Style.space(12)
      spacing: Style.space(2)
      Text {
        width: parent.width; text: label; color: Qt.darker(root.barForeground, 1.4)
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.caption; font.bold: true; font.letterSpacing: 1
        horizontalAlignment: Text.AlignHCenter
      }
      Text {
        width: parent.width; text: value; color: root.barForeground
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.subtitle; font.bold: true
        horizontalAlignment: Text.AlignHCenter
      }
      Text {
        width: parent.width; text: detail; color: Qt.darker(root.barForeground, 1.4)
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.caption; elide: Text.ElideRight
        horizontalAlignment: Text.AlignHCenter
      }
    }
  }

  component LabeledSlider: Column {
    id: control
    property string title: ""
    property int value: 0
    property int minimum: 0
    property int maximum: 100
    property int tickCount: 0
    property string suffix: ""
    property bool showPlus: false
    signal committed(int value)
    width: parent ? parent.width : 0
    spacing: Style.space(6)
    opacity: control.enabled ? 1 : 0.45

    Item {
      width: parent.width
      implicitHeight: Math.max(controlTitle.implicitHeight, controlValue.implicitHeight)
      PanelSectionHeader {
        id: controlTitle
        text: control.title; foreground: root.barForeground
        fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
        anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
      }
      Text {
        id: controlValue
        readonly property int shown: slider.dragging ? Math.round(slider.liveValue) : control.value
        text: (control.showPlus && shown > 0 ? "+" : "") + shown + control.suffix
        color: Qt.darker(root.barForeground, 1.4)
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.caption; font.bold: true
        anchors.right: parent.right; anchors.rightMargin: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
      }
    }

    PanelSlider {
      id: slider
      width: parent.width
      bar: root.bar
      minimum: control.minimum
      maximum: control.maximum
      step: 1
      integer: true
      tickCount: control.tickCount
      value: control.value
      enabled: control.enabled
      onReleased: function(value) { control.committed(Math.round(value)) }
    }
  }
}
