# Microphone talkback (PLAF203)

The camera feeder's **Status** tab contains **Talk / Stop talking** below the
live camera. Microphone capture starts only after clicking Talk and granting
browser permission. Leaving the tab, closing the device view, opening Edit,
hiding the page, disconnecting, or clicking Stop releases the microphone.
Camera audio is muted during capture to reduce feedback.

Use HTTPS (including a suitably configured Home Assistant ingress) or
localhost. Browsers do not provide microphone access on ordinary LAN HTTP.
Enable the camera, or enable **Camera power with Live View or Talk**. Automatic
camera power is shared between live view and Talk, and turns off after both
stop. Only one microphone connection per feeder is accepted. A connection
times out after five seconds without audio and has a two-minute maximum.

## Validation status

The official-app capture
`PCAPdroid_14_Oct_12_27_11.pcap` resolves the speaker protocol on the tested
V3.0.30 feeder. The app sends `SPEAKERSTART` (`0x0350`) with eight zero-valued
argument bytes, then sends AAC-LC microphone frames over the existing Session16
session on channel `0x0103`; it does not open a reverse AV session. It ends with
`SPEAKERSTOP` (`0x0351`). The captured format is AAC ADTS (`0x87`), 44.1 kHz,
mono. The bridge implementation now follows that sequence.

Browser microphone controls, PCM16 streaming, FFmpeg AAC conversion, HTTP
streaming, ownership and cleanup have passed automated tests. The overlaid Go
bridge compiles against the pinned source. However, the updated talkback path
has not yet been deployed to Home Assistant or verified for audible playback
on the physical feeder; treat real-device playback as unconfirmed. The capture
is diagnostic evidence and its microphone audio is not stored by the app.

## Implementation

Browser AudioWorklet (mono PCM16 LE, 44100 Hz) -> device-scoped WebSocket ->
FFmpeg AAC-LC ADTS -> local bridge HTTP stream -> shared feeder Session16
channel `0x0103`, bracketed by `0x0350` / `0x0351` speaker controls.
Microphone data is streamed in memory and is not saved.

The add-on builds its pinned bridge with the existing media patch, the new
`camera-bridge-talkback.patch`, and the source overlay in `addon/camera-talkback`.
The bridge sends the captured speaker-start control before accepting audio.
Failed setup, socket closure, device shutdown and add-on shutdown release the
speaker state and kill the encoder.

## Checks

```
node --test petlibro-local/tests/test_camera_talk.mjs
.venv/Scripts/python.exe -B -m unittest discover -s petlibro-local/tests -v
```

The Go bridge and talkback tests must also pass in the Docker build, which
applies both patches to the pinned bridge before running `go test ./...`.
