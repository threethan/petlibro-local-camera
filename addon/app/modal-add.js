// ── Add device flow ────────────────────────────────────────────────────────
function openAddDevice() {
  if (!isMqttConfigured()) { checkMqttSetup(); return; }
  stopCapturePolling();
  setSetupError("");
  _wizardStep = 0;
  showNewDeviceStep(0);
  ["w-device-type","w-serial","w-mqtt-user","w-mqtt-pass","w-name","w-room",
   "a-serial","a-name","a-room","n-password"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  showAddView("method");
  document.getElementById("modal-add-device").classList.add("open");
}

function showAddView(view) {
  document.getElementById("add-method-select").style.display  = view === "method" ? "" : "none";
  document.getElementById("add-auto-flow").style.display      = view === "auto"   ? "" : "none";
  document.getElementById("add-manual-flow").style.display    = view === "manual" ? "" : "none";
  document.getElementById("add-new-flow").style.display       = view === "new"    ? "" : "none";
  if (view === "new") return autofillNewDeviceAddress();
}

async function autofillNewDeviceAddress() {
  const input = document.getElementById("n-broker");
  if (input.value.trim()) return;
  try {
    // This server-side lookup uses the HA host's route, including through ingress.
    const suggestion = await api("GET", "/api/settings/local-audio-url-suggestion");
    const host = new URL(suggestion.url).hostname;
    if (!input.value.trim()) input.value = host;
  } catch {
    // Leave the field available for manual entry if detection is unavailable.
  }
}

let _countdownTimer = null;
let _newDeviceSetup = false;
let _newDeviceBusy = false;
let _setupPollError = false;

function setSetupError(message) {
  const error = document.getElementById("setup-error");
  error.textContent = message ? `Setup failed: ${message}` : "";
  error.hidden = !message;
}

function showNewDeviceStep(step) {
  updateNewDeviceNext();
  [0, 1, 2].forEach(i => {
    document.getElementById(`new-step-${i}`).style.display = i === step ? "" : "none";
    const bar = document.getElementById(`new-progress-${i}`);
    bar.className = "wizard-step" + (i < step ? " done" : i === step ? " active" : "");
    if (i === step) bar.setAttribute("aria-current", "step");
    else bar.removeAttribute("aria-current");
  });
}

function updateNewDeviceNext() {
  const selected = !!document.getElementById("n-device").value;
  const next = document.getElementById("btn-new-next");
  next.style.display = selected ? "" : "none";
  next.disabled = !selected || _newDeviceBusy;
}

function nextNewDeviceStep() {
  if (_newDeviceBusy || !document.getElementById("n-device").value) return;
  document.getElementById("new-wifi-status").textContent = "";
  showNewDeviceStep(1);
}

async function scanNewDevices() {
  if (_newDeviceBusy) return;
  setSetupError("");
  _newDeviceBusy = true;
  const status = document.getElementById("new-status");
  const button = document.getElementById("btn-new-scan");
  const select = document.getElementById("n-device");
  select.replaceChildren();
  button.disabled = true;
  updateNewDeviceNext();
  status.textContent = "Scanning with Home Assistant's Bluetooth…";
  try {
    const result = await api("POST", "/api/provision/scan");
    for (const device of result.devices) {
      const option = document.createElement("option");
      option.value = device.address;
      option.textContent = `${device.name} · ${device.address} · ${device.rssi} dBm`;
      select.append(option);
    }
    status.textContent = result.devices.length ? "Select your device, then choose Next to enter its Wi-Fi settings." : "No pairing devices found. Check pairing mode and move closer to HA.";
  } catch (error) { status.textContent = error.message; }
  finally {
    button.disabled = false;
    _newDeviceBusy = false;
    updateNewDeviceNext();
  }
}

async function startNewDevice() {
  if (_newDeviceBusy) return;
  setSetupError("");
  const status = document.getElementById("new-wifi-status");
  const body = {
    address: document.getElementById("n-device").value,
    ssid: document.getElementById("n-ssid").value,
    password: document.getElementById("n-password").value,
    broker_ip: document.getElementById("n-broker").value.trim(),
  };
  if (!body.address || !body.ssid || !body.broker_ip) {
    status.textContent = "Select a device and enter the Wi-Fi name and Home Assistant LAN address.";
    return;
  }
  _newDeviceBusy = true;
  document.getElementById("btn-new-start").disabled = true;
  try {
    await api("POST", "/api/provision/start", body);
    _newDeviceSetup = true;
    document.getElementById("n-password").value = "";
    status.textContent = "";
    showNewDeviceStep(2);
    document.getElementById("new-connection-status").textContent = "Preparing Bluetooth provisioning…";
    _capturePolling = setInterval(pollAutoCapture, 2000);
  } catch (error) { status.textContent = error.message; }
  finally {
    body.password = "";
    _newDeviceBusy = false;
    document.getElementById("btn-new-start").disabled = false;
  }
}

async function cancelDeviceSetup() {
  stopCapturePolling();
  document.getElementById("n-password").value = "";
  try { await api("POST", "/api/capture/cancel"); }
  catch (error) { setSetupError(error.message); }
  _newDeviceSetup = false;
}

function showAutoStep(n) {
  [0, 1, 2].forEach(i => {
    document.getElementById(`auto-step-${i}`).style.display = i === n ? "" : "none";
  });
}

async function startAutoCapture() {
  setSetupError("");
  _newDeviceSetup = false;
  document.getElementById("auto-wait-title").textContent = t("add_device.waiting_stopped");
  document.getElementById("auto-app-hint").hidden = false;
  showAutoStep(1);
  let remaining = 62;
  const el = document.getElementById("auto-countdown");
  const tick = () => {
    remaining--;
    if (remaining > 0) el.textContent = t("add_device.countdown", {n: remaining});
    else { el.textContent = ""; clearInterval(_countdownTimer); }
  };
  el.textContent = t("add_device.countdown", {n: remaining});
  _countdownTimer = setInterval(tick, 1000);
  try {
    await api("POST", "/api/capture/start");
    _capturePolling = setInterval(pollAutoCapture, 2000);
  } catch(e) {
    clearInterval(_countdownTimer);
    showAutoStep(0);
    setSetupError(t("add_device.err_start", {error: e.message}));
  }
}

async function pollAutoCapture() {
  try {
    const s = await api("GET", "/api/capture/status");
    if (_setupPollError) { setSetupError(""); _setupPollError = false; }
    if (s.error) setSetupError(s.error);
    if (_newDeviceSetup && s.status === "capturing") {
      document.getElementById("new-connection-status").textContent = s.detail || "Waiting for MQTT credentials…";
    }
    if (s.status === "captured") {
      stopCapturePolling();
      clearInterval(_countdownTimer);
      const detected = detectFromClientId(s.result.client_id || "");
      document.getElementById("a-login-warn").style.display = s.login_saved === false ? "" : "none";
      if (s.detail) alert(s.detail);
      document.getElementById("a-serial").value = detected.serial || s.result.client_id || "";
      const sel = document.getElementById("a-device-type");
      if (detected.device_type) {
        for (const opt of sel.options) {
          if (opt.value === detected.device_type) { opt.selected = true; break; }
        }
        document.getElementById("a-type-warn").style.display = "none";
      } else {
        // Unrecognized serial prefix -- leave the placeholder selected rather
        // than silently defaulting to whatever option happens to be first in
        // the list, and warn so it's obvious manual selection is needed
        // (previously this defaulted to Dockstream 2 with no indication at
        // all, see issue #8).
        sel.value = "";
        document.getElementById("a-type-warn").style.display = "";
      }
      const capturedUser = s.result.username || "";
      const capturedPass = s.result.password || "";
      document.getElementById("a-serial").dataset.mqttUser = capturedUser;
      document.getElementById("a-serial").dataset.mqttPass = capturedPass;
      document.getElementById("a-cred-user").value = capturedUser;
      document.getElementById("a-cred-pass").value = capturedPass;
      const capturedSerial = detected.serial || s.result.client_id || "";
      const detectedVariant = detectVariantFromSerial(capturedSerial, detected.device_type || "");
      populateVariantSelect("a-variant", detected.device_type || "", detectedVariant);
      populateRoomSelect("a-room", "");
      populatePetSection("a-pet-section", "a-pet-list", "a-pet-optional", detected.device_type || "");
      await api("POST", "/api/capture/reset");
      _newDeviceSetup = false;
      showAddView("auto");
      showAutoStep(2);
    } else if (s.status === "timeout" || s.status === "error") {
      const message = s.detail || (s.status === "timeout"
        ? "Timed out waiting for the device to complete setup. Check pairing mode and network access, then retry."
        : "Device setup failed. Check the add-on logs for details.");
      setSetupError(message);
      stopCapturePolling();
      clearInterval(_countdownTimer);
      if (_newDeviceSetup) {
        setSetupError("");
        showNewDeviceStep(1);
        showAddView("new");
        document.getElementById("new-wifi-status").textContent = message;
        _newDeviceSetup = false;
        return;
      }
      showAutoStep(0);
    }
  } catch (error) {
    _setupPollError = true;
    setSetupError(`Cannot check setup status: ${error.message || "Home Assistant is unreachable"}. Retrying automatically…`);
  }
}

async function finishAutoDevice() {
  const serialEl = document.getElementById("a-serial");
  const serial = serialEl.value.trim().toUpperCase();
  if (!serial) { alert(t("add_device.err_serial")); return; }
  const typeEl = document.getElementById("a-device-type");
  if (!typeEl.value) { alert(t("add_device.err_type")); return; }
  const modelOpt = typeEl.options[typeEl.selectedIndex];
  const aVariant = document.getElementById("a-variant").value;
  const body = {
    serial,
    device_type: typeEl.value,
    model: modelOpt.dataset.model || "",
    mqtt_user: serialEl.dataset.mqttUser || "",
    mqtt_pass: serialEl.dataset.mqttPass || "",
    name: document.getElementById("a-name").value.trim() || t("add_device.default_name"),
    room: document.getElementById("a-room").value.trim(),
    variant: aVariant,
    image_url: deviceImageUrl(typeEl.value, aVariant),
    pet_ids: selectedPetIds("a-pet-list"),
  };
  try {
    await api("POST", "/api/devices", body);
    document.getElementById("modal-add-device").classList.remove("open");
    await refresh();
  } catch(e) { alert(t("add_device.err_add", {error: e.message})); }
}

function updateWizard() {
  [0, 1, 2].forEach(i => {
    document.getElementById(`wizard-step-${i}`).style.display = i === _wizardStep ? "" : "none";
    const dot = document.querySelector(`.wizard-step[data-mstep="${i}"]`);
    if (dot) dot.className = "wizard-step" + (i < _wizardStep ? " done" : i === _wizardStep ? " active" : "");
  });
  document.getElementById("btn-wizard-next").textContent = _wizardStep === 2 ? "Add Device" : "Next";
}

async function wizardNext() {
  if (_wizardStep === 0) {
    if (!document.getElementById("w-device-type").value) { alert(t("add_device.err_type")); return; }
    _wizardStep = 1; updateWizard();
  } else if (_wizardStep === 1) {
    if (!document.getElementById("w-serial").value.trim()) { alert(t("add_device.err_serial")); return; }
    if (!document.getElementById("w-mqtt-user").value.trim()) { alert(t("add_device.err_user")); return; }
    populateRoomSelect("w-room", "");
    populatePetSection("w-pet-section", "w-pet-list", "w-pet-optional", document.getElementById("w-device-type").value);
    _wizardStep = 2; updateWizard();
  } else if (_wizardStep === 2) {
    await finishManualDevice();
  }
}

function wizardBack() {
  if (_wizardStep === 0) showAddView("method");
  else { _wizardStep--; updateWizard(); }
}

async function finishManualDevice() {
  const typeEl = document.getElementById("w-device-type");
  const modelOpt = typeEl.options[typeEl.selectedIndex];
  const serial = document.getElementById("w-serial").value.trim().toUpperCase();
  const wVariant = document.getElementById("w-variant").value;
  const body = {
    serial,
    device_type: typeEl.value,
    model: modelOpt.dataset.model || "",
    mqtt_user: document.getElementById("w-mqtt-user").value.trim(),
    mqtt_pass: document.getElementById("w-mqtt-pass").value,
    name: document.getElementById("w-name").value.trim() || t("add_device.default_name"),
    room: document.getElementById("w-room").value.trim(),
    variant: wVariant,
    image_url: deviceImageUrl(typeEl.value, wVariant),
    pet_ids: selectedPetIds("w-pet-list"),
  };
  try {
    await api("POST", "/api/devices", body);
    document.getElementById("modal-add-device").classList.remove("open");
    await refresh();
  } catch(e) { alert(t("add_device.err_add", {error: e.message})); }
}

function stopCapturePolling() {
  if (_capturePolling) { clearInterval(_capturePolling); _capturePolling = null; }
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
}
