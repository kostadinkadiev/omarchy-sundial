import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "lib/Status.js" as Status

// Bar widget and popup. A pure view onto the singleton service — every bar
// surface (one per monitor) reads the same state, so a second display cannot
// start a second controller.
//
// Two controls, deliberately. An earlier version led with three stat cards
// reporting sun elevation, raw lux, and a target percentage, then offered a
// toggle, two curve anchors and a three-way sensor strength. That is a readout
// of the controller's internals, and it was built because it was useful to the
// person writing the controller. Someone opening a brightness panel is asking
// "why is my screen like this, and how do I change it" — which is a sentence
// and a slider. The curve anchors and sensor strength still exist as settings
// in shell.json for anyone who wants them.
Panel {
  id: root
  moduleName: "kokd.daylight"
  ipcTarget: "kokd.daylight"

  readonly property var backend: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null
  readonly property bool automatic: backend ? backend.automatic : false
  readonly property bool manualOverride: backend ? backend.manualOverride : false
  readonly property bool hasSensor: backend ? backend.hasSensor : false
  readonly property bool ambientActive: backend ? backend.ambientActive : false
  readonly property real ambientDelta: backend ? backend.ambientDelta : 0
  readonly property int current: backend ? backend.current : 0
  readonly property int offsetPercent: backend ? backend.offsetPercent : 0
  readonly property real elevation: backend ? backend.elevation : NaN
  readonly property string phase: backend ? backend.phase : "unknown"
  readonly property string locationName: backend ? backend.locationName : ""
  readonly property string locationError: backend ? backend.locationError : ""
  readonly property bool hasLocation: backend
    ? isFinite(backend.latitude) && isFinite(backend.longitude) : false

  readonly property string elevationText: isFinite(elevation)
    ? (elevation >= 0 ? "+" : "") + elevation.toFixed(1) + "°"
    : "—"

  readonly property string statusSentence: Status.sentence({
    hasLocation: root.hasLocation,
    locationError: root.locationError,
    locationName: root.locationName,
    automatic: root.automatic,
    manualOverride: root.manualOverride,
    hasSensor: root.hasSensor,
    ambientActive: root.ambientActive,
    ambientDelta: root.ambientDelta
  })

  property var persistQueue: []

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
      ? "Daylight · " + root.current + "% · " + root.phase
        + " (sun " + root.elevationText + ")"
      : "Daylight paused"
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
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(420))

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
          implicitHeight: Math.max(heroIcon.implicitHeight, heroTitle.implicitHeight, heroPercent.implicitHeight)

          Text {
            id: heroIcon
            text: root.automatic ? "󰃠" : "󰃞"
            color: root.barForeground
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Text {
            id: heroTitle
            text: "Daylight"
            color: root.barForeground
            font.family: root.bar ? root.bar.fontFamily : Style.font.family
            font.pixelSize: Style.font.title
            font.bold: true
            elide: Text.ElideRight
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: heroPercent.left
            anchors.rightMargin: Style.space(12)
            anchors.verticalCenter: parent.verticalCenter
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

        // The whole readout, in one line of English.
        Text {
          width: parent.width
          text: root.statusSentence
          color: Qt.darker(root.barForeground, 1.4)
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
        }

        // Shown only when there is something to do about it.
        Text {
          visible: !root.hasLocation
          width: parent.width
          text: "omarchy-weather-location --set \"City\" 41.9965,21.4314"
          color: Qt.darker(root.barForeground, 1.4)
          font.family: root.bar ? root.bar.fontFamily : Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.WrapAnywhere
        }

        Toggle {
          width: parent.width
          label: "Adjust automatically"
          checked: root.automatic
          enabled: root.backend !== null && !persistProc.running
          foreground: root.barForeground
          onClicked: root.persistSetting("automatic", !root.automatic)
        }

        Button {
          visible: root.manualOverride && root.automatic
          enabled: root.backend !== null
          width: parent.width
          text: "Resume automatic control"
          iconText: "󰑐"
          foreground: root.barForeground
          fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
          bordered: true
          onClicked: if (root.backend) root.backend.resume()
        }

        PanelSeparator { foreground: root.barForeground }

        // One standing preference. The brightness keys still give a temporary
        // override on top of this; the difference is that this one persists.
        Column {
          width: parent.width
          spacing: Style.space(6)

          Item {
            width: parent.width
            implicitHeight: Math.max(offsetTitle.implicitHeight, offsetValue.implicitHeight)
            PanelSectionHeader {
              id: offsetTitle
              text: "OVERALL"
              foreground: root.barForeground
              fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
            }
            Text {
              id: offsetValue
              readonly property int shown: offsetSlider.dragging
                ? Math.round(offsetSlider.liveValue) : root.offsetPercent
              text: (shown > 0 ? "+" : "") + shown + "%"
              color: Qt.darker(root.barForeground, 1.4)
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
              anchors.right: parent.right
              anchors.rightMargin: Style.space(6)
              anchors.verticalCenter: parent.verticalCenter
            }
          }

          PanelSlider {
            id: offsetSlider
            width: parent.width
            bar: root.bar
            minimum: -30
            maximum: 30
            step: 1
            integer: true
            tickCount: 7
            value: root.offsetPercent
            enabled: root.backend !== null
            // Dragging shows the brightness the offset produces, so the control
            // demonstrates its own effect instead of describing it.
            onMoved: function(value) {
              if (root.backend) root.backend.previewOffset(Math.round(value))
            }
            onReleased: function(value) {
              root.persistSetting("offsetPercent", Math.round(value))
              if (root.backend) root.backend.endPreview()
            }
          }

          Item {
            width: parent.width
            implicitHeight: dimmerLabel.implicitHeight
            Text {
              id: dimmerLabel
              text: "Dimmer"
              color: Qt.darker(root.barForeground, 1.4)
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
              anchors.left: parent.left
            }
            Text {
              text: "Brighter"
              color: Qt.darker(root.barForeground, 1.4)
              font.family: root.bar ? root.bar.fontFamily : Style.font.family
              font.pixelSize: Style.font.caption
              anchors.right: parent.right
            }
          }
        }
      }
    }
  }
}
