import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "lib/Status.js" as Status

// Bar widget and popup. A pure view onto the singleton service — every bar
// surface (one per monitor) reads the same state, so a second display cannot
// start a second controller.
//
// The bar icon carries the whole feature, the way the first-party toggles do:
// press to turn it on or off, scroll to adjust. The popup is on the right
// button, and holds no control the icon does not — just the reason the screen
// looks the way it does, and a way to undo what the plugin has learned.
//
// This is the third pass. The first was three stat cards, a toggle, two curve
// anchors and a sensor strength — a readout of the controller's internals,
// built because it was useful to the person writing the controller. The second
// cut that to a toggle and an offset slider. The slider is gone now too:
// scrolling the icon does the same job in the place the user is already
// looking, and unlike a slider it knows which time of day it is being asked
// about. The curve anchors and sensor strength still exist as settings in
// shell.json for anyone who wants them.
Panel {
  id: root
  moduleName: "kokd.sundial"
  ipcTarget: "kokd.sundial"

  readonly property var backend: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null
  readonly property bool automatic: backend ? backend.automatic : false
  readonly property bool hasSensor: backend ? backend.hasSensor : false
  readonly property string phaseKey: backend ? backend.phaseKey : ""
  readonly property real learnedOffset: backend ? backend.learnedOffset : 0
  readonly property bool hasLearned: backend ? backend.hasLearned : false
  property real wheelAccumulator: 0
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
    hasSensor: root.hasSensor,
    phaseKey: root.phaseKey,
    learnedOffset: root.learnedOffset,
    ambientActive: root.ambientActive,
    ambientDelta: root.ambientDelta
  })

  property var persistQueue: []

  function persistSetting(key, value) {
    persistQueue.push([key, value])
    runPersistQueue()
  }

  function showBrightnessOsd(percent) {
    if (!bar || !bar.shell) return
    bar.shell.summon("omarchy.osd", JSON.stringify({ icon: "brightness", value: percent }))
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

    // Two states now, matching the house style set by the first-party toggles
    // (Night Light, DND, Stay Awake), which set useActiveColor: false and
    // dimmed: !active so that off reads as dimmed and never as the accent:
    //
    //   off                 dimmed, plain colour
    //   on                  full, plain colour
    //
    // There was a third — the accent for an active manual override — which is
    // gone with the override itself. Nothing about this plugin is urgent, and
    // the accent is reserved for things that are (recording, alerts).
    dimmed: !root.automatic
    tooltipText: root.automatic
      ? "Sundial · " + root.current + "% · " + root.phase
        + " (sun " + root.elevationText + ")"
        + "\nScroll to adjust · right-click for details"
      : "Sundial paused\nClick to resume"

    // Left is the feature, which is the same bargain the rest of the row makes:
    // one press does the thing, and the popup is somewhere else. An earlier
    // version had these the other way round, so the common action was buried
    // behind a panel and the rare one was a click away.
    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton)
        root.toggle()
      else
        root.persistSetting("automatic", !root.automatic)
    }

    // Five points a notch, matching the first-party Monitor widget, so the
    // scroll behaves the same over either icon. It teaches as it goes: what
    // this sets becomes the preference for this time of day.
    onWheelMoved: function(delta) {
      if (!root.backend) return
      var wheel = Util.wheelSteps(root.wheelAccumulator, delta)
      root.wheelAccumulator = wheel.remainder
      if (wheel.steps === 0) return
      root.backend.nudge(wheel.steps * 5)
      root.showBrightnessOsd(root.backend.nudgeIntent >= 0
        ? root.backend.nudgeIntent : root.current)
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
            text: "Sundial"
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

        // Offered only when there is something to undo. Learning that cannot
        // be inspected or reversed is the thing people mean when they call an
        // adaptive backlight haunted; the status sentence above names what was
        // learned, and this takes it back.
        Button {
          visible: root.hasLearned
          enabled: root.backend !== null
          width: parent.width
          text: "Forget what I taught it"
          iconText: "󰑐"
          foreground: root.barForeground
          fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
          bordered: true
          onClicked: if (root.backend) root.backend.forget()
        }
      }
    }
  }
}
