"""Minimal TCP MQTT broker for one-time credential capture.

Listens on port 1883, waits for a device CONNECT packet, extracts
username, password, and client ID. During BLE setup, camera feeders stay
connected until their final BINDING reply has been delivered and acknowledged.

No dependencies beyond stdlib -- parses the MQTT 3.1.1 wire format manually.
"""

import asyncio
import json
import logging
import struct
import time

_LOGGER = logging.getLogger(__name__)

CAPTURE_PORT = 1883
CAPTURE_TIMEOUT = 60
CAPTURE_CLEANUP_TIMEOUT = 3


def _decode_varint(data: bytes, offset: int) -> tuple[int, int]:
    multiplier = 1
    value = 0
    while True:
        byte = data[offset]
        offset += 1
        value += (byte & 0x7F) * multiplier
        multiplier *= 128
        if not (byte & 0x80):
            break
        if multiplier > 128 * 128 * 128:
            raise ValueError("Malformed variable-length integer")
    return value, offset


def _decode_utf8(data: bytes, offset: int) -> tuple[str, int]:
    length = struct.unpack_from(">H", data, offset)[0]
    offset += 2
    if offset + length > len(data):
        raise ValueError("Truncated MQTT string")
    return data[offset:offset + length].decode("utf-8", errors="replace"), offset + length


def _decode_bytes(data: bytes, offset: int) -> tuple[bytes, int]:
    length = struct.unpack_from(">H", data, offset)[0]
    offset += 2
    return data[offset:offset + length], offset + length


def _parse_connect(data: bytes) -> dict | None:
    """Parse an MQTT CONNECT packet. Returns dict with client_id, username, password or None."""
    try:
        if not data or data[0] != 0x10:
            return None

        _, offset = _decode_varint(data, 1)

        proto_name, offset = _decode_utf8(data, offset)
        if proto_name not in ("MQTT", "MQIsdp"):
            return None

        _proto_level = data[offset]
        offset += 1

        connect_flags = data[offset]
        offset += 1

        has_username = bool(connect_flags & 0x80)
        has_password = bool(connect_flags & 0x40)
        has_will = bool(connect_flags & 0x04)

        offset += 2  # keepalive

        client_id, offset = _decode_utf8(data, offset)

        if has_will:
            _, offset = _decode_utf8(data, offset)
            _, offset = _decode_bytes(data, offset)

        username = ""
        password = ""

        if has_username:
            username, offset = _decode_utf8(data, offset)
        if has_password:
            pwd_bytes, offset = _decode_bytes(data, offset)
            password = pwd_bytes.decode("utf-8", errors="replace")

        return {"client_id": client_id, "username": username, "password": password}
    except Exception:
        _LOGGER.exception("Failed to parse CONNECT packet")
        return None


CONNACK_ACCEPTED = bytes([0x20, 0x02, 0x00, 0x00])

# Client ID prefixes that identify Petlibro devices
PETLIBRO_PREFIXES = ("WF", "AF", "LS", "PL")


def _is_petlibro(client_id: str) -> bool:
    upper = client_id.upper()
    return any(upper.startswith(p) for p in PETLIBRO_PREFIXES)


def _packet(header: int, payload: bytes) -> bytes:
    length = len(payload)
    encoded = bytearray([header])
    while True:
        byte = length % 128
        length //= 128
        encoded.append(byte | (0x80 if length else 0))
        if not length:
            return bytes(encoded) + payload


def _field(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return struct.pack(">H", len(encoded)) + encoded


class _CaptureProtocol(asyncio.Protocol):
    def __init__(self, result_future: asyncio.Future, known_serials: frozenset[str] = frozenset(), require_binding=False, binding_ready=None, on_binding=None):
        self._future = result_future
        self._known_serials = known_serials
        self._buf = b""
        self._transport = None
        self._require_binding = require_binding
        self._creds = None
        self._subscribed = False
        self._subscription_qos = 0
        self._reply_qos = 0
        self._binding = None
        self._binding_sent = False
        self._binding_packet_id = 0
        self._on_binding = on_binding
        self._binding_ready = binding_ready

    def connection_made(self, transport):
        self._transport = transport
        peer = transport.get_extra_info("peername")
        _LOGGER.info("Capture: connection from %s", peer)

    def data_received(self, data: bytes):
        self._buf += data
        if len(self._buf) > 65536:
            self._transport.close()
            return
        while len(self._buf) >= 2:
            try:
                length, offset = _decode_varint(self._buf, 1)
            except IndexError:
                return  # fragmented remaining-length field
            except ValueError:
                self._transport.close()
                return
            try:
                if length > 65531:
                    raise ValueError("MQTT packet too large")
                if len(self._buf) < offset + length:
                    return
                wire, self._buf = self._buf[:offset + length], self._buf[offset + length:]
                if self._creds is None:
                    if not self._connect(wire):
                        return
                else:
                    self._session_packet(wire[0], wire[offset:])
            except (IndexError, ValueError, struct.error, UnicodeError):
                self._transport.close()
                return

    def _connect(self, wire):
        creds = _parse_connect(wire)
        if creds is not None:
            client_id = creds.get("client_id", "")
            # Always send CONNACK so the device doesn't error out
            self._transport.write(CONNACK_ACCEPTED)

            if not _is_petlibro(client_id):
                _LOGGER.info(
                    "Capture: skipping non-Petlibro client '%s' — still waiting...",
                    client_id[:16],
                )
                self._transport.close()
                return False

            if client_id.upper() in self._known_serials:
                # Stopping Mosquitto for this capture window disconnects every
                # already-configured device too, not just the new one the user
                # is trying to add, and any of them reconnecting during the
                # window would otherwise win the capture race. Real complaint
                # from a user with multiple devices (issue #8, 2026-09-11):
                # re-adding one device kept re-capturing an already-onboarded
                # one instead, since it reconnects faster than a freshly
                # power-cycled new device.
                _LOGGER.info(
                    "Capture: skipping already-onboarded device '%s...' — still waiting...",
                    client_id[:8],
                )
                self._transport.close()
                return False

            _LOGGER.info(
                "Capture: Petlibro device — client_id=%s..., user=%s...",
                client_id[:8],
                creds["username"][:4] if creds["username"] else "?",
            )
            if self._require_binding and client_id.upper().startswith("AF03"):
                if self._binding_ready is not None and not self._binding_ready.is_set():
                    # A connection using previous settings must reconnect after
                    # the requested broker/account command has been sent. Keeping
                    # it open would swallow its one-shot startup BINDING request.
                    _LOGGER.info("Capture: deferring %s... until MQTT settings are sent; reconnect required", client_id[:8])
                    self._transport.close()
                    return False
                self._creds = creds
                _LOGGER.info("Capture: waiting for final MQTT binding from %s...", client_id[:8])
                if self._on_binding is not None:
                    self._on_binding()
                return True
            self._finish(creds)
        self._transport.close()
        return False

    def _finish(self, creds):
        if not self._future.done():
            self._future.set_result(creds)

    def _session_packet(self, header, payload):
        serial = self._creds["client_id"]
        topic = f"dl/PLAF203/{serial}/device/system/"
        kind = header >> 4
        if header == 0x82:  # SUBSCRIBE: acknowledge every requested topic.
            packet_id = payload[:2]
            if len(packet_id) != 2:
                raise ValueError("Missing packet ID")
            offset, granted = 2, bytearray()
            while offset < len(payload):
                subscription, offset = _decode_utf8(payload, offset)
                qos = payload[offset]
                offset += 1
                if qos > 2:
                    raise ValueError("Invalid subscription QoS")
                granted.append(min(qos, 1))
                # Accept the exact response topic and MQTT wildcard filters.
                if self._matches(subscription, topic + "sub"):
                    self._subscribed = True
                    self._subscription_qos = max(self._subscription_qos, min(qos, 1))
            if not granted:
                raise ValueError("Empty subscription")
            self._transport.write(_packet(0x90, packet_id + granted))
            _LOGGER.info("Capture: subscription acknowledged for %s... binding_topic=%s qos=%s",
                         serial[:8], self._subscribed, self._subscription_qos)
            self._send_binding()
        elif kind == 3:  # PUBLISH (QoS 0 or 1).
            qos = (header >> 1) & 3
            if qos > 1:
                raise ValueError("Unsupported publish QoS")
            published_topic, offset = _decode_utf8(payload, 0)
            if qos:
                packet_id = payload[offset:offset + 2]
                if len(packet_id) != 2:
                    raise ValueError("Missing publish packet ID")
                offset += 2
                self._transport.write(_packet(0x40, packet_id))
            if header & 1:
                return
            try:
                data = json.loads(payload[offset:])
            except (ValueError, UnicodeError):
                return
            if not isinstance(data, dict):
                return
            if data.get("cmd") in ("BINDING", "DEVICE_START_EVENT"):
                _LOGGER.info("Capture: %s received from %s... channel=%s qos=%s",
                             data["cmd"], serial[:8], published_topic.split("/")[-2], qos)
            if (self._binding_sent and published_topic == f"dl/PLAF203/{serial}/device/event/post"
                    and data.get("cmd") == "DEVICE_START_EVENT" and data.get("success") is True):
                self._binding_complete()
                return
            if published_topic != topic + "post" or data.get("cmd") != "BINDING":
                return
            if self._binding_ready is not None and not self._binding_ready.is_set():
                return  # An old connection must not confirm unsent setup settings.
            msg_id = data.get("msgId")
            if not isinstance(msg_id, str) or not msg_id or len(msg_id) > 256:
                return
            self._binding = {"cmd": "BINDING", "msgId": msg_id, "code": 0,
                             "bindId": 15, "ts": int(time.time() * 1000)}
            self._binding_packet_id = self._binding_packet_id % 65535 + 1
            self._binding_sent = False
            self._send_binding()
        elif header == 0x40:  # PUBACK for our QoS 1 BINDING reply.
            if self._binding_sent and self._reply_qos == 1 and payload == struct.pack(">H", self._binding_packet_id):
                self._binding_complete()
        elif header == 0xc0 and not payload:
            self._transport.write(b"\xd0\x00")
        elif header == 0xe0:
            self._transport.close()

    @staticmethod
    def _matches(subscription, topic):
        levels = topic.split("/")
        for index, level in enumerate(subscription.split("/")):
            if level == "#":
                return index == len(subscription.split("/")) - 1
            if index >= len(levels) or level not in ("+", levels[index]):
                return False
        return len(subscription.split("/")) == len(levels)

    def _send_binding(self):
        if not self._subscribed or self._binding is None or self._binding_sent:
            return
        topic = f'dl/PLAF203/{self._creds["client_id"]}/device/system/sub'
        self._reply_qos = self._subscription_qos
        payload = _field(topic)
        if self._reply_qos:
            payload += struct.pack(">H", self._binding_packet_id)
        payload += json.dumps(self._binding).encode()
        self._transport.write(_packet(0x30 | self._reply_qos << 1, payload))
        self._binding_sent = True
        _LOGGER.info("Capture: binding reply sent to %s... qos=%s; waiting for confirmation",
                     self._creds["client_id"][:8], self._reply_qos)

    def _binding_complete(self):
        _LOGGER.info("Capture: final binding reply acknowledged by %s... (bindId=15)", self._creds["client_id"][:8])
        self._finish({**self._creds, "binding_confirmed": True})

    def connection_lost(self, exc):
        if exc:
            _LOGGER.debug("Capture: connection lost: %s", exc)


async def capture_credentials(timeout_seconds: int = CAPTURE_TIMEOUT, known_serials=frozenset(), on_ready=None, capture_ready=None, on_binding=None) -> dict:
    """Run a mini MQTT broker on port 1883 and capture the first CONNECT credentials
    from a device NOT already in known_serials (already-onboarded devices reconnecting
    during this same window are skipped, not captured).

    Retries binding the port every 3 seconds until Mosquitto fully releases it.
    BLE camera feeders complete only after the final MQTT binding reply's
    PUBACK (or a successful device-start event for QoS 0 subscriptions), before
    Mosquitto resumes. Other capture paths still use CONNECT.
    Returns credentials (plus binding_confirmed for BLE camera feeders), or {}.
    """
    loop = asyncio.get_running_loop()
    result: asyncio.Future = loop.create_future()
    deadline = loop.time() + timeout_seconds
    server = None
    protocols = set()
    known_serials = frozenset(s.upper() for s in known_serials)

    # Retry until port is free -- Mosquitto can take several seconds to release it
    while loop.time() < deadline:
        try:
            def make_protocol():
                protocol = _CaptureProtocol(result, known_serials, require_binding=on_ready is not None,
                                            binding_ready=capture_ready, on_binding=on_binding)
                protocols.add(protocol)
                return protocol
            server = await loop.create_server(
                make_protocol,
                host="0.0.0.0",
                port=CAPTURE_PORT,
            )
            break
        except OSError:
            remaining = deadline - loop.time()
            if remaining < 4:
                _LOGGER.error("Port %d never became free -- Mosquitto may not have stopped", CAPTURE_PORT)
                return {}
            _LOGGER.info("Port %d still in use, retrying in 3s...", CAPTURE_PORT)
            await asyncio.sleep(3)

    if server is None:
        return {}

    _LOGGER.info("Capture broker ready on port %d (%ds window)", CAPTURE_PORT, int(deadline - loop.time()))
    provisioning_task = None
    completion_task = None
    try:
        async with asyncio.timeout(max(0.0, deadline - loop.time())):
            # Provision only after the listener is bound, so a fast device's
            # first CONNECT cannot be lost. The callback shares the deadline.
            if on_ready is not None:
                provisioning_task = asyncio.create_task(on_ready())
                async def complete():
                    # Existing Wi-Fi/MQTT settings may cause a CONNECT before
                    # this setup has sent its requested broker/account values.
                    if capture_ready is not None:
                        await capture_ready.wait()
                    return await result
                completion_task = asyncio.create_task(complete())
                await asyncio.wait((provisioning_task, completion_task), return_when=asyncio.FIRST_COMPLETED)
                # Camera feeder completion requires its final MQTT BINDING
                # exchange, even when its second BLE reply never arrives.
                if completion_task.done():
                    return completion_task.result()
                await provisioning_task  # propagate provisioning failures
                return await completion_task
            return await result
    except asyncio.TimeoutError:
        _LOGGER.warning("Credential capture timed out after %ds", timeout_seconds)
        return {}
    except Exception:
        if on_ready is not None:
            raise
        _LOGGER.exception("Capture broker error")
        return {}
    finally:
        # Release the broker port before awaiting Bluetooth teardown: BlueZ
        # disconnect can stall even when the provisioning task is cancelled.
        server.close()
        for protocol in protocols:
            if protocol._transport is not None:
                protocol._transport.abort()
        await server.wait_closed()
        tasks = {task for task in (completion_task, provisioning_task) if task is not None}
        for task in tasks:
            task.cancel()
        if tasks:
            _, pending = await asyncio.wait(tasks, timeout=CAPTURE_CLEANUP_TIMEOUT)
            for task in tasks:
                # Retrieve late failures without allowing a stuck radio cleanup
                # to hold Mosquitto stopped indefinitely.
                task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
            if pending:
                _LOGGER.warning("Bluetooth cleanup still pending; restoring MQTT broker now")
                for task in pending:
                    task.cancel()
        _LOGGER.info("Capture broker stopped")
