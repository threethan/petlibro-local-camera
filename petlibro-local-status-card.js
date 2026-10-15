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

class PetlibroLocalStatusCard extends HTMLElement {
  static getConfigElement() { return document.createElement("petlibro-local-status-card-editor"); }
  static getStubConfig() { return { type: `custom:${CARD_TYPE}` }; }

  setConfig(config) {
    this.config = config;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.render();
  }

  set hass(hass) { this._hass = hass; this.render(); }
  getCardSize() { return this.config?.camera_entity ? 7 : 5; }

  _entity(key) {
    const match = this.config?.feed_now_entity?.match(/^button\.(.+)_feed_now$/);
    return match ? `${key}.${match[1]}_${key === "camera" ? "camera" : key}` : undefined;
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
    const liveCamera = this._state(liveCameraEntity);
    const status = [
      ["food_status", "Food status", "mdi:food-drumstick-outline"],
      ["battery", "Battery", "mdi:battery"],
      ["last_fed", "Last fed", "mdi:food"],
      ["next_meal", "Next meal", "mdi:clock-outline"],
    ];
    const title = this.config.name || this._state(feedButton)?.attributes?.friendly_name
      ?.replace(/ Feed Now$/, "") || "Petlibro";
    const cameraSource = camera?.attributes?.entity_picture
      || (camera?.attributes?.access_token ? `/api/camera_proxy/${cameraEntity}?token=${camera.attributes.access_token}` : "");
    const liveSource = liveCamera?.attributes?.entity_picture
      || (liveCamera?.attributes?.access_token ? `/api/camera_proxy/${liveCameraEntity}?token=${liveCamera.attributes.access_token}` : "");
    const online = this._state(feedButton)?.state !== "unavailable";

    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; }
        ha-card { overflow:hidden; }
        .header { display:flex; align-items:center; justify-content:space-between; padding:16px 16px 10px; font-size:20px; font-weight:500; }
        .availability { color:var(--secondary-text-color); font-size:12px; font-weight:400; }
        .availability::before { content:""; display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; background:${online ? "var(--success-color, #4caf50)" : "var(--error-color, #db4437)"}; }
        .camera { display:block; position:relative; margin:0 16px 12px; background:var(--secondary-background-color); border-radius:12px; overflow:hidden; aspect-ratio:16/9; cursor:pointer; }
        .camera img { width:100%; height:100%; object-fit:cover; display:block; }
        .camera .snapshot { position:absolute; inset:0; }
        .camera .live { position:absolute; inset:0; opacity:1; transition:opacity .15s ease; }
        .camera.is-connecting .live { opacity:0; }
        .connecting { position:absolute; z-index:1; left:50%; top:50%; transform:translate(-50%,-50%); display:none; align-items:center; gap:8px; padding:8px 12px; border-radius:999px; background:rgb(0 0 0 / 65%); color:white; font-size:13px; }
        .camera.is-connecting .connecting { display:flex; }
        .connecting span { width:13px; height:13px; border:2px solid rgb(255 255 255 / 40%); border-top-color:white; border-radius:50%; animation:spin .7s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .camera-empty { height:100%; display:grid; place-items:center; color:var(--secondary-text-color); }
        .grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); border-top:1px solid var(--divider-color); }
        .metric { min-width:0; padding:13px 16px; border-bottom:1px solid var(--divider-color); }
        .metric:nth-child(odd) { border-right:1px solid var(--divider-color); }
        .label { color:var(--secondary-text-color); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .value { padding-top:4px; font-size:15px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .actions { padding:12px 16px 16px; }
        button { width:100%; border:0; border-radius:10px; padding:11px 14px; background:var(--primary-color); color:var(--text-primary-color, white); font:inherit; font-weight:500; cursor:pointer; }
        button:disabled { opacity:.55; cursor:default; }
      </style>
      <ha-card>
        <div class="header"><span>${escapeHtml(title)}</span><span class="availability">${online ? "Online" : "Offline"}</span></div>
        ${camera ? `<div class="camera ${liveCamera ? "is-connecting" : ""}" data-camera>${cameraSource ? `<img class="snapshot" src="${escapeHtml(cameraSource)}" alt="${escapeHtml(camera.attributes?.friendly_name || "Petlibro camera")}">` : '<div class="camera-empty">Camera image unavailable</div>'}${liveCamera && liveSource ? `<img class="live" data-live-camera src="${escapeHtml(liveSource)}" alt="">` : ""}${liveCamera ? '<div class="connecting"><span></span>Connecting…</div>' : ""}</div>` : ""}
        <div class="grid">${status.map(([key, label, icon]) => {
          const entity = this._entity(key);
          const state = this._state(entity);
          return `<div class="metric" title="${escapeHtml(entity || "")}"><div class="label"><ha-icon icon="${icon}"></ha-icon> ${label}</div><div class="value">${escapeHtml(friendlyState(state))}</div></div>`;
        }).join("")}</div>
        <div class="actions"><button type="button" ${online ? "" : "disabled"}>Feed now</button></div>
      </ha-card>`;

    this.shadowRoot.querySelector("button")?.addEventListener("click", () => {
      hass?.callService("button", "press", { entity_id: feedButton });
    });
    this.shadowRoot.querySelector("[data-camera]")?.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        detail: { entityId: cameraEntity }, bubbles: true, composed: true,
      }));
    });
    this.shadowRoot.querySelector("[data-live-camera]")?.addEventListener("load", () => {
      this.shadowRoot.querySelector(".camera")?.classList.remove("is-connecting");
    }, { once: true });
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

customElements.define(CARD_TYPE, PetlibroLocalStatusCard);
customElements.define("petlibro-local-status-card-editor", PetlibroLocalStatusCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TYPE,
  name: "Petlibro Local Status Card",
  description: "Camera-feeder status and Feed Now controls for Petlibro Local.",
  preview: true,
  documentationURL: "https://github.com/smcneece/petlibro-local#petlibro-local-status-card",
});
