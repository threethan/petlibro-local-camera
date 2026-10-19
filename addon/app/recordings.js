// SD-card playback uses a separate historical stream; dates use the feeder zone.
const _recordings = { active: false, serial: "", items: [], filter: "all", selected: null,
  offset: 0, playing: false, generation: 0, listGeneration: 0, abort: null, player: null, power: null,
  selection: new Set(), actionAbort: null, actionBusy: false, actionKind: null };
let _recordingSelectionDrag = null;

function stopRecordingSelectionDrag() {
  const drag = _recordingSelectionDrag;
  if (!drag) return;
  _recordingSelectionDrag = null;
  try { drag.button.releasePointerCapture(drag.pointerId); } catch { /* Pointer already ended. */ }
  document.getElementById("recordings-list")?.classList.remove("is-drag-selecting");
}

function extendRecordingSelectionDrag() {
  const drag = _recordingSelectionDrag;
  if (!drag || !_recordings.active || _recordings.actionBusy) return;
  const row = document.elementFromPoint(drag.x, drag.y)?.closest(".recording-item");
  if (!row || !document.getElementById("recordings-list").contains(row)) return;
  const items = filteredRecordings();
  const anchor = items.findIndex(item => item.start === drag.anchor);
  const target = items.findIndex(item => item.start === Number(row.dataset.start));
  if (anchor < 0 || target < 0) return;
  const selection = new Set(drag.original);
  for (let index = Math.min(anchor, target); index <= Math.max(anchor, target); index++) {
    if (drag.selecting) selection.add(items[index].start);
    else selection.delete(items[index].start);
  }
  _recordings.selection = selection;
  updateRecordingSelection();
}

function wireRecordingSelectionDrag(button, item) {
  let timer, held = false, origin;
  const cancelTimer = () => { clearTimeout(timer); timer = null; };
  button.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || _recordings.actionBusy) return;
    if (event.target.closest(".recording-action, .recording-select")) return;
    stopRecordingSelectionDrag();
    held = false;
    origin = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      if (!_recordings.active || !button.isConnected || _recordings.actionBusy) return;
      held = true;
      _recordingSelectionDrag = {
        button, pointerId: event.pointerId, anchor: item.start,
        original: new Set(_recordings.selection), selecting: !_recordings.selection.has(item.start),
        x: origin.x, y: origin.y,
      };
      try { button.setPointerCapture(event.pointerId); } catch { /* Touch fallback below retains its target. */ }
      document.getElementById("recordings-list").classList.add("is-drag-selecting");
      extendRecordingSelectionDrag();
    }, 500);
  });
  button.addEventListener("pointermove", event => {
    const drag = _recordingSelectionDrag;
    if (drag?.button === button && drag.pointerId === event.pointerId) {
      event.preventDefault();
      drag.x = event.clientX; drag.y = event.clientY;
      extendRecordingSelectionDrag();
    } else if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 12) cancelTimer();
  });
  // Cancel native touch scrolling only after the hold activates selection.
  // Ordinary swipes before that point continue to scroll the recordings list.
  button.addEventListener("touchmove", event => {
    if (_recordingSelectionDrag?.button === button) event.preventDefault();
  }, { passive: false });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    button.addEventListener(name, () => { cancelTimer(); if (_recordingSelectionDrag?.button === button) stopRecordingSelectionDrag(); });
  }
  button.addEventListener("pointerleave", () => { if (_recordingSelectionDrag?.button !== button) cancelTimer(); });
  button.addEventListener("contextmenu", event => event.preventDefault());
  return () => { cancelTimer(); const result = held; held = false; return result; };
}

function recordingIcon(name) {
  return `<span class="material-icons" aria-hidden="true">${escHtml(name)}</span>`;
}

function recordingTimezone() {
  try {
    const zone = _settings.feeder_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
    return zone;
  } catch { return "UTC"; }
}

function recordingDate(timestamp = Date.now() / 1000) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: recordingTimezone(), year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp * 1000));
  const get = key => parts.find(part => part.type === key).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function recordingAdjacentDate(date, days) {
  const instant = new Date(`${date}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function recordingMidnight(date, zone = recordingTimezone()) {
  const target = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(target)) throw new Error(t("recordings.invalid_date"));
  let instant = target;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const correction = target - wall;
    instant += correction;
    if (!correction) break;
  }
  return instant / 1000;
}

function recordingDayRange(date) {
  return { start: recordingMidnight(date), end: recordingMidnight(recordingAdjacentDate(date, 1)) };
}

function recordingTime(seconds) {
  return new Intl.DateTimeFormat(undefined, { timeZone: recordingTimezone(), hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(seconds * 1000));
}

function recordingDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function recordingKind(item) {
  // Same-version Flutter PlaybackEventType: feed48, motion1, sound240.
  return ({ 48: "feeding", 1: "motion", 240: "sound" })[item.event & 255] || "recording";
}

function filteredRecordings() {
  return _recordings.items.filter(item => _recordings.filter === "all" || recordingKind(item) === _recordings.filter);
}

function syncRecordingsDevices() {
  if (!_recordings.active) return;
  const select = document.getElementById("recordings-device");
  const cameras = _devices.filter(device => device.device_type === "camera_feeder");
  const optionsKey = JSON.stringify(cameras.map(device => [device.serial, device.name]));
  if (select.dataset.optionsKey !== optionsKey) {
    select.dataset.optionsKey = optionsKey;
    select.innerHTML = cameras.map(device => `<option value="${escHtml(device.serial)}">${escHtml(device.name || device.serial)}</option>`).join("");
  }
  if (!cameras.some(device => device.serial === _recordings.serial)) {
    leaveRecordingsDevice();
    _recordings.items = [];
    _recordings.selected = null;
    _recordings.serial = cameras[0]?.serial || "";
    select.value = _recordings.serial;
    if (_recordings.serial) loadRecordings();
    else renderRecordingList();
  } else select.value = _recordings.serial;
  const device = cameras.find(item => item.serial === _recordings.serial);
  document.getElementById("recordings-date").max = recordingDate();
  updateRecordingAvailability(device);
  if (!device) setRecordingListStatus(t("recordings.no_devices"));
  else if (!device.online || noSdCardDetected(device)) {
    _recordings.abort?.abort();
    _recordings.listGeneration++;
    stopRecordingPlayback();
    _recordings.items = [];
    _recordings.selection.clear();
    _recordings.selected = null;
    renderRecordingList();
    setRecordingListStatus(t(device.online ? "recordings.no_card" : "recordings.offline"));
  }
}

function updateRecordingAvailability(device) {
  const message = !device ? "recordings.no_devices"
    : !device.online ? "recordings.offline"
    : noSdCardDetected(device) ? "recordings.no_card" : "";
  const notice = document.getElementById("recordings-availability");
  notice.textContent = message ? t(message) : "";
  notice.hidden = !message;
  document.getElementById("recordings-content").hidden = !!message;
  document.getElementById("recordings-device-label").hidden = !device;
  document.getElementById("recordings-heading").classList.toggle("sr-only", !!device);
  const total = Number(device?.sdCardTotalCapacity), used = Number(device?.sdCardUsedCapacity);
  document.getElementById("recordings-storage").textContent = !message && total > 0 && Number.isFinite(used)
    ? `${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} GB` : "";
}

function setRecordingsTabActive(active) {
  _recordings.active = active;
  if (!active) { leaveRecordingsDevice(); return; }
  initRecordings();
  const previousSerial = _recordings.serial;
  syncRecordingsDevices();
  if (_recordings.serial && previousSerial === _recordings.serial) loadRecordings();
}

function leaveRecordingsDevice() {
  exitRecordingFullscreen();
  stopRecordingSelectionDrag();
  _recordings.actionAbort?.abort();
  const progress = document.getElementById("recordings-action-progress");
  if (progress) progress.hidden = true;
  _recordings.selection.clear();
  updateRecordingSelection();
  _recordings.abort?.abort();
  _recordings.abort = null;
  _recordings.listGeneration++;
  stopRecordingPlayback();
  if (_recordings.power) {
    releaseCameraPower(_recordings.power.serial, _recordings.power);
    _recordings.power = null;
  }
}

async function recordingPowerReady(serial) {
  const device = _devices.find(item => item.serial === serial);
  if (device?.camera_power_with_live_view === true && !_recordings.power) {
    const owner = { serial };
    _recordings.power = owner;
    await acquireCameraPower(serial, owner);
  }
}

function setRecordingListStatus(message) {
  document.getElementById("recordings-list-status").textContent = message;
}

async function loadRecordings() {
  _recordings.selection.clear();
  stopRecordingPlayback();
  _recordings.abort?.abort();
  const controller = new AbortController();
  _recordings.abort = controller;
  const generation = ++_recordings.listGeneration;
  _recordings.items = [];
  _recordings.selected = null;
  renderRecordingList();
  const serial = _recordings.serial;
  const device = _devices.find(item => item.serial === serial && item.device_type === "camera_feeder");
  updateRecordingAvailability(device);
  if (!device) return;
  if (!device.online || noSdCardDetected(device)) {
    setRecordingListStatus(t(device.online ? "recordings.no_card" : "recordings.offline"));
    return;
  }
  setRecordingListStatus(t("recordings.loading"));
  document.getElementById("recordings-list").setAttribute("aria-busy", "true");
  try {
    await recordingPowerReady(serial);
    if (controller.signal.aborted) return;
    const date = document.getElementById("recordings-date").value;
    const { start, end } = recordingDayRange(date);
    document.getElementById("recordings-timezone").textContent = t("recordings.timezone", { zone: recordingTimezone() });
    document.getElementById("recordings-day-after").disabled = date >= recordingDate();
    const response = await fetch(`${BASE}/api/devices/${encodeURIComponent(serial)}/recordings?${new URLSearchParams({ start, end })}`, { signal: controller.signal });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    if (generation !== _recordings.listGeneration) return;
    if (data.complete !== true || !Array.isArray(data.recordings)) throw new Error(t("recordings.incomplete"));
    _recordings.items = data.recordings.filter(item => Number.isFinite(item.start) && Number.isFinite(item.duration) && item.duration > 0)
      .sort((a, b) => a.start - b.start);
    renderRecordingList();
    if (_recordings.items.length) {
      const viewport = document.querySelector(".recordings-timeline-scroll");
      const timeline = document.getElementById("recordings-timeline");
      viewport.scrollLeft = Math.max(0, (_recordings.items[0].start - start) / (end - start) * timeline.scrollWidth - viewport.clientWidth / 2);
    }
    setRecordingListStatus(_recordings.items.length ? t("recordings.count", { count: _recordings.items.length }) : t("recordings.empty"));
  } catch (error) {
    if (!controller.signal.aborted && generation === _recordings.listGeneration) {
      setRecordingListStatus(`${t("recordings.load_failed")} ${error.message}`);
    }
  } finally {
    if (generation === _recordings.listGeneration) document.getElementById("recordings-list").removeAttribute("aria-busy");
  }
}

function renderRecordingList() {
  stopRecordingSelectionDrag();
  const items = filteredRecordings();
  const selected = _recordings.selected;
  const list = document.getElementById("recordings-list");
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement("div");
    row.dataset.start = item.start;
    row.className = `recording-item${item === selected ? " selected" : ""}${_recordings.selection.has(item.start) ? " is-selected" : ""}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "recording-select";
    checkbox.checked = _recordings.selection.has(item.start);
    checkbox.disabled = _recordings.actionBusy;
    checkbox.setAttribute("aria-label", t("recordings.select", { time: recordingTime(item.start) }));
    checkbox.addEventListener("change", () => toggleRecordingSelection(item));
    row.append(checkbox);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recording-play";
    button.disabled = _recordings.actionBusy;
    button.setAttribute("aria-pressed", String(item === selected));
    const kind = recordingKind(item);
    button.innerHTML = `${recordingIcon(kind === "feeding" ? "restaurant" : kind === "motion" ? "pets" : kind === "sound" ? "volume_up" : "videocam")}<span><strong>${escHtml(recordingTime(item.start))}</strong><small>${escHtml(t(`recordings.${["feeding", "motion", "sound"].includes(kind) ? kind : "recording"}`))}</small></span><span class="recording-duration">${recordingDuration(item.duration)}</span>${recordingIcon("play_circle")}`;
    const consumeHoldClick = wireRecordingSelectionDrag(row, item);
    row.addEventListener("click", event => {
      if (event.target.closest(".recording-action, .recording-select") || _recordings.actionBusy) return;
      if (consumeHoldClick()) return;
      if (event.ctrlKey || event.metaKey || _recordings.selection.size) toggleRecordingSelection(item);
      else playRecording(item);
    });
    row.append(button);
    for (const action of ["download", "delete"]) {
      const control = document.createElement("button");
      control.type = "button";
      control.className = `recording-action recording-${action}`;
      control.title = t(`recordings.${action}_one`);
      control.setAttribute("aria-label", `${control.title} · ${recordingTime(item.start)}`);
      control.innerHTML = recordingIcon(action);
      control.disabled = _recordings.actionBusy;
      control.addEventListener("click", () => runRecordingAction(action, [item]));
      row.append(control);
    }
    list.append(row);
  }
  if (_recordings.items.length && !items.length) {
    const message = document.createElement("p");
    message.textContent = t("recordings.no_matches");
    list.append(message);
  }
  renderRecordingTimeline(items);
  updateRecordingControls();
  updateRecordingSelection();
}

function toggleRecordingSelection(item) {
  if (_recordings.actionBusy) return;
  if (_recordings.selection.has(item.start)) _recordings.selection.delete(item.start);
  else _recordings.selection.add(item.start);
  updateRecordingSelection();
}

function updateRecordingSelection() {
  const island = document.getElementById("recordings-selection-island");
  if (!island) return;
  const count = _recordings.selection.size;
  document.querySelectorAll(".recording-item").forEach(row => {
    const selected = _recordings.selection.has(Number(row.dataset.start));
    row.classList.toggle("is-selected", selected);
    row.querySelector(".recording-select").checked = selected;
  });
  for (const id of ["recordings-device", "recordings-date", "recordings-refresh", "recordings-day-before"]) {
    document.getElementById(id).disabled = _recordings.actionBusy || (id === "recordings-device" && !_recordings.serial);
  }
  document.getElementById("recordings-day-after").disabled = _recordings.actionBusy || document.getElementById("recordings-date").value >= recordingDate();
  document.querySelectorAll("[data-recording-filter]").forEach(button => { button.disabled = _recordings.actionBusy; });
  island.hidden = !_recordings.active || count < 2 || _recordings.actionBusy;
  for (const action of ["delete", "download"]) {
    const button = document.getElementById(`recordings-bulk-${action}`);
    button.innerHTML = `${recordingIcon(action)}<span>${escHtml(t(`recordings.${action}_count`, { n: count }))}</span>`;
    button.disabled = _recordings.actionBusy;
  }
  document.getElementById("recordings-clear-selection").disabled = _recordings.actionBusy;
  document.getElementById("recordings-list").setAttribute("aria-busy", String(_recordings.actionBusy));
}

async function runRecordingAction(action, items) {
  if (!items.length || _recordings.actionBusy) return;
  if (action === "delete" && !confirm(t("recordings.delete_confirm", { n: items.length }))) return;
  const serial = _recordings.serial;
  const controller = new AbortController();
  _recordings.actionAbort = controller;
  _recordings.actionBusy = true;
  _recordings.actionKind = action;
  stopRecordingPlayback(false);
  renderRecordingList();
  const files = [];
  let size = 0, completed = 0;
  showRecordingActionProgress(action, completed, items.length, size, action === "delete" ? 0 : null);
  try {
    await recordingPowerReady(serial);
    for (const item of items) {
      controller.signal.throwIfAborted();
      setRecordingListStatus(t(`recordings.${action}_progress`, { n: completed + 1, total: items.length }));
      const root = `${BASE}/api/devices/${encodeURIComponent(serial)}/recordings`;
      const path = action === "delete" ? `${root}/${item.start}` : `${root}/video.mp4?${new URLSearchParams({ start: item.start, offset: 0 })}`;
      let response;
      for (let attempt = 0; attempt < 8; attempt++) {
        response = await fetch(path, { method: action === "delete" ? "DELETE" : "GET", signal: controller.signal });
        if (response.status !== 409 || attempt === 7) break;
        // Closing the player releases its device channel asynchronously.
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (!response.ok) throw new Error(await response.text());
      if (action === "delete") {
        const result = await response.json();
        if (result.deleted !== item.start) throw new Error(t("recordings.delete_unconfirmed"));
        _recordings.items = _recordings.items.filter(candidate => candidate.start !== item.start);
        _recordings.selection.delete(item.start);
        if (_recordings.selected?.start === item.start) _recordings.selected = null;
      } else {
        // Bound downloads in memory, including a batch's uncompressed ZIP.
        const chunks = [], reader = response.body.getReader();
        const length = Number(response.headers.get("Content-Length"));
        let fileBytes = 0;
        showRecordingActionProgress(action, completed, items.length, size, length > 0 ? completed / items.length : null);
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            fileBytes += value.byteLength;
            showRecordingActionProgress(action, completed, items.length, size,
              length > 0 ? (completed + Math.min(fileBytes / length, 1)) / items.length : null);
            if (size > 256 * 1024 * 1024) throw new Error(t("recordings.download_too_large"));
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        files.push({ name: `petlibro-${serial}-${item.start}.mp4`, blob: new Blob(chunks, { type: "video/mp4" }) });
      }
      completed++;
      showRecordingActionProgress(action, completed, items.length, size, completed / items.length);
    }
    if (action === "download" && !controller.signal.aborted) {
      const blob = files.length === 1 ? files[0].blob : await recordingZip(files, {
        signal: controller.signal,
        onProgress: fraction => showRecordingActionProgress(action, completed, items.length, size, fraction, true),
      });
      controller.signal.throwIfAborted();
      const name = files.length === 1 ? files[0].name : `petlibro-${serial}-recordings.zip`;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = name;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    if (!controller.signal.aborted) setRecordingListStatus(t(`recordings.${action}_done`, { n: completed }));
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "user" && _recordings.active) {
      setRecordingListStatus(t("recordings.download_cancelled"));
    } else if (!controller.signal.aborted) setRecordingListStatus(t(action === "download" ? "recordings.download_failed" : "recordings.action_failed", { n: completed, total: items.length, error: error.message }));
  } finally {
    if (_recordings.actionAbort === controller) {
      _recordings.actionAbort = null;
      _recordings.actionBusy = false;
      _recordings.actionKind = null;
      document.getElementById("recordings-action-progress").hidden = true;
      renderRecordingList();
    }
  }
}

function showRecordingActionProgress(action, completed, total, bytes, fraction = null, packaging = false) {
  document.getElementById("recordings-action-progress").hidden = !_recordings.active;
  const progress = document.getElementById("recordings-action-bar");
  if (fraction === null) progress.removeAttribute("value");
  else progress.value = Math.max(0, Math.min(1, fraction));
  document.getElementById("recordings-action-label").textContent = packaging
    ? t("recordings.preparing_zip")
    : t(`recordings.${action}_progress`, { n: Math.min(completed + 1, total), total });
  const received = bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  document.getElementById("recordings-action-detail").textContent = action === "delete"
    ? t("recordings.delete_completed", { n: completed, total })
    : t("recordings.download_received", { size: received, n: completed, total });
  document.getElementById("recordings-download-cancel").hidden = action !== "download";
  document.getElementById("recordings-download-cancel").disabled = false;
}

function cancelRecordingDownload() {
  if (_recordings.actionKind !== "download") return;
  document.getElementById("recordings-download-cancel").disabled = true;
  setRecordingListStatus(t("recordings.download_cancelled"));
  _recordings.actionAbort?.abort("user");
}

async function recordingZip(files, { signal, onProgress } = {}) {
  const entries = [], directory = [];
  let offset = 0, directorySize = 0;
  const encode = new TextEncoder();
  const totalBytes = files.reduce((sum, file) => sum + file.blob.size, 0);
  let processedBytes = 0;
  signal?.throwIfAborted();
  onProgress?.(0);
  const crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    crcTable[index] = value;
  }
  const header = size => { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; };
  for (const file of files) {
    signal?.throwIfAborted();
    const name = encode.encode(file.name), data = new Uint8Array(await file.blob.arrayBuffer());
    let crc = 0xffffffff;
    for (let offset = 0; offset < data.length; offset += 1024 * 1024) {
      signal?.throwIfAborted();
      const end = Math.min(offset + 1024 * 1024, data.length);
      for (let index = offset; index < end; index++) crc = (crc >>> 8) ^ crcTable[(crc ^ data[index]) & 255];
      onProgress?.((processedBytes + end) / Math.max(1, totalBytes));
      // Yield while packaging so the Cancel button remains responsive.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    processedBytes += data.length;
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = header(30), central = header(46);
    local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, 20, true);
    local.view.setUint16(12, 0x21, true);
    local.view.setUint32(14, crc, true); local.view.setUint32(18, data.length, true); local.view.setUint32(22, data.length, true); local.view.setUint16(26, name.length, true);
    central.view.setUint32(0, 0x02014b50, true); central.view.setUint16(4, 20, true); central.view.setUint16(6, 20, true);
    central.view.setUint16(14, 0x21, true);
    central.view.setUint32(16, crc, true); central.view.setUint32(20, data.length, true); central.view.setUint32(24, data.length, true); central.view.setUint16(28, name.length, true); central.view.setUint32(42, offset, true);
    entries.push(local.bytes, name, data); directory.push(central.bytes, name);
    offset += 30 + name.length + data.length; directorySize += 46 + name.length;
  }
  const end = header(22); end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, files.length, true); end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, directorySize, true); end.view.setUint32(16, offset, true);
  signal?.throwIfAborted();
  return new Blob([...entries, ...directory, end.bytes], { type: "application/zip" });
}

function renderRecordingTimeline(items) {
  const timeline = document.getElementById("recordings-timeline");
  timeline.replaceChildren();
  const date = document.getElementById("recordings-date").value;
  if (!date) return;
  const { start, end } = recordingDayRange(date);
  for (let hour = start; hour <= end; hour += 3600) {
    const tick = document.createElement("span");
    tick.className = "recordings-hour";
    tick.style.left = `${100 * (hour - start) / (end - start)}%`;
    tick.textContent = hour === end ? "24:00" : recordingTime(hour).slice(0, 5);
    timeline.append(tick);
  }
  for (const item of items) {
    const clipStart = Math.max(start, item.start), clipEnd = Math.min(end, item.start + item.duration);
    if (clipEnd <= clipStart) continue;
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = `recordings-segment ${recordingKind(item)}${item === _recordings.selected ? " selected" : ""}`;
    mark.style.left = `${100 * (clipStart - start) / (end - start)}%`;
    mark.style.width = `${100 * (clipEnd - clipStart) / (end - start)}%`;
    mark.title = `${recordingTime(item.start)} · ${recordingDuration(item.duration)}`;
    mark.setAttribute("aria-label", mark.title);
    mark.addEventListener("click", event => {
      const position = Math.max(0, Math.min(1, event.offsetX / mark.clientWidth));
      playRecording(item, Math.floor(clipStart - item.start + position * (clipEnd - clipStart)));
    });
    timeline.append(mark);
  }
}

function updateRecordingControls() {
  const item = _recordings.selected;
  const index = _recordings.items.indexOf(item);
  document.getElementById("recordings-previous").disabled = index <= 0;
  document.getElementById("recordings-next").disabled = index < 0 || index >= _recordings.items.length - 1;
  const play = document.getElementById("recordings-play");
  play.disabled = !item;
  play.innerHTML = `${recordingIcon(_recordings.playing ? "pause" : "play_arrow")}<span class="sr-only">${escHtml(t(_recordings.playing ? "recordings.pause" : "recordings.play"))}</span>`;
  const seek = document.getElementById("recordings-seek");
  seek.disabled = !item;
  seek.max = Math.max(1, (item?.duration || 1) - 1);
  seek.value = Math.floor(_recordings.offset);
  document.getElementById("recordings-clock").textContent = `${recordingDuration(_recordings.offset)} / ${recordingDuration(item?.duration || 0)}`;
  document.getElementById("recordings-snapshot").disabled = !_recordings.player || !_recordings.playing;
  const timeline = document.getElementById("recordings-timeline");
  timeline.querySelector(".recordings-playhead")?.remove();
  if (item) {
    const date = document.getElementById("recordings-date").value;
    const { start, end } = recordingDayRange(date);
    const instant = item.start + _recordings.offset;
    if (instant >= start && instant <= end) {
      const needle = document.createElement("span");
      needle.className = "recordings-playhead";
      needle.style.left = `${100 * (instant - start) / (end - start)}%`;
      timeline.append(needle);
    }
  }
}

function stopRecordingPlayback(reset = true) {
  _recordings.generation++;
  _recordings.playing = false;
  _recordings.player?.close();
  _recordings.player = null;
  if (reset) _recordings.offset = 0;
  document.getElementById("recordings-placeholder").hidden = false;
  document.getElementById("recordings-player-status").textContent = "";
  updateRecordingControls();
}

async function playRecording(item, offset = 0) {
  stopRecordingPlayback();
  _recordings.selected = item;
  _recordings.offset = Math.max(0, Math.min(item.duration - 1, offset));
  _recordings.playing = true;
  const generation = _recordings.generation;
  const serial = _recordings.serial;
  renderRecordingList();
  const status = document.getElementById("recordings-player-status");
  status.textContent = t("recordings.connecting");
  try {
    await recordingPowerReady(serial);
    if (generation !== _recordings.generation || !_recordings.active) return;
    const baseOffset = _recordings.offset;
    const params = new URLSearchParams({ start: item.start, offset: Math.floor(baseOffset) });
    const player = openRecordingPlayer(`${BASE}/api/devices/${encodeURIComponent(serial)}/recordings/video.mp4?${params}`, {
      onTime(seconds) {
        if (generation !== _recordings.generation) return;
        _recordings.offset = Math.min(item.duration, baseOffset + seconds);
        updateRecordingControls();
        if (_recordings.offset >= item.duration) {
          stopRecordingPlayback(false);
          status.textContent = t("recordings.ended");
        }
      },
      onReady() {
        if (generation !== _recordings.generation) return;
        document.getElementById("recordings-placeholder").hidden = true;
        status.textContent = recordingTime(item.start + baseOffset);
      },
      onEnd(error) {
        if (generation !== _recordings.generation) return;
        stopRecordingPlayback(false);
        status.textContent = error ? `${t("recordings.play_failed")} ${error.message}` : t("recordings.ended");
      },
    });
    _recordings.player = player;
    updateRecordingControls();
  } catch (error) {
    if (generation === _recordings.generation) {
      stopRecordingPlayback(false);
      status.textContent = `${t("recordings.play_failed")} ${error.message}`;
    }
  }
}

function openRecordingPlayer(path, callbacks) {
  const mime = 'video/mp4; codecs="avc1.42E01F, mp4a.40.2"';
  if (!window.MediaSource || !MediaSource.isTypeSupported(mime)) throw new Error(t("recordings.browser_unsupported"));
  const controller = new AbortController();
  const video = document.createElement("video");
  video.autoplay = true; video.playsInline = true; video.muted = false;
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  let reader;
  const timer = setTimeout(() => { callbacks.onEnd(new Error(t("recordings.timeout"))); close(); }, 65000);
  const close = () => {
    clearTimeout(timer);
    controller.abort();
    reader?.cancel().catch(() => {});
    video.onloadeddata = video.ontimeupdate = video.onended = video.onerror = null;
    video.pause(); video.removeAttribute("src"); video.load(); video.remove();
    URL.revokeObjectURL(url);
  };
  const wait = () => new Promise(resolve => {
    const id = setTimeout(done, 150);
    function done() { clearTimeout(id); controller.signal.removeEventListener("abort", done); resolve(); }
    controller.signal.addEventListener("abort", done, { once: true });
  });
  const update = (buffer, operation) => new Promise((resolve, reject) => {
    const cleanup = () => { buffer.removeEventListener("updateend", done); buffer.removeEventListener("error", fail); controller.signal.removeEventListener("abort", aborted); };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error(t("recordings.decode_failed"))); };
    const aborted = () => { cleanup(); resolve(); };
    buffer.addEventListener("updateend", done, { once: true });
    buffer.addEventListener("error", fail, { once: true });
    controller.signal.addEventListener("abort", aborted, { once: true });
    try { operation(); } catch (error) { cleanup(); reject(error); }
  });
  video.onloadeddata = () => {
    clearTimeout(timer);
    callbacks.onReady();
    video.play().catch(error => {
      // Some browsers require another tap after the asynchronous SD setup.
      if (error.name === "NotAllowedError") video.controls = true;
      else callbacks.onEnd(error);
    });
  };
  video.ontimeupdate = () => callbacks.onTime(video.currentTime);
  video.onended = () => callbacks.onEnd();
  video.onerror = () => callbacks.onEnd(new Error(t("recordings.decode_failed")));
  document.getElementById("recordings-frame").prepend(video);
  video.src = url;
  (async () => {
    await new Promise(resolve => {
      const done = () => { source.removeEventListener("sourceopen", done); controller.signal.removeEventListener("abort", done); resolve(); };
      source.addEventListener("sourceopen", done, { once: true });
      controller.signal.addEventListener("abort", done, { once: true });
    });
    if (controller.signal.aborted) return;
    const buffer = source.addSourceBuffer(mime);
    let response;
    // The previous stream may be releasing its device channel after a seek.
    for (let retry = 0; retry < 8; retry++) {
      response = await fetch(path, { signal: controller.signal });
      if (response.status !== 409 || retry === 7) break;
      await response.body?.cancel();
      await wait();
    }
    if (!response.ok || !response.body) throw new Error(await response.text());
    reader = response.body.getReader();
    while (!controller.signal.aborted) {
      // Historical video must retain its position; bound buffering without jumping ahead.
      while (buffer.buffered.length && buffer.buffered.end(buffer.buffered.length - 1) - video.currentTime > 10 && !controller.signal.aborted) await wait();
      if (controller.signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      await update(buffer, () => buffer.appendBuffer(value));
      if (controller.signal.aborted) return;
      if (video.currentTime > 30 && buffer.buffered.length && buffer.buffered.start(0) < video.currentTime - 15) {
        await update(buffer, () => buffer.remove(buffer.buffered.start(0), video.currentTime - 15));
      }
    }
    if (!controller.signal.aborted && source.readyState === "open") source.endOfStream();
  })().catch(error => { if (!controller.signal.aborted) { callbacks.onEnd(error); close(); } });
  return { video, close };
}

function initRecordings() {
  const select = document.getElementById("recordings-device");
  if (select.dataset.wired) return;
  select.dataset.wired = "true";
  document.getElementById("recordings-download-cancel").addEventListener("click", cancelRecordingDownload);
  const date = document.getElementById("recordings-date");
  date.value = date.max = recordingDate();
  select.addEventListener("change", () => { leaveRecordingsDevice(); _recordings.serial = select.value; loadRecordings(); });
  date.addEventListener("change", () => { if (date.validity.valid && date.value) loadRecordings(); });
  document.getElementById("recordings-refresh").addEventListener("click", loadRecordings);
  for (const [id, delta] of [["day-before", -1], ["day-after", 1]]) {
    document.getElementById(`recordings-${id}`).addEventListener("click", () => { date.value = recordingAdjacentDate(date.value, delta); loadRecordings(); });
  }
  document.querySelectorAll("[data-recording-filter]").forEach(button => button.addEventListener("click", () => {
    _recordings.selection.clear();
    _recordings.filter = button.dataset.recordingFilter;
    document.querySelectorAll("[data-recording-filter]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
    renderRecordingList();
  }));
  for (const action of ["delete", "download"]) {
    document.getElementById(`recordings-bulk-${action}`).addEventListener("click", () => runRecordingAction(action,
      _recordings.items.filter(item => _recordings.selection.has(item.start))));
  }
  document.getElementById("recordings-clear-selection").addEventListener("click", () => { _recordings.selection.clear(); renderRecordingList(); });
  document.getElementById("recordings-play").addEventListener("click", () => {
    if (_recordings.playing) { stopRecordingPlayback(false); document.getElementById("recordings-player-status").textContent = t("recordings.paused"); }
    else if (_recordings.selected) playRecording(_recordings.selected, _recordings.offset >= _recordings.selected.duration - 1 ? 0 : _recordings.offset);
  });
  for (const [id, delta] of [["previous", -1], ["next", 1]]) {
    document.getElementById(`recordings-${id}`).addEventListener("click", () => {
      const item = _recordings.items[_recordings.items.indexOf(_recordings.selected) + delta];
      if (item) playRecording(item);
    });
  }
  document.getElementById("recordings-seek").addEventListener("change", event => {
    if (_recordings.selected) playRecording(_recordings.selected, Number(event.target.value));
  });
  document.getElementById("recordings-fullscreen").addEventListener("click", toggleRecordingFullscreen);
  document.getElementById("recordings-snapshot").addEventListener("click", () => {
    const video = _recordings.player?.video;
    if (!video?.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob(blob => { if (blob) downloadLiveCameraBlob(blob, "png"); }, "image/png");
  });
}

window.addEventListener("pagehide", leaveRecordingsDevice);

function exitRecordingFullscreen() {
  const frame = document.getElementById("recordings-frame");
  if (!frame) return;
  if ((document.fullscreenElement || document.webkitFullscreenElement) === frame) {
    Promise.resolve((document.exitFullscreen || document.webkitExitFullscreen)?.call(document)).catch(() => {});
  }
  frame.classList.remove("is-fullscreen-fallback", "is-landscape-rotated", "is-rotation-clockwise", "is-video-fullscreen");
}
async function toggleRecordingFullscreen() {
  const frame = document.getElementById("recordings-frame");
  if (cameraFullscreenElement() === frame || frame.classList.contains("is-fullscreen-fallback")) {
    exitRecordingFullscreen();
  } else {
    await enterCameraFullscreen(frame);
  }
  syncRecordingFullscreen();
}
function syncRecordingFullscreen() {
  const frame = document.getElementById("recordings-frame");
  if (!frame) return;
  const active = cameraFullscreenElement() === frame || frame.classList.contains("is-fullscreen-fallback");
  syncCameraFullscreenRotation(frame, active);
}
document.addEventListener?.("fullscreenchange", syncRecordingFullscreen);
document.addEventListener?.("webkitfullscreenchange", syncRecordingFullscreen);
window.addEventListener("orientationchange", syncRecordingFullscreen);
window.addEventListener("resize", syncRecordingFullscreen);
document.addEventListener?.("keydown", event => {
  if (event.key === "Escape") {
    const frame = document.getElementById("recordings-frame");
    if (frame?.classList.contains("is-fullscreen-fallback")) exitRecordingFullscreen();
  }
});
window.addEventListener("blur", stopRecordingSelectionDrag);
document.addEventListener("pointerup", stopRecordingSelectionDrag);
document.addEventListener("pointercancel", stopRecordingSelectionDrag);
document.addEventListener("visibilitychange", () => { if (document.hidden) leaveRecordingsDevice(); });
