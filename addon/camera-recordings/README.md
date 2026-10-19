# Direct SD recordings bridge overlay

This adds recording enumeration, historical video playback and explicit deletion to the
existing PLAF203 camera bridge. Apply `camera-bridge-recordings.patch` after the
audio and talkback patches, then copy `camera-recordings/internal/` over the
bridge's `internal/` directory. The addon Dockerfile performs those steps.

## Internal HTTP API

`DELETE /devices/{device_id}/recordings/{start}` deletes one explicitly selected
recording. The bridge verifies the clip exists and sends the APK's
`CommandPlaybackDelete`: request `0x3000000a`, response `0x3000000b`. Its 24-byte
request has total1 at offset0, page0/end1/count1 at offsets4/5/6, Unix start
seconds at offset8, and remaining fields zero. The eight-byte reply must contain
endflag1 at offset0 and the matching Unix start at offset4. Success returns
`{"deleted": start}` only after that confirmation. Deletion is blocked during
playback and serialized per camera. No physical-device deletion was performed
while implementing this endpoint; tests use a simulated device.

`GET /devices/{device_id}/recordings?start=1792108800&end=1792195199`

Timestamps are Unix seconds. The inclusive interval must be ordered, positive,
and at most seven days. Successful responses are always complete:

```json
{"recordings":[{"start":1792108800,"duration":60,"event":48,"status":0}],"complete":true,"start":1792108800,"end":1792195199}
```

An explicitly completed zero-event device response returns `recordings: []`.
Lost responses, missing pages, invalid timestamps, conflicting duplicate pages,
and mismatched advertised totals do not become empty days. Zero- and one-based
page sequences are supported. Only one list query per camera session runs at a
time; live video and an established playback session may continue alongside it.

`GET /devices/{device_id}/recordings/stream?start=1792108800&offset=10&format=mpegts`

`start` must identify the clip's original start time. The bridge queries its
duration from the device before allocating playback. `offset` defaults to zero
and must be less than that duration. `format=mpegts` returns `video/mp2t` with
device millisecond frame timestamps converted into 90 kHz presentation times.
The relay should use this format for its ffmpeg input; raw H.264 lacks explicit
frame timestamps. Omitting `format`, or specifying `h264`, returns `video/h264`.
MPEG-TS includes AAC-LC ADTS audio from the secondary playback channel when
available. Audio starts after the requested seek and uses the same timestamp
origin as video. Startup probes for audio for up to two seconds while buffering
video; clips without audio retain a video-only program map. The relay encodes
the optional audio track as AAC-LC in its fragmented MP4, and the browser plays
it unmuted. Raw H.264 remains video only.

The secondary playback channel uses the SDK's `1c/0a` envelope with full wire
encoding. A real PLAF203 accepted this framing and returned historical H.264;
forcing the primary live client's `1d/0b` envelope on the secondary channel caused
its authentication to time out. The allocated channel still travels in byte14.
Authentication retries the same login datagrams every 300 ms within the existing
three-second deadline to tolerate device AV-server startup without changing
sequence numbers or the request timestamp.

Only one playback per device session is permitted. Live viewing retains its
primary channel and receives no historical frames. Playback allocates and
authenticates the secondary AV channel returned by the device, multiplexed over
the same IOTC socket. Startup is bounded by 15 seconds for initial camera
connection plus 25 seconds for recording setup. Allow at least 45 seconds for
the initial upstream HTTP response. After startup, the request remains open
until EOF, client cancellation, failure, or the bounded clip duration.

Disconnecting the HTTP client stops secondary video and releases the recording
allocation on the primary channel. Device EOF on either AV channel is accepted.
A stalled consumer, lost camera stream, and secondary receive overflow release
their resources. Failures after HTTP headers abort the chunked transfer so the
relay can distinguish truncation from a normal recording end.

Errors use JSON `{"error":"..."}` before streaming: 400 invalid parameters or
offset; 404 unregistered camera or missing clip; 409 busy; 502 malformed or
incomplete device reply; 503 closed session; 504 timeout. Request cancellation
before headers uses 499.

## Evidence and verification

The supplied PETLIBRO 1.3.70 APK establishes LISTEVENT 0x0318/0x0319, playback
control 0x031a/0x031b, seek 0x033c/0x033d, UTC STimeDay serialization, and the
secondary channel's unchanged mapping into outer IOTC packet byte 14. Its
START/STOP video arguments contain that secondary channel. Retained sources and
native disassembly are summarized in `playback-investigation/apk-playback-findings.md`
at the repository workspace root. Those findings are static artifact evidence,
not a successful historical video exchange with this feeder.

The overlay tests cover request bytes, timestamp validation, complete and
out-of-order pagination, missing-page timeouts, HTTP validation/errors, secondary
authentication/routing, historical frames, EOF on the secondary channel,
exclusive ownership, startup cleanup, both STOP commands, retained live socket,
and MPEG-TS presentation times. The recording tests pass repeatedly; `go vet`
passes. The full inherited suite also passes with the complete build patch.
The patch includes modern APK `1d/0b` client framing, accepts device `0a/0b`
variants, and chooses the reversible transform from the packet flag. This fixes
the discrepancy between earlier modified checkouts and the packaged source.
Protocol test fixtures now use the corresponding transform; the retained old
capture's counters, sequence and session identity still match byte for byte.
Race instrumentation is unavailable on this host because no C compiler is
installed and Go runs with CGO disabled.

Device testing confirms SD enumeration, secondary authentication with the
`1c/0a` envelope, historical H.264 reception, and a ten-second seek returning a
keyframe at 10,000 ms. The historical stream also passes FFmpeg conversion and
browser playback. Firmware compatibility beyond the tested PLAF203 needs further
checks. The
overlay currently rejects fragmented IOCtrl responses explicitly rather than
interpreting unverified fragment layouts; paginated unfragmented responses are
supported. A larger fragmented response returns a protocol error, not an empty
recording list.

The original source archive was rebuilt with the Dockerfile's three patches,
four explicit talkback file copies, and recording overlay copy. `go test ./...`,
`go vet ./...`, and Linux amd64/arm64 bridge cross-builds succeeded. A complete Docker
image build could not run because Docker Desktop's engine was not running.
Subsequent device testing successfully rebuilt and started the add-on on Home
Assistant. Its MP4 API streamed real SD video and a ten-second seek with HTTP200;
the emitted MP4 passed decoding and browser playback checks.
