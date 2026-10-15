// ── Render devices ─────────────────────────────────────────────────────────
function _sortedDevices() {
  const list = [..._devices];
  const byName = (a, b) => (a.name || a.device_type || "").localeCompare(b.name || b.device_type || "");
  list.sort((a, b) => {
    const ra = a.room || "￿", rb = b.room || "￿";
    return ra.localeCompare(rb) || byName(a, b);
  });
  return list;
}

function renderDevices() {
  const key = JSON.stringify(_devices.map(d => ({
    s: d.serial, o: d.online, w: d.currentWeight, i: d.intake_today_grams,
    f: d.filterNextReplacementTimestamp, r: d.rssi,
    sg: d.surplusGrain, eq: d.electricQuantity, pt: d.powerType, bd: d.barnDoorState,
    img: d.image_url, variant: d.variant, name: d.name, room: d.room,
    lct: d.last_cleaned_ts, lci: d.cleaning_interval_days,
    plans: (d.feeding_plans||[]).map(p=>p.executionTime+"_"+(p._enabled!==false?1:0)).join(),
    dt: d.display_text, din: d.display_icon_name, di: d.display_icon,
    pets: (d.pets || []).map(p => `${p.id}:${p.image_url}:${p.name}`).join(),
    units: _settings.units,
  })));
  if (key === _lastDeviceRenderKey) return;
  _lastDeviceRenderKey = key;

  const grid = document.getElementById("device-grid");
  if (!_devices.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon"><span class="material-icons">hub</span></div>
      <div class="empty-msg">${t("device.none")}</div>
    </div>`;
    return;
  }
  const sorted = _sortedDevices();
  grid.innerHTML = sorted.map(d => {
    const online = d.online;
    const statusClass = online ? "online" : "offline";
    const isFeeder = d.device_type === "one_rfid" || d.device_type === "granary" || d.device_type === "camera_feeder";
    const water = fmtWater(d.currentWeight ?? null);
    const filterDays = filterDaysRemaining(d);
    const cleanDays = cleaningDaysRemaining(d);
    const icon = deviceIcon(d);
    const imageUrl = d.image_url || (d.device_type === "camera_feeder"
      ? deviceImageUrl(d.device_type, d.variant || "b")
      : "");
    const imgHtml = imageUrl
      ? `<img src="${escHtml(imageUrl)}" alt="">`
      : `<div class="card-img-placeholder"><span class="material-icons">${icon}</span></div>`;
    const allPets = d.pets || [];
    const maxPetSlots = 5;
    let shownPets = allPets, petOverflow = 0;
    if (allPets.length > maxPetSlots) {
      shownPets = allPets.slice(0, maxPetSlots - 1);
      petOverflow = allPets.length - shownPets.length;
    }
    const petsHtml = shownPets.map(p =>
      p.image_url
        ? `<div class="card-pet-avatar"><img src="${escHtml(p.image_url)}" alt="${escHtml(p.name)}"></div>`
        : `<div class="card-pet-avatar"><span class="material-icons">pets</span></div>`
    ).join("") + (petOverflow > 0 ? `<div class="card-pet-avatar card-pet-overflow">+${petOverflow}</div>` : "");
    const alerts = deviceAlerts(d);
    const alertDot = alerts.length ? `<div class="card-alert" title="${escHtml(alerts.map(alertLabel).join(', '))}">!</div>` : "";
    const intakeHtml = !isFeeder && d.intake_today_grams > 0
      ? `<div class="card-intake">${escHtml(t("time.today"))}: ${escHtml(fmtWater(d.intake_today_grams))}</div>`
      : "";
    const cleanStat = cleanDays != null
      ? `<div class="card-stat stat-secondary">
          <div class="stat-label">${t("card.clean")}</div>
          <div class="stat-value${cleanDays <= 0 ? " danger" : ""}">${escHtml(fmtDays(Math.max(0, cleanDays)))}</div>
        </div>`
      : "";

    return `<div class="ha-card device-card" data-serial="${escHtml(d.serial)}">
      <div class="card-img-wrap">
        ${imgHtml}
        <div class="card-status ${statusClass}"><svg viewBox="0 0 24 18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 14a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm-4.24-2.83a6 6 0 0 1 8.48 0l-1.42 1.42a4 4 0 0 0-5.65 0L7.76 11.17zm-2.83-2.83a10 10 0 0 1 14.14 0l-1.42 1.42a8 8 0 0 0-11.31 0L4.93 8.34zM1.1 5.51a15 15 0 0 1 21.21 0l-1.42 1.42a13 13 0 0 0-18.38 0L1.1 5.51z"/></svg></div>
        ${alertDot}
        ${petsHtml ? `<div class="card-pets">${petsHtml}</div>` : ""}
      </div>
      <div class="card-body">
        <div class="card-name">${escHtml(d.name || d.device_type || d.serial)}</div>
        <div class="card-room">${escHtml(d.room || "")}</div>
        <div class="card-stats">
          ${isFeeder ? `
          <div class="card-stat">
            <div class="stat-label">${t("card.food")}</div>
            <div class="stat-value${d.surplusGrain === false ? " danger" : " accent"}">${d.surplusGrain === false ? t("food.low") : d.surplusGrain === true ? t("food.ok") : "—"}</div>
          </div>
          ${d.device_type === "one_rfid" ? `
          <div class="card-stat stat-secondary">
            <div class="stat-label">${t("card.lid")}</div>
            <div class="stat-value${d.barnDoorState === true ? " accent" : ""}">${d.barnDoorState === true ? t("door.open") : d.barnDoorState === false ? t("door.closed") : "—"}</div>
          </div>
          <div class="card-stat stat-secondary">
            <div class="stat-label">${t("card.battery")}</div>
            <div class="stat-value${d.electricQuantity != null && d.electricQuantity > 0 && d.electricQuantity <= (d.battery_low_pct ?? 20) ? " danger" : ""}">${d.electricQuantity != null && d.electricQuantity > 0 ? `${d.electricQuantity}% ${d.powerType === 2 ? t("power.battery") : t("power.ac")}` : (d.powerType === 2 ? t("power.battery") : t("power.ac"))}</div>
          </div>
          ` : `
          <div class="card-stat stat-secondary">
            <div class="stat-label">${t("card.battery")}</div>
            <div class="stat-value${d.electricQuantity != null && d.electricQuantity > 0 && d.electricQuantity <= (d.battery_low_pct ?? 20) ? " danger" : ""}">${d.electricQuantity != null && d.electricQuantity > 0 ? `${d.electricQuantity}%` : "—"}</div>
          </div>
          `}
          ${(() => { const nm = nextMealLabel(d.feeding_plans); return nm ? `<div class="card-stat stat-secondary"><div class="stat-label">${t("card.next_meal")}</div><div class="stat-value">${escHtml(nm)}</div></div>` : ""; })()}
          ${(() => { if (!d.last_fed_ts) return ""; return `<div class="card-stat stat-secondary"><div class="stat-label">${t("card.last_fed")}</div><div class="stat-value">${escHtml(lastFedLabel(d.last_fed_ts))}</div></div>`; })()}
          ${(() => { const lbl = _fmtDisplayLabel(d); if (!lbl) return ""; const short = lbl.length > 9 ? lbl.slice(0, 8) + "…" : lbl; return `<div class="card-stat stat-secondary"><div class="stat-label">${t("card.display")}</div><div class="stat-value" title="${escHtml(lbl)}">${escHtml(short)}</div></div>`; })()}
          ` : `
          <div class="card-stat">
            <div class="stat-label">${t("card.water")}</div>
            <div class="stat-value accent">${escHtml(water)}</div>
          </div>
          <div class="card-stat">
            <div class="stat-label">${t("card.filter")}</div>
            <div class="stat-value">${escHtml(fmtDays(filterDays))}</div>
          </div>
          ${cleanStat}
          `}
        </div>
        ${intakeHtml}
      </div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".device-card").forEach(card => {
    card.addEventListener("click", () => {
      const device = _devices.find(d => d.serial === card.dataset.serial);
      if (device) openDeviceModal(device);
    });
  });
}
