// Keep one muted live connection per camera for this browser page.
const _backgroundCameras = new Map();
let _backgroundCameraHost = null;

function backgroundCameraHost() {
  if (!_backgroundCameraHost) {
    _backgroundCameraHost = document.createElement("div");
    _backgroundCameraHost.setAttribute("aria-hidden", "true");
    _backgroundCameraHost.style.cssText = "position:fixed;left:-2px;top:-2px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
    document.body.append(_backgroundCameraHost);
  }
  return _backgroundCameraHost;
}

function getBackgroundCamera(serial) {
  return _backgroundCameras.get(serial) || null;
}

function detachBackgroundCamera(serial) {
  const session = getBackgroundCamera(serial);
  if (!session?.video) return;
  session.video.muted = true;
  const card = feederCameraCard(serial);
  (card || backgroundCameraHost()).append(session.video);
  session.video.play().catch(() => {});
}

function closeBackgroundCamera(serial) {
  const session = _backgroundCameras.get(serial);
  if (!session) return;
  session.closed = true;
  _backgroundCameras.delete(serial);
  if (_liveCameraBackgroundSerial === serial) stopLiveCamera();
  session.bridge?.close();
  session.pc?.close();
  if (session.token) {
    fetch(`${BASE}/api/devices/${encodeURIComponent(serial)}/camera/webrtc/${encodeURIComponent(session.token)}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }
  session.video?.pause();
  session.video?.remove();
  if (session.powerOwner) releaseCameraPower(serial, session.powerOwner);
}

async function connectBackgroundCamera(device) {
  const serial = device.serial;
  const session = { closed: false, pc: null, bridge: null, token: null, video: null, powerOwner: null, ready: null };
  _backgroundCameras.set(serial, session);
  session.ready = (async () => {
    try {
      if (device.camera_power_with_live_view === true) {
        session.powerOwner = { serial };
        await acquireCameraPower(serial, session.powerOwner);
        if (session.closed) return false;
      }
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.className = "camera-video";
      session.video = video;
      backgroundCameraHost().append(video);
      try {
        const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
        session.pc = pc;
        const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
        if (_settings.camera_vp8_transcoding === true) preferVP8(transceiver);
        pc.addTransceiver("audio", { direction: "recvonly" });
        const stream = new MediaStream();
        pc.ontrack = event => {
          stream.addTrack(event.track);
          video.srcObject = stream;
          video.play().catch(() => {});
        };
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise(resolve => {
          if (pc.iceGatheringState === "complete") return resolve();
          const done = () => { if (pc.iceGatheringState === "complete") { pc.removeEventListener("icegatheringstatechange", done); resolve(); } };
          pc.addEventListener("icegatheringstatechange", done);
          setTimeout(resolve, 2500);
        });
        if (session.closed) return false;
        const response = await fetch(`${BASE}/api/devices/${encodeURIComponent(serial)}/camera/webrtc`, {
          method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription.sdp,
        });
        const token = response.headers.get("X-Petlibro-WebRTC-Session");
        if (session.closed) {
          if (token) fetch(`${BASE}/api/devices/${encodeURIComponent(serial)}/camera/webrtc/${encodeURIComponent(token)}`, { method: "DELETE", keepalive: true }).catch(() => {});
          return false;
        }
        if (!response.ok) throw new Error(await response.text());
        session.token = token;
        await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
        const connected = await new Promise(resolve => {
          if (video.readyState >= 2) return resolve(true);
          const finish = value => { clearTimeout(timer); video.removeEventListener("loadeddata", loaded); pc.removeEventListener("connectionstatechange", changed); resolve(value); };
          const loaded = () => finish(true);
          const changed = () => { if (["failed", "closed"].includes(pc.connectionState)) finish(false); };
          const timer = setTimeout(() => finish(false), 12000);
          video.addEventListener("loadeddata", loaded, { once: true });
          pc.addEventListener("connectionstatechange", changed);
        });
        if (session.closed) return false;
        if (!connected) throw new Error("Direct camera connection timed out");
        pc.addEventListener("connectionstatechange", () => {
          if (pc.connectionState === "failed" && !session.closed && getBackgroundCamera(serial) === session) closeBackgroundCamera(serial);
        });
        return true;
      } catch {
        session.pc?.close();
        session.pc = null;
        if (session.token) {
          fetch(`${BASE}/api/devices/${encodeURIComponent(serial)}/camera/webrtc/${encodeURIComponent(session.token)}`, { method: "DELETE", keepalive: true }).catch(() => {});
          session.token = null;
        }
        video.remove();
        if (session.closed) return false;
        const bridge = openLiveCameraVideoBridge(serial, backgroundCameraHost(), () => {
          if (getBackgroundCamera(serial) === session) closeBackgroundCamera(serial);
        });
        session.bridge = bridge;
        session.video = bridge.video;
        if (!await bridge.ready || session.closed) throw new Error("Camera video bridge unavailable");
        return true;
      }
    } catch (error) {
      if (!session.closed) {
        console.warn("Background camera connection failed", serial, error);
        closeBackgroundCamera(serial);
      }
      return false;
    }
  })();
  return session;
}

function syncBackgroundCameras() {
  const enabled = (_settings.camera_stream_lifetime || (_settings.camera_preload_live_feeds === true ? "web_interface" : "viewing")) !== "viewing" || _settings.feeder_card_display === "live";
  const wanted = new Map(enabled ? _devices.filter(device =>
    device.device_type === "camera_feeder" && device.online &&
    (device.cameraSwitch !== false || device.camera_power_with_live_view === true)
  ).map(device => [device.serial, device]) : []);
  for (const serial of _backgroundCameras.keys()) {
    if (!wanted.has(serial)) closeBackgroundCamera(serial);
  }
  for (const [serial, device] of wanted) {
    if (!_backgroundCameras.has(serial)) connectBackgroundCamera(device).then(session => session.ready.then(() => {
      if (_settings.feeder_card_display === "live") syncFeederCardCameras();
    }));
  }
}

window.addEventListener("pagehide", () => {
  for (const serial of _backgroundCameras.keys()) closeBackgroundCamera(serial);
});
window.addEventListener("pageshow", syncBackgroundCameras);

// Cards and the status view share the same muted camera connection.
function feederCameraCard(serial) {
  if (_settings.feeder_card_display !== "live") return null;
  return [...document.querySelectorAll(".card-camera")].find(card => card.dataset.cameraSerial === serial) || null;
}
let _feederSnapshotTimer = null;
let _feederSnapshotGeneration = 0;
function syncFeederCardCameras() {
  clearTimeout(_feederSnapshotTimer);
  const generation = ++_feederSnapshotGeneration;
  document.querySelectorAll(".card-camera").forEach(card => {
    const serial = card.dataset.cameraSerial;
    if (_settings.feeder_card_display === "live") {
      const session = getBackgroundCamera(serial);
      if (session?.video && !session.closed && _liveCameraBackgroundSerial !== serial) {
        card.replaceChildren(session.video);
        session.video.muted = true;
        session.video.play().catch(() => {});
      }
    } else if (_settings.feeder_card_display === "snapshot") {
      const image = new Image();
      image.alt = "Latest camera snapshot";
      image.onload = () => {
        if (generation === _feederSnapshotGeneration && card.isConnected) card.replaceChildren(image);
      };
      image.src = `${BASE}/api/devices/${encodeURIComponent(serial)}/camera/snapshot?t=${Date.now()}`;
    }
  });
  if (_settings.feeder_card_display === "snapshot") {
    _feederSnapshotTimer = setTimeout(syncFeederCardCameras, Math.max(1, _settings.camera_snapshot_interval_secs || 15) * 1000);
  }
}
