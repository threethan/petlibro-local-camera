// The dashboard embeds the exact Status-tab player and its event handlers.
(() => {
  const serial = new URLSearchParams(location.search).get("serial") || "";
  let timer = null;
  let disposed = false;
  let mounted = false;
  const host = document.getElementById("camera-view");
  const message = text => {
    host.replaceChildren();
    const element = document.createElement("div");
    element.id = "camera-view-message";
    element.setAttribute("role", "status");
    element.textContent = text;
    host.append(element);
  };
  async function refreshCamera() {
    try {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(serial)) throw new Error("Choose a camera feeder in the card editor.");
      const [devices, settings] = await Promise.all([api("GET", "/api/devices"), api("GET", "/api/settings")]);
      if (disposed) return;
      _settings = { ...settings, camera_auto_start_live_view: true };
      // Warm only this card's feeder, never every camera on the account.
      _devices = devices.filter(device => device.serial === serial && device.device_type === "camera_feeder");
      _currentDevice = _devices[0];
      if (!_currentDevice) throw new Error("Camera feeder not found. Check the configured serial.");
      if (!_currentDevice.online) throw new Error("Camera feeder is offline.");
      if (!mounted) {
        await loadLocale(settings.language === "auto" ? "en" : settings.language || "en");
        if (disposed) return;
        host.innerHTML = buildLiveCameraView(_currentDevice);
        const deviceLink = document.createElement("a");
        deviceLink.className = "camera-device-link";
        deviceLink.href = `${BASE.replace(/\/$/, "")}/?device=${encodeURIComponent(serial)}`;
        deviceLink.target = "_top";
        deviceLink.setAttribute("aria-label", `Open ${_currentDevice.name || serial} Status in Petlibro Local`);
        host.querySelector(".overview-live-camera-overlay").prepend(deviceLink);
        syncBackgroundCameras();
        wireDeviceTabHandlers("overview");
        mounted = true;
      }
    } catch (error) {
      if (disposed) return;
      stopCameraTalk();
      stopLiveCamera();
      for (const key of _backgroundCameras.keys()) closeBackgroundCamera(key);
      mounted = false;
      message(error.message || "Camera unavailable. Retrying…");
    } finally {
      if (!disposed) timer = setTimeout(refreshCamera, 8000);
    }
  }
  document.addEventListener("visibilitychange", handleCameraVisibilityChange);
  window.addEventListener("pagehide", () => {
    disposed = true;
    clearTimeout(timer);
    stopCameraTalk();
    stopLiveCamera();
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) { disposed = false; mounted = false; refreshCamera(); }
  });
  refreshCamera();
})();
