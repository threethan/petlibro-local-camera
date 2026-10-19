# SD card video retrieval: capture findings

## APK-derived Recordings tab

The Recordings tab reads the PLAF203's SD card through the local camera bridge.
Select a camera feeder, choose a date, then select a clip or click a recorded
interval on the timeline. The viewer provides pause/resume, previous/next clip,
seeking, snapshot and fullscreen controls. Dates use the configured feeder
timezone, including 23- and 25-hour daylight-saving days. Camera-power ownership
is shared with existing live-view controls when automatic camera power is enabled.
Otherwise the camera must already be enabled. The feeder must be online.

In Settings → General, **Show Videos Tab** controls the Recordings tab and
**Show Pets Tab** controls Pets. Both are enabled by default. Uncheck an option
and save to hide its tab.

Each recording has download and delete controls. Tap and hold a recording, then
drag across others to select a range; the list scrolls near the screen edges.
Drag back to shrink the range. Checkboxes and Ctrl/Command-click also select
recordings. Once at least two are
selected, the bottom action island shows **Delete {n}** and **Download {n}**.
Deletion asks for confirmation and removes each row only after the camera
acknowledges that exact recording. Batch downloads produce one ZIP of MP4 files;
downloads are limited to 256 MB per batch and currently contain video only.

The layout follows the supplied Android app's SD Card source selector, date
navigation, timeline, event filters and player controls. Timeline colors recovered
from Flutter AOT are motion yellow `#ffd500`, feeding mint `#90d6d1`, and still
gray `#aeaeae`. Event IDs are feeding 48, motion 1 and sound 240; unknown event
IDs stay visible under All. No cloud credentials, Petlibro HTTPS or SD formatting
are involved. Recorded audio is not implemented; the player labels this explicitly.
Cloud thumbnails and pinch-to-zoom are not included.

Rebuild the add-on to include the new bridge overlay. Browser files alone do not
add the device protocol implementation.

### Evidence

Supplied APK: `com.designlibro.petlibro_1.3.70-1370_4arch_7dpi.apk`.
SHA-256: `cc5d060922f1060fd579a0525a7865332ebc85984000dfe2edfd522c3c2d0bb1`.
The investigation reused local JADX and Blutter tools. REA MCP/CLI was unavailable;
these are offline shell-derived observations, not REA Evidence IDs or observed
device execution. Full findings and decompilations are retained in the workspace
at `../../playback-investigation/apk-playback-findings.md` and the accompanying
Java/native files. Flutter assembly is in `../../schedule-investigation/dart-analysis`.

`PlaybackController`, `ReplayController`, `CommandListEvent`,
`CommandRecordPlayControl`, `CommandSetRecordProgress`, and `STimeDay` establish:

| Operation | Request / response | Format |
| --- | --- | --- |
| Enumerate | `0x0318` / `0x0319` | Request: camera channel0, start/end UTC STimeDay, event0, status0. Reply: channel, total, page index/end flag/count; 12-byte records containing UTC time, event, status and duration. |
| Start / stop | `0x031a` / `0x031b` | 24 bytes: camera channel0, command, mode0, UTC event start, duration. Commands start16, pause0, stop1, resume8. Start returns a secondary AV channel. |
| Seek | `0x033c` / `0x033d` | 20 bytes: camera channel0, UTC event start, progress seconds, total duration seconds. |

STimeDay is eight bytes: little-endian uint16 year, then month, day, weekday
(Sunday0), hour, minute, second. App bridge timestamps are Unix seconds.
Native `libAVAPIsT.so` / `libIOTCAPIsT.so` show that the allocated playback
channel uses the existing session ID and is written to outer UDP byte14.
It requires its own AV login, counters and media parser. Displaying the primary
live channel would not play the requested recording.

The bridge overlay implements this secondary channel and leaves the existing
live receiver in control of its UDP socket. Recording frame timestamps become
MPEG-TS PTS before FFmpeg transcodes to browser H.264 fMP4, preserving cadence.
The ingress API validates device/range/offset inputs and reports timeout or
incomplete lists separately from a confirmed empty day. Viewer disconnect,
navigation, pause, camera removal and shutdown release playback resources.

### Validation and limits

Automated tests cover wire formats, pagination, secondary-channel playback and
cleanup using a simulated device, API validation and disconnect cleanup, calendar
boundaries, event filtering, and browser playback of a generated H.264 recording.
Browser checks exercise the real UI with an ingress prefix, desktop/mobile
layouts, pause/resume, seeking, errors, empty dates and tab navigation.

The complete source patch sequence passes `go test ./...` and `go vet ./...`,
and the bridge cross-compiles for Linux amd64 and arm64. All 54 Python tests (plus 27
subtests) and 27 JavaScript tests pass. The bridge patch includes the APK's
modern `1d/0b` client envelope and flag-aware transforms, accepts both `0a` and
`0b` device envelopes, and updates the corresponding simulated protocol fixtures.
A full container build was unavailable because the Docker engine was not running.

For local builds copied from Windows, the Dockerfile normalizes all three bridge
patches to LF before applying them. CRLF in the recordings patch reproduced a
Linux Git patch failure against upstream revision
`6136304ea023d2d32742d2432bc5ca07bc738430`; normalization fixes that failure.
`tests/test_build_patches.py` checks the patch inputs' line endings. The fixed
patch sequence was verified with Linux Git against that exact revision, followed
by the complete Go test suite and vet.

Physical PLAF203 testing subsequently confirmed enumeration, historical H.264
reception, and a ten-second seek returning a keyframe at 10,000 ms. The captured
stream passes the viewer's FFmpeg conversion and browser MediaSource playback.
The playback channel requires the SDK's `1c/0a` framing; forcing the primary
live client's `1d/0b` framing caused secondary authentication to time out. Login
also retries the identical datagrams within its existing timeout because the
device's AV server may not be ready immediately after allocation. Other firmware
versions still need validation. The original supplied PCAPs did not capture a
successful SD recording exchange; the later direct-device tests establish this
runtime behavior.

## Earlier capture evidence

## Available evidence

- `../../video-playback.pcap` contains traffic from 2026-10-15 20:45:50 through
  20:46:22 UTC. The direct camera session is UDP between `10.215.173.1:12440`
  and `192.168.2.154:41248` (641 client to device and 1,012 device to client
  Session16 packets). The outer opcodes are `0x0407` and `0x0408`.
- The capture also contains HTTPS connections to Petlibro endpoints. Their
  application payloads are TLS encrypted, so the PCAP does not expose URLs,
  request bodies, or responses for those connections.
- The HTTP Toolkit exchanges in `../../sdcard-video-logs/` contain four
  `/data/data/realInfo` responses reporting `sdCardState=1`, recording enabled,
  `videoRecordMode=CONTINUOUS`, and used SD card capacity of 320 or 384 MB.
  Three `/hls/video/getDaysWithVideoRecords` responses return `data: []`.

## Direct session

The UDP packets use the same TUTK Session16 transport as the existing live
camera bridge. The existing `tools/plaf203-pcap` decoder can identify the
Session16 headers, Session25 counters, and media packets. It sees a device
`0x032b` audio format reply during setup. Video traffic follows on media
channels. The traffic is consistent with an active camera stream.

The corrected parser in `../../playback-investigation/findings.md` recovers
readable control payloads after trimming PCAPdroid trailers using the IPv4/UDP
lengths. Those payloads contain no recording list, timeline, seek, or download
controls. The captured
device control replies do not contain the standard TUTK recording list or
playback reply IDs `0x0319` or `0x031b`. The standard definitions in
`tutk_test/include/AVIOCTRLDEFs.h` are therefore insufficient to establish the
Petlibro recording protocol or response format.

## Earlier implementation boundary (resolved by the APK above)

A working Videos tab needs confirmed request and response formats for recording
dates, clip lists or timeline ranges, playback start, seeking, stop, and file
download. It also needs to know whether the official app uses the direct camera
session, Petlibro HTTPS, or both for each operation. These details are not
recoverable from the available decrypted HTTP Toolkit exchanges and this PCAP.
Implementing controls from the standard TUTK header alone would risk showing
empty lists or sending commands the PLAF203 firmware does not support.

The next useful capture is the app's decrypted HTTP requests and responses made
while opening an SD card recording, seeking, and downloading it, or a capture of
the app layer TUTK IOCtrl type and data before transport encryption. A Petlibro
APK of the same app version would also permit tracing these message formats.
