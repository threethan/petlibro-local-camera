# Home Assistant entities

Back to the [README](../README.md).

Petlibro Local automatically publishes MQTT discovery messages so Home Assistant creates entities for every device. No configuration is required; entities appear as soon as the app connects to Mosquitto and HA's MQTT integration is enabled.

## Requirements

- The **MQTT integration** must be enabled in Home Assistant (*Settings → Devices & Services → + Add integration → MQTT*). If you already have Mosquitto set up, you likely have this.
- Both the app and HA's MQTT integration must point to the same Mosquitto broker.

## Every device

| Entity | Type | Description |
|--------|------|-------------|
| Signal Strength | Sensor (diagnostic) | WiFi RSSI in dBm |
| Firmware Version | Sensor (diagnostic) | Current firmware version string |
| Hardware Version | Sensor (diagnostic) | Hardware revision string |
| Clock Offset | Sensor (diagnostic) | Seconds the device's own clock is behind real time (negative if ahead). Petlibro Local sends a time correction on its own if this passes 30 seconds, so it normally sits near zero |

**Firmware Version and Hardware Version** only populate after a device sends its boot event, the only time it reports these, so a device that hasn't rebooted since you added it may show blank until its next power cycle or reconnect.

## One RFID Smart Feeder

| Entity | Type | Description |
|--------|------|-------------|
| Feed Now | Button | Dispenses one portion immediately |
| Open Door | Button | Opens the feeder lid on demand |
| Volume | Number (slider) | Speaker volume 0-100 |
| LED Display | Switch | Turns the feeder's LED screen on or off, like the Show display switch in the app. It is the setting; with a custom LED Display hours window the screen can still be dark outside that window while this is on |
| Display Text | Text | Scrolling text shown on the feeder's LED screen (up to 20 characters) |
| Display Icon | Select | Built-in icons (Heart, Dog, Cat, Elk, Petlibro Salute) plus any icons you saved in the Icon Editor. Choosing No icon goes back to your saved text |
| Display Animation | Select | No animation, the built-in animations, and the animations you saved in the animation editor. Choosing one plays it on the LED screen; No animation stops it and shows your saved text again |
| Food Door | Binary Sensor | Open/closed state of the feeder lid |
| Battery | Sensor | Backup battery charge in percent |
| On AC Power | Binary Sensor | Whether the feeder is on mains power |
| Last Fed | Sensor | Timestamp of the last dispense or detected eating session |
| Last Eating Duration | Sensor | Duration in seconds of the last qualifying feeder door session, RFID or manual |
| Next Meal | Sensor (diagnostic) | Timestamp of the next enabled scheduled feeding. Goes to unknown when there is none (schedules paused, or every plan disabled or deleted) |
| Desiccant Days Remaining | Sensor (diagnostic) | Days until desiccant replacement is due |

**Last Fed** updates automatically when food is dispensed, and also when the feeder door closes after being open for at least the minimum eating duration. That threshold defaults to 30 seconds and is adjustable per device in Edit Device → Minimum Eating Duration.

**Next Meal** reflects the next enabled plan from the feeding schedule, skipping a plan that is skipped, and is recalculated on every device heartbeat. It counts only plans that are running, so pausing all schedules clears it.

**Display Icon and Display Animation** show the last thing sent from this app. If you also change the display in the Petlibro app, these entities cannot know, since the feeder does not report which icon or animation is on screen. An unsaved drawing sent from the Icon Editor shows as No icon, because it is not one of the select's options. Save it as an icon to make it selectable.

Display hours, sound hours and the schedule pause and skip controls are in the app's web UI only; they are not Home Assistant entities yet.

## Granary and Smart Camera Feeders

The Smart Camera Feeder exposes the Granary entities except Buttons Lock; its commands use the `PLAF203` MQTT model instead of `PLAF103`.

| Entity | Type | Description |
|--------|------|-------------|
| Feed Now | Button | Dispenses one portion immediately |
| Volume | Number (slider) | Speaker volume 0-100 |
| Light | Switch | The feeder's indicator light |
| Buttons Lock | Switch (config) | Locks the feeder's physical buttons (Granary only) |
| Battery | Sensor | Battery charge in percent |
| Last Fed | Sensor | Timestamp of the last dispense |
| Next Meal | Sensor (diagnostic) | Timestamp of the next enabled scheduled feeding |
| Desiccant Days Remaining | Sensor (diagnostic) | Days until desiccant replacement is due |

The PLAF203 Smart Camera Feeder creates a snapshot **Camera** entity that receives a fresh JPEG at the configured interval while snapshot capture is enabled in Settings and the feeder reports both `cameraSwitch` and `enableCamera` as on. In the web UI's Camera tab, enable **Live Camera in Home Assistant** to add a separate stream-capable camera entity; turn it off to remove that entity. The Petlibro Local - Live Camera Bridge custom integration must be installed and added to Home Assistant once. The toggle controls a go2rtc RTSP source reachable from Home Assistant's Supervisor network.

## Fountains (Dockstream 2 and the other fountain models)

| Entity | Type | Description |
|--------|------|-------------|
| Pump | Switch | Pump on/off (waterStopSwitch, inverted) |
| Light | Switch | LED ring light on/off |
| Water Level | Sensor | Current water level in mL |
| Last Drink | Sensor (diagnostic) | Timestamp of the last detected drink |
| Filter Days Remaining | Sensor (diagnostic) | Days until filter replacement is due |
| Battery | Sensor | Battery percentage (Cordless model only) |

The Dockstream RFID Smart Fountain additionally reports which pet's RFID tag was present during a drink, logged and attributed to that pet in its Recent Activity the same way the One RFID Smart Feeder attributes eating sessions.

## Automations and voice assistants

Because the entities appear in HA like any other integration, they work everywhere HA does:

- **Alexa / Google Home**: expose the Feed Now button or Pump switch via your preferred voice assistant integration
- **Automations**: trigger a feeding when motion is detected near the feeder, alert when water level drops below a threshold, or turn the pump off overnight
- **Dashboards**: add any entity to a Lovelace card
- **History**: all sensor values are tracked in HA's history and statistics

Entity IDs are stable and based on the device serial number, so they survive device renames and room reassignments.

**Example: play an animation from an automation.** Use the standard `select.select_option` action on the Display Animation entity (its entity ID starts with your device's name), with the animation's name as the option:

```yaml
action: select.select_option
target:
  entity_id: select.your_feeder_display_animation
data:
  option: "Kitten chases a ball"
```

To go back to the saved text afterward, send the option `No animation`.
