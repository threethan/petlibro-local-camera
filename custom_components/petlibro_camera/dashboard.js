/* Petlibro Local Status Card - a dependency-free Home Assistant Lovelace card. */

const CARD_TYPE = "petlibro-local-status-card";

const escapeHtml = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const friendlyState = state => {
  if (!state || ["unknown", "unavailable", "None"].includes(state.state)) return "—";
  if (state.attributes?.device_class === "timestamp") {
    const value = new Date(state.state);
    if (!Number.isNaN(value.getTime())) return value.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  return `${state.state}${state.attributes?.unit_of_measurement ? ` ${state.attributes.unit_of_measurement}` : ""}`;
};

const statusEntityRegistries = new WeakMap();
const cameraEntityRegistry = hass => {
  const connection = hass.connection || hass;
  if (!statusEntityRegistries.has(connection)) {
    statusEntityRegistries.set(connection, hass.callWS({ type: "config/entity_registry/list" }).catch(() => []));
  }
  return statusEntityRegistries.get(connection);
};
const knownStatusState = state => state && !["unknown", "unavailable", "None", ""].includes(state.state);
const statusClock = date => `${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")} ${date.getHours() >= 12 ? "PM" : "AM"}`;
const statusValue = (key, state) => {
  if (!knownStatusState(state)) return "—";
  if (key === "food_status") return ({ adequate: "OK", ok: "OK", low: "Low" })[state.state.toLowerCase()] || state.state;
  if (key === "battery") return Number(state.state) > 0 ? `${state.state}%` : "—";
  if (key === "last_fed" || key === "next_meal") {
    const date = new Date(state.state);
    if (Number.isNaN(date.getTime())) return "—";
    if (key === "next_meal") return statusClock(date);
    const hours = (Date.now() - date.getTime()) / 3600000;
    if (hours < 1) {
      const minutes = Math.max(0, Math.round(hours * 60));
      return minutes === 0 ? "Just Now" : `${minutes}m ago`;
    }
    return hours < 24 ? statusClock(date) : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]} ${statusClock(date)}`;
  }
  return friendlyState(state);
};

class PetlibroLocalStatusCard extends HTMLElement {
  static getConfigElement() { return document.createElement("petlibro-local-status-card-editor"); }
  static getStubConfig() { return { type: `custom:${CARD_TYPE}` }; }

  setConfig(config) {
    this.config = config;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.render();
  }

  set hass(hass) { this._hass = hass; this._loadEntityRegistry(); this.render(); }
  getCardSize() { return this.config?.camera_entity || this.config?.live_camera_entity ? 7 : 5; }

  _entity(key) {
    if (this.config?.[`${key}_entity`]) return this.config[`${key}_entity`];
    const feed = this._entityRegistry?.find(entry => entry.entity_id === this.config?.feed_now_entity);
    if (feed?.platform === "mqtt" && feed.unique_id?.endsWith("_feed_now")) {
      const uniqueId = `${feed.unique_id.slice(0, -"feed_now".length)}${key}`;
      const entry = this._entityRegistry.find(item => item.platform === feed.platform && item.device_id === feed.device_id && item.unique_id === uniqueId);
      if (entry) return entry.entity_id;
    }
    const match = this.config?.feed_now_entity?.match(/^button\.(.+)_feed_now$/);
    return match ? `${key === "camera" ? "camera" : "sensor"}.${match[1]}_${key}` : undefined;
  }

  _loadEntityRegistry() {
    const hass = this._hass;
    if (!hass?.callWS) return;
    const connection = hass.connection || hass;
    if (this._registryConnection === connection) return;
    this._registryConnection = connection;
    cameraEntityRegistry(hass).then(entries => {
      if (this._registryConnection !== connection) return;
      this._entityRegistry = entries;
      this.render();
    });
  }

  _cameraEntity() { return this.config?.camera_entity || this._entity("camera"); }
  _liveCameraEntity() { return this.config?.live_camera_entity; }
  _state(entity) { return entity && this._hass?.states?.[entity]; }

  render() {
    if (!this.shadowRoot || !this.config) return;
    const hass = this._hass;
    const feedButton = this.config.feed_now_entity;
    if (!feedButton) {
      this.shadowRoot.innerHTML = `<ha-card style="padding:16px">Choose a Petlibro <strong>Feed Now</strong> button in the card editor.</ha-card>`;
      return;
    }
    const cameraEntity = this._cameraEntity();
    const camera = this._state(cameraEntity);
    const liveCameraEntity = this._liveCameraEntity();
    const status = [
      ["food_status", "Food Level"],
      ["battery", "Battery"],
      ["last_fed", "Last Fed"],
      ["next_meal", "Next Feed"],
    ];
    const title = this.config.name || this._state(feedButton)?.attributes?.friendly_name
      ?.replace(/ Feed Now$/, "") || "Petlibro";
    const online = !!this._state(feedButton) && this._state(feedButton).state !== "unavailable";
    const metrics = status.map(([key, label]) => {
      const entity = this._entity(key), state = this._state(entity);
      const tone = key === "food_status" ? (state?.state?.toLowerCase() === "low" ? "danger" : "accent")
        : key === "battery" && knownStatusState(state) && Number(state.state) > 0 && Number(state.state) <= 20 ? "danger" : "";
      return `<div class="metric" title="${escapeHtml(entity || "")}"><div class="label">${label}</div><div class="value ${tone}">${escapeHtml(statusValue(key, state))}</div></div>`;
    }).join("");
    // Keep the camera custom element mounted when HA updates sensor values.
    const existingView = this.shadowRoot.querySelector("petlibro-local-camera-view");
    if (existingView) {
      this.shadowRoot.querySelector(".grid").innerHTML = metrics;
      this.shadowRoot.querySelector("[data-title]").textContent = title;
      const availability = this.shadowRoot.querySelector(".availability");
      availability.textContent = online ? "Online" : "Offline";
      availability.classList.toggle("is-online", online);
      this.shadowRoot.querySelector("button").disabled = !online;
      this._syncCameraView(cameraEntity, liveCameraEntity, !!camera);
      return;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; --petlibro-camera-radius:12px; --petlibro-control-radius:10px; }
        ha-card { overflow:hidden; }
        .header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:24px 24px 20px; font-size:28px; font-weight:700; line-height:1.2; }
        .availability { color:var(--secondary-text-color); font-size:12px; font-weight:400; padding-right:12px; }
        [data-camera-slot] { margin:0 16px 12px; border-radius:var(--petlibro-camera-radius); overflow:hidden; }
        [data-camera-slot][hidden] { display:none; }
        .grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; margin:0 16px 12px; }
        .metric { box-sizing:border-box; min-width:0; padding:8px 14px; border-radius:var(--petlibro-control-radius); background:color-mix(in srgb, var(--secondary-background-color, #282828) 50%, transparent); border:0; box-shadow:none; }
        .label { color:var(--secondary-text-color); font-size:11px; margin-bottom:4px; }
        .value { font-size:20px; font-weight:700; }
        .value.accent { color:var(--primary-color); }
        .value.danger { color:var(--error-color, #db4437); }
        .actions { padding:0 16px 16px; }
        button { width:100%; border:0; border-radius:var(--petlibro-control-radius); padding:11px 14px; background:var(--primary-color); color:var(--text-primary-color, white); font:inherit; font-weight:500; cursor:pointer; }
        button:disabled { opacity:.55; cursor:default; }
      </style>
      <ha-card>
        <div class="header"><span data-title>${escapeHtml(title)}</span><span class="availability ${online ? "is-online" : ""}">${online ? "Online" : "Offline"}</span></div>
        <div data-camera-slot hidden></div>
        <div class="grid">${metrics}</div>
        <div class="actions"><button type="button" ${online ? "" : "disabled"}>Feed Now</button></div>
      </ha-card>`;

    this.shadowRoot.querySelector("button")?.addEventListener("click", () => {
      hass?.callService("button", "press", { entity_id: feedButton });
    });
    this._syncCameraView(cameraEntity, liveCameraEntity, !!camera);
  }

  _syncCameraView(cameraEntity, liveCameraEntity, cameraExists) {
    const slot = this.shadowRoot.querySelector("[data-camera-slot]");
    if (!slot) return;
    const wanted = !!liveCameraEntity || !!this.config.camera_entity || cameraExists;
    slot.hidden = !wanted;
    if (!wanted) { slot.replaceChildren(); return; }
    let view = slot.querySelector("petlibro-local-camera-view");
    if (!view) { view = document.createElement("petlibro-local-camera-view"); slot.append(view); }
    const feed = this._entityRegistry?.find(entry => entry.entity_id === this.config.feed_now_entity);
    const serial = feed?.unique_id?.match(/^petlibro_(.+)_feed_now$/)?.[1];
    view.setConfig({ camera_entity: cameraEntity, live_camera_entity: liveCameraEntity, serial,
      addon: this.config.addon, embedded: true });
    view.hass = this._hass;
  }
}

class PetlibroLocalStatusCardEditor extends HTMLElement {
  setConfig(config) { this.config = config || {}; this.render(); }
  set hass(hass) { this._hass = hass; this.render(); }

  render() {
    if (!this._hass || !this.config) return;
    this.innerHTML = `
      <style>:host { display:block; padding:16px; } ha-entity-picker { display:block; margin:12px 0; }</style>
      <ha-entity-picker label="Feed Now button" allow-custom-entity></ha-entity-picker>
      <ha-entity-picker label="Snapshot camera (optional)" allow-custom-entity></ha-entity-picker>
      <ha-entity-picker label="Live camera (optional)" allow-custom-entity></ha-entity-picker>
      <ha-textfield label="Card title (optional)" value="${escapeHtml(this.config.name || "")}"></ha-textfield>`;
    const [feed, camera, liveCamera] = this.querySelectorAll("ha-entity-picker");
    feed.hass = this._hass; feed.includeDomains = ["button"]; feed.value = this.config.feed_now_entity || "";
    camera.hass = this._hass; camera.includeDomains = ["camera"]; camera.value = this.config.camera_entity || "";
    liveCamera.hass = this._hass; liveCamera.includeDomains = ["camera"]; liveCamera.value = this.config.live_camera_entity || "";
    const update = changes => this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: { ...this.config, ...changes } }, bubbles: true, composed: true }));
    feed.addEventListener("value-changed", event => update({ feed_now_entity: event.detail.value }));
    camera.addEventListener("value-changed", event => update({ camera_entity: event.detail.value || undefined }));
    liveCamera.addEventListener("value-changed", event => update({ live_camera_entity: event.detail.value || undefined }));
    this.querySelector("ha-textfield").addEventListener("input", event => update({ name: event.target.value || undefined }));
  }
}

if (!customElements.get(CARD_TYPE)) customElements.define(CARD_TYPE, PetlibroLocalStatusCard);
if (!customElements.get("petlibro-local-status-card-editor")) customElements.define("petlibro-local-status-card-editor", PetlibroLocalStatusCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === CARD_TYPE)) window.customCards.push({
  type: CARD_TYPE,
  name: "Petlibro Local Status Card",
  description: "Camera-feeder status and Feed Now controls for Petlibro Local.",
  preview: true,
  documentationURL: "https://github.com/smcneece/petlibro-local#petlibro-local-status-card",
});

// Reuse the add-on's Status player instead of maintaining another video client.
class PetlibroLocalCameraView extends HTMLElement {
  static getConfigElement() { return document.createElement("petlibro-local-live-camera-card-editor"); }
  static getStubConfig() { return { type: "custom:petlibro-local-live-camera-card", camera_entity: "" }; }

  setConfig(config) {
    const serial = String(config.serial || "").trim();
    const addon = config.addon || "local_petlibro_local";
    if (serial && !/^[A-Za-z0-9_-]{1,64}$/.test(serial)) throw new Error("Invalid camera feeder serial.");
    if (!/^[A-Za-z0-9_-]+$/.test(addon)) throw new Error("Invalid Petlibro add-on slug.");
    const cameraEntity = config.camera_entity || config.entity;
    const liveCameraEntity = config.live_camera_entity;
    for (const entity of [cameraEntity, liveCameraEntity]) {
      if (entity && !/^camera\.[a-z0-9_]+$/.test(entity)) throw new Error("Select a camera entity.");
    }
    const key = JSON.stringify([serial, addon, config.name, cameraEntity, liveCameraEntity, !!config.embedded]);
    if (this._configKey === key) return;
    this._configKey = key;
    this.config = { ...config, serial, addon, camera_entity: cameraEntity, live_camera_entity: liveCameraEntity };
    this._reset();
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>
      :host { display:block; } ha-card, .camera-shell { display:block; overflow:hidden; }
      .title { padding:24px 24px 20px; font-size:28px; font-weight:700; line-height:1.2; }
      .frame { position:relative; aspect-ratio:16/9; background:#101820; }
      iframe { position:absolute; inset:0; border:0; width:100%; height:100%; }
      img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
      .message { position:absolute; z-index:2; inset:0; display:grid; align-content:center; justify-items:center; gap:12px; padding:16px; color:white; text-align:center; background:rgb(16 24 32 / 75%); }
      .message[hidden] { display:none; } button { font:inherit; padding:8px 16px; cursor:pointer; }
    </style><${config.embedded ? 'div class="camera-shell"' : 'ha-card'}>${config.embedded ? "" : '<div class="title"></div>'}
      <div class="frame"><div class="message" role="status"><span></span><button type="button" hidden>Retry</button></div></div>
    </${config.embedded ? 'div' : 'ha-card'}>`;
    this.shadowRoot.querySelector("button").onclick = () => { this._reset(); this._connect(); };
    this._updateTitle();
    this._message(serial || cameraEntity || liveCameraEntity ? "Connecting…" : "Choose a live or snapshot camera in the card editor.");
    this._connect();
  }

  set hass(value) { this._hass = value; this._updateTitle(); this._connect(); }
  connectedCallback() { this._connect(); }
  disconnectedCallback() { this._reset(); }
  getCardSize() { return 4; }
  getGridOptions() { return { columns: 12, rows: 4, min_columns: 6, min_rows: 3 }; }

  _updateTitle() {
    const title = this.shadowRoot?.querySelector(".title");
    if (!title) return;
    const selected = this.config.live_camera_entity || this.config.camera_entity;
    const name = this._hass?.states?.[selected]?.attributes?.friendly_name;
    title.textContent = this.config.name || name?.replace(/ (?:Live Camera|Snapshot Camera|Camera)$/i, "") || "Petlibro camera";
  }

  _reset() {
    this._generation = (this._generation || 0) + 1;
    this._connecting = false;
    clearTimeout(this._sessionTimer);
    clearTimeout(this._snapshotTimer);
    this._snapshotTimer = null;
    this.shadowRoot?.querySelector("iframe")?.remove();
    this.shadowRoot?.querySelector("img")?.remove();
  }

  _message(text, retry = false) {
    const element = this.shadowRoot?.querySelector(".message");
    if (!element) return;
    element.hidden = false;
    element.querySelector("span").textContent = text;
    element.querySelector("button").hidden = !retry;
  }

  async _session() {
    const result = await this._hass.callWS({ type: "supervisor/api", endpoint: "/ingress/session", method: "post" });
    if (!result.session) throw new Error("Could not create a Petlibro app session.");
    document.cookie = `ingress_session=${encodeURIComponent(result.session)};path=/api/hassio_ingress/;SameSite=Strict${location.protocol === "https:" ? ";Secure" : ""}`;
  }

  async _connect() {
    if (!this.isConnected || !this._hass || !this.config || this._connecting || this.shadowRoot?.querySelector("iframe")) return;
    if (!this.config.live_camera_entity && this.config.camera_entity) { this._snapshot(); return; }
    if (!this.config.serial && !this.config.live_camera_entity) return;
    const generation = this._generation;
    this._connecting = true;
    this._message("Connecting…");
    try {
      let serial = this.config.serial;
      if (this.config.live_camera_entity) {
        const entries = await cameraEntityRegistry(this._hass);
        if (generation !== this._generation || !this.isConnected) return;
        const selected = entries.find(entry => entry.entity_id === this.config.live_camera_entity);
        serial = selected?.unique_id?.match(/^petlibro_(.+)_camera(?:_live)?$/)?.[1] || serial;
      }
      if (!serial) throw new Error("Select a Petlibro live camera, or use a snapshot camera.");
      await this._session();
      if (generation !== this._generation || !this.isConnected) return;
      const info = await this._hass.callWS({ type: "supervisor/api", endpoint: `/addons/${this.config.addon}/info`, method: "get" });
      if (generation !== this._generation || !this.isConnected) return;
      if (info.state !== "started") throw new Error("Start the Petlibro Local add-on to view its camera.");
      if (!/^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/?$/.test(info.ingress_url || "")) throw new Error("The Petlibro add-on has no ingress URL.");
      const frame = document.createElement("iframe");
      frame.title = this.config.name || "Petlibro live camera";
      frame.allow = "autoplay; microphone; fullscreen";
      frame.allowFullscreen = true;
      frame.src = `${info.ingress_url.replace(/\/$/, "")}/camera?serial=${encodeURIComponent(serial)}`;
      frame.onload = () => { if (generation === this._generation) this.shadowRoot.querySelector(".message").hidden = true; };
      this.shadowRoot.querySelector(".frame").append(frame);
      this._renewSession(generation);
    } catch (error) {
      if (generation === this._generation) this._message(error.message || "Unable to open the Petlibro app camera.", true);
    } finally {
      if (generation === this._generation) this._connecting = false;
    }
  }

  _snapshot(refresh = false) {
    const entity = this.config.camera_entity;
    const state = this._hass.states?.[entity];
    if (!state || state.state === "unavailable") { this._message("Camera image unavailable", true); return; }
    const source = state.attributes?.entity_picture || (state.attributes?.access_token
      ? `/api/camera_proxy/${entity}?token=${encodeURIComponent(state.attributes.access_token)}` : "");
    if (!source) { this._message("Camera image unavailable", true); return; }
    let image = this.shadowRoot.querySelector("img");
    if (!image) {
      image = document.createElement("img");
      image.alt = state.attributes?.friendly_name || "Camera snapshot";
      image.onload = () => { this.shadowRoot.querySelector(".message").hidden = true; };
      image.onerror = () => this._message("Camera image unavailable", true);
      this.shadowRoot.querySelector(".frame").append(image);
    }
    if (image.dataset.source !== source || refresh) {
      image.dataset.source = source;
      image.src = `${source}${source.includes('?') ? '&' : '?'}_petlibro=${Date.now()}`;
    }
    if (!this._snapshotTimer) this._snapshotTimer = setTimeout(() => {
      this._snapshotTimer = null;
      if (this.isConnected) this._snapshot(true);
    }, 15000);
  }

  _renewSession(generation) {
    this._sessionTimer = setTimeout(async () => {
      if (generation !== this._generation || !this.isConnected) return;
      try { await this._session(); }
      catch { /* The current stream can continue; retry session renewal next time. */ }
      if (generation === this._generation && this.isConnected) this._renewSession(generation);
    }, 5 * 60 * 1000);
  }
}

class PetlibroLocalLiveCameraCard extends PetlibroLocalCameraView {}

class PetlibroLocalLiveCameraCardEditor extends HTMLElement {
  setConfig(config) { this.config = config || {}; this.render(); }
  set hass(value) { this._hass = value; this.render(); }
  render() {
    if (!this._hass || !this.config) return;
    this.innerHTML = `<style>ha-textfield, ha-entity-picker { display:block; margin:12px 0; }</style>
      <ha-entity-picker data-key="camera_entity" label="Snapshot camera (optional)" allow-custom-entity></ha-entity-picker>
      <ha-entity-picker data-key="live_camera_entity" label="Live camera (optional)" allow-custom-entity></ha-entity-picker>
      <ha-textfield data-key="name" label="Title (optional)" value="${escapeHtml(this.config.name || "")}"></ha-textfield>
      <details><summary>Advanced</summary>
      <ha-textfield data-key="serial" label="Camera feeder serial (optional)" value="${escapeHtml(this.config.serial || "")}"></ha-textfield>
      <ha-textfield data-key="addon" label="Add-on slug" value="${escapeHtml(this.config.addon || "local_petlibro_local")}"></ha-textfield></details>`;
    const update = (key, value) => {
      this.config = { ...this.config, [key]: value || undefined };
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this.config }, bubbles: true, composed: true }));
    };
    this.querySelectorAll("ha-entity-picker").forEach(picker => {
      picker.hass = this._hass;
      picker.includeDomains = ["camera"];
      picker.value = this.config[picker.dataset.key] || (picker.dataset.key === "camera_entity" ? this.config.entity : "") || "";
      picker.addEventListener("value-changed", event => update(picker.dataset.key, event.detail.value));
    });
    this.querySelectorAll("ha-textfield").forEach(field => field.addEventListener("input", event => {
      update(field.dataset.key, event.target.value);
    }));
  }
}

if (!customElements.get("petlibro-local-camera-view")) customElements.define("petlibro-local-camera-view", PetlibroLocalCameraView);
if (!customElements.get("petlibro-local-live-camera-card")) customElements.define("petlibro-local-live-camera-card", PetlibroLocalLiveCameraCard);
if (!customElements.get("petlibro-local-live-camera-card-editor")) customElements.define("petlibro-local-live-camera-card-editor", PetlibroLocalLiveCameraCardEditor);
if (!window.customCards.some(card => card.type === "petlibro-local-live-camera-card")) window.customCards.push({ type: "petlibro-local-live-camera-card", name: "Petlibro Local Live Camera", preview: true,
  description: "Live video with the same controls as the Petlibro Local Status view." });
