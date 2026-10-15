// Browser microphone -> mono PCM16 at 44.1 kHz -> feeder talkback bridge.
let _cameraTalk = null;
let _cameraTalkMessage = "";

function syncCameraTalkUI() {
  const button = document.getElementById("camera-talk-toggle");
  const status = document.getElementById("camera-talk-status");
  if (button) {
    const label = _cameraTalk ? "Stop talking" : "Talk";
    button.innerHTML = `<span class="material-icons" aria-hidden="true">${_cameraTalk ? "mic_off" : "mic"}</span>`;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.setAttribute("aria-pressed", String(!!_cameraTalk));
  }
  if (status) status.textContent = _cameraTalkMessage || "Use your microphone to talk to the feeder.";
}

function muteCameraForTalk() {
  if (!_cameraTalk) return;
  const video = document.querySelector("#camera-live-frame video");
  if (video && video !== _cameraTalk.video) {
    _cameraTalk.video = video;
    _cameraTalk.wasMuted = video.muted;
    video.muted = true;
  }
  const sound = document.getElementById("camera-live-sound");
  if (sound) {
    sound.disabled = true;
    sound.innerHTML = '<span class="material-icons" aria-hidden="true">volume_off</span>';
    sound.title = "Camera sound is muted while talking";
    sound.setAttribute("aria-label", sound.title);
  }
}

function stopCameraTalk(message = "") {
  const session = _cameraTalk;
  _cameraTalk = null; // Invalidates every pending permission/connection result.
  _cameraTalkMessage = message;
  if (session) {
    clearTimeout(session.timeout);
    session.node?.disconnect();
    if (session.node) session.node.port.onmessage = null;
    session.source?.disconnect();
    session.stream?.getTracks().forEach(track => track.stop());
    session.context?.close().catch(() => {});
    if (session.powerSerial) releaseCameraPower(session.powerSerial, session);
    const socket = session.socket;
    if (socket) {
      socket.onmessage = socket.onerror = socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" }));
      socket.close();
    }
    if (session.video) session.video.muted = session.wasMuted;
    const sound = document.getElementById("camera-live-sound");
    if (sound) {
      sound.disabled = false;
      const muted = session.video?.muted !== false;
      sound.textContent = muted ? "🔇" : "🔊";
      sound.title = muted ? "Turn sound on" : "Mute camera sound";
      sound.setAttribute("aria-label", sound.title);
    }
  }
  syncCameraTalkUI();
}

async function startCameraTalk(serial) {
  if (_cameraTalk) { stopCameraTalk(); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    stopCameraTalk("Microphone access requires HTTPS or localhost. Open Petlibro Local using HTTPS and allow microphone access.");
    return;
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !window.AudioWorkletNode) {
    stopCameraTalk("This browser does not support microphone streaming. Use a current browser with AudioWorklet support.");
    return;
  }
  const session = { serial };
  const device = _currentDevice;
  if (device?.serial !== serial) return;
  if (device.cameraSwitch === false && device.camera_power_with_live_view !== true) {
    stopCameraTalk("Enable the camera to talk to the feeder.");
    return;
  }
  _cameraTalk = session;
  _cameraTalkMessage = "Preparing microphone…";
  syncCameraTalkUI();
  muteCameraForTalk();
  const current = () => _cameraTalk === session;
  try {
    session.context = new AudioContextClass({ sampleRate: 44100 });
    // Resume during the explicit button gesture, before asynchronous permission work.
    await session.context.resume();
    if (!current()) return;
    if (device.camera_power_with_live_view === true) {
      session.powerSerial = serial;
      _cameraTalkMessage = "Turning on camera for talkback…";
      syncCameraTalkUI();
      await acquireCameraPower(serial, session);
      if (!current()) return;
    }
    if (session.context.sampleRate !== 44100) throw new Error("The browser could not provide 44.1 kHz audio. Try another browser.");
    await session.context.audioWorklet.addModule(`${BASE}/camera-talk-worklet.js?v=${encodeURIComponent(window.__VERSION__ || "")}`);
    if (!current()) return;
    _cameraTalkMessage = "Allow microphone access to talk…";
    syncCameraTalkUI();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 44100, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
    session.stream = stream;
    stream.getTracks().forEach(track => track.addEventListener("ended", () => {
      if (current()) stopCameraTalk("Microphone disconnected.");
    }));
    session.source = session.context.createMediaStreamSource(stream);
    session.node = new AudioWorkletNode(session.context, "petlibro-talk-pcm", { channelCount: 1, channelCountMode: "explicit", outputChannelCount: [1] });
    const url = new URL(`${BASE}/api/devices/${encodeURIComponent(serial)}/camera/talk`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = session.socket = new WebSocket(url.href);
    _cameraTalkMessage = "Microphone on · connecting to feeder…";
    syncCameraTalkUI();
    session.timeout = setTimeout(() => {
      if (current()) stopCameraTalk("The feeder did not become ready. Try again.");
    }, 30000);
    socket.onmessage = event => {
      if (!current()) return;
      let reply;
      try { reply = JSON.parse(event.data); } catch { stopCameraTalk("Invalid response from the talkback bridge."); return; }
      if (reply.type === "error") { stopCameraTalk(reply.message || "Could not start talkback."); return; }
      if (reply.type !== "ready" || session.ready) return;
      session.ready = true;
      clearTimeout(session.timeout);
      session.node.port.onmessage = event => {
        if (!current() || socket.readyState !== WebSocket.OPEN) return;
        // Stop instead of building up delayed speech during a slow connection.
        if (socket.bufferedAmount > 44100) { stopCameraTalk("Connection is too slow for live audio. Try again."); return; }
        socket.send(event.data);
      };
      session.source.connect(session.node);
      session.node.connect(session.context.destination); // Worklet output is silence.
      _cameraTalkMessage = "Microphone on · talking to feeder";
      syncCameraTalkUI();
    };
    socket.onerror = () => { if (current()) stopCameraTalk("Could not connect to feeder talkback."); };
    socket.onclose = () => { if (current()) stopCameraTalk("Talkback disconnected."); };
  } catch (error) {
    if (!current()) return;
    const messages = {
      NotAllowedError: "Microphone access was denied. Allow microphone access in your browser's site settings and try again.",
      NotFoundError: "No microphone was found. Connect a microphone and try again.",
      NotReadableError: "The microphone is unavailable or in use by another application."
    };
    stopCameraTalk(messages[error.name] || error.message || "Could not start microphone audio.");
  }
}

function wireCameraTalk(serial) {
  document.getElementById("camera-talk-toggle").onclick = () => startCameraTalk(serial);
  syncCameraTalkUI();
  muteCameraForTalk();
}

window.addEventListener("pagehide", () => stopCameraTalk());
