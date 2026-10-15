/* Sync the ingress UI with the theme currently applied by Home Assistant.
 *
 * Add-on ingress is rendered in an iframe, so CSS custom properties do not
 * cascade from the Home Assistant document into this document.  The ingress
 * URL is same-origin with Home Assistant, which lets us read its resolved
 * properties and copy the ones this UI uses into our local token set.
 */
(() => {
  const tokenMap = {
    "--pl-bg": ["--primary-background-color"],
    "--pl-surface": ["--card-background-color", "--ha-card-background"],
    "--pl-surface-2": ["--secondary-background-color"],
    "--pl-accent": ["--primary-color"],
    "--pl-accent-dim": ["--primary-color"],
    "--pl-text": ["--primary-text-color"],
    "--pl-subtext": ["--secondary-text-color"],
    "--pl-danger": ["--error-color"],
    "--pl-success": ["--success-color"],
    "--pl-warning": ["--warning-color"],
    "--ha-card-background": ["--ha-card-background", "--card-background-color"],
    "--ha-card-box-shadow": ["--ha-card-box-shadow"],
    "--ha-card-backdrop-filter": ["--ha-card-backdrop-filter"],
    "--ha-card-border-width": ["--ha-card-border-width"],
    "--ha-card-border-color": ["--ha-card-border-color", "--divider-color"],
    "--ha-card-border-radius": ["--ha-card-border-radius"],
    "--ha-border-radius-lg": ["--ha-border-radius-lg"],
    "--divider-color": ["--divider-color"],
    "--primary-text-color": ["--primary-text-color"],
    "--app-header-background-color": ["--app-header-background-color"],
    "--input-fill-color": ["--input-fill-color"],
    "--input-ink-color": ["--input-ink-color"],
    "--input-outlined-idle-border-color": ["--input-outlined-idle-border-color"],
    "--ha-font-family-body": ["--ha-font-family-body"],
    "--ha-dialog-surface-background": ["--ha-dialog-surface-background"],
    "--ha-dialog-border-radius": ["--ha-dialog-border-radius"],
    "--wa-transition-fast": ["--wa-transition-fast"],
    "--wa-transition-easing": ["--wa-transition-easing"],
    "--wa-form-control-padding-inline": ["--wa-form-control-padding-inline"],
    "--wa-form-control-height": ["--wa-form-control-height"],
    "--wa-form-control-border-style": ["--wa-form-control-border-style"],
    "--wa-form-control-border-width": ["--wa-form-control-border-width"],
    "--wa-form-control-border-radius": ["--wa-form-control-border-radius"],
    "--wa-font-weight-action": ["--wa-font-weight-action"],
    "--wa-color-fill-loud": ["--wa-color-fill-loud"],
    "--wa-color-neutral-fill-loud": ["--wa-color-neutral-fill-loud"],
    "--wa-color-on-loud": ["--wa-color-on-loud"],
    "--wa-color-neutral-on-loud": ["--wa-color-neutral-on-loud"],
    "--pl-button-padding-inline": ["--ha-space-4", "--wa-form-control-padding-inline"],
    "--pl-button-radius": ["--ha-button-border-radius", "--ha-border-radius-pill", "--wa-form-control-border-radius"],
    "--pl-button-accent-bg": ["--ha-color-fill-primary-loud-resting", "--wa-color-brand-fill-loud", "--primary-color"],
    "--pl-button-accent-text": ["--ha-color-on-primary-loud", "--wa-color-brand-on-loud"],
  };

  let scheduled = false;

  const getHostDocument = () => {
    try {
      return window.parent !== window ? window.parent.document : null;
    } catch {
      // Keep the built-in palette when the UI is opened outside HA ingress.
      return null;
    }
  };

  const themedElements = (doc) => [
    doc.querySelector("home-assistant"),
    doc.documentElement,
    doc.body,
  ].filter(Boolean);

  const readThemeValue = (elements, names, seen = new Set()) => {
    for (const name of names) {
      if (seen.has(name)) continue;
      for (const element of elements) {
        const raw = getComputedStyle(element).getPropertyValue(name).trim();
        if (!raw) continue;
        let value = raw;
        const nextSeen = new Set([...seen, name]);
        // Computed custom properties can still contain var() references. Resolve
        // them against the HA document before copying values into the iframe.
        for (let i = 0; i < 20 && value.includes("var("); i++) {
          let unresolved = false;
          const replaced = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, reference, fallback) => {
            const resolved = readThemeValue(elements, [reference], nextSeen);
            if (resolved) return resolved;
            if (fallback !== undefined) return fallback.trim();
            unresolved = true;
            return "";
          });
          if (unresolved || replaced === value) { value = ""; break; }
          value = replaced;
        }
        if (value && !value.includes("var(")) return value;
      }
    }
    return "";
  };

  const applyTheme = () => {
    scheduled = false;
    const doc = getHostDocument();
    if (!doc) return;
    const elements = themedElements(doc);
    const rootStyle = document.documentElement.style;
    for (const [localName, hostNames] of Object.entries(tokenMap)) {
      const value = readThemeValue(elements, hostNames);
      if (value) rootStyle.setProperty(localName, value);
    }
    const font = readThemeValue(elements, ["--primary-font-family"]);
    if (font) rootStyle.setProperty("--primary-font-family", font);
  };

  const scheduleApply = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(applyTheme, 0);
  };

  const observeTheme = () => {
    const doc = getHostDocument();
    if (!doc || !window.MutationObserver) return;
    const observer = new MutationObserver(scheduleApply);
    const config = { attributes: true, attributeFilter: ["class", "style"], childList: true, subtree: true };
    observer.observe(doc.documentElement, config);
    if (doc.head) observer.observe(doc.head, config);
  };

  applyTheme();
  observeTheme();
  // HA may finish mounting its themed root just after the ingress page loads.
  [100, 500, 2000].forEach(delay => setTimeout(applyTheme, delay));
})();
