/**
 * Export all tweakable application settings to a JSON file.
 *
 * Exposes window.ConfigExport:
 *   .registerProviders(fn)  — supply live state (selections, effect snapshots, etc.)
 *   .collect()              — build the config object
 *   .download(config?)      — trigger a file download
 *   .exportToFile()         — collect + download
 */
(function () {
  "use strict";

  const STORAGE_PREFIX = "highpersonic3.";
  const EXPORT_VERSION = 1;

  /** @type {(() => object) | null} */
  let providerFn = null;

  function registerProviders(fn) {
    providerFn = typeof fn === "function" ? fn : null;
  }

  function readPrefixedStorage() {
    /** @type {Record<string, unknown>} */
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
        const shortKey = key.slice(STORAGE_PREFIX.length);
        const raw = localStorage.getItem(key);
        if (raw == null) continue;
        try {
          out[shortKey] = JSON.parse(raw);
        } catch {
          out[shortKey] = raw;
        }
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /**
   * @param {Record<string, Record<string, unknown>> | null | undefined} store
   * @param {Record<string, Record<string, unknown>> | null | undefined} snapshots
   */
  function mergeEffectParameters(store, snapshots) {
    /** @type {Record<string, Record<string, unknown>>} */
    const merged = {};
    if (snapshots && typeof snapshots === "object") {
      for (const [groupKey, snap] of Object.entries(snapshots)) {
        if (snap && typeof snap === "object") merged[groupKey] = { ...snap };
      }
    }
    if (store && typeof store === "object") {
      for (const [groupKey, bag] of Object.entries(store)) {
        if (!bag || typeof bag !== "object") continue;
        merged[groupKey] = { ...(merged[groupKey] || {}), ...bag };
      }
    }
    return merged;
  }

  function collect() {
    const storage = readPrefixedStorage();
    const live = providerFn ? providerFn() : {};

    const kickDetection = live.kickDetection
      ?? (storage.kickDetection && typeof storage.kickDetection === "object" ? storage.kickDetection : null);
    const snareDetection = live.snareDetection
      ?? (storage.snareDetection && typeof storage.snareDetection === "object" ? storage.snareDetection : null);

    const effectStore = live.effectParameterStore
      ?? (storage.effectParameters && typeof storage.effectParameters === "object" ? storage.effectParameters : {});
    const effectParameters = mergeEffectParameters(effectStore, live.runtimeEffectSnapshots);

    return {
      exportVersion: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      app: "Highpersonic3",
      hint: "Use this file to update default values in index.html, audiocore.js, lights.js, and effect modules.",
      selections: {
        background: live.background ?? storage.selectedBackground ?? null,
        foreground: live.foreground ?? storage.selectedForeground ?? null,
        feedback: live.feedback ?? storage.selectedFeedback ?? null,
        beat: live.beat ?? storage.selectedBeat ?? null,
        primaryTexture: live.primaryTexture ?? storage.selectedPrimaryTexture ?? null
      },
      fgInFeedback: typeof live.fgInFeedback === "boolean"
        ? live.fgInFeedback
        : storage.fgInFeedback === "true",
      beatEffectsEnabled: typeof live.beatEffectsEnabled === "boolean"
        ? live.beatEffectsEnabled
        : storage.beatEffectsEnabled !== "false",
      kickDetection,
      snareDetection,
      chrome: {
        autoTransitionsLocked: typeof live.autoTransitionsLocked === "boolean"
          ? live.autoTransitionsLocked
          : storage.autoTransitionsLocked === "1",
        audioAnalysisVisible: typeof live.audioAnalysisVisible === "boolean"
          ? live.audioAnalysisVisible
          : storage.audioAnalysisVisible === "1"
      },
      sceneLighting: live.sceneLighting ?? null,
      effectParameters
    };
  }

  /** @param {object} [config] */
  function download(config) {
    const payload = config || collect();
    const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const a = document.createElement("a");
    a.href = url;
    a.download = "highpersonic3-config-" + stamp + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportToFile() {
    download(collect());
  }

  window.ConfigExport = {
    registerProviders,
    collect,
    download,
    exportToFile
  };
})();
