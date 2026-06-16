/**
 * Save the main visualization frame as JPEG (Ctrl+S / Cmd+S).
 *
 * Exposes window.AppScreenshot:
 *   .registerProviders({ isReady, captureJpegBlob })
 *   .defaultFilename()
 *   .saveJpegBlob(blob, suggestedName)
 *   .saveVisualization()
 *   .initKeyboardShortcut()
 */
(function () {
  "use strict";

  /** @type {{ isReady: () => boolean, captureJpegBlob: () => Promise<Blob | null> } | null} */
  let providers = null;
  let saving = false;

  function registerProviders(spec) {
    if (!spec || typeof spec !== "object") {
      providers = null;
      return;
    }
    providers = {
      isReady: typeof spec.isReady === "function" ? spec.isReady : () => false,
      captureJpegBlob: typeof spec.captureJpegBlob === "function" ? spec.captureJpegBlob : async () => null
    };
  }

  function defaultFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = d.getFullYear()
      + pad(d.getMonth() + 1)
      + pad(d.getDate())
      + "-"
      + pad(d.getHours())
      + pad(d.getMinutes())
      + pad(d.getSeconds());
    return "highpersonic3-" + stamp + ".jpg";
  }

  function ensureJpegExtension(name) {
    const trimmed = String(name || "").trim() || defaultFilename();
    if (/\.jpe?g$/i.test(trimmed)) return trimmed;
    return trimmed.replace(/\.[^./\\]+$/, "") + ".jpg";
  }

  /**
   * @param {Blob} blob
   * @param {string} [suggestedName]
   * @returns {Promise<boolean>} true if saved, false if cancelled
   */
  async function saveJpegBlob(blob, suggestedName) {
    if (!blob) return false;
    const suggested = ensureJpegExtension(suggestedName || defaultFilename());

    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: [{
            description: "JPEG image",
            accept: { "image/jpeg": [".jpg", ".jpeg"] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch (err) {
        if (err && err.name === "AbortError") return false;
        console.warn("showSaveFilePicker failed, falling back to download link", err);
      }
    }

    let filename = suggested;
    if (typeof window.prompt === "function") {
      const entered = window.prompt("Save image as:", suggested);
      if (entered === null) return false;
      filename = ensureJpegExtension(entered);
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  }

  async function saveVisualization() {
    if (saving || !providers || !providers.isReady()) return false;
    saving = true;
    try {
      const blob = await providers.captureJpegBlob();
      if (!blob) return false;
      return await saveJpegBlob(blob, defaultFilename());
    } finally {
      saving = false;
    }
  }

  function isEditableTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return !!target.closest("[contenteditable='true']");
  }

  function isBootOrIntroActive() {
    const root = document.documentElement;
    return root.classList.contains("boot-active") || root.classList.contains("intro-boot");
  }

  function initKeyboardShortcut() {
    document.addEventListener("keydown", (ev) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "s") return;
      if (ev.altKey) return;
      if (isEditableTarget(ev.target)) return;
      if (isBootOrIntroActive()) return;
      if (!providers || !providers.isReady()) return;

      ev.preventDefault();
      saveVisualization().catch((err) => console.error(err));
    });
  }

  window.AppScreenshot = {
    registerProviders,
    defaultFilename,
    saveJpegBlob,
    saveVisualization,
    initKeyboardShortcut
  };
})();
