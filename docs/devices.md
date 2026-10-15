# Supported device notes

Back to the [README](../README.md). The table of supported devices is there; these are the details behind it.

**Granary Smart Feeder:** No RFID and no lid on this model (confirmed via a real MQTT capture, issue #8), so pet-attributed feeding and the "Open Lid"/"Food Door" features don't apply here, only the One RFID Smart Feeder has those. Has an indicator light and a "Buttons Lock" (physical button lock) the One RFID feeder doesn't.

**WF01 units:** Some Dockstream 2 boxes/units are labeled "PLWF105" rather than "PLWF106". A real MQTT capture (issue #8) confirmed a `WF01`-prefixed unit reports `PLWF106` over the wire regardless, so it's treated identically to `WF03`.

**Color variant encoding:** On the Dockstream 2, I think the serial number encodes the color variant. The characters at positions 10-11 appear to indicate color: `BD` = black, `BA` = white. If other owners of the Dockstream 2 fountains could also let me know by opening an issue.

**Dockstream RFID Smart Fountain:** A user-submitted `WF02` serial was initially assumed to be a plain Dockstream 2 (same prefix as an earlier report), but a real MQTT capture later showed it actually reports MQTT model `PLWF305`, a distinct, RFID-capable fountain. It reports which pet's tag was present during a drink (`WEIGHT_CHANGE_EVENT`), logged and attributed to that pet's activity the same way the One RFID feeder attributes eating sessions. Everything else (water level, filter, pump, light) works the same as the Dockstream 2. Serial prefix `WF02` now maps to this device type instead of the plain Dockstream 2, correcting the earlier assumption. Only a white variant is confirmed so far. If your `WF02` fountain doesn't have RFID tag support, or you have a black one, please open an issue so we can sort that out.

**Cordless fountain:** Feature-identical to the wired Dockstream 2 with the addition of battery level, charge state (Charging / Charged / Discharging), and battery percentage. MQTT model `PLWF116` is taken from the cloud HA integration. The serial prefix `WF04` and color encoding (`BD`/`BA`) are inferred by analogy with the wired model, not confirmed from a real device. If you own one, please open an issue with your serial number so we can confirm or correct these.

**One RFID Smart Feeder:** Significantly different from the fountain: RFID door, desiccant tray, feeding plan, display matrix, sound, and lid controls. Serial prefix confirmed as `AF06`, MQTT model confirmed as `PLAF301`. Color variant does not appear to be encoded at positions 10-11 the way fountain serials are. Note that Petlibro's product listing shows this device as model `PLAF103`; that's the retail box/product number and is unrelated to `PLAF301`, which is the MQTT topic model this app matches on. Serials on newer hardware revisions run a few characters longer than early units but use the same `AF06` prefix and work the same way.

**Smart Camera Feeder:** An `AF0301...` device reports product ID `PLAF203` in its MQTT topics (captured on firmware 3.0.30 / hardware 1.0.7). It supports the Granary feature set except Buttons Lock, and uses its own `camera_feeder` device type so Petlibro Local routes MQTT traffic to `PLAF203` rather than the Granary's `PLAF103`. Existing AF0301 entries saved under another type are corrected automatically.

With the feeder camera enabled, the add-on registers the `uuid` from `DEVICE_START_EVENT` with its pinned PLAF203 direct-LAN bridge. Home Assistant receives raw JPEG snapshots over MQTT approximately every five seconds. The Camera tab can also expose a separate live stream entity when enabled. No cloud camera credentials are used.

## Firmware versions I have seen

| Device | Firmware | Hardware |
|--------|----------|----------|
| One RFID Smart Feeder | 3.0.72 | 5.0.0 |
| One RFID Smart Feeder | 2.0.47 | 4.0.0 |
| Dockstream 2 Smart Fountain | 0.0.34 | 1.0.0 |

I don't have a firmware version for the Granary, the cordless fountain, or the RFID fountain. If yours shows a different one (it's at the top of the device's modal), please [open an issue](https://github.com/smcneece/petlibro-local/issues) and tell me, since newer firmware may behave differently.

## Adding a new device type

Additional devices can be added by contributing a device type entry, the MQTT model string (the topic prefix after `dl/`), and the serial number prefix used for auto-detection during capture. The MQTT topic structure is consistent across the Petlibro product line.
