// ── Device detail modal ────────────────────────────────────────────────────
let _liveCameraPc = null;
let _liveCameraSession = null;
let _liveCameraSerial = null;
let _liveCameraPowerOwner = null;
let _liveCameraGeneration = 0;
const _cameraPowerOwners = new Map();
let _liveCameraPowerRequest = Promise.resolve();
function preferVP8(transceiver) {
  const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs;
  if (!codecs || !transceiver.setCodecPreferences) return;
  const vp8 = codecs.filter(codec => codec.mimeType.toLowerCase() === "video/vp8");
  if (vp8.length) {
    const preferred = new Set(vp8);
    transceiver.setCodecPreferences([...vp8, ...codecs.filter(codec => !preferred.has(codec))]);
  }
}
function setLiveCameraPower(serial, enabled) {
  _liveCameraPowerRequest = _liveCameraPowerRequest.catch(() => {}).then(async () => {
    await api("POST", `/api/devices/${encodeURIComponent(serial)}/command`, { cameraSwitch: enabled });
    _patchDevice(serial, { cameraSwitch: enabled });
    if (_currentDevice?.serial === serial) _currentDevice.cameraSwitch = enabled;
  });
  return _liveCameraPowerRequest;
}
function acquireCameraPower(serial, owner) {
  let lease = _cameraPowerOwners.get(serial);
  if (!lease) {
    lease = { owners: new Set(), ready: setLiveCameraPower(serial, true) };
    _cameraPowerOwners.set(serial, lease);
  }
  lease.owners.add(owner);
  return lease.ready;
}
function releaseCameraPower(serial, owner) {
  const lease = _cameraPowerOwners.get(serial);
  if (!lease || !lease.owners.delete(owner) || lease.owners.size) return;
  _cameraPowerOwners.delete(serial);
  setLiveCameraPower(serial, false).catch(() => {});
}
function stopLiveCamera(stopTalk = true) {
  if (stopTalk) stopCameraTalk();
  _liveCameraGeneration++;
  const powerOwner = _liveCameraPowerOwner;
  _liveCameraPowerOwner = null;
  if (_liveCameraPc) { _liveCameraPc.close(); _liveCameraPc = null; }
  if (_liveCameraSession) {
    fetch(`${BASE}/api/devices/${encodeURIComponent(_liveCameraSerial || "")}/camera/webrtc/${encodeURIComponent(_liveCameraSession)}`, { method: "DELETE", keepalive: true }).catch(() => {});
    _liveCameraSession = null;
  }
  _liveCameraSerial = null;
  const frame = document.getElementById("camera-live-frame");
  frame?.classList.remove("is-live");
  frame?.querySelector("video")?.remove();
  const placeholder = document.getElementById("camera-live-placeholder");
  if (placeholder) placeholder.style.display = "";
  const start = document.getElementById("camera-live-start");
  if (start) { start.textContent = "Click to start live view"; start.disabled = false; start.hidden = false; }
  const stop = document.getElementById("camera-live-stop");
  if (stop) stop.hidden = true;
  const sound = document.getElementById("camera-live-sound");
  if (sound) sound.hidden = true;
  const status = document.getElementById("camera-live-status");
  if (status) status.textContent = "";
  const vp8Hint = document.getElementById("camera-windows-vp8-hint");
  if (vp8Hint) vp8Hint.hidden = true;
  if (powerOwner) releaseCameraPower(powerOwner.serial, powerOwner);
}
function openDeviceModal(device) {
  stopLiveCamera();
  _currentDevice = device;
  _currentDeviceTab = "overview";

  const imgEl = document.getElementById("detail-img");
  const imageUrl = device.image_url || (device.device_type === "camera_feeder"
    ? deviceImageUrl(device.device_type, device.variant || "b")
    : "");
  imgEl.innerHTML = imageUrl
    ? `<img src="${escHtml(imageUrl)}" alt="">`
    : `<span class="material-icons">${deviceIcon(device)}</span>`;

  document.getElementById("detail-name").textContent = device.name || device.device_type || device.serial;
  document.getElementById("detail-room").textContent = device.room || "";

  const badge = document.getElementById("detail-status-badge");
  badge.textContent = device.online ? t("device.online") : t("device.offline");
  badge.className = `status-badge ${device.online ? "online" : "offline"}`;

  const rssiEl = document.getElementById("detail-rssi");
  rssiEl.className = `rssi-badge ${rssiClass(device.rssi)}`;
  rssiEl.textContent = rssiLabel(device.rssi);
  const fwEl = document.getElementById("detail-fw");
  if (device.softwareVersion) {
    fwEl.textContent = `fw: ${device.softwareVersion}`;
    fwEl.style.display = "";
  } else {
    fwEl.style.display = "none";
  }

  const hwEl = document.getElementById("detail-hw");
  if (device.hardwareVersion) {
    hwEl.textContent = `hw: ${device.hardwareVersion}`;
    hwEl.style.display = "";
  } else {
    hwEl.style.display = "none";
  }

  const powerEl = document.getElementById("detail-power");
  if (device.device_type === "one_rfid" && device.electricQuantity != null && device.electricQuantity > 0) {
    const onAC = device.powerType !== 2;
    powerEl.innerHTML = onAC ? `<span class="material-icons">electric_plug</span> ${t("power.ac")}` : `<span class="material-icons">battery_charging</span> ${device.electricQuantity}%`;
    powerEl.style.display = "";
  } else {
    powerEl.style.display = "none";
  }

  // Device clock vs real time, from heartbeats. Positive = device is slow.
  // The add-on pushes a correction itself past ~30s, so this normally reads
  // "in sync"; a lingering large value means the device ignored the push.
  const clockEl = document.getElementById("detail-clock");
  const off = device.clock_offset_secs;
  if (device.online && off != null) {
    if (Math.abs(off) <= 30) {
      clockEl.style.display = "none";
    } else {
      const mag = Math.abs(off) >= 120 ? `${Math.round(Math.abs(off) / 60)}m` : `${Math.abs(off)}s`;
      clockEl.innerHTML = off > 0 ? `${t("clock.slow", { n: mag })}` : `${t("clock.fast", { n: mag })}`;
      clockEl.style.display = "";
    }
  } else {
    clockEl.style.display = "none";
  }

  const isFeeder = device.device_type === "one_rfid" || device.device_type === "granary" || device.device_type === "camera_feeder";
  const isFountain = device.device_type?.startsWith("dockstream");
  document.getElementById("device-tabs").style.display = device.online ? "" : "none";
  document.querySelectorAll(".dtab").forEach(b => {
    b.classList.toggle("active", b.dataset.dtab === "overview");
    if (b.dataset.dtab === "log") b.style.display = "";
    if (b.dataset.dtab === "schedule") b.style.display = isFeeder ? "" : "none";
    if (b.dataset.dtab === "led") b.style.display = device.device_type === "one_rfid" ? "" : "none";
    if (b.dataset.dtab === "controls") b.style.display = isFountain ? "" : "none";
    if (b.dataset.dtab === "camera") b.style.display = "none";
    if (b.dataset.dtab === "sensors") b.style.display = device.device_type === "camera_feeder" ? "" : "none";
    if (b.dataset.dtab === "camera-sound") b.style.display = "none";
    if (b.dataset.dtab === "maintenance") b.style.display = "";
  });

  renderDeviceTab("overview");

  document.getElementById("btn-detail-edit").onclick = openEditDevice;
  document.getElementById("modal-device").classList.add("open");
}

function renderDeviceTab(tabName) {
  // Accept former internal keys used by cached markup or older integrations.
  if (["device-settings", "options", "camera-motion", "camera-video"].includes(tabName)) tabName = "sensors";
  if (tabName === "camera-sound") tabName = "overview";
  if (_currentDevice && !_currentDevice.online) {
    _currentDeviceTab = "offline";
    document.getElementById("device-tabs").style.display = "none";
    document.getElementById("dtab-content").innerHTML = buildOfflineTroubleshooting();
    return;
  }
  document.getElementById("device-tabs").style.display = "";
  if (tabName !== "overview" || _currentDevice.device_type !== "camera_feeder") stopCameraTalk();
  _currentDeviceTab = tabName;
  const content = document.getElementById("dtab-content");
  if (tabName === "overview") content.innerHTML = buildOverviewTab(_currentDevice);
  else if (tabName === "controls") content.innerHTML = buildControlsTab(_currentDevice);
  else if (tabName === "sensors") content.innerHTML = buildCameraSettingsTab(_currentDevice, "sensors");
  else if (tabName === "led") content.innerHTML = buildLedTab(_currentDevice);
  else if (tabName === "maintenance") content.innerHTML = buildMaintenanceTab(_currentDevice);
  else if (tabName === "log") {
    content.innerHTML = `<p style="color:var(--pl-subtext);padding:16px 0;text-align:center">Loading...</p>`;
    if (_currentDevice.device_type === "one_rfid" || _currentDevice.device_type === "granary" || _currentDevice.device_type === "camera_feeder") {
      api("GET", `/api/devices/${_currentDevice.serial}/feeder-log`)
        .then(log => { content.innerHTML = buildFeederLogTab(_currentDevice, log); })
        .catch(() => { content.innerHTML = `<p style="color:var(--pl-danger);padding:16px 0">${t("device_modal.load_failed_log")}</p>`; });
    } else if (_currentDevice.device_type?.startsWith("dockstream")) {
      api("GET", `/api/devices/${_currentDevice.serial}/fountain-log`)
        .then(log => { content.innerHTML = buildFountainLogTab(_currentDevice, log); })
        .catch(() => { content.innerHTML = `<p style="color:var(--pl-danger);padding:16px 0">${t("device_modal.load_failed_log")}</p>`; });
    } else {
      api("GET", `/api/devices/${_currentDevice.serial}/intake?days=7`)
        .then(history => { content.innerHTML = buildLogTab(_currentDevice, history); })
        .catch(() => { content.innerHTML = `<p style="color:var(--pl-danger);padding:16px 0">${t("device_modal.load_failed_intake")}</p>`; });
    }
    return;
  }
  else if (tabName === "schedule") {
    content.innerHTML = `<p style="color:var(--pl-subtext);padding:16px 0;text-align:center">Loading...</p>`;
    api("GET", `/api/devices/${_currentDevice.serial}/feeding-plans`)
      .then(plans => {
        _schedPlans = plans;
        content.innerHTML = buildScheduleTab(plans);
        wireScheduleTabHandlers();
      })
      .catch(() => { content.innerHTML = `<p style="color:var(--pl-danger);padding:16px 0">${t("device_modal.load_failed_schedule")}</p>`; });
    return;
  }
  else if (tabName === "notifications") content.innerHTML = buildNotificationsTab(_currentDevice);
  wireDeviceTabHandlers(tabName);
}

function buildOfflineTroubleshooting() {
  return `<section class="offline-help">
    <h2>${escHtml(t("device.offline_help_title"))}</h2>
    <p>${escHtml(t("device.offline_help_intro"))}</p>
    <ol>
      <li>${escHtml(t("device.offline_help_power"))}</li>
      <li>${escHtml(t("device.offline_help_wifi"))}</li>
      <li>${escHtml(t("device.offline_help_restart"))}</li>
    </ol>
    <p class="offline-help-note">${escHtml(t("device.offline_help_wait"))}</p>
  </section>`;
}

function buildCameraStorageStatus(device) {
  const number = value => (typeof value === "number" && Number.isInteger(value) && value >= 0) || (typeof value === "string" && /^\d{1,20}$/.test(value)) ? Number(value) : null;
  const state = number(device.sdCardState), total = number(device.sdCardTotalCapacity), used = number(device.sdCardUsedCapacity);
  const mb = value => value === null ? "Unknown" : `${value} MB`;
  const status = ({0: "Not available", 1: "Available", 2: "Initializing"})[state] || "Unknown";
  const free = total !== null && used !== null && used <= total ? total - used : null;
  return `<section class="camera-settings-section"><header class="camera-settings-header"><h3>SD card</h3></header><div class="camera-settings-body">
    <p class="form-hint">Last reported by the feeder.</p>
    <div class="form-row"><span>Status</span><strong>${escHtml(status)}</strong></div>
    <div class="form-row"><span>Filesystem</span><strong>${escHtml(typeof device.sdCardFileSystem === "string" ? device.sdCardFileSystem : "Unknown")}</strong></div>
    <div class="form-row"><span>Total / Used / Free</span><strong>${escHtml(`${mb(total)} / ${mb(used)} / ${mb(free)}`)}</strong></div>
    <div class="form-row"><span>Recording capability</span><strong>${device.enableVideoRecord === true ? "Supported" : device.enableVideoRecord === false ? "Unavailable" : "Unknown"}</strong></div>
  </div></section>`;
}

function buildCameraSettingsTab(device, category = "all") {
  const row = (label, field, value, type = "text", extra = "") => `<div class="form-row"><label class="form-label">${label}</label><input class="form-input" data-camera-setting="${field}" type="${type}" value="${escHtml(String(value ?? ""))}" ${extra}></div>`;
  const choice = (label, field, value, options) => `<div class="form-row"><label class="form-label">${label}</label><select class="form-select" data-camera-setting="${field}">${options.map(([v, text]) => `<option value="${v}" ${String(value) === String(v) ? "selected" : ""}>${text}</option>`).join("")}</select></div>`;
  const section = (title, field, enabled, content, options = {}) => `<section class="camera-settings-section">
    <header class="camera-settings-header"><h3>${title}</h3><button type="button" class="toggle-switch ${enabled ? "sw-on" : "sw-off"}" data-camera-setting="${field}" data-toggle="true" aria-label="Enable ${title}" ${options.toggleHidden ? "hidden" : ""}></button></header>
    <div class="camera-settings-body" ${enabled || options.bodyOpen ? "" : "hidden"}>${content}</div>
    ${options.trailing || ""}
  </section>`;
  const schedule = (name, agingField, agingType, startField, startValue, endField, endValue, leadingControl = "", trailingControl = "") => {
    const scheduled = Number(agingType ?? 1) === 2;
    return `<div class="camera-sound-controls">${leadingControl}<label class="small-toggle-row"><span>Schedule</span><input class="small-toggle" type="checkbox" data-camera-setting="${agingField}" data-toggle-kind="all-day" ${scheduled ? "checked" : ""}></label>${trailingControl}</div>
      <div class="camera-time-grid" data-schedule-times="${name}" ${scheduled ? "" : "hidden"}>
        ${row("", startField, startValue, "time")}<span class="camera-time-separator">to</span>${row("", endField, endValue, "time")}
      </div>`;
  };
  const show = name => category === "all" || category === name ||
    (category === "sensors" && ["video", "sound-detection", "motion", "recording", "feeding-video"].includes(name)) ||
    (category === "overview" && ["sound", "indicators"].includes(name));
  const utcToLocalOrEmpty = value => value ? _utcToLocal(value) : "";
  const powerWithLiveView = device.camera_power_with_live_view === true;
  const powerWithLiveViewControl = `<div class="camera-ha-expose-row">
      <div class="camera-ha-expose-copy">
        <span class="camera-ha-expose-label">${t("settings.camera_power_with_live_view")}</span>
        <p class="camera-ha-expose-hint">${t("settings.camera_power_with_live_view_hint")}</p>
      </div>
      <button type="button" id="camera-power-with-live-view" role="switch" aria-checked="${powerWithLiveView}" aria-label="${t("settings.camera_power_with_live_view")}" class="toggle-switch camera-ha-expose-toggle ${powerWithLiveView ? "sw-on" : "sw-off"}"></button>
    </div>`;
  const exposureControl = `<div class="camera-ha-expose-row" id="camera-ha-expose-row" ${powerWithLiveView ? "hidden" : ""}>
      <div class="camera-ha-expose-copy">
        <span class="camera-ha-expose-label">Live Camera in Home Assistant</span>
        <p class="camera-ha-expose-hint">Adds or removes a separate live camera entity in Home Assistant. Can use more CPU. The snapshot camera is available either way.</p>
        <span id="camera-ha-expose-status" role="status" class="camera-ha-expose-status"></span>
      </div>
      <button type="button" id="camera-ha-expose" role="switch" aria-checked="${device.live_camera_exposed === true}" aria-label="Live Camera in Home Assistant" class="toggle-switch camera-ha-expose-toggle ${device.live_camera_exposed === true ? "sw-on" : "sw-off"}"></button>
    </div>`;
  return `${show("video") ? section("Camera", "cameraSwitch", device.cameraSwitch !== false, `
      <div class="camera-settings-grid">${choice(t("settings.camera_resolution"), "resolution", device.resolution || "P1080", [["P1080","1080p"],["P720","720p"]])}${choice(t("settings.camera_night_vision"), "nightVision", device.nightVision || "OPEN", [["AUTOMATIC","Automatic"],["OPEN","Always on"],["CLOSE","Off"]])}</div>
      ${schedule("camera", "cameraAgingType", device.cameraAgingType, "cameraStartTime", device.camera_start_local || "00:00", "cameraEndTime", device.camera_end_local || "23:59", "", `<label class="small-toggle-row"><span>PetLibro Watermark &amp; Time</span><input class="small-toggle" type="checkbox" data-camera-setting="videoWatermarkSwitch" ${device.videoWatermarkSwitch !== false ? "checked" : ""}></label>`)}
    `, { toggleHidden: powerWithLiveView, bodyOpen: powerWithLiveView, trailing: powerWithLiveViewControl + exposureControl }) : ""}
    ${show("indicators") ? section("Indicator lights", "lightSwitch", device.lightSwitch !== false, `
      ${schedule("indicators", "lightAgingType", device.lightAgingType, "lightingStartTime", device.lightingStartTime || utcToLocalOrEmpty(device.lightingStartTimeUtc) || "00:00", "lightingEndTime", device.lightingEndTime || utcToLocalOrEmpty(device.lightingEndTimeUtc) || "23:59")}
      <p class="form-hint">Lights stay on all day with Schedule off. With Schedule on, choose the hours when indicator lights are enabled. Hours use the configured feeder timezone.</p>
    `) : ""}
    ${show("recording") ? buildCameraStorageStatus(device) + section("SD card recording", "videoRecordSwitch", device.videoRecordSwitch === true, `
      <p class="form-hint">The feeder saves video to its SD card. Motion recording also requires Motion Detection to be enabled with overlapping hours.</p>
      ${choice("Recording mode", "videoRecordMode", device.videoRecordMode || "CONTINUOUS", [["CONTINUOUS", "Continuous"], ["MOTION_DETECTION", "Motion detection"]])}
      ${schedule("recording", "videoRecordAgingType", device.videoRecordAgingType, "videoRecordStartTime", device.videoRecordStartTime || utcToLocalOrEmpty(device.videoRecordStartTimeUtc) || "00:00", "videoRecordEndTime", device.videoRecordEndTime || utcToLocalOrEmpty(device.videoRecordEndTimeUtc) || "23:59")}
      <p class="form-hint">Hours use the configured feeder timezone. Overnight schedules are supported.</p>
    `) : ""}
    ${show("feeding-video") ? section("Feeding video", "feedingVideoSwitch", device.feedingVideoSwitch === true, `
      <label class="small-toggle-row"><span>Record scheduled feeding</span><input class="small-toggle" type="checkbox" data-camera-setting="enableVideoStartFeedingPlan" ${device.enableVideoStartFeedingPlan === true ? "checked" : ""}></label>
      ${row("Minutes before scheduled feeding", "beforeFeedingPlanTime", device.beforeFeedingPlanTime ?? 1, "number", 'min="1" max="5" step="1"')}
      ${row("Automatic recording duration (minutes)", "automaticRecording", device.automaticRecording ?? 1, "number", 'min="1" max="5" step="1"')}
      <label class="small-toggle-row"><span>Record after manual feeding</span><input class="small-toggle" type="checkbox" data-camera-setting="enableVideoAfterManualFeeding" ${device.enableVideoAfterManualFeeding === true ? "checked" : ""}></label>
      ${row("Minutes after manual feeding", "afterManualFeedingTime", device.afterManualFeedingTime ?? 1, "number", 'min="1" max="5" step="1"')}
    `) : ""}
    ${show("sound") ? section(t("settings.sound_tab"), "soundSwitch", device.soundSwitch !== false, `
      ${schedule("sound", "soundAgingType", device.soundAgingType, "soundStartTime", device.sound_start_local || "00:00", "soundEndTime", device.sound_end_local || "23:59", `
        <div class="camera-volume-control">
          <label class="form-label" for="camera-sound-volume">${t("settings.sound_volume")} <output for="camera-sound-volume">${device.volume ?? 50}</output></label>
          <input id="camera-sound-volume" data-camera-setting="volume" type="range" min="0" max="100" step="1" value="${device.volume ?? 50}">
        </div>`)}
    `) : ""}
    ${show("motion") ? section("Motion Detection", "motionDetectionSwitch", device.motionDetectionSwitch !== false, `
      <div class="camera-settings-grid">${choice("Sensitivity", "motionDetectionSensitivity", device.motionDetectionSensitivity || "MEDIUM", [["LOW","Low"],["MEDIUM","Medium"],["HIGH","High"]])}${choice("Range", "motionDetectionRange", device.motionDetectionRange || "MEDIUM", [["SMALL","Small"],["MEDIUM","Medium"],["LARGE","Large"]])}</div>
      ${schedule("motion", "motionDetectionAgingType", device.motionDetectionAgingType, "motionDetectionStartTime", device.motion_start_local || "00:00", "motionDetectionEndTime", device.motion_end_local || "23:59")}
    `) : ""}
    ${show("sound-detection") ? section(t("settings.sound_detection"), "soundDetectionSwitch", device.soundDetectionSwitch !== false, `
      <div class="camera-settings-grid">${choice(t("settings.sound_detection_sensitivity"), "soundDetectionSensitivity", device.soundDetectionSensitivity || "MEDIUM", [["LOW","Low"],["MEDIUM","Medium"],["HIGH","High"]])}</div>
      ${schedule("sound-detection", "soundDetectionAgingType", device.soundDetectionAgingType, "soundDetectionStartTime", device.sound_detection_start_local || utcToLocalOrEmpty(device.soundDetectionStartTimeUtc) || "00:00", "soundDetectionEndTime", device.sound_detection_end_local || utcToLocalOrEmpty(device.soundDetectionEndTimeUtc) || "23:59")}
    `) : ""}
    <p class="form-hint" id="camera-settings-status" role="status"></p>${category === "sensors" ? `<p class="form-hint">Sound &amp; motion sensors can be configured as triggers in Home Assistant.</p>` : ""}`;
}

// ── Overview tab ──────────────────────────────────────────────────────────
function buildOverviewTab(device) {
  const filterDays = filterDaysRemaining(device);
  const filterClass = filterDays != null && filterDays <= 3 ? "danger" : "accent";
  const cleanDays = cleaningDaysRemaining(device);
  const cleanClass = cleanDays != null && cleanDays < 1 ? "danger" : "";
  const intakeHtml = device.intake_today_grams > 0
    ? `<div class="detail-stat">
        <div class="detail-stat-label">${t("overview.intake_today")}</div>
        <div class="detail-stat-value accent">${escHtml(fmtWater(device.intake_today_grams))}</div>
      </div>`
    : "";
  const cleanHtml = cleanDays != null
    ? `<div class="detail-stat">
        <div class="detail-stat-label">${t("overview.next_clean")}</div>
        <div class="detail-stat-value ${cleanClass}">${escHtml(fmtDays(Math.max(0, cleanDays)))}</div>
      </div>`
    : "";

  let petIntakeHtml = "";
  if (device.device_type === "dockstream_rfid") {
    const pets = device.pets || [];
    if (pets.length) {
      const rows = pets.map(p => `
      <div class="intake-row">
        <div class="intake-avatar">${p.image_url ? `<img src="${escHtml(p.image_url)}" alt="${escHtml(p.name)}">` : `<span class="material-icons">pets</span>`}</div>
        <div class="intake-info">
          <div class="intake-name">${escHtml(p.name || t("pet.unnamed"))}</div>
          <div class="intake-stats">${p.visits ? t("overview.pet_intake_stats", {duration: fmtDuration(p.duration_secs || 0), n: p.visits}) : t("overview.pet_intake_none")}</div>
        </div>
        <div class="intake-value">${escHtml(fmtWater(p.grams || 0))}</div>
      </div>`).join("");
      petIntakeHtml = `
  <div class="tab-section-heading" style="margin-top:18px">${t("overview.pet_activity")}</div>
  <div class="intake-list">${rows}</div>`;
    }
  }

  if (device.device_type === "one_rfid") {
    const foodOk     = device.surplusGrain;
    const foodClass  = foodOk === false ? "danger" : "accent";
    const powerIsAC  = device.powerType !== 2;
    const hasBattery = device.electricQuantity != null && device.electricQuantity > 0;
    const lowPct     = device.battery_low_pct ?? 20;
    const battClass  = hasBattery && device.electricQuantity <= lowPct ? "danger" : "";
    const closeSpeed = device.coverCloseSpeed ?? "FAST";
    const openMode   = device.coverOpenMode   ?? "CUSTOM";
    const closeSec   = device.closeDoorTimeSec ?? 10;
    const childLock  = device.childLockSwitch  ?? false;
    const soundOn    = device.soundSwitch !== false;
    const foodLabel = foodOk === false ? t("food.low") : foodOk === true ? t("food.ok") : "—";
    const battPct  = hasBattery
      ? `${device.electricQuantity}% (${powerIsAC ? t("power.ac") : t("power.battery")})`
      : (powerIsAC ? t("power.ac") : "—");
    return `<div class="detail-stats">
      <div class="detail-stat" style="padding:8px 14px">
        <div class="detail-stat-label">${t("overview.food_level")}</div>
        <div class="detail-stat-value ${foodClass}">${foodLabel}</div>
      </div>
      <div class="detail-stat" style="padding:8px 14px">
        <div class="detail-stat-label">${t("overview.battery")}</div>
        <div class="detail-stat-value ${battClass}">${battPct}</div>
      </div>
    </div>
    <div style="margin-top:16px">
      <div class="tab-section-heading">${t("overview.controls")}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <label style="white-space:nowrap;font-size:13px;color:var(--pl-subtext)">${t("overview.portions")}</label>
        <select class="form-input" id="feeder-portions" style="width:110px">
          <option value="1" selected>${fmtPortions(1, device.calibrated_grams_per_portion, device.feed_unit)}</option>
          <option value="2">${fmtPortions(2, device.calibrated_grams_per_portion, device.feed_unit)}</option>
          <option value="3">${fmtPortions(3, device.calibrated_grams_per_portion, device.feed_unit)}</option>
          <option value="4">${fmtPortions(4, device.calibrated_grams_per_portion, device.feed_unit)}</option>
          <option value="5">${fmtPortions(5, device.calibrated_grams_per_portion, device.feed_unit)}</option>
        </select>
        <button class="btn-primary" id="btn-feed-now" style="flex:1">${t("overview.feed_now")}</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn-secondary" id="btn-open-lid" style="flex:1">${t("overview.open_lid")}</button>
        <button class="btn-secondary" id="btn-close-lid" style="flex:1">${t("overview.close_lid")}</button>
      </div>
    </div>
    <div style="margin-top:16px">
      <div class="form-row">
        <label class="form-label">${t("overview.lid_mode")}</label>
        <select class="form-input" id="feeder-cover-open-mode">
          <option value="KEEP_CLOSE" ${openMode === "KEEP_CLOSE" ? "selected" : ""}>${t("overview.lid_always_closed")}</option>
          <option value="CUSTOM"     ${openMode === "CUSTOM"     ? "selected" : ""}>${t("overview.lid_auto_close")}</option>
          <option value="KEEP_OPEN"  ${openMode === "KEEP_OPEN"  ? "selected" : ""}>${t("overview.lid_stay_open")}</option>
        </select>
      </div>
      <div style="display:flex;gap:8px">
        <div style="flex:1">
          <label class="form-label">${t("overview.close_speed")}</label>
          <select class="form-input" id="feeder-cover-close-speed">
            <option value="FAST" ${closeSpeed === "FAST" ? "selected" : ""}>${t("overview.close_speed_fast")}</option>
            <option value="SLOW" ${closeSpeed === "SLOW" ? "selected" : ""}>${t("overview.close_speed_slow")}</option>
          </select>
        </div>
        <div style="flex:1">
          <label class="form-label">${t("overview.auto_close_sec")}</label>
          <input class="form-input" id="feeder-close-door-sec" type="number" min="1" max="10" value="${closeSec}">
        </div>
      </div>
      <div class="form-row" style="align-items:center;gap:16px;flex-wrap:wrap;margin-top:8px">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="feeder-sound-switch" ${soundOn ? "checked" : ""}> ${t("overview.sound")}
        </label>
        ${device.device_type !== "camera_feeder" ? `
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="feeder-child-lock" ${childLock ? "checked" : ""}> ${t("overview.child_lock")}
        </label>
        ` : ''}
      </div>
      ${_hoursBlock("hrs-sound", t("hours.sound_heading"),
          device.sound_hours_mode || (device.soundAgingType === 2 ? "custom" : "all"),
          device.sound_start_local || (device.soundStartTimeUtc ? _utcToLocal(device.soundStartTimeUtc) : ""), device.sound_end_local || (device.soundEndTimeUtc ? _utcToLocal(device.soundEndTimeUtc) : ""),
          t("hours.sound_hint"))}
    </div>
    ${(!device.pets?.length) ? `
    <div style="background:rgba(224,168,85,.12);border:1px solid rgba(224,168,85,.5);color:var(--pl-warning);border-radius:var(--pl-radius-sm);padding:10px 12px;font-size:13px;margin-top:14px;line-height:1.5">
      ${t("overview.no_pets")}
    </div>` : ""}`;
  }

  if (device.device_type === "granary" || device.device_type === "camera_feeder") {
    // Both feeder types share the Granary controls; the registered model
    // selects the correct MQTT product topic for device commands.
    const foodOk     = device.surplusGrain;
    const foodClass  = foodOk === false ? "danger" : "accent";
    const foodLabel  = foodOk === false ? t("food.low") : foodOk === true ? t("food.ok") : "—";
    const hasBattery = device.electricQuantity != null && device.electricQuantity > 0;
    const lowPct     = device.battery_low_pct ?? 20;
    const battClass  = hasBattery && device.electricQuantity <= lowPct ? "danger" : "";
    const battLabel  = hasBattery ? `${device.electricQuantity}%` : "—";
    const lightOn    = !!device.lightSwitch;
    const lockOn     = !!device.disableHardwareButton;
    const ua = navigator.userAgent || "";
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    const brands = navigator.userAgentData?.brands?.map(brand => brand.brand).join(" ") || "";
    const isWindowsChrome = /windows/i.test(`${platform} ${ua}`)
      && (/chrome/i.test(brands) || /Chrome\//.test(ua))
      && !/Edg|OPR|Opera/i.test(`${brands} ${ua}`);
    const liveCameraHtml = device.device_type === "camera_feeder" ? `<section class="overview-live-camera">
      ${isWindowsChrome ? `<div class="detail-stat" id="camera-windows-vp8-hint" hidden>${t("camera.windows_vp8_hint")}</div>` : ""}
      <div class="tab-section-heading">Live camera</div>
      <div class="overview-live-camera-frame" id="camera-live-frame">
        <button type="button" class="overview-live-camera-start" id="camera-live-start">Click to start live view</button>
        <div class="overview-live-camera-controls" id="camera-live-controls" aria-label="Live camera settings">
          <label title="Resolution"><span class="material-icons" aria-hidden="true">high_quality</span><select id="camera-live-resolution" aria-label="Resolution"><option value="P1080">1080p</option><option value="P720">720p</option></select></label>
          <label title="Night vision"><span class="material-icons" aria-hidden="true">nightlight</span><select id="camera-live-night-vision" aria-label="Night vision"><option value="AUTOMATIC">Auto</option><option value="OPEN">On</option><option value="CLOSE">Off</option></select></label>
          <button type="button" class="overview-live-camera-sound" id="camera-live-sound" aria-label="Turn camera sound on" title="Turn sound on" hidden><span class="material-icons" aria-hidden="true">volume_off</span></button>
          <button type="button" class="overview-live-camera-stop" id="camera-live-stop" aria-label="Stop live view"><span class="material-icons" aria-hidden="true">stop</span></button>
        </div>
        <span class="overview-live-camera-status" id="camera-live-status" role="status" aria-live="polite"></span>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:10px">
        <button type="button" class="btn-secondary" id="camera-talk-toggle" aria-label="Talk" aria-pressed="false" aria-describedby="camera-talk-status"><span class="material-icons" aria-hidden="true">mic</span></button>
        <span id="camera-talk-status" class="form-hint" role="status" aria-live="polite">Use your microphone to talk to the feeder.</span>
      </div>
    </section>` : "";
    return `${liveCameraHtml}<div class="detail-stats">
      <div class="detail-stat" style="padding:8px 14px">
        <div class="detail-stat-label">${t("overview.food_level")}</div>
        <div class="detail-stat-value ${foodClass}">${foodLabel}</div>
      </div>
      <div class="detail-stat" style="padding:8px 14px">
        <div class="detail-stat-label">${t("overview.battery")}</div>
        <div class="detail-stat-value ${battClass}">${battLabel}</div>
      </div>
    </div>
    <div style="margin-top:16px">
      <div class="tab-section-heading">${t("overview.controls")}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <label style="white-space:nowrap;font-size:13px;color:var(--pl-subtext)">${t("overview.portions")}</label>
        <select class="form-input" id="feeder-portions" style="width:110px">
          <option value="1" selected>${fmtPortions(1, device.calibrated_grams_per_portion, device.feed_unit)}</option>
          <option value="2">${fmtPortions(2, device.calibrated_grams_per_portion, device.feed_unit)}</option>
          <option value="3">${fmtPortions(3, device.calibrated_grams_per_portion, device.feed_unit)}</option>
          <option value="4">${fmtPortions(4, device.calibrated_grams_per_portion, device.feed_unit)}</option>
          <option value="5">${fmtPortions(5, device.calibrated_grams_per_portion, device.feed_unit)}</option>
        </select>
        <button class="btn-primary" id="btn-feed-now" style="flex:1">${t("overview.feed_now")}</button>
      </div>
    </div>
    <div class="toggle-list" style="margin-top:16px">
      <div class="toggle-row">
        <span class="toggle-label">${t("overview.light")}</span>
        <button class="toggle-switch ${lightOn ? "sw-on" : "sw-off"}" id="ctrl-granary-light"></button>
      </div>
      ${device.device_type !== "camera_feeder" ? `
      <div class="toggle-row">
        <span class="toggle-label">${t("overview.buttons_lock")}</span>
        <button class="toggle-switch ${lockOn ? "sw-on" : "sw-off"}" id="ctrl-granary-lock"></button>
      </div>
      ` : ''}
    </div>
    ${device.device_type === "camera_feeder" ? buildCameraSettingsTab(device, "overview") : ""}`;
  }

  return `<div class="detail-stats">
    <div class="detail-stat">
      <div class="detail-stat-label">${t("overview.water_level")}</div>
      <div class="detail-stat-value accent">${escHtml(fmtWater(device.currentWeight ?? null))}</div>
    </div>
    <div class="detail-stat">
      <div class="detail-stat-label">${t("overview.filter_due")}</div>
      <div class="detail-stat-value ${filterClass}">${escHtml(fmtDays(filterDays))}</div>
    </div>
    ${intakeHtml}
    ${cleanHtml}
  </div>${petIntakeHtml}`;
}

// Polls /api/devices for a scale-calibration ack newer than sentAt, up to
// ~6s. Returns "container" (code 3007 -- water container still on the
// scale), "ok" (a response carrying the "zero_standar" baseline msg), or
// "unknown" if nothing definitive showed up in the window.
async function _pollCalibrationResult(serial, sentAt) {
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const list = await api("GET", "/api/devices");
      const dev = list.find(x => x.serial === serial);
      const cal = dev && dev._scale_calibration;
      if (cal && cal.ts >= sentAt - 2000) {
        if (cal.code === 3007) return "container";
        if ((cal.msg || "").includes("zero_standar")) return "ok";
      }
    } catch(e) {}
  }
  return "unknown";
}

// ── Controls tab (fountains) ──────────────────────────────────────────────
function buildControlsTab(device) {
  const pumpOn = !device.waterStopSwitch;
  const lightOn = !!device.lightSwitch;
  const filterLedOn = !!device.filterLedSwitch;
  const waterType = device.useWaterType ?? 0;
  const waterInterval = device.useWaterInterval ?? 15;
  const waterDuration = device.useWaterDuration ?? 15;
  const lightStart = device.light_start_time || "08:00";
  const lightEnd = device.light_end_time || "20:00";
  const soundSwitch = device.soundSwitch;
  const soundVolume = device.volume ?? 50;
  const motionDetection = device.motionDetectionSwitch;
  const cameraOn = device.cameraSwitch;
  // lightAgingType 1=static/manual, 2=scheduled. Confirmed working on real
  // hardware, both directions -- see toggles.js's toggleLightScheduleEnabled
  // for the history of what it took to get here.
  const scheduleEnabled = device.lightAgingType === 2;
  return `
  <div class="toggle-list">
    <div class="toggle-row">
      <span class="toggle-label">${t("overview.pump")}</span>
      <button class="toggle-switch ${pumpOn ? "sw-on" : "sw-off"}" id="ctrl-pump"></button>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">${t("overview.light")}</span>
      <button class="toggle-switch ${lightOn ? "sw-on" : "sw-off"}" id="ctrl-light"></button>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">${t("overview.filter_indicator")}</span>
      <button class="toggle-switch ${filterLedOn ? "sw-on" : "sw-off"}" id="ctrl-filter-led"></button>
    </div>
  </div>
  <p class="form-hint">${t("overview.filter_indicator_hint")}</p>
  <div class="form-row">
    <label class="form-label">${t("overview.flow_mode")}</label>
    <select class="form-select" id="ctrl-water-type">
      <option value="0" ${waterType === 0 ? "selected" : ""}>${t("overview.flow_continuous")}</option>
      <option value="1" ${waterType === 1 ? "selected" : ""}>${t("overview.flow_intermittent")}</option>
      <option value="2" ${waterType === 2 ? "selected" : ""}>${t("overview.flow_smart")}</option>
    </select>
  </div>
  <div id="intermittent-settings" style="${waterType === 1 ? "" : "display:none"}">
    <div class="form-row">
      <label class="form-label">${t("overview.on_duration")}</label>
      <input class="form-input" id="ctrl-water-duration" type="number" min="1" max="60" value="${waterDuration}">
    </div>
    <div class="form-row">
      <label class="form-label">${t("overview.off_interval")}</label>
      <input class="form-input" id="ctrl-water-interval" type="number" min="1" max="120" value="${waterInterval}">
    </div>
    <button class="btn-primary" id="btn-apply-schedule">${t("overview.apply_schedule")}</button>
  </div>
  <div class="tab-section-heading" style="margin-top:18px">${t("overview.light_schedule")}</div>
  <div class="toggle-row">
    <span class="toggle-label">${t("overview.light_schedule_enabled")}</span>
    <button class="toggle-switch ${scheduleEnabled ? "sw-on" : "sw-off"}" id="ctrl-light-schedule-enabled"></button>
  </div>
  <div class="form-row">
    <label class="form-label">${t("overview.light_start")}</label>
    <input class="form-input" id="ctrl-light-start" type="time" value="${lightStart}">
  </div>
  <div class="form-row">
    <label class="form-label">${t("overview.light_end")}</label>
    <input class="form-input" id="ctrl-light-end" type="time" value="${lightEnd}">
  </div>
  <button class="btn-primary" id="btn-apply-light-schedule">${t("overview.apply_light_schedule")}</button>
  <p class="form-hint">${t("overview.light_schedule_enabled_hint")}</p>

  <!-- Sound settings -->
  <div class="form-row" style="margin-top:12px">
    <label class="form-label">${t("settings.sound_switch")}</label>
    <button class="toggle-switch ${soundSwitch !== false ? "sw-on" : "sw-off"}" id="ctrl-sound-switch"></button>
    <input class="form-input" id="ctrl-sound-volume" type="number" min="0" max="100" value="${soundVolume}" style="width:72px;margin-left:4px">
    <label class="form-label" style="margin-left:8px;color:var(--pl-subtext)">${t("settings.sound_volume")}</label>
  </div>
  <div class="form-row" style="margin-top:8px">
    <label class="form-label">${t("settings.sound_aging_type")}</label>
    <select class="form-input" id="ctrl-sound-aging-type">
      <option value="1" ${soundVolume > 0 || soundSwitch ? "" : ""}>${t("hours.all_day")}</option>
      <option value="2" ${soundSwitch && soundVolume > 0 ? "selected" : ""}>${t("hours.custom")}</option>
    </select>
    <label class="form-label" style="margin-left:8px;color:var(--pl-subtext)">${t("settings.sound_aging_type_hint")}</label>
  </div>

  <!-- Motion detection settings -->
  <div class="form-row" style="margin-top:12px">
    <label class="form-label">${t("settings.motion_detection_switch")}</label>
    <button class="toggle-switch ${motionDetection !== false ? "sw-on" : "sw-off"}" id="ctrl-motion-switch"></button>
    <input class="form-input" id="ctrl-motion-sensitivity" type="number" min="1" max="10" value="${device.motionSensitivity ?? 5}" style="width:50px;margin-left:4px">
    <label class="form-label" style="margin-left:8px;color:var(--pl-subtext)">${t("settings.motion_sensitivity")}</label>
    <input class="form-input" id="ctrl-motion-range" type="number" min="1" max="100" value="${device.motionRange ?? 50}" style="width:50px;margin-left:4px">
    <label class="form-label" style="margin-left:8px;color:var(--pl-subtext)">${t("settings.motion_range")}</label>
  </div>

  <!-- Camera settings -->
  <div class="form-row" style="margin-top:12px">
    <label class="form-label">${t("settings.camera_switch")}</label>
    <button class="toggle-switch ${cameraOn !== false ? "sw-on" : "sw-off"}" id="ctrl-camera-switch"></button>
    <input class="form-input" id="ctrl-camera-resolution" type="text" value="${device.cameraResolution ?? "1080p"}" style="width:120px;margin-left:4px">
    <label class="form-label" style="margin-left:8px;color:var(--pl-subtext)">${t("settings.camera_resolution")}</label>
    <input class="form-input" id="ctrl-camera-night-vision" type="checkbox" ${device.cameraNightVision !== false ? "checked" : ""} style="margin-left:4px">
    <label class="form-label" style="margin-left:8px;color:var(--pl-subtext)">${t("settings.camera_night_vision")}</label>
  </div>

  <div class="tab-section-heading" style="margin-top:18px">${t("overview.calibrate_scale")}</div>
  <button class="btn-secondary" id="btn-calibrate-scale">${t("overview.calibrate_scale")}</button>
  <p class="form-hint">${t("overview.calibrate_scale_hint")}</p>`;
}

// LED tab (One RFID): display on/off and hours, scrolling text, icon editor,
// animations and the animation editor. Moved out of Overview.
function buildLedTab(device) {
  return `    <div style="margin-top:16px">
      <div class="tab-section-heading">${t("overview.led_display")}</div>
      <div class="toggle-row">
        <span class="toggle-label">${t("hours.display_show")}</span>
        <button class="toggle-switch ${(device.screenDisplaySwitch ?? device.enableScreenDisplay ?? true) ? "sw-on" : "sw-off"}" id="hrs-display-switch"></button>
      </div>
      ${_hoursBlock("hrs-display", t("hours.display_heading"),
          device.display_hours_mode || (device.screenDisplayAgingType === 2 ? "custom" : "all"),
          device.display_start_local || (device.screenDisplayStartTimeUtc ? _utcToLocal(device.screenDisplayStartTimeUtc) : ""), device.display_end_local || (device.screenDisplayEndTimeUtc ? _utcToLocal(device.screenDisplayEndTimeUtc) : ""),
          t("hours.display_hint"))}
      <div class="form-row" style="margin-top:14px">
        <label class="form-label">${t("overview.scrolling_text")}</label>
        <div style="display:flex;gap:8px">
          <input class="form-input" id="feeder-display-text" type="text" maxlength="20" placeholder="e.g. MOCHI" value="${escHtml(device.display_text || "")}" oninput="this.value=this.value.toUpperCase()">
          <button class="btn-secondary" id="btn-send-display-text" style="flex-shrink:0">Send</button>
        </div>
        <p class="form-hint">${t("overview.display_text_hint")}</p>
      </div>
      <button class="btn-secondary" id="btn-open-icon-editor" style="width:100%;margin-top:4px">${t("overview.icon_editor_btn")}</button>
      <div class="form-row" style="margin-top:14px">
        <label class="form-label">${t("anim.heading")}</label>
        <select class="form-input" id="anim-select"><option>${t("anim.loading")}</option></select>
        <canvas id="anim-preview" width="260" height="70" style="width:100%;max-width:260px;margin-top:8px;border-radius:6px;background:#10101a;display:block"></canvas>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <label style="font-size:13px;color:var(--pl-subtext);white-space:nowrap">${t("anim.speed")}</label>
          <input type="range" id="anim-speed" min="2" max="8" value="4" style="flex:1">
          <button class="btn-secondary" id="anim-send" style="flex-shrink:0">${t("anim.send")}</button>
        </div>
        <p class="form-hint">${t("anim.hint")}</p>
        <button class="btn-secondary" id="btn-open-anim-editor" style="width:100%">${t("animed.open")}</button>
      </div>
    </div>`;
}

// ── Maintenance tab ───────────────────────────────────────────────────────
function buildMaintenanceTab(device) {
  if (device.device_type === "one_rfid" || device.device_type === "granary" || device.device_type === "camera_feeder") {
    const foodDays = foodRefillDaysRemaining(device);
    const dDays    = desiccantDaysRemaining(device);
    const bowlDays = bowlDaysRemaining(device);
    const housDays = housingDaysRemaining(device);
    const fdCol = foodDays != null && foodDays <= 0 ? "var(--pl-danger)" : "var(--pl-accent)";
    const dCol  = dDays    != null && dDays    <= 3 ? "var(--pl-danger)" : "var(--pl-accent)";
    const bCol  = bowlDays != null && bowlDays <= 0 ? "var(--pl-danger)" : "var(--pl-accent)";
    const hCol  = housDays != null && housDays <= 0 ? "var(--pl-danger)" : "var(--pl-accent)";
    return `
    <div class="tab-section-heading">${t("maint.food_tank")}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:13px;color:var(--pl-subtext);white-space:nowrap">${t("maint.next_refill_in")}</span>
      <input class="form-input" id="maint-food-refill-days" type="number" min="0" max="365"
        value="${foodDays != null ? Math.max(0, Math.round(foodDays)) : ""}"
        placeholder="${foodDays != null ? "" : t("maint.bowl_not_set")}"
        style="max-width:90px;color:${fdCol}">
    </div>
    <label class="form-label">${t("maint.refill_every")}</label>
    <div style="display:flex;gap:8px;margin-bottom:18px">
      <input class="form-input" id="maint-food-refill-interval" type="number" min="1" max="365" value="${device.food_refill_interval_days ?? 14}" style="flex:1">
      <button class="btn-secondary" id="btn-record-food-refill" style="flex-shrink:0">${t("maint.record_food_refill")}</button>
    </div>

    <div class="tab-section-heading">${t("maint.desiccant")}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:13px;color:var(--pl-subtext);white-space:nowrap">${t("maint.days_remaining")}</span>
      <input class="form-input" id="maint-desiccant-days" type="number" min="0" max="730"
        value="${dDays != null ? Math.max(0, Math.round(dDays)) : ""}"
        placeholder="${dDays != null ? "" : t("maint.desiccant_not_set")}"
        style="max-width:90px;color:${dCol}">
    </div>
    <label class="form-label">${t("maint.desiccant_replace_every")}</label>
    <div style="display:flex;gap:8px;margin-bottom:18px">
      <input class="form-input" id="maint-desiccant-life" type="number" min="1" max="365" value="${device.desiccant_life_days ?? 14}" style="flex:1">
      <button class="btn-secondary" id="btn-reset-desiccant" style="flex-shrink:0">${t("maint.reset_desiccant")}</button>
    </div>

    <div class="tab-section-heading">${t("maint.bowl")}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:13px;color:var(--pl-subtext);white-space:nowrap">${t("maint.next_clean_in")}</span>
      <input class="form-input" id="maint-bowl-days" type="number" min="0" max="365"
        value="${bowlDays != null ? Math.max(0, Math.round(bowlDays)) : ""}"
        placeholder="${bowlDays != null ? "" : t("maint.bowl_not_set")}"
        style="max-width:90px;color:${bCol}">
    </div>
    <label class="form-label">${t("maint.bowl_clean_every")}</label>
    <div style="display:flex;gap:8px;margin-bottom:18px">
      <input class="form-input" id="maint-bowl-interval" type="number" min="1" max="90" value="${device.bowl_cleaning_interval_days ?? 7}" style="flex:1">
      <button class="btn-secondary" id="btn-record-bowl" style="flex-shrink:0">${t("maint.record_bowl")}</button>
    </div>

    <div class="tab-section-heading">${t("maint.housing")}</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-size:13px;color:var(--pl-subtext);white-space:nowrap">${t("maint.next_clean_in")}</span>
      <input class="form-input" id="maint-housing-days" type="number" min="0" max="365"
        value="${housDays != null ? Math.max(0, Math.round(housDays)) : ""}"
        placeholder="${housDays != null ? "" : t("maint.bowl_not_set")}"
        style="max-width:90px;color:${hCol}">
    </div>
    <label class="form-label">${t("maint.bowl_clean_every")}</label>
    <div style="display:flex;gap:8px;margin-bottom:18px">
      <input class="form-input" id="maint-housing-interval" type="number" min="1" max="365" value="${device.housing_cleaning_interval_days ?? 30}" style="flex:1">
      <button class="btn-secondary" id="btn-record-housing" style="flex-shrink:0">${t("maint.record_housing")}</button>
    </div>`;
  }

  const filterDays = filterDaysRemaining(device);
  const filterLifeDays = device.filter_life_days ?? 30;
  const cleanDays = cleaningDaysRemaining(device);
  const cleanInterval = device.cleaning_interval_days ?? 30;
  const imperial = useImperial();
  const lowWaterGrams = device.lowWater ?? device.low_water_grams ?? 500;
  const lowWaterDisplay = imperial ? (lowWaterGrams * 0.033814).toFixed(1) : lowWaterGrams;
  const lowWaterUnit = imperial ? "fl oz" : "ml";

  const filterClass = filterDays != null && filterDays <= 3 ? "danger" : "accent";
  const cleanClass = cleanDays != null && cleanDays < 1 ? "danger" : "";

  const fCol = filterDays != null && filterDays <= 3 ? "var(--pl-danger)" : "var(--pl-accent)";
  const cCol = cleanDays  != null && cleanDays  <  1 ? "var(--pl-danger)" : "";
  return `
  <div class="tab-section-heading">${t("maint.filter")}</div>
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
    <span style="font-size:13px;color:var(--pl-subtext);white-space:nowrap">${t("maint.days_remaining")}</span>
    <input class="form-input" id="maint-filter-days" type="number" min="0" max="730"
      value="${filterDays != null ? Math.max(0, Math.round(filterDays)) : ""}"
      style="max-width:90px;${fCol ? `color:${fCol}` : ""}">
  </div>
  <label class="form-label">${t("maint.filter_life")}</label>
  <div style="display:flex;gap:8px;margin-bottom:18px">
    <input class="form-input" id="maint-filter-life" type="number" min="1" max="365" value="${filterLifeDays}" style="flex:1">
    <button class="btn-secondary" id="btn-reset-filter" style="flex-shrink:0">${t("maint.reset_filter")}</button>
  </div>

  <div class="tab-section-heading">${t("maint.cleaning")}</div>
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
    <span style="font-size:13px;color:var(--pl-subtext);white-space:nowrap">${t("maint.next_cleanup_in")}</span>
    <input class="form-input" id="maint-clean-days" type="number" min="0" max="365"
      value="${cleanDays != null ? Math.max(0, Math.round(cleanDays)) : ""}"
      style="max-width:90px;${cCol ? `color:${cCol}` : ""}">
  </div>
  <label class="form-label">${t("maint.cleanup_interval")}</label>
  <div style="display:flex;gap:8px;margin-bottom:18px">
    <input class="form-input" id="maint-clean-interval" type="number" min="1" max="90" value="${cleanInterval}" style="flex:1">
    <button class="btn-secondary" id="btn-record-clean" style="flex-shrink:0">${t("maint.record_cleaning")}</button>
  </div>

  <div class="tab-section-heading">${t("maint.low_water")}</div>
  <div class="form-row">
    <label class="form-label">${t("maint.low_water_threshold", {unit: escHtml(lowWaterUnit)})}</label>
    <input class="form-input" id="maint-low-water" type="number" min="0" value="${lowWaterDisplay}">
  </div>

  <div class="tab-section-heading">${t("maint.drink_detection")}</div>
  <div class="form-row">
    <label class="form-label">${t("maint.min_drink_label")}</label>
    <input class="form-input" id="maint-min-drink" type="number" min="1" max="200" value="${device.min_drink_grams ?? 5}">
  </div>
  <p class="form-hint">${t("maint.min_drink_hint")}</p>`;
}

// ── Custom feed sounds (feeder schedule tab) ───────────────────────────────
async function _wireFeedSoundControls(device, selectEl) {
  const statusEl = document.getElementById("maint-audio-status");
  const pushBtn  = document.getElementById("btn-push-audio");
  const repetitionsEl = document.getElementById("maint-audio-repetitions");

  async function refreshList() {
    try {
      const names = await api("GET", "/api/audio");
      selectEl.innerHTML = names.length
        ? names.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join("")
        : `<option value="">${t("maint.feed_sound_none")}</option>`;
    } catch {
      selectEl.innerHTML = `<option value="">${t("maint.feed_sound_none")}</option>`;
    }
  }
  await refreshList();

  if (pushBtn) {
    pushBtn.onclick = async () => {
      const name = selectEl.value;
      if (!name) { statusEl.textContent = t("maint.feed_sound_select_first"); return; }
      const soundRepititions = Math.max(1, Math.min(5, Number(repetitionsEl?.value) || 1));
      if (repetitionsEl) repetitionsEl.value = soundRepititions;
      pushBtn.disabled = true;
      statusEl.textContent = t("maint.pushing");
      try {
        await api("POST", `/api/devices/${device.serial}/push-audio`, { name, soundRepititions });
        statusEl.textContent = t("maint.push_success");
      } catch(e) {
        statusEl.textContent = t("maint.push_failed", {error: e.message});
      } finally {
        pushBtn.disabled = false;
      }
    };
  }
}

// ── Log tab ───────────────────────────────────────────────────────────────
function buildLogTab(device, history) {
  const hasData = history && history.some(d => d.grams > 0);
  if (!hasData) {
    return `<div style="text-align:center;padding:32px 0">
      <div style="font-size:40px;margin-bottom:8px"><span class="material-icons">water_drop</span></div>
      <p class="form-hint">${t("log.no_intake")}</p>
    </div>`;
  }
  const maxGrams = Math.max(...history.map(d => d.grams), 1);
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

  return `<div class="tab-section-heading">${t("log.water_heading")}</div>
  <div class="intake-log">
    ${history.map(d => {
      let label;
      if (d.date === today) label = t("time.today");
      else if (d.date === yesterday) label = t("time.yesterday");
      else label = new Date(d.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      const pct = d.grams > 0 ? Math.max(4, Math.round(d.grams / maxGrams * 100)) : 0;
      const val = d.grams > 0 ? fmtWater(d.grams) : "—";
      return `<div class="intake-row">
        <div class="intake-label">${escHtml(label)}</div>
        <div class="intake-bar-wrap"><div class="intake-bar" style="width:${pct}%"></div></div>
        <div class="intake-value">${escHtml(val)}</div>
      </div>`;
    }).join("")}
  </div>`;
}

// ── Feeder log tab ────────────────────────────────────────────────────────
function buildFeederLogTab(device, entries) {
  if (!entries || !entries.length) {
    return `<div style="text-align:center;padding:32px 0">
      <div style="font-size:40px;margin-bottom:8px"><span class="material-icons">pets</span></div>
      <p class="form-hint">${t("log.no_activity")}</p>
    </div>`;
  }
  const petName = (device.pets && device.pets.length === 1) ? device.pets[0].name : null;

  let lastDate = null;
  const rows = entries.map(e => {
    const dateLabel = fmtDate(e.ts);
    const dateHeader = dateLabel !== lastDate
      ? `<div class="tab-section-heading" style="margin-top:${lastDate ? "16px" : "0"}">${escHtml(dateLabel)}</div>`
      : "";
    lastDate = dateLabel;

    let line;
    if (e.type === "food_dispensed") {
      const portions = fmtPortions(e.portions, device.calibrated_grams_per_portion, device.feed_unit);
      const key = e.source === "manual" ? "log.food_dispensed_manual"
        : e.source === "scheduled" ? "log.food_dispensed_scheduled"
        : "log.food_dispensed"; // older entries logged before this distinction existed
      line = `<span style="color:var(--pl-subtext)">${escHtml(fmtTime(e.ts))}</span> ${t(key, {portions: escHtml(portions)})}`;
    } else if (e.type === "pet_eating") {
      const who = petName ? escHtml(petName) : t("pet.unnamed");
      line = `<span style="color:var(--pl-subtext)">${escHtml(fmtTime(e.ts))}</span> ${t("log.pet_ate", {name: who, duration: escHtml(fmtDuration(e.duration_secs))})}`;
    } else if (e.type === "door_open") {
      line = `<span style="color:var(--pl-subtext)">${escHtml(fmtTime(e.ts))}</span> ${t("log.door_open", {duration: escHtml(fmtDuration(e.duration_secs))})}`;
    } else {
      line = `<span style="color:var(--pl-subtext)">${escHtml(fmtTime(e.ts))}</span> ${escHtml(e.type)}`;
    }
    return `${dateHeader}<div style="padding:6px 0;border-bottom:1px solid var(--pl-border);font-size:0.9rem">${line}</div>`;
  }).join("");

  return `<div class="tab-section-heading">${t("log.activity_heading")}</div>${rows}`;
}

// ── Fountain log tab ──────────────────────────────────────────────────────
function buildFountainLogTab(device, entries) {
  if (!entries || !entries.length) {
    return `<div style="text-align:center;padding:32px 0">
      <div style="font-size:40px;margin-bottom:8px"><span class="material-icons">water_drop</span></div>
      <p class="form-hint">${t("log.no_activity")}</p>
    </div>`;
  }

  const solePetName = (device.pets && device.pets.length === 1) ? device.pets[0].name : null;

  let lastDate = null;
  const rows = entries.map(e => {
    const dateLabel = fmtDate(e.ts);
    const dateHeader = dateLabel !== lastDate
      ? `<div class="tab-section-heading" style="margin-top:${lastDate ? "16px" : "0"}">${escHtml(dateLabel)}</div>`
      : "";
    lastDate = dateLabel;

    let line;
    if (e.type === "drink" && e.rfid_tag) {
      const matched = (device.pets || []).find(p => p.id === e.pet_id);
      const who = matched ? matched.name : (solePetName || t("pet.unnamed"));
      line = `<span style="color:var(--pl-subtext)">${escHtml(fmtTime(e.ts))}</span> ${t("log.pet_drank", {name: escHtml(who), volume: escHtml(fmtWater(e.grams))})}`;
    } else if (e.type === "drink") {
      line = `<span style="color:var(--pl-subtext)">${escHtml(fmtTime(e.ts))}</span> ${t("log.drink", {volume: escHtml(fmtWater(e.grams))})}`;
    } else {
      line = `<span style="color:var(--pl-subtext)">${escHtml(fmtTime(e.ts))}</span> ${escHtml(e.type)}`;
    }
    return `${dateHeader}<div style="padding:6px 0;border-bottom:1px solid var(--pl-border);font-size:0.9rem">${line}</div>`;
  }).join("");

  return `<div class="tab-section-heading">${t("log.activity_heading")}</div>${rows}`;
}

// ── Schedule tab ──────────────────────────────────────────────────────────
const _DAY_KEYS = ["time.day_mon","time.day_tue","time.day_wed","time.day_thu","time.day_fri","time.day_sat","time.day_sun"];
function _DAYS() { return _DAY_KEYS.map(k => t(k)); }
// repeatDay uses 1=Mon...6=Sat,7=Sun
const _RDAY = [1,2,3,4,5,6,7];

function _schedDayLabel(repeatDay) {
  if (!repeatDay || repeatDay.length === 0) return t("schedule.no_days");
  if (repeatDay.length === 7) return t("schedule.daily");
  const sorted = [...repeatDay].sort((a,b)=>a-b);
  if (sorted.join(",") === "1,2,3,4,5") return t("schedule.weekdays");
  if (sorted.join(",") === "6,7") return t("schedule.weekends");
  const days = _DAYS();
  return sorted.map(d => days[d===7?6:d-1]).join(", ");
}

// Device Sound hours / LED Display hours (One RFID). Same fields the vendor
// app's two screens send: All day, or a Custom time window (local HH:MM).
function _hoursBlock(id, heading, mode, start, end, hint) {
  const custom = mode === "custom";
  return `<div class="form-row" style="margin-top:8px">
    <label class="form-label">${heading}</label>
    <select class="form-input" id="${id}-mode">
      <option value="all" ${custom ? "" : "selected"}>${t("hours.all_day")}</option>
      <option value="custom" ${custom ? "selected" : ""}>${t("hours.custom")}</option>
    </select>
  </div>
  <div id="${id}-times" style="${custom ? "" : "display:none"}">
    <div style="display:flex;gap:8px">
      <div style="flex:1"><label class="form-label">${t("hours.from")}</label>
        <input class="form-input" id="${id}-start" type="time" value="${start || "08:00"}"></div>
      <div style="flex:1"><label class="form-label">${t("hours.until")}</label>
        <input class="form-input" id="${id}-end" type="time" value="${end || "20:00"}"></div>
    </div>
  </div>
  <button class="btn-secondary" id="${id}-apply" style="width:100%;margin-top:8px">${t("hours.apply")}</button>
  <p class="form-hint">${hint}</p>`;
}

// Skip today: the Petlibro app's per-plan skipEndTime (epoch ms, OBSERVED as
// the end of the day, local midnight). A plan with a skipEndTime in the future
// does not run until then.
function _feederNowParts() {
  const off = _schedTzOffset();
  const localMs = Date.now() + off * 3600000;
  const d = new Date(localMs);
  return {
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
    wday: d.getUTCDay() === 0 ? 7 : d.getUTCDay(),
    midnightEndMs: Math.floor(localMs / 86400000) * 86400000 + 86400000 - off * 3600000,
  };
}
function _planSkipped(plan) {
  return typeof plan.skipEndTime === "number" && plan.skipEndTime > Date.now();
}
// How many days ahead the plan's next occurrence is (0 = later today), or null
// if it never runs. Skipping it sets skipEndTime to the end of that local day,
// the same rule the Petlibro app uses for a same-day skip.
function _nextOccurrenceDayOffset(plan) {
  const days = plan.repeatDay || [];
  if (!days.length) return null;
  const now = _feederNowParts();
  const [h, m] = _utcToLocal(plan.executionTime || "00:00").split(":").map(Number);
  for (let off = 0; off < 8; off++) {
    const wday = ((now.wday - 1 + off) % 7) + 1;
    if (!days.includes(wday)) continue;
    if (off === 0 && h * 60 + m <= now.min) continue;
    return off;
  }
  return null;
}
function _skipLabelKey(plan) {
  const midnight = _feederNowParts().midnightEndMs;
  if (plan.skipEndTime <= midnight) return "schedule.skipped";
  if (plan.skipEndTime <= midnight + 86400000) return "schedule.skipped_tomorrow";
  return "schedule.skipped_later";
}

// LED animations: built-in presets (animations.py), previewed here and sent to
// the feeder as a multi-frame DISPLAY_MATRIX_SERVICE.
let _animPresets = null;
let _animTimer = null;
function _drawAnimFrame(canvas, frame) {
  const ctx = canvas.getContext("2d");
  const cell = canvas.width / 26;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 26; c++) {
      const on = (frame[r] >> (25 - c)) & 1;
      ctx.fillStyle = on ? "#fff0c8" : "#262636";
      ctx.beginPath();
      ctx.arc(c * cell + cell / 2, r * cell + cell / 2 + 3, cell * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
async function _wireAnimations(d) {
  const sel = document.getElementById("anim-select");
  const canvas = document.getElementById("anim-preview");
  const speed = document.getElementById("anim-speed");
  const sendBtn = document.getElementById("anim-send");
  if (!sel || !canvas) return;
  if (!_animPresets) {
    try { _animPresets = await api("GET", "/api/animations"); } catch { _animPresets = []; }
  }
  if (!document.getElementById("anim-select")) return;   // tab changed while loading
  sel.innerHTML = _animPresets.map((a, i) => `<option value="${i}">${a.custom ? "\u2605 " : ""}${escHtml(a.name)} (${a.count})</option>`).join("");
  const current = () => _animPresets[+sel.value];
  const play = () => {
    if (_animTimer) clearInterval(_animTimer);
    const a = current();
    if (!a) return;
    let i = 0;
    _animTimer = setInterval(() => {
      if (!canvas.isConnected) { clearInterval(_animTimer); _animTimer = null; return; }
      _drawAnimFrame(canvas, a.frames[i++ % a.frames.length]);
    }, Math.max(1, +speed.value) * 25);
  };
  speed.value = _animPresets[0]?.interval || 4;
  sel.onchange = () => { speed.value = current().interval; play(); };
  speed.oninput = play;
  play();
  sendBtn.onclick = async () => {
    const a = current();
    if (!a) return;
    const orig = sendBtn.textContent;
    sendBtn.textContent = t("overview.sending");
    sendBtn.disabled = true;
    try {
      await api("POST", `/api/devices/${d.serial}/command`, { _display_animation: { frames: a.frames, interval: +speed.value, loop: true, name: a.name } });
      sendBtn.textContent = t("overview.sent");
    } catch(e) {
      sendBtn.textContent = t("overview.failed");
      alert(t("overview.cmd_failed", {error: e.message}));
    }
    setTimeout(() => { sendBtn.textContent = orig; sendBtn.disabled = false; }, 2000);
  };
}

function buildScheduleTab(plans) {
  // Display in chronological (local time) order for readability, but keep
  // data-idx pointing at each plan's real position in the underlying array --
  // that's what edit/delete/toggle and the push-to-feeder order are keyed on,
  // and nothing about storage or the feeder protocol requires sorted order.
  const order = plans.map((_, i) => i).sort((a, b) =>
    _utcToLocal(plans[a].executionTime || "00:00").localeCompare(_utcToLocal(plans[b].executionTime || "00:00"))
  );
  const rows = order.map(i => {
    const plan = plans[i];
    const enabled = plan._enabled !== false;
    const skipped = _planSkipped(plan);
    const dayLabel = _schedDayLabel(plan.repeatDay);
    const portions = plan.grainNum || 1;
    const sound = plan.enableAudio ? ` · ${t("schedule.sound_times", {n: plan.audioTimes||1})}` : "";
    return `<div class="sched-row${enabled?"":' disabled'}" data-idx="${i}">
      <div class="sched-time">${escHtml(fmtTime12(_utcToLocal(plan.executionTime||"00:00")))}</div>
      <div class="sched-meta">${escHtml(dayLabel)} · ${escHtml(fmtPortions(portions, _currentDevice?.calibrated_grams_per_portion, _currentDevice?.feed_unit))}${escHtml(sound)}${skipped ? ` · <span style="color:var(--pl-warning)">${t(_skipLabelKey(plan))}</span>` : ""}</div>
      <div class="sched-actions">
        ${skipped || _nextOccurrenceDayOffset(plan) !== null ? `<button class="sched-skip-btn" data-idx="${i}" title="${t(skipped ? "schedule.undo_skip" : "schedule.skip_today")}" style="background:none;border:1px solid ${skipped ? "var(--pl-warning)" : "var(--pl-border)"};border-radius:6px;cursor:pointer;padding:3px 8px;font-size:12px;line-height:1.2;color:${skipped ? "var(--pl-warning)" : "var(--pl-text)"}">${t(skipped ? "schedule.undo_btn" : "schedule.skip_btn")}</button>` : ""}
        <button class="sched-toggle${enabled?" on":""}" data-idx="${i}" title="${enabled?"Disable":"Enable"}"></button>
        <button class="sched-edit-btn" data-idx="${i}" title="Edit"><span class="material-icons">edit</span></button>
        <button class="sched-del-btn" data-idx="${i}" title="Delete" style="background:none;border:none;cursor:pointer;padding:4px;color:var(--pl-danger,#e05252);font-size:16px;line-height:1;opacity:0.8">&#x2715;</button>
      </div>
    </div>`;
  }).join("");

  const days = _DAYS();
  const form = `<div class="sched-form" id="sched-form">
    <div class="form-row">
      <label>${t("schedule.time")} <span id="sf-tz-hint" style="font-weight:400;color:var(--pl-subtext)"></span></label>
      <input type="time" class="form-input" id="sf-time" value="08:00">
    </div>
    <div class="form-row">
      <label>${t("schedule.days")}</label>
      <div class="day-chips" id="sf-days">
        ${days.map((d,i)=>`<div class="day-chip on" data-rday="${_RDAY[i]}">${d}</div>`).join("")}
      </div>
    </div>
    <div class="form-row">
      <label>${t("schedule.portions")}</label>
      <div class="portion-chips" id="sf-portions">
        ${[1,2,3,4,5].map(n=>`<div class="portion-chip${n===1?" on":""}" data-n="${n}">${escHtml(fmtPortions(n, _currentDevice?.calibrated_grams_per_portion, _currentDevice?.feed_unit))}</div>`).join("")}
      </div>
    </div>
    <div class="form-row" style="display:flex;align-items:center;gap:10px">
      <input type="checkbox" id="sf-sound" style="width:16px;height:16px;accent-color:var(--pl-accent);flex-shrink:0">
      <label for="sf-sound" style="margin:0;flex-shrink:0">${t("schedule.sound")}</label>
      <span id="sf-sound-times-wrap" style="display:flex;align-items:center;gap:6px;margin-left:6px">
        <label style="margin:0;flex-shrink:0;font-size:12px;color:var(--pl-subtext)">×</label>
        <input type="number" class="form-input" id="sf-sound-times" value="1" min="1" max="5" style="width:52px;padding:4px 8px">
      </span>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button class="btn-primary" id="sf-save" style="flex:1">${t("schedule.save")}</button>
      <button class="btn-secondary" id="sf-cancel" style="flex:1">${t("schedule.cancel")}</button>
    </div>
    <input type="hidden" id="sf-edit-idx" value="">
  </div>`;

  const addBtn = `<button class="btn-secondary" id="sched-add-btn" style="width:100%;margin-bottom:10px">${t("schedule.add")}</button>`;

  const _fu = _currentDevice?.feed_unit || "auto";
  const unitOpt = (v, key) => `<option value="${v}"${_fu === v ? " selected" : ""}>${t(key)}</option>`;
  const calSection = (_currentDevice?.device_type === "one_rfid" || _currentDevice?.device_type === "granary" || _currentDevice?.device_type === "camera_feeder") ? `
    <div class="tab-section-heading" style="margin-top:18px">${t("feed_unit.heading")}</div>
    <select class="form-select" id="feed-unit-select">
      ${unitOpt("auto", "feed_unit.auto")}${unitOpt("cup", "feed_unit.cup")}${unitOpt("oz", "feed_unit.oz")}${unitOpt("g", "feed_unit.g")}${unitOpt("ml", "feed_unit.ml")}
    </select>
    <p class="form-hint" style="margin-top:6px">${t("feed_unit.hint")}</p>
    <div class="tab-section-heading" style="margin-top:18px">${t("maint.feed_calibration")}</div>
    <p class="form-hint">${_currentDevice.calibrated_grams_per_portion
      ? t("maint.feed_calibration_set", {grams: _currentDevice.calibrated_grams_per_portion})
      : t("maint.feed_calibration_unset")}</p>
    <div style="display:flex;gap:8px">
      <button class="btn-secondary" id="btn-calibrate-feed" style="flex:1">${t("maint.calibrate_feed")}</button>
      ${_currentDevice.calibrated_grams_per_portion ? `<button class="btn-secondary" id="btn-reset-feed-calibration" style="flex-shrink:0;color:var(--pl-danger)">${t("maint.reset_calibration")}</button>` : ""}
    </div>` : "";
  const audioSection = (_currentDevice?.device_type === "one_rfid" || _currentDevice?.device_type === "granary" || _currentDevice?.device_type === "camera_feeder") ? `
    <div class="tab-section-heading" style="margin-top:18px">${t("maint.feed_sounds")}</div>
    <p class="form-hint">${t("maint.feed_sounds_hint")}</p>
    <div class="feed-sound-controls">
      <div class="feed-sound-field">
        <label class="form-label" for="maint-audio-select">${t("maint.feed_sound_select")}</label>
        <select class="form-select" id="maint-audio-select">
          <option value="" data-i18n="maint.feed_sound_loading">${t("maint.feed_sound_loading")}</option>
        </select>
      </div>
      <div class="feed-sound-field">
        <label class="form-label" for="maint-audio-repetitions">${t("maint.default_repititions")}</label>
        <input class="form-input" id="maint-audio-repetitions" type="number" min="1" max="5" value="${_currentDevice.soundRepititions ?? 1}">
      </div>
      <div class="feed-sound-field">
        <span class="form-label" aria-hidden="true">&nbsp;</span>
        <button class="btn-secondary" id="btn-push-audio" aria-label="${t("maint.push_sound")}">${t("maint.push_sound")}</button>
      </div>
    </div>
    <p class="form-hint" id="maint-audio-status"></p>` : "";

  const _paused = !!_currentDevice?.schedules_paused;
  const pauseRow = `<div class="toggle-row">
      <span class="toggle-label">${t("schedule.run_all")}</span>
      <button class="toggle-switch ${_paused ? "sw-off" : "sw-on"}" id="sched-run-all"></button>
    </div>
    <p class="form-hint" style="margin-bottom:12px;${_paused ? "color:var(--pl-danger)" : ""}">${t(_paused ? "schedule.paused_note" : "schedule.run_all_hint")}</p>`;

  return `<div class="tab-section-heading">${t("schedule.heading")}</div>
    ${pauseRow}
    ${addBtn}
    ${form}
    <div class="sched-list" id="sched-list">${rows || `<p style="color:var(--pl-subtext);text-align:center;padding:12px 0">${t("schedule.no_plans")}</p>`}</div>
    <p style="font-size:11px;color:var(--pl-subtext);margin-top:4px">${t("schedule.sync_note")}</p>
    ${calSection}
    ${audioSection}`;
}

// In-memory plans for schedule tab editing
let _schedPlans = [];

async function _saveSchedule() {
  const ok = await api("POST", `/api/devices/${_currentDevice.serial}/feeding-plans`, _schedPlans).catch(() => null);
  return ok;
}

function wireScheduleTabHandlers() {
  const list = document.getElementById("sched-list");
  const form = document.getElementById("sched-form");
  if (!list || !form) return;

  const audioSelect = document.getElementById("maint-audio-select");
  if (audioSelect) _wireFeedSoundControls(_currentDevice, audioSelect);

  const runAll = document.getElementById("sched-run-all");
  if (runAll) {
    runAll.onclick = async () => {
      const pause = !_currentDevice.schedules_paused;
      try {
        await api("POST", `/api/devices/${_currentDevice.serial}/schedules-paused`, { paused: pause });
        _patchDevice(_currentDevice.serial, { schedules_paused: pause });
        renderDeviceTab("schedule");
      } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
    };
  }

  const unitSel = document.getElementById("feed-unit-select");
  if (unitSel) {
    unitSel.onchange = async () => {
      const v = unitSel.value;
      await api("POST", `/api/devices/${_currentDevice.serial}`, { feed_unit: v === "auto" ? null : v });
      _patchDevice(_currentDevice.serial, { feed_unit: v === "auto" ? null : v });
      renderDeviceTab("schedule");
    };
  }
  const calibrateBtn = document.getElementById("btn-calibrate-feed");
  if (calibrateBtn) calibrateBtn.onclick = () => openFeedCalibration(_currentDevice);
  const resetCalBtn = document.getElementById("btn-reset-feed-calibration");
  if (resetCalBtn) {
    resetCalBtn.onclick = async () => {
      await api("POST", `/api/devices/${_currentDevice.serial}`, { calibrated_grams_per_portion: null });
      _patchDevice(_currentDevice.serial, { calibrated_grams_per_portion: null });
      renderDeviceTab("schedule");
    };
  }

  function openForm(idx) {
    const plan = idx >= 0 ? _schedPlans[idx] : null;
    document.getElementById("sf-time").value = plan ? _utcToLocal(plan.executionTime || "08:00") : "08:00";
    document.getElementById("sf-edit-idx").value = idx >= 0 ? idx : "";
    // Days
    const rdays = new Set(plan?.repeatDay || _RDAY);
    document.querySelectorAll(".day-chip").forEach(c => c.classList.toggle("on", rdays.has(+c.dataset.rday)));
    // Portions
    const portions = plan?.grainNum || 1;
    document.querySelectorAll(".portion-chip").forEach(c => c.classList.toggle("on", +c.dataset.n === portions));
    // Sound — new plans default to on (matches feeder factory default)
    const soundOn = plan ? (plan.enableAudio ?? true) : true;
    const soundCheck = document.getElementById("sf-sound");
    soundCheck.checked = soundOn;
    document.getElementById("sf-sound-times").value = plan?.audioTimes ?? 1;
    document.getElementById("sf-sound-times-wrap").style.display = soundOn ? "flex" : "none";
    // Timezone hint
    const tzHint = document.getElementById("sf-tz-hint");
    if (tzHint) {
      const off = _schedTzOffset();
      const label = _settings.feeder_timezone || `UTC${off >= 0 ? "+" : ""}${off}`;
      tzHint.textContent = `(${label}, UTC${off >= 0 ? "+" : ""}${Math.round(off)})`;
    }
    form.classList.add("open");
    document.getElementById("sf-time").focus();
  }

  function closeForm() { form.classList.remove("open"); }

  function rerender() {
    const tmp = document.createElement("div");
    tmp.innerHTML = buildScheduleTab(_schedPlans);
    const newList = tmp.querySelector("#sched-list");
    if (newList) list.innerHTML = newList.innerHTML;
    wireListHandlers();
  }

  function wireListHandlers() {
    list.querySelectorAll(".sched-toggle").forEach(btn => {
      btn.onclick = async () => {
        const idx = +btn.dataset.idx;
        _schedPlans[idx]._enabled = !(_schedPlans[idx]._enabled !== false);
        await _saveSchedule();
        rerender();
      };
    });
    list.querySelectorAll(".sched-skip-btn").forEach(btn => {
      btn.onclick = async () => {
        const plan = _schedPlans[+btn.dataset.idx];
        if (_planSkipped(plan)) delete plan.skipEndTime;
        else plan.skipEndTime = _feederNowParts().midnightEndMs + _nextOccurrenceDayOffset(plan) * 86400000;
        await _saveSchedule();
        rerender();
      };
    });
    list.querySelectorAll(".sched-edit-btn").forEach(btn => {
      btn.onclick = () => openForm(+btn.dataset.idx);
    });
    list.querySelectorAll(".sched-del-btn").forEach(btn => {
      btn.onclick = async () => {
        const idx = +btn.dataset.idx;
        const plan = _schedPlans[idx];
        if (!confirm(t("schedule.delete_confirm", {time: plan.executionTime}))) return;
        _schedPlans.splice(idx, 1);
        await _saveSchedule();
        rerender();
      };
    });
  }

  // Sound checkbox toggles the ×N input
  document.getElementById("sf-sound").addEventListener("change", e => {
    document.getElementById("sf-sound-times-wrap").style.display = e.target.checked ? "flex" : "none";
  });

  // Day chip toggle
  form.querySelectorAll(".day-chip").forEach(c => {
    c.onclick = () => c.classList.toggle("on");
  });
  // Portion chip select
  form.querySelectorAll(".portion-chip").forEach(c => {
    c.onclick = () => {
      form.querySelectorAll(".portion-chip").forEach(x => x.classList.remove("on"));
      c.classList.add("on");
    };
  });

  document.getElementById("sched-add-btn").onclick = () => openForm(-1);
  document.getElementById("sf-cancel").onclick = closeForm;

  document.getElementById("sf-save").onclick = async () => {
    const time = document.getElementById("sf-time").value;
    if (!time) { alert(t("schedule.err_no_time")); return; }
    const repeatDay = Array.from(form.querySelectorAll(".day-chip.on")).map(c => +c.dataset.rday);
    if (repeatDay.length === 0) { alert(t("schedule.err_no_days")); return; }
    const grainNum = +form.querySelector(".portion-chip.on")?.dataset.n || 1;
    const enableAudio = document.getElementById("sf-sound").checked;
    const audioTimes = +document.getElementById("sf-sound-times").value || 1;
    const editIdx = document.getElementById("sf-edit-idx").value;
    const previousPlans = _schedPlans.map(plan => ({...plan}));
    const planData = {
      planId: editIdx !== "" ? _schedPlans[+editIdx].planId : (5000000 + Math.floor(Math.random() * 1000000)),
      executionTime: _localToUtc(time),
      repeatDay,
      enableAudio,
      audioTimes,
      grainNum,
      syncTime: Date.now(),
      _enabled: editIdx !== "" ? (_schedPlans[+editIdx]._enabled !== false) : true,
    };
    if (editIdx !== "" && _schedPlans[+editIdx].skipEndTime) planData.skipEndTime = _schedPlans[+editIdx].skipEndTime;
    if (editIdx !== "") {
      _schedPlans[+editIdx] = planData;
    } else {
      _schedPlans.push(planData);
    }
    const result = await _saveSchedule();
    if (!result) {
      _schedPlans = previousPlans;
      rerender();
      alert(t("overview.cmd_failed", {error: "Schedule could not be saved. Please try again."}));
      return;
    }
    closeForm();
    rerender();
    if (result?.mqtt === false) {
      // Non-blocking toast
      const msg = document.createElement("div");
      msg.textContent = t("schedule.offline_toast");
      msg.style.cssText = "position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--pl-surface2);border:1px solid var(--pl-border);border-radius:8px;padding:10px 16px;font-size:12px;z-index:9999;max-width:90vw;text-align:center";
      document.body.appendChild(msg);
      setTimeout(() => msg.remove(), 3500);
    }
  };

  wireListHandlers();
}

// ── Notifications tab ─────────────────────────────────────────────────────
function buildNotificationsTab(device) {
  const notif = device.notifications || {};
  const isFeeder = device.device_type === "one_rfid" || device.device_type === "granary" || device.device_type === "camera_feeder";
  const checks = device.device_type === "one_rfid" ? [
    { key: "food_low",        label: t("notif.food_low") },
    { key: "food_refill_due", label: t("notif.food_refill_due") },
    { key: "desiccant_due",   label: t("notif.desiccant_due") },
    { key: "bowl_due",      label: t("notif.bowl_due") },
    { key: "housing_due",   label: t("notif.housing_due") },
    { key: "power_battery", label: t("notif.power_battery") },
    { key: "door_jam",      label: t("notif.door_jam") },
    { key: "missed_feed",   label: t("notif.missed_feed") },
    { key: "food_dispensed", label: t("notif.food_dispensed"), defaultOn: false },
    { key: "offline",       label: t("notif.offline") },
  ] : device.device_type === "granary" || device.device_type === "camera_feeder" ? [
    // No door_jam (no lid on this model) and no power_battery (powerType's
    // meaning isn't confirmed for this device yet, see granary.py)
    { key: "food_low",        label: t("notif.food_low") },
    { key: "food_refill_due", label: t("notif.food_refill_due") },
    { key: "desiccant_due",   label: t("notif.desiccant_due") },
    { key: "bowl_due",        label: t("notif.bowl_due") },
    { key: "housing_due",     label: t("notif.housing_due") },
    { key: "missed_feed",     label: t("notif.missed_feed") },
    { key: "food_dispensed",  label: t("notif.food_dispensed"), defaultOn: false },
    { key: "offline",         label: t("notif.offline") },
  ] : [
    { key: "water_low",    label: t("notif.water_low") },
    { key: "filter_due",   label: t("notif.filter_due") },
    { key: "cleaning_due", label: t("notif.cleaning_due") },
    { key: "offline",      label: t("notif.offline") },
  ];
  const devMobileOptions = `<option value="">-- Default from Settings --</option>` +
    _mobileTargets.map(t =>
      `<option value="${escHtml(t.service)}"${device.notify_mobile_service === t.service ? " selected" : ""}>${escHtml(t.label)}</option>`
    ).join("") +
    (device.notify_mobile_service && !_mobileTargets.find(t => t.service === device.notify_mobile_service)
      ? `<option value="${escHtml(device.notify_mobile_service)}" selected>${escHtml(device.notify_mobile_service)}</option>` : "");

  const batteryLowRow = isFeeder ? `
    <div class="toggle-row">
      <span class="toggle-label">${t("notif.battery_low")}</span>
      <input class="form-input" id="notif-battery-low-pct" type="number" min="0" max="99" value="${device.battery_low_pct ?? 20}" style="width:70px;text-align:center">
    </div>` : "";

  return `
  <div class="tab-section-heading">${t("notif.alert_conditions")}</div>
  <div class="toggle-list">
    ${checks.map(c => `<div class="toggle-row">
      <span class="toggle-label">${c.label}</span>
      <input type="checkbox" class="notif-check" data-key="${c.key}" ${(c.defaultOn === false ? notif[c.key] === true : notif[c.key] !== false) ? "checked" : ""}>
    </div>`).join("")}${batteryLowRow}
  </div>
  ${isFeeder ? `<p class="form-hint">${t("notif.battery_low_hint")}</p>` : ""}

  <div class="tab-section-heading" style="margin-top:18px">${t("notif.channels")}</div>
  <div class="toggle-list" style="margin-bottom:14px">
    <div class="toggle-row">
      <span class="toggle-label">${t("notif.ha_bell")}</span>
      <input type="checkbox" class="notif-check" id="nchan-bell" ${device.notify_bell !== false ? "checked" : ""}>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">${t("notif.email")}</span>
      <input type="checkbox" class="notif-check" id="nchan-email" ${device.notify_email !== false ? "checked" : ""}>
    </div>
    <div class="toggle-row">
      <span class="toggle-label">${t("notif.mobile")}</span>
      <input type="checkbox" class="notif-check" id="nchan-mobile" ${device.notify_mobile ? "checked" : ""}>
    </div>
  </div>
  <div id="nchan-email-section" style="${device.notify_email !== false ? "" : "display:none"}">
    <div class="form-row">
      <label class="form-label">${t("notif.email_override")}</label>
      <input class="form-input" id="nchan-email-addr" type="email" placeholder="${t("notif.email_placeholder")}" value="${escHtml(device.notify_email_address || "")}">
    </div>
  </div>
  <div id="nchan-mobile-section" style="${device.notify_mobile ? "" : "display:none"}">
    <div class="form-row">
      <label class="form-label">${t("notif.mobile_service")}</label>
      <select class="form-select" id="nchan-mobile-svc">${devMobileOptions}</select>
    </div>
  </div>

  <button class="btn-primary" id="btn-save-device-notifications">${t("notif.save")}</button>`;
}

// ── Wire device tab handlers ──────────────────────────────────────────────
function _wireHours(d, id, cmdKey, fields) {
  const modeEl = document.getElementById(`${id}-mode`);
  const applyEl = document.getElementById(`${id}-apply`);
  if (!modeEl || !applyEl) return;
  modeEl.onchange = () => {
    document.getElementById(`${id}-times`).style.display = modeEl.value === "custom" ? "" : "none";
  };
  applyEl.onclick = async () => {
    const mode = modeEl.value;
    const start = document.getElementById(`${id}-start`).value;
    const end = document.getElementById(`${id}-end`).value;
    if (mode === "custom" && (!start || !end || start === end)) { alert(t("hours.err_times")); return; }
    // Visible feedback so a click that did register is distinguishable
    // from one that did nothing (the device gives no reply to show).
    const orig = applyEl.textContent;
    applyEl.textContent = t("overview.sending");
    applyEl.disabled = true;
    try {
      await api("POST", `/api/devices/${d.serial}/command`, { [cmdKey]: { mode, start, end } });
      _patchDevice(d.serial, { [fields[0]]: mode, [fields[1]]: start, [fields[2]]: end });
      applyEl.textContent = t("overview.sent");
    } catch(e) {
      applyEl.textContent = t("overview.failed");
      alert(t("overview.cmd_failed", {error: e.message}));
    }
    setTimeout(() => { applyEl.textContent = orig; applyEl.disabled = false; }, 2000);
  };
}

function wireCameraExposureToggle(device) {
  const expose = document.getElementById("camera-ha-expose");
  const exposeStatus = document.getElementById("camera-ha-expose-status");
  if (!expose) return;
  expose.onclick = async () => {
    if (expose.disabled) return;
    const enabled = expose.getAttribute("aria-checked") !== "true";
    expose.setAttribute("aria-checked", String(enabled));
    expose.className = `toggle-switch camera-ha-expose-toggle ${enabled ? "sw-on" : "sw-off"}`;
    expose.disabled = true;
    exposeStatus.textContent = enabled ? "Registering with Home Assistant…" : "Removing from Home Assistant…";
    try {
      await api("POST", `/api/devices/${encodeURIComponent(device.serial)}/camera/exposure`, { enabled });
      _patchDevice(device.serial, { live_camera_exposed: enabled });
      exposeStatus.textContent = enabled ? "Live camera added to Home Assistant." : "Live camera removed from Home Assistant.";
    } catch (error) {
      expose.setAttribute("aria-checked", String(!enabled));
      expose.className = `toggle-switch camera-ha-expose-toggle ${!enabled ? "sw-on" : "sw-off"}`;
      exposeStatus.textContent = error.message || "Could not update Home Assistant camera.";
    } finally {
      expose.disabled = false;
    }
  };
}

function wireCameraPowerWithLiveViewToggle(device) {
  const toggle = document.getElementById("camera-power-with-live-view");
  if (!toggle) return;
  toggle.onclick = async () => {
    if (toggle.disabled) return;
    const enabled = toggle.getAttribute("aria-checked") !== "true";
    const section = toggle.closest("section");
    const cameraToggle = section?.querySelector('[data-camera-setting="cameraSwitch"]');
    const body = section?.querySelector(".camera-settings-body");
    const exposure = document.getElementById("camera-ha-expose-row");
    const applyVisibility = value => {
      toggle.setAttribute("aria-checked", String(value));
      toggle.className = `toggle-switch camera-ha-expose-toggle ${value ? "sw-on" : "sw-off"}`;
      if (cameraToggle) cameraToggle.hidden = value;
      if (exposure) exposure.hidden = value;
      if (body) body.hidden = !value && cameraToggle?.classList.contains("sw-off");
    };
    applyVisibility(enabled);
    toggle.disabled = true;
    try {
      await api("POST", `/api/devices/${encodeURIComponent(device.serial)}`, { camera_power_with_live_view: enabled });
      _patchDevice(device.serial, { camera_power_with_live_view: enabled });
      device.camera_power_with_live_view = enabled;
    } catch (error) {
      applyVisibility(!enabled);
      alert(error.message || t("overview.failed"));
    } finally {
      toggle.disabled = false;
    }
  };
}

function wireDeviceTabHandlers(tabName) {
  const d = _currentDevice;
  if (tabName !== "overview" || d.device_type !== "camera_feeder") stopLiveCamera();
  if (tabName === "sensors") {
    wireCameraPowerWithLiveViewToggle(d);
    wireCameraExposureToggle(d);
  }
  if (tabName === "overview" && d.device_type === "camera_feeder") {
    wireCameraTalk(d.serial);
    const frame = document.getElementById("camera-live-frame");
    const start = document.getElementById("camera-live-start");
    const status = document.getElementById("camera-live-status");
    const placeholder = document.getElementById("camera-live-placeholder");
    const sound = document.getElementById("camera-live-sound");
    const controls = document.getElementById("camera-live-controls");
    const stop = document.getElementById("camera-live-stop");
    const resolution = document.getElementById("camera-live-resolution");
    const nightVision = document.getElementById("camera-live-night-vision");
    if (resolution) resolution.value = d.resolution || "P1080";
    if (nightVision) nightVision.value = d.nightVision || "AUTOMATIC";
    const sendCameraSetting = async (field, value) => {
      if (!d.serial) return;
      try {
        await api("POST", `/api/devices/${encodeURIComponent(d.serial)}/command`, { [field]: value });
        _patchDevice(d.serial, { [field]: value });
        d[field] = value;
        if (field === "resolution") {
          const fullSelect = document.querySelector('[data-camera-setting="resolution"]');
          if (fullSelect) fullSelect.value = value;
        } else if (field === "nightVision") {
          const fullSelect = document.querySelector('[data-camera-setting="nightVision"]');
          if (fullSelect) fullSelect.value = value;
        }
      } catch (error) {
        status.textContent = error.message || "Could not update camera setting.";
      }
    };
    if (resolution) resolution.onchange = () => sendCameraSetting("resolution", resolution.value);
    if (nightVision) nightVision.onchange = () => sendCameraSetting("nightVision", nightVision.value);
    if (controls) controls.hidden = false;
    if (stop) stop.hidden = true;
    const setSoundState = (muted) => {
      if (!sound) return;
      sound.innerHTML = `<span class="material-icons" aria-hidden="true">${muted ? "volume_off" : "volume_up"}</span>`;
      sound.title = muted ? "Turn sound on" : "Mute camera sound";
      sound.setAttribute("aria-label", sound.title);
    };
    if (sound) sound.onclick = () => {
      if (_cameraTalk) return;
      const video = frame.querySelector("video");
      if (!video) return;
      video.muted = !video.muted;
      setSoundState(video.muted);
      if (!video.muted) video.play().catch(() => {});
    };
    const stopCameraView = () => {
      stopLiveCamera(false);
      frame?.querySelector("video")?.remove();
      if (sound) sound.hidden = true;
      if (placeholder) placeholder.style.display = "";
      if (start) {
        start.textContent = "Click to start live view";
        start.hidden = false;
        start.disabled = false;
      }
    };
    if (stop) stop.onclick = stopCameraView;
    if (start && frame) start.onclick = async () => {
      // A Status rerender can replace the button while setup is still pending.
      if (_liveCameraPc || _liveCameraPowerOwner) stopLiveCamera(false);
      const generation = ++_liveCameraGeneration;
      const current = () => generation === _liveCameraGeneration;
      const powerWithLiveView = d.camera_power_with_live_view === true;
      if (d.cameraSwitch === false && !powerWithLiveView) {
        status.textContent = "Enable the camera to start live view.";
        return;
      }
      start.disabled = true;
      start.hidden = true;
      status.textContent = "Connecting…";
      if (powerWithLiveView) {
        const owner = { serial: d.serial };
        _liveCameraPowerOwner = owner;
        try {
          await acquireCameraPower(d.serial, owner);
          if (!current()) return;
        } catch (error) {
          if (!current()) return;
          releaseCameraPower(d.serial, owner);
          _liveCameraPowerOwner = null;
          status.textContent = error.message || "Could not turn on the camera.";
          start.hidden = false;
          start.disabled = false;
          return;
        }
      }
      const video = document.createElement("video");
      video.autoplay = true; video.playsInline = true; video.muted = true;
      video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain";
      if (placeholder) placeholder.style.display = "none";
      frame.prepend(video);
      try {
        const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
        _liveCameraPc = pc;
        const videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
        if (_settings.camera_vp8_transcoding === true) preferVP8(videoTransceiver);
        pc.addTransceiver("audio", { direction: "recvonly" });
        const stream = new MediaStream();
        pc.ontrack = event => { stream.addTrack(event.track); video.srcObject = stream; video.play().catch(() => {}); };
        video.onloadeddata = () => {
          if (!current()) return;
          status.textContent = "Live"; start.hidden = true; start.disabled = false;
          if (stop) stop.hidden = false;
          frame.classList.add("is-live");
          const vp8Hint = document.getElementById("camera-windows-vp8-hint");
          if (vp8Hint) vp8Hint.hidden = _settings.camera_vp8_transcoding !== true;
          if (sound) sound.hidden = false;
          setSoundState(video.muted);
          muteCameraForTalk();
        };
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise(resolve => {
          if (pc.iceGatheringState === "complete") return resolve();
          const done = () => { if (pc.iceGatheringState === "complete") { pc.removeEventListener("icegatheringstatechange", done); resolve(); } };
          pc.addEventListener("icegatheringstatechange", done); setTimeout(resolve, 2500);
        });
        if (!current()) return;
        const response = await fetch(`${BASE}/api/devices/${encodeURIComponent(d.serial)}/camera/webrtc`, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription.sdp });
        if (!current()) {
          const staleSession = response.headers.get("X-Petlibro-WebRTC-Session");
          if (staleSession) fetch(`${BASE}/api/devices/${encodeURIComponent(d.serial)}/camera/webrtc/${encodeURIComponent(staleSession)}`, { method: "DELETE", keepalive: true }).catch(() => {});
          return;
        }
        if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
        _liveCameraSession = response.headers.get("X-Petlibro-WebRTC-Session");
        _liveCameraSerial = d.serial;
        await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
      } catch (error) {
        if (!current()) return;
        stopLiveCamera(false);
        frame.classList.remove("is-live");
        video.remove();
        if (placeholder) { placeholder.textContent = "Camera stream unavailable."; placeholder.style.display = ""; }
        status.textContent = error.message;
        start.textContent = "Click to start live view";
        start.hidden = false;
        start.disabled = false;
        if (stop) stop.hidden = true;
      }
    };
    if (_settings.camera_auto_start_live_view === true) start?.click();
  }
  if (tabName === "sensors" || (tabName === "overview" && d.device_type === "camera_feeder")) {
    const status = document.getElementById("camera-settings-status");
    document.querySelectorAll("[data-camera-setting]").forEach(el => {
      const field = el.dataset.cameraSetting;
      const isToggle = el.dataset.toggle === "true";
      let savedValue = el.type === "checkbox" ? el.checked : el.value;
      if (el.type === "range") {
        el.addEventListener("input", () => {
          el.closest(".camera-volume-control").querySelector("output").value = el.value;
        });
      }
      const save = async () => {
        const previous = d[field];
        let value = isToggle ? el.classList.contains("sw-off") : el.type === "checkbox" ? el.checked : el.value;
        if (isToggle) {
          el.className = `toggle-switch ${value ? "sw-on" : "sw-off"}`;
          el.closest("section").querySelector(".camera-settings-body").hidden = !value;
          el.disabled = true;
        }
        if (el.dataset.toggleKind === "all-day") {
          value = value ? 2 : 1;
          const scheduleName = {soundAgingType: "sound", motionDetectionAgingType: "motion", soundDetectionAgingType: "sound-detection", cameraAgingType: "camera", videoRecordAgingType: "recording", lightAgingType: "indicators"}[field];
          const times = document.querySelector(`[data-schedule-times="${scheduleName}"]`);
          if (times) times.hidden = !el.checked;
        }
        if (el.type === "number" || el.type === "range") value = Number(value);
        const payload = { [field]: value };
        if ((field === "videoRecordAgingType" || field === "lightAgingType") && value === 2) {
          for (const timeField of (field === "lightAgingType" ? ["lightingStartTime", "lightingEndTime"] : ["videoRecordStartTime", "videoRecordEndTime"])) {
            payload[timeField] = document.querySelector(`[data-camera-setting="${timeField}"]`)?.value;
          }
        }
        const timeFields = {
          soundStartTime: ["soundStartTimeUtc", "sound_start_local"],
          soundEndTime: ["soundEndTimeUtc", "sound_end_local"],
          motionDetectionStartTime: ["motionDetectionStartTimeUtc", "motion_start_local"],
          motionDetectionEndTime: ["motionDetectionEndTimeUtc", "motion_end_local"],
          soundDetectionStartTime: ["soundDetectionStartTimeUtc", "sound_detection_start_local"],
          soundDetectionEndTime: ["soundDetectionEndTimeUtc", "sound_detection_end_local"],
          cameraStartTime: ["cameraStartTimeUtc", "camera_start_local"],
          cameraEndTime: ["cameraEndTimeUtc", "camera_end_local"],
        }[field];
        if (timeFields) {
          const [h, m] = String(value).split(":").map(Number);
          const utc = new Date(2000, 0, 1, h, m);
          payload[timeFields[0]] = `${String(utc.getUTCHours()).padStart(2,"0")}:${String(utc.getUTCMinutes()).padStart(2,"0")}`;
          payload[timeFields[1]] = value;
        }
        try {
          if (el.checkValidity && !el.checkValidity()) { el.reportValidity(); return; }
          // Recording hours are converted by the backend using the feeder timezone.
          await api("POST", `/api/devices/${encodeURIComponent(d.serial)}/command`, payload);
          _patchDevice(d.serial, payload);
          savedValue = el.type === "checkbox" ? el.checked : el.value;
          if (status) status.textContent = "";
        } catch (e) {
          if (!isToggle) {
            if (el.type === "checkbox") el.checked = savedValue;
            else el.value = savedValue;
          }
          if (field === "videoRecordAgingType" || field === "lightAgingType") {
            el.checked = Number(previous ?? 1) === 2;
            const times = document.querySelector(`[data-schedule-times="${field === "lightAgingType" ? "indicators" : "recording"}"]`);
            if (times) times.hidden = !el.checked;
          }
          if (isToggle) {
            el.className = `toggle-switch ${!value ? "sw-on" : "sw-off"}`;
            el.closest("section").querySelector(".camera-settings-body").hidden = value;
          }
          if (status) status.textContent = t("overview.failed");
          alert(t("overview.cmd_failed", {error: e.message}));
        } finally {
          if (isToggle) el.disabled = false;
        }
      };
      el.addEventListener(isToggle ? "click" : "change", save);
    });
    if (tabName !== "overview") return;
  }
  if (tabName === "controls") {
    const pump = document.getElementById("ctrl-pump");
    const light = document.getElementById("ctrl-light");
    const filterLed = document.getElementById("ctrl-filter-led");
    const waterType = document.getElementById("ctrl-water-type");
    const intermittent = document.getElementById("intermittent-settings");
    const applySchedule = document.getElementById("btn-apply-schedule");
    const applyLightSchedule = document.getElementById("btn-apply-light-schedule");
    const lightScheduleEnabled = document.getElementById("ctrl-light-schedule-enabled");
    const calibrateScale = document.getElementById("btn-calibrate-scale");

    if (pump) pump.onclick = () => togglePump(d);
    if (light) light.onclick = () => toggleLight(d);
    if (filterLed) filterLed.onclick = () => toggleFilterLed(d);
    if (lightScheduleEnabled) lightScheduleEnabled.onclick = () => toggleLightScheduleEnabled(d);
    if (waterType) {
      waterType.onchange = async () => {
        const val = parseInt(waterType.value);
        if (intermittent) intermittent.style.display = val === 1 ? "" : "none";
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { useWaterType: val });
          _patchDevice(d.serial, { useWaterType: val });
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }
    if (applySchedule) {
      applySchedule.onclick = async () => {
        const duration = parseInt(document.getElementById("ctrl-water-duration").value) || 15;
        const interval = parseInt(document.getElementById("ctrl-water-interval").value) || 15;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, {
            useWaterDuration: duration,
            useWaterInterval: interval,
          });
          _patchDevice(d.serial, { useWaterDuration: duration, useWaterInterval: interval });
          applySchedule.textContent = t("overview.applied");
          setTimeout(() => { applySchedule.textContent = t("overview.apply_schedule"); }, 1500);
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }
    if (applyLightSchedule) {
      applyLightSchedule.onclick = async () => {
        const start = document.getElementById("ctrl-light-start").value || "08:00";
        const end = document.getElementById("ctrl-light-end").value || "20:00";
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { _light_schedule: { start, end } });
          // Not patching lightAgingType here -- applying new times no longer
          // forces schedule mode on, it preserves whatever the device
          // already had (see devices.py's _light_schedule handler), so the
          // toggle's on-screen state shouldn't change just from this.
          _patchDevice(d.serial, { light_start_time: start, light_end_time: end });
          applyLightSchedule.textContent = t("overview.applied");
          setTimeout(() => { applyLightSchedule.textContent = t("overview.apply_light_schedule"); }, 1500);
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }
    if (calibrateScale) {
      calibrateScale.onclick = async () => {
        const orig = calibrateScale.textContent;
        calibrateScale.textContent = t("overview.calibrating");
        calibrateScale.disabled = true;
        const sentAt = Date.now();
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { cmd: "WEIGHT_CLR_SERVICE", threshold: 550 });
          const result = await _pollCalibrationResult(d.serial, sentAt);
          calibrateScale.textContent =
            result === "container" ? t("overview.calibrate_scale_container") :
            result === "ok"        ? t("overview.calibrate_scale_done") :
                                      t("overview.sent");
        } catch(e) {
          calibrateScale.textContent = t("overview.failed");
        }
        setTimeout(() => { calibrateScale.textContent = orig; calibrateScale.disabled = false; }, 3500);
      };
    }

    // Sound switch
    const soundSwitchEl = document.getElementById("ctrl-sound-switch");
    if (soundSwitchEl) {
      soundSwitchEl.onclick = async () => {
        const enabled = !soundSwitch;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { soundSwitch: enabled });
          _patchDevice(d.serial, { soundSwitch: enabled });
          soundSwitchEl.className = `toggle-switch ${enabled ? "sw-on" : "sw-off"}`;
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }
    // Sound volume
    const soundVolumeEl = document.getElementById("ctrl-sound-volume");
    if (soundVolumeEl) {
      soundVolumeEl.onchange = async () => {
        const volume = parseInt(soundVolumeEl.value) || 50;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { volume: volume });
          _patchDevice(d.serial, { volume: volume });
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }
    // Sound aging type
    const soundAgingTypeEl = document.getElementById("ctrl-sound-aging-type");
    if (soundAgingTypeEl) {
      soundAgingTypeEl.onchange = async () => {
        const mode = soundAgingTypeEl.value;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { soundAgingType: parseInt(mode) });
          _patchDevice(d.serial, { soundAgingType: parseInt(mode) });
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }

    // Motion detection switch
    const motionSwitchEl = document.getElementById("ctrl-motion-switch");
    if (motionSwitchEl) {
      motionSwitchEl.onclick = async () => {
        const enabled = !motionDetection;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { motionDetectionSwitch: enabled });
          _patchDevice(d.serial, { motionDetectionSwitch: enabled });
          motionSwitchEl.className = `toggle-switch ${enabled ? "sw-on" : "sw-off"}`;
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }
    // Motion sensitivity
    const motionSensitivityEl = document.getElementById("ctrl-motion-sensitivity");
    if (motionSensitivityEl) {
      motionSensitivityEl.onchange = async () => {
        const sensitivity = parseInt(motionSensitivityEl.value) || 5;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { motionDetectionSensitivity: sensitivity });
          _patchDevice(d.serial, { motionDetectionSensitivity: sensitivity });
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }
    // Motion range
    const motionRangeEl = document.getElementById("ctrl-motion-range");
    if (motionRangeEl) {
      motionRangeEl.onchange = async () => {
        const range = parseInt(motionRangeEl.value) || 50;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { motionDetectionRange: range });
          _patchDevice(d.serial, { motionDetectionRange: range });
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }

    // Camera switch
    const cameraSwitchEl = document.getElementById("ctrl-camera-switch");
    if (cameraSwitchEl) {
      cameraSwitchEl.onclick = async () => {
        const enabled = !cameraOn;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { cameraSwitch: enabled });
          _patchDevice(d.serial, { cameraSwitch: enabled });
          cameraSwitchEl.className = `toggle-switch ${enabled ? "sw-on" : "sw-off"}`;
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }
    // Camera resolution
    const cameraResolutionEl = document.getElementById("ctrl-camera-resolution");
    if (cameraResolutionEl) {
      cameraResolutionEl.onchange = async () => {
        const resolution = cameraResolutionEl.value;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { cameraResolution: resolution });
          _patchDevice(d.serial, { cameraResolution: resolution });
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }
    // Camera night vision
    const cameraNightVisionEl = document.getElementById("ctrl-camera-night-vision");
    if (cameraNightVisionEl) {
      cameraNightVisionEl.onchange = async () => {
        const enabled = cameraNightVisionEl.checked;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { cameraNightVision: enabled });
          _patchDevice(d.serial, { cameraNightVision: enabled });
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }

  }
  else if (tabName === "overview") {
    // Feeder controls
    const feedNow = document.getElementById("btn-feed-now");
    const openLid = document.getElementById("btn-open-lid");
    const closeLid = document.getElementById("btn-close-lid");

    if (feedNow) {
      feedNow.onclick = async () => {
        const portions = parseInt(document.getElementById("feeder-portions").value) || 1;
        feedNow.textContent = t("overview.feeding");
        feedNow.disabled = true;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, {
            cmd: "MANUAL_FEEDING_SERVICE",
            grainNum: portions,
          });
          feedNow.textContent = t("overview.sent");
        } catch(e) {
          feedNow.textContent = t("overview.failed");
        }
        setTimeout(() => { feedNow.textContent = t("overview.feed_now"); feedNow.disabled = false; }, 2000);
      };
    }
    if (openLid) {
      openLid.onclick = async () => {
        const orig = openLid.textContent;
        openLid.textContent = t("overview.opening");
        openLid.disabled = true;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, {
            cmd: "SWITCH_DOOR_SERVICE",
            barnDoorState: true,
          });
          openLid.textContent = t("overview.sent");
        } catch(e) {
          openLid.textContent = t("overview.failed");
          alert(t("overview.cmd_failed", {error: e.message}));
        }
        setTimeout(() => { openLid.textContent = orig; openLid.disabled = false; }, 2000);
      };
    }
    if (closeLid) {
      closeLid.onclick = async () => {
        const orig = closeLid.textContent;
        closeLid.textContent = t("overview.closing");
        closeLid.disabled = true;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, {
            cmd: "SWITCH_DOOR_SERVICE",
            barnDoorState: false,
          });
          closeLid.textContent = t("overview.sent");
        } catch(e) {
          closeLid.textContent = t("overview.failed");
          alert(t("overview.cmd_failed", {error: e.message}));
        }
        setTimeout(() => { closeLid.textContent = orig; closeLid.disabled = false; }, 2000);
      };
    }
    // Each feeder setting auto-saves independently on its own change, rather
    // than one bundled "Save Settings" button that resent every field
    // together -- that meant toggling Child Lock also re-sent Sound/Volume
    // every time, which made the feeder audibly announce "sound setting
    // saved" for a setting that hadn't actually changed.
    const feederAutoSave = (elId, getPayload, debounceMs) => {
      const el = document.getElementById(elId);
      if (!el) return;
      const send = async () => {
        const payload = getPayload(el);
        try {
          await api("POST", `/api/devices/${d.serial}/command`, payload);
          _patchDevice(d.serial, payload);
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
      // Debounced fields: a number input's spinner arrows fire onchange on
      // every single click, so rapid clicking would otherwise send one
      // command per click -- for volume specifically, that made the feeder
      // repeatedly announce "sound settings changed" out loud.
      el.onchange = debounceMs ? _debounce(send, debounceMs) : send;
    };
    feederAutoSave("feeder-cover-open-mode",  el => ({ coverOpenMode: el.value }));
    feederAutoSave("feeder-cover-close-speed", el => ({ coverCloseSpeed: el.value }));
    feederAutoSave("feeder-close-door-sec",   el => ({ closeDoorTimeSec: Math.min(10, Math.max(1, parseInt(el.value) || 10)) }), 2000);
    feederAutoSave("feeder-sound-switch",     el => ({ soundSwitch: el.checked }));
    feederAutoSave("feeder-volume",           el => ({ volume: parseInt(el.value) || 50 }), 2000);
    feederAutoSave("feeder-child-lock",       el => ({ childLockSwitch: el.checked }));

    _wireHours(d, "hrs-sound", "_sound_hours", ["sound_hours_mode", "sound_start_local", "sound_end_local"]);

    // Granary-style feeder controls -- unlike the RFID feeder above, this
    // settings path resends the complete bundle rather than a lone field (see
    // _granary_settings_bundle in devices.py), so these go through the
    // _granary_field/_granary_value flag instead of feederAutoSave's bare
    // single-field payloads.
    const granaryToggle = (elId, field) => {
      const el = document.getElementById(elId);
      if (!el) return;
      el.onclick = async () => {
        const newVal = !el.classList.contains("sw-on");
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { _granary_field: field, _granary_value: newVal });
          _patchDevice(d.serial, { [field]: newVal });
          renderDeviceTab("overview");
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    };
    granaryToggle("ctrl-granary-light", "lightSwitch");
    granaryToggle("ctrl-granary-lock", "disableHardwareButton");
    const granaryVolume = document.getElementById("feeder-granary-volume");
    if (granaryVolume) {
      granaryVolume.onchange = _debounce(async () => {
        const vol = parseInt(granaryVolume.value) || 50;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { _granary_field: "volume", _granary_value: vol });
          _patchDevice(d.serial, { volume: vol });
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      }, 2000);
    }

  }
  else if (tabName === "led") {
    _wireHours(d, "hrs-display", "_display_hours", ["display_hours_mode", "display_start_local", "display_end_local"]);
    _wireAnimations(d);
    const dispSw = document.getElementById("hrs-display-switch");
    if (dispSw) {
      dispSw.onclick = async () => {
        const on = !dispSw.classList.contains("sw-on");
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { _display_switch: on });
          _patchDevice(d.serial, { screenDisplaySwitch: on, enableScreenDisplay: on });
          renderDeviceTab("led");
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }

    const sendDisplayText = document.getElementById("btn-send-display-text");
    if (sendDisplayText) {
      sendDisplayText.onclick = async () => {
        const text = (document.getElementById("feeder-display-text").value || "").trim().toUpperCase();
        if (!text) return;
        const orig = sendDisplayText.textContent;
        sendDisplayText.textContent = "Sending...";
        sendDisplayText.disabled = true;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { _display_text: text });
          _patchDevice(d.serial, { display_text: text, display_icon: 0, display_icon_name: null });
          renderDevices();
          sendDisplayText.textContent = "Sent!";
        } catch(e) {
          sendDisplayText.textContent = "Failed";
        }
        setTimeout(() => { sendDisplayText.textContent = orig; sendDisplayText.disabled = false; }, 2000);
      };
    }

    const openAnimEditorBtn = document.getElementById("btn-open-anim-editor");
    if (openAnimEditorBtn) openAnimEditorBtn.onclick = () => openAnimEditor(d.serial);
    const openIconEditorBtn = document.getElementById("btn-open-icon-editor");
    if (openIconEditorBtn) {
      openIconEditorBtn.onclick = () => openIconEditor(d.serial);
    }
  }
  else if (tabName === "maintenance") {
    // Helper: back-calculate a last_ts from (days remaining, interval)
    function _lastTsFromDays(daysRemaining, intervalDays) {
      const elapsed = Math.max(0, intervalDays - daysRemaining);
      return Date.now() - elapsed * 86400000;
    }

    // Feeder: editable days-remaining inputs auto-save on change
    const foodRefillDaysEl = document.getElementById("maint-food-refill-days");
    if (foodRefillDaysEl) {
      foodRefillDaysEl.onchange = async () => {
        const days = parseInt(foodRefillDaysEl.value);
        if (isNaN(days)) return;
        const interval = parseInt(document.getElementById("maint-food-refill-interval").value) || 14;
        const last_ts = _lastTsFromDays(days, interval);
        await api("POST", `/api/devices/${d.serial}`, { last_food_refill_ts: last_ts, food_refill_interval_days: interval });
        _patchDevice(d.serial, { last_food_refill_ts: last_ts, food_refill_interval_days: interval });
      };
    }
    const desiccantDaysEl = document.getElementById("maint-desiccant-days");
    if (desiccantDaysEl) {
      desiccantDaysEl.onchange = async () => {
        const days = parseInt(desiccantDaysEl.value);
        if (isNaN(days)) return;
        const life = parseInt(document.getElementById("maint-desiccant-life").value) || 14;
        const last_ts = _lastTsFromDays(days, life);
        await api("POST", `/api/devices/${d.serial}`, { last_desiccant_ts: last_ts, desiccant_life_days: life });
        _patchDevice(d.serial, { last_desiccant_ts: last_ts, desiccant_life_days: life });
      };
    }
    const bowlDaysEl = document.getElementById("maint-bowl-days");
    if (bowlDaysEl) {
      bowlDaysEl.onchange = async () => {
        const days = parseInt(bowlDaysEl.value);
        if (isNaN(days)) return;
        const interval = parseInt(document.getElementById("maint-bowl-interval").value) || 7;
        const last_ts = _lastTsFromDays(days, interval);
        await api("POST", `/api/devices/${d.serial}`, { last_bowl_cleaned_ts: last_ts, bowl_cleaning_interval_days: interval });
        _patchDevice(d.serial, { last_bowl_cleaned_ts: last_ts, bowl_cleaning_interval_days: interval });
      };
    }
    const housingDaysEl = document.getElementById("maint-housing-days");
    if (housingDaysEl) {
      housingDaysEl.onchange = async () => {
        const days = parseInt(housingDaysEl.value);
        if (isNaN(days)) return;
        const interval = parseInt(document.getElementById("maint-housing-interval").value) || 30;
        const last_ts = _lastTsFromDays(days, interval);
        await api("POST", `/api/devices/${d.serial}`, { last_housing_cleaned_ts: last_ts, housing_cleaning_interval_days: interval });
        _patchDevice(d.serial, { last_housing_cleaned_ts: last_ts, housing_cleaning_interval_days: interval });
      };
    }
    // Fountain: editable days-remaining inputs auto-save on change
    const filterDaysEl = document.getElementById("maint-filter-days");
    if (filterDaysEl) {
      filterDaysEl.onchange = async () => {
        const days = parseInt(filterDaysEl.value);
        if (isNaN(days)) return;
        const newTs = Date.now() + days * 86400000;
        await api("POST", `/api/devices/${d.serial}/command`, { filterNextReplacementTimestamp: newTs });
        _patchDevice(d.serial, { filterNextReplacementTimestamp: newTs });
      };
    }
    const cleanDaysEl = document.getElementById("maint-clean-days");
    if (cleanDaysEl) {
      cleanDaysEl.onchange = async () => {
        const days = parseInt(cleanDaysEl.value);
        if (isNaN(days)) return;
        const interval = parseInt(document.getElementById("maint-clean-interval").value) || 30;
        const last_ts = _lastTsFromDays(days, interval);
        await api("POST", `/api/devices/${d.serial}`, { last_cleaned_ts: last_ts, cleaning_interval_days: interval });
        _patchDevice(d.serial, { last_cleaned_ts: last_ts, cleaning_interval_days: interval });
      };
    }

    const recordFoodRefill = document.getElementById("btn-record-food-refill");
    if (recordFoodRefill) {
      recordFoodRefill.onclick = async () => {
        const interval = parseInt(document.getElementById("maint-food-refill-interval").value) || 14;
        const now = Date.now();
        await api("POST", `/api/devices/${d.serial}`, { last_food_refill_ts: now, food_refill_interval_days: interval });
        _patchDevice(d.serial, { last_food_refill_ts: now, food_refill_interval_days: interval });
        recordFoodRefill.textContent = t("maint.recorded");
        setTimeout(() => { recordFoodRefill.textContent = t("maint.record_food_refill"); renderDeviceTab("maintenance"); }, 1200);
      };
    }
    const resetDesiccant = document.getElementById("btn-reset-desiccant");
    if (resetDesiccant) {
      resetDesiccant.onclick = async () => {
        const lifeDays = parseInt(document.getElementById("maint-desiccant-life").value) || 14;
        const now = Date.now();
        await api("POST", `/api/devices/${d.serial}`, { last_desiccant_ts: now, desiccant_life_days: lifeDays });
        _patchDevice(d.serial, { last_desiccant_ts: now, desiccant_life_days: lifeDays });
        resetDesiccant.textContent = t("maint.reset");
        setTimeout(() => { resetDesiccant.textContent = t("maint.reset_desiccant"); renderDeviceTab("maintenance"); }, 1200);
      };
    }
    const recordBowl = document.getElementById("btn-record-bowl");
    if (recordBowl) {
      recordBowl.onclick = async () => {
        const interval = parseInt(document.getElementById("maint-bowl-interval").value) || 7;
        const now = Date.now();
        await api("POST", `/api/devices/${d.serial}`, { last_bowl_cleaned_ts: now, bowl_cleaning_interval_days: interval });
        _patchDevice(d.serial, { last_bowl_cleaned_ts: now, bowl_cleaning_interval_days: interval });
        recordBowl.textContent = t("maint.recorded");
        setTimeout(() => { recordBowl.textContent = t("maint.record_bowl"); renderDeviceTab("maintenance"); }, 1200);
      };
    }
    const recordHousing = document.getElementById("btn-record-housing");
    if (recordHousing) {
      recordHousing.onclick = async () => {
        const interval = parseInt(document.getElementById("maint-housing-interval").value) || 30;
        const now = Date.now();
        await api("POST", `/api/devices/${d.serial}`, { last_housing_cleaned_ts: now, housing_cleaning_interval_days: interval });
        _patchDevice(d.serial, { last_housing_cleaned_ts: now, housing_cleaning_interval_days: interval });
        recordHousing.textContent = t("maint.recorded");
        setTimeout(() => { recordHousing.textContent = t("maint.record_housing"); renderDeviceTab("maintenance"); }, 1200);
      };
    }

    // Interval/life-days fields auto-save independently of the action
    // buttons below, so you can update just the interval without it also
    // claiming the maintenance task was just performed.
    const filterLifeEl = document.getElementById("maint-filter-life");
    if (filterLifeEl) {
      filterLifeEl.onchange = async () => {
        const lifeDays = parseInt(filterLifeEl.value) || 30;
        await api("POST", `/api/devices/${d.serial}`, { filter_life_days: lifeDays });
        _patchDevice(d.serial, { filter_life_days: lifeDays });
        renderDeviceTab("maintenance");
      };
    }
    const cleanIntervalEl = document.getElementById("maint-clean-interval");
    if (cleanIntervalEl) {
      cleanIntervalEl.onchange = async () => {
        const interval = parseInt(cleanIntervalEl.value) || 30;
        await api("POST", `/api/devices/${d.serial}`, { cleaning_interval_days: interval });
        _patchDevice(d.serial, { cleaning_interval_days: interval });
        renderDeviceTab("maintenance");
      };
    }
    const foodRefillIntervalEl = document.getElementById("maint-food-refill-interval");
    if (foodRefillIntervalEl) {
      foodRefillIntervalEl.onchange = async () => {
        const interval = parseInt(foodRefillIntervalEl.value) || 14;
        await api("POST", `/api/devices/${d.serial}`, { food_refill_interval_days: interval });
        _patchDevice(d.serial, { food_refill_interval_days: interval });
        renderDeviceTab("maintenance");
      };
    }
    const bowlIntervalEl = document.getElementById("maint-bowl-interval");
    if (bowlIntervalEl) {
      bowlIntervalEl.onchange = async () => {
        const interval = parseInt(bowlIntervalEl.value) || 7;
        await api("POST", `/api/devices/${d.serial}`, { bowl_cleaning_interval_days: interval });
        _patchDevice(d.serial, { bowl_cleaning_interval_days: interval });
        renderDeviceTab("maintenance");
      };
    }
    const housingIntervalEl = document.getElementById("maint-housing-interval");
    if (housingIntervalEl) {
      housingIntervalEl.onchange = async () => {
        const interval = parseInt(housingIntervalEl.value) || 30;
        await api("POST", `/api/devices/${d.serial}`, { housing_cleaning_interval_days: interval });
        _patchDevice(d.serial, { housing_cleaning_interval_days: interval });
        renderDeviceTab("maintenance");
      };
    }
    const desiccantLifeEl = document.getElementById("maint-desiccant-life");
    if (desiccantLifeEl) {
      desiccantLifeEl.onchange = async () => {
        const lifeDays = parseInt(desiccantLifeEl.value) || 14;
        await api("POST", `/api/devices/${d.serial}`, { desiccant_life_days: lifeDays });
        _patchDevice(d.serial, { desiccant_life_days: lifeDays });
        renderDeviceTab("maintenance");
      };
    }

    const resetFilter = document.getElementById("btn-reset-filter");
    const recordClean = document.getElementById("btn-record-clean");

    if (resetFilter) {
      resetFilter.onclick = async () => {
        const lifeDays = parseInt(document.getElementById("maint-filter-life").value) || 30;
        await api("POST", `/api/devices/${d.serial}`, { filter_life_days: lifeDays });
        const newTs = Date.now() + lifeDays * 86400000;
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { filterNextReplacementTimestamp: newTs });
          _patchDevice(d.serial, { filterNextReplacementTimestamp: newTs, filter_life_days: lifeDays });
          resetFilter.textContent = t("maint.reset");
          setTimeout(() => {
            resetFilter.textContent = t("maint.reset_filter");
            renderDeviceTab("maintenance");
          }, 1200);
        } catch(e) { alert(t("overview.cmd_failed", {error: e.message})); }
      };
    }
    if (recordClean) {
      recordClean.onclick = async () => {
        const cleanInterval = parseInt(document.getElementById("maint-clean-interval").value) || 30;
        const now = Date.now();
        await api("POST", `/api/devices/${d.serial}`, { last_cleaned_ts: now, cleaning_interval_days: cleanInterval });
        _patchDevice(d.serial, { last_cleaned_ts: now, cleaning_interval_days: cleanInterval });
        recordClean.textContent = t("maint.recorded");
        setTimeout(() => {
          recordClean.textContent = t("maint.record_cleaning");
          renderDeviceTab("maintenance");
        }, 1200);
      };
    }
    const lowWaterEl = document.getElementById("maint-low-water");
    if (lowWaterEl) {
      lowWaterEl.onchange = async () => {
        const inputVal = parseFloat(lowWaterEl.value) || 0;
        const grams = useImperial() ? Math.round(inputVal / 0.033814) : Math.round(inputVal);
        await api("POST", `/api/devices/${d.serial}`, { low_water_grams: grams });
        try {
          await api("POST", `/api/devices/${d.serial}/command`, { lowWater: grams });
        } catch {}
        _patchDevice(d.serial, { low_water_grams: grams, lowWater: grams });
      };
    }
    const minDrinkEl = document.getElementById("maint-min-drink");
    if (minDrinkEl) {
      minDrinkEl.onchange = async () => {
        const val = Math.max(1, parseInt(minDrinkEl.value) || 5);
        await api("POST", `/api/devices/${d.serial}`, { min_drink_grams: val });
        _patchDevice(d.serial, { min_drink_grams: val });
      };
    }
  }
  else if (tabName === "notifications") {
    // Wire show/hide for email address and mobile service sections
    const emailCb = document.getElementById("nchan-email");
    const mobileCb = document.getElementById("nchan-mobile");
    const emailSec = document.getElementById("nchan-email-section");
    const mobileSec = document.getElementById("nchan-mobile-section");
    if (emailCb && emailSec) emailCb.onchange = () => { emailSec.style.display = emailCb.checked ? "" : "none"; };
    if (mobileCb && mobileSec) mobileCb.onchange = () => { mobileSec.style.display = mobileCb.checked ? "" : "none"; };

    const saveBtn = document.getElementById("btn-save-device-notifications");
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const notif = {};
        document.querySelectorAll(".notif-check[data-key]").forEach(cb => {
          notif[cb.dataset.key] = cb.checked;
        });
        const battLowEl = document.getElementById("notif-battery-low-pct");
        const payload = {
          notifications: notif,
          notify_bell: document.getElementById("nchan-bell")?.checked !== false,
          notify_email: document.getElementById("nchan-email")?.checked !== false,
          notify_email_address: (document.getElementById("nchan-email-addr")?.value || "").trim(),
          notify_mobile: !!document.getElementById("nchan-mobile")?.checked,
          notify_mobile_service: document.getElementById("nchan-mobile-svc")?.value || "",
          ...(battLowEl ? { battery_low_pct: Math.max(0, Math.min(99, parseInt(battLowEl.value) || 0)) } : {}),
        };
        await api("POST", `/api/devices/${d.serial}`, payload);
        _patchDevice(d.serial, { ...payload });
        saveBtn.textContent = t("notif.saved");
        setTimeout(() => { saveBtn.textContent = t("notif.save"); }, 1500);
      };
    }
  }
}

function _patchDevice(serial, patch) {
  const d = _devices.find(d => d.serial === serial);
  if (d) Object.assign(d, patch);
  if (_currentDevice && _currentDevice.serial === serial) Object.assign(_currentDevice, patch);
}
