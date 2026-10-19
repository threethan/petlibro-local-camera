"""Petlibro 1.3.70 BLE provisioning, recovered from the ARM64 Dart snapshot.

Uses the HA host's BlueZ adapter through D-Bus, never the browser's radio.
See docs/device-provisioning.md for evidence and hardware-validation limits.
"""

import asyncio
import ipaddress
import logging
import re
import traceback

SERVICE = "0000ffee-0000-1000-8000-00805f9b34fb"
WRITE = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY = "0000ffe2-0000-1000-8000-00805f9b34fb"
NOTIFY_TIMEOUT = 15
ACK_TIMEOUT = 45
PLAF203_SETUP_TIMEOUT = 120
RECONNECT_DELAY = 2
POLL_INTERVAL = 1
READ_TIMEOUT = 5
ACCOUNT_ID = "123456789"
_LOGGER = logging.getLogger(__name__)


class ProvisioningError(Exception):
    """A safe, credential-free error suitable for the UI."""


class _Reconnect(Exception):
    """A PLAF203 transport interruption, not a device rejection."""


def _is_plaf203(device):
    return (getattr(device, "name", None) or "").strip().upper().startswith("PLAF203")


def _bleak():
    try:
        from bleak import BleakClient, BleakScanner
    except ImportError:
        raise ProvisioningError("Bluetooth support is unavailable. Rebuild the add-on.") from None
    return BleakClient, BleakScanner


def packet(command, *fields):
    encoded = [field.encode("utf-8") for field in fields]
    if any(len(value) > 255 for value in encoded):
        raise ValueError("Provisioning values exceed the protocol's byte limit.")
    payload = b"".join(bytes([len(value)]) + value for value in encoded)
    if len(payload) > 255:
        raise ValueError("Provisioning values exceed the protocol's byte limit.")
    return b"DL" + bytes([command, 0, 0, len(payload)]) + payload + b"\xff"


def validate(data):
    if not isinstance(data, dict):
        raise ValueError("Expected provisioning settings.")
    values = {key: data.get(key, "") for key in ("address", "ssid", "password", "broker_ip")}
    # Firmware requires a nonempty account field, even for local-only setup.
    values["owner_id"] = ACCOUNT_ID
    if not all(isinstance(value, str) for value in values.values()):
        raise ValueError("Provisioning settings must be text.")
    if not re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", values["address"]):
        raise ValueError("Select a discovered Bluetooth device.")
    values["address"] = values["address"].upper()
    if not 1 <= len(values["ssid"].encode("utf-8")) <= 32:
        raise ValueError("Wi-Fi name must contain 1–32 UTF-8 bytes.")
    password = values["password"]
    if password and not (8 <= len(password.encode("utf-8")) <= 63 or re.fullmatch(r"[0-9a-fA-F]{64}", password)):
        raise ValueError("Wi-Fi password must be 8–63 bytes or a 64-digit hex key; leave empty for an open network.")
    try:
        address = ipaddress.IPv4Address(values["broker_ip"])
    except ipaddress.AddressValueError:
        raise ValueError("Enter Home Assistant's LAN IPv4 address.") from None
    if address.is_loopback or address.is_unspecified or address.is_multicast or address.is_reserved or address.is_link_local:
        raise ValueError("Enter Home Assistant's reachable LAN IPv4 address.")
    packet(1, values["ssid"], password)
    packet(2, f"{address}:1883", values["owner_id"])
    return values


async def scan():
    _, scanner = _bleak()
    try:
        found = await scanner.discover(timeout=8, return_adv=True)
    except Exception:
        raise ProvisioningError("Cannot scan Bluetooth. Check that the HA host has a powered local adapter and host D-Bus access.") from None
    return {
        device.address.upper(): (device, {
            "address": device.address.upper(),
            "name": adv.local_name or device.name or "Petlibro device",
            "rssi": adv.rssi,
        })
        for device, adv in found.values()
        if SERVICE in [value.lower() for value in adv.service_uuids]
        or re.match(r"(?:PL(?:AF|WF|LS)\d|PETLIBRO)", adv.local_name or device.name or "", re.I)
    }


async def provision(device, settings, progress):
    if not _is_plaf203(device):
        return await _provision_session(device, settings, progress)
    # The app reconnects after two seconds and invokes the original Wi-Fi
    # write callback again. Keep one deadline across all connections/replies.
    last_interruption = ""
    reconnect = False
    try:
        async with asyncio.timeout(PLAF203_SETUP_TIMEOUT):
            while True:
                try:
                    if reconnect:
                        _, scanner = _bleak()
                        progress("reconnecting", "Scanning for the device to reconnect…")
                        try:
                            fresh = await scanner.find_device_by_address(device.address, timeout=8)
                        except Exception as error:
                            _LOGGER.warning("PLAF203 rediscovery failed: type=%s", type(error).__name__)
                            raise _Reconnect("Bluetooth rediscovery failed.") from None
                        if fresh is None:
                            raise _Reconnect("Device is no longer advertising for Bluetooth setup.")
                        device = fresh
                    return await _provision_session(device, settings, progress)
                except _Reconnect as error:
                    reconnect = True
                    last_interruption = str(error)  # constructed safe text only
                    progress("reconnecting", "Bluetooth disconnected. Reconnecting to continue device setup…")
                    _LOGGER.info("PLAF203 reconnect scheduled in %s seconds", RECONNECT_DELAY)
                    await asyncio.sleep(RECONNECT_DELAY)
    except TimeoutError:
        detail = f" Last interruption: {last_interruption}" if last_interruption else ""
        raise ProvisioningError(f"PLAF203 setup timed out without successful device acknowledgements. Bluetooth recovery did not complete setup.{detail}") from None


async def _prefer_le(device):
    """Keep dual-mode BlueZ entries from selecting Classic for BLE setup."""
    details = getattr(device, "details", None)
    path = details.get("path") if isinstance(details, dict) else None
    if not isinstance(path, str) or not path.startswith("/org/bluez/"):
        return
    from dbus_fast import BusType, Message, MessageType, Variant
    from dbus_fast.aio import MessageBus

    bus = None
    try:
        async with asyncio.timeout(5):
            bus = MessageBus(bus_type=BusType.SYSTEM)
            await bus.connect()
            reply = await bus.call(Message(
                destination="org.bluez", path=path,
                interface="org.freedesktop.DBus.Properties", member="Set",
                signature="ssv", body=["org.bluez.Device1", "PreferredBearer", Variant("s", "le")],
            ))
            if reply.message_type == MessageType.ERROR:
                # Older BlueZ and LE-only devices may lack this optional property.
                _LOGGER.info("BLE bearer preference unavailable: %s", reply.error_name)
            else:
                _LOGGER.info("Bluetooth setup transport set to LE")
    except Exception as error:
        _LOGGER.warning("Could not set BLE bearer preference: type=%s", type(error).__name__)
    finally:
        if bus is not None:
            bus.disconnect()


async def _provision_session(device, settings, progress):
    client_type, _ = _bleak()
    replies = asyncio.Queue(maxsize=16)
    operation = "Bluetooth connection"
    poll_replies = _is_plaf203(device)

    def notified(_characteristic, data):
        # FFE2 returns the complete DL frame, e.g. the live Wi-Fi ACK is
        # 44 4c 01 00 00 01 00 ff. Indices recovered from the app's _process
        # were incorrectly applied directly to these raw, framed GATT bytes.
        if (len(data) >= 8 and data[:2] == b"DL" and data[2] in (1, 2)
                and data[3:5] == b"\x00\x00" and len(data) == data[5] + 7
                and data[-1] == 0xff and not replies.full()):
            replies.put_nowait((data[2], data[6]))

    async def acknowledged(command):
        async with asyncio.timeout(PLAF203_SETUP_TIMEOUT if poll_replies else ACK_TIMEOUT):
            while True:
                if poll_replies:
                    # The official app skips subscriptions for PLAF203 and
                    # reads FFE2 from its periodic _check203DeviceAdd method.
                    await asyncio.sleep(POLL_INTERVAL)
                    try:
                        async with asyncio.timeout(READ_TIMEOUT):
                            data = await client.read_gatt_char(NOTIFY)
                    except Exception as error:
                        connected = bool(client.is_connected)
                        # The official HiBle reader catches read exceptions and
                        # the periodic timer keeps running. Never log payloads.
                        _LOGGER.warning("PLAF203 reply read failed: type=%s connected=%s; %s", type(error).__name__, connected, "retrying read" if connected else "reconnecting")
                        if not connected:
                            raise _Reconnect("Bluetooth disconnected while reading the device reply.") from None
                        continue
                    notified(None, data)
                    if replies.empty():
                        continue
                kind, status = await replies.get()
                if kind == command:
                    # _process uses zero for Wi-Fi, but ONE for MQTT acceptance.
                    if status != (0 if command == 1 else 1):
                        stage = "Wi-Fi connection" if command == 1 else "MQTT configuration"
                        if poll_replies:
                            # BLE status 255 is expected on PLAF203, including
                            # successful setup. It is not a Wi-Fi failure and
                            # must not produce a log or UI warning. Continue to
                            # MQTT configuration; final MQTT binding, rather than
                            # this BLE status, determines onboarding success.
                            if status == 255:
                                return False
                            # Other unexpected replies remain provisional too:
                            # networking may still succeed after a BLE rejection.
                            _LOGGER.warning("PLAF203 %s BLE reply code %s is unconfirmed; waiting for MQTT binding", stage, status)
                            progress("wifi_unconfirmed" if command == 1 else "mqtt_unconfirmed",
                                     f"Device reported {stage} code {status} over Bluetooth. Checking MQTT binding…")
                            return False
                        raise ProvisioningError(f"Device rejected {stage} (code {status}). Check settings and pairing mode.")
                    _LOGGER.info("Provisioning command %d acknowledged", command)
                    return True

    async def send(command, *fields):
        nonlocal operation
        att_error = False
        try:
            await client.write_gatt_char(WRITE, packet(command, *fields), response=True)
        except Exception as error:
            if not poll_replies or getattr(error, "code", None) != 0x0e:
                raise
            # HiBle.writeCharacteristic handles write errors; app-level replies
            # drive completion. Allow only this observed error on PLAF203 and
            # still require a successful, command-specific reply below.
            _LOGGER.warning("PLAF203 command %d returned ATT 0x0e; checking device acknowledgement", command)
            att_error = True
        if command == 2:
            _LOGGER.info("MQTT configuration dispatched; waiting for device connectivity")
            progress("mqtt_sent", "MQTT settings sent. Waiting for the device to connect…")
        operation = "Wi-Fi acknowledgement" if command == 1 else "MQTT acknowledgement"
        try:
            return await acknowledged(command)
        except TimeoutError:
            if att_error:
                raise ProvisioningError(f"PLAF203 returned ATT 0x0e for command {command} and did not acknowledge it. Setup was not completed.") from None
            raise

    try:
        progress("connecting", "Connecting to the device over Bluetooth…")
        await _prefer_le(device)
        async with client_type(device, timeout=20) as client:
            service = client.services.get_service(SERVICE)
            if service is None or service.get_characteristic(WRITE) is None or service.get_characteristic(NOTIFY) is None:
                raise ProvisioningError("Device does not expose the Petlibro provisioning characteristics.")
            if poll_replies:
                _LOGGER.info("PLAF203 connected; using FFE2 reply polling instead of notifications")
            else:
                progress("subscribing", "Bluetooth connected. Enabling device notifications…")
                _LOGGER.info("Bluetooth connected; enabling provisioning notifications with StartNotify")
                try:
                    async with asyncio.timeout(NOTIFY_TIMEOUT):
                        await client.start_notify(NOTIFY, notified, bluez={"use_start_notify": True})
                except TimeoutError:
                    raise ProvisioningError("Bluetooth connected, but enabling device notifications timed out. Retry pairing.") from None
                except Exception as error:
                    # Do not expose exception text, which can contain payloads.
                    code = getattr(error, "dbus_error", "")
                    if not isinstance(code, str) or not re.fullmatch(r"org\.(?:bluez|freedesktop\.DBus)\.Error\.[A-Za-z]+", code):
                        code = "unavailable"
                    _LOGGER.warning("Provisioning StartNotify failed: type=%s code=%s", type(error).__name__, code)
                    detail = f" ({code})" if code != "unavailable" else ""
                    raise ProvisioningError(f"Bluetooth connected, but enabling device notifications failed{detail}. Close other Bluetooth clients and retry pairing.") from None
                _LOGGER.info("Provisioning notifications enabled")
            progress("wifi", "Sending Wi-Fi settings and waiting for the device to connect…")
            operation = "Wi-Fi settings write"
            wifi_confirmed = await send(1, settings["ssid"], settings["password"])
            progress("mqtt", "Wi-Fi connected. Sending the local MQTT address…" if wifi_confirmed
                     else "Sending the local MQTT address. Waiting for device connectivity…")
            operation = "MQTT settings write"
            await send(2, f'{settings["broker_ip"]}:1883', ACCOUNT_ID)
            progress("waiting", "MQTT settings sent. Waiting for final device binding…" if poll_replies
                     else "MQTT settings accepted. Waiting for credentials…")
            operation = "Bluetooth disconnect"
    except (ProvisioningError, _Reconnect):
        raise
    except TimeoutError:
        if poll_replies and operation == "Bluetooth connection":
            raise _Reconnect("Bluetooth connection timed out.") from None
        raise ProvisioningError("Device did not acknowledge provisioning in time. Check Wi-Fi settings, range, and pairing mode.") from None
    except Exception as error:
        # Transport errors may contain characteristic payloads; never expose them.
        code = getattr(error, "code", None)
        att = f"0x{code:02x}" if isinstance(code, int) and not isinstance(code, bool) and 0 <= code <= 255 else "unavailable"
        dbus = getattr(error, "dbus_error", "")
        if not isinstance(dbus, str) or not re.fullmatch(r"org\.(?:bluez|freedesktop\.DBus)\.Error\.[A-Za-z]+", dbus):
            dbus = "unavailable"
        # Frame locations identify the failing library call without recording
        # exception text, local values or source lines containing credentials.
        frames = " -> ".join(f"{frame.name}:{frame.lineno}" for frame in traceback.extract_tb(error.__traceback__))
        _LOGGER.warning("Provisioning transport failed: operation=%s type=%s ATT=%s DBus=%s frames=%s", operation, type(error).__name__, att, dbus, frames)
        if poll_replies and operation == "Bluetooth connection":
            detail = f" ({dbus})" if dbus != "unavailable" else ""
            raise _Reconnect(f"Could not establish Bluetooth and discover the device's services{detail}.") from None
        if att != "unavailable":
            raise ProvisioningError(f"Device rejected {operation} (ATT {att}). Check device pairing mode and firmware compatibility.") from None
        detail = f" ({dbus})" if dbus != "unavailable" else ""
        fallback = "You may have better luck connecting from the PetLibro app, then using Auto Setup."
        if operation in ("Wi-Fi acknowledgement", "MQTT acknowledgement"):
            stage = "Wi-Fi" if operation == "Wi-Fi acknowledgement" else "MQTT"
            raise ProvisioningError(f"Could not read the device's {stage} setup reply over Bluetooth{detail}. No successful acknowledgement was received; setup did not complete. {fallback}") from None
        if operation == "Bluetooth connection":
            raise ProvisioningError(f"Could not establish Bluetooth and discover the device's services{detail}. Scan again and check pairing mode before retrying. {fallback}") from None
        raise ProvisioningError(f"Bluetooth failed during {operation}{detail}. Check the logs. {fallback}") from None
