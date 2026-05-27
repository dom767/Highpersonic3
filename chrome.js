/**
 * Application chrome: bottom-left brand menu with reveal/hide animations,
 * settings drawer toggle, lock/analysis toggles, and L/R volume meters.
 *
 * Exposes window.AppChrome with:
 *   .autoTransitionsLocked  (boolean, live)
 *   .audioAnalysisVisible   (boolean, live)
 *   .updateVolumeMeters(frame)
 *   .resetVolumeMeters()
 */
(function () {
  "use strict";

  const chromeBarLayer = document.getElementById("chrome-bar-layer");
  const appChrome = document.getElementById("app-chrome");
  const brandTitle = document.getElementById("brand-title");
  const brandMenu = document.getElementById("brand-menu");
  const chromeSettingsBtn = document.getElementById("chrome-settings");
  const chromeLockBtn = document.getElementById("chrome-lock");
  const chromeAnalysisBtn = document.getElementById("chrome-analysis");
  const meterFillL = document.getElementById("meter-fill-l");
  const meterFillR = document.getElementById("meter-fill-r");
  const meterValueL = document.getElementById("meter-value-l");
  const meterValueR = document.getElementById("meter-value-r");

  const DRAWER_OPEN_KEY = "highpersonic3.settingsDrawerOpen";
  const AUTO_TRANSITIONS_LOCKED_KEY = "highpersonic3.autoTransitionsLocked";
  const AUDIO_ANALYSIS_VISIBLE_KEY = "highpersonic3.audioAnalysisVisible";

  let autoTransitionsLocked = false;
  let audioAnalysisVisible = true;
  let smoothedLevelL = 0;
  let smoothedLevelR = 0;

  // --- Settings drawer ---

  function setSettingsDrawerOpen(open, options) {
    const persist = !options || options.persist !== false;
    document.documentElement.classList.toggle("drawer-open", open);
    if (chromeSettingsBtn) {
      chromeSettingsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (persist) {
      try {
        localStorage.setItem(DRAWER_OPEN_KEY, open ? "1" : "0");
      } catch { /* ignore */ }
    }
  }

  function applyDrawerPreference() {
    const open = localStorage.getItem(DRAWER_OPEN_KEY) === "1";
    setSettingsDrawerOpen(open, { persist: false });
  }
  applyDrawerPreference();

  // --- Chrome preferences (lock, analysis) ---

  function loadChromePreferences() {
    try {
      autoTransitionsLocked = localStorage.getItem(AUTO_TRANSITIONS_LOCKED_KEY) === "1";
    } catch {
      autoTransitionsLocked = false;
    }
    try {
      const stored = localStorage.getItem(AUDIO_ANALYSIS_VISIBLE_KEY);
      audioAnalysisVisible = stored !== "0";
    } catch {
      audioAnalysisVisible = true;
    }
    if (chromeLockBtn) {
      chromeLockBtn.setAttribute("aria-pressed", autoTransitionsLocked ? "true" : "false");
    }
    if (chromeAnalysisBtn) {
      chromeAnalysisBtn.setAttribute("aria-pressed", audioAnalysisVisible ? "true" : "false");
    }
    document.documentElement.classList.toggle("audio-analysis-hidden", !audioAnalysisVisible);
  }

  function saveAutoTransitionsLocked(locked) {
    autoTransitionsLocked = locked;
    try {
      localStorage.setItem(AUTO_TRANSITIONS_LOCKED_KEY, locked ? "1" : "0");
    } catch { /* ignore */ }
    if (chromeLockBtn) {
      chromeLockBtn.setAttribute("aria-pressed", locked ? "true" : "false");
    }
  }

  function saveAudioAnalysisVisible(visible) {
    audioAnalysisVisible = visible;
    try {
      localStorage.setItem(AUDIO_ANALYSIS_VISIBLE_KEY, visible ? "1" : "0");
    } catch { /* ignore */ }
    if (chromeAnalysisBtn) {
      chromeAnalysisBtn.setAttribute("aria-pressed", visible ? "true" : "false");
    }
    document.documentElement.classList.toggle("audio-analysis-hidden", !visible);
  }

  loadChromePreferences();

  // --- Animation constants ---

  const BRAND_TEXT = "HIGHPERSONIC 3";
  const CHROME_INACTIVITY_MS = 10000;
  const LETTER_DURATION_MS = 720;
  const LETTER_SCALE_START = 90;
  const LETTER_SCALE_START_TRANSFORM = "scaleX(" + LETTER_SCALE_START + ")";
  const LETTER_SCALE_END_TRANSFORM = "scaleX(1)";
  const POINTER_THROTTLE_MS = 80;
  const BAR_FADE_MS = 660;
  const OPACITY_EXP_K = 4.5;
  const OPACITY_CURVE_STEPS = 24;

  // --- Chrome state machine & animations ---

  function initAppChrome() {
    if (!appChrome || !brandTitle || !brandMenu) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let chromeState = "hidden";
    let inactivityTimer = null;
    let dismissGeneration = 0;
    let brandChars = [];
    let menuBtns = Array.from(brandMenu.querySelectorAll(".chrome-menu-btn"));
    menuBtns.sort((a, b) => Number(a.dataset.menuOrder) - Number(b.dataset.menuOrder));

    function isDismissing() {
      return chromeState === "hidingMenu" || chromeState === "hidingLogo";
    }

    function setChromeState(next) {
      chromeState = next;
      appChrome.dataset.chromeState = next;
      if (appChrome.classList.contains("is-active")) {
        appChrome.style.pointerEvents = isDismissing() ? "none" : "auto";
      }
    }

    function clearInactivityTimer() {
      if (inactivityTimer !== null) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
    }

    function resetInactivityTimer() {
      clearInactivityTimer();
      if (chromeState === "showingMenu") {
        inactivityTimer = setTimeout(() => {
          startDismiss();
        }, CHROME_INACTIVITY_MS);
      }
    }

    function activateChromeContainer() {
      appChrome.classList.add("is-active");
    }

    function deactivateChromeContainer() {
      appChrome.classList.remove("is-active");
    }

    function setChromeBarVisible(visible) {
      if (!chromeBarLayer) return;
      chromeBarLayer.classList.toggle("is-active", visible);
      chromeBarLayer.setAttribute("aria-hidden", visible ? "false" : "true");
      chromeBarLayer.style.opacity = visible ? "1" : "0";
    }

    async function fadeChromeBarIn(gen) {
      if (!chromeBarLayer) return;
      chromeBarLayer.classList.add("is-active");
      chromeBarLayer.setAttribute("aria-hidden", "false");
      if (reducedMotion) {
        chromeBarLayer.style.opacity = "1";
        return;
      }
      chromeBarLayer.style.opacity = "0";
      await runAnimation(
        chromeBarLayer,
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: BAR_FADE_MS, easing: "ease-out", fill: "forwards" }
      );
      if (gen !== dismissGeneration) return;
      chromeBarLayer.style.opacity = "1";
    }

    async function fadeChromeBarOut(gen) {
      if (!chromeBarLayer) return;
      if (reducedMotion) {
        setChromeBarVisible(false);
        return;
      }
      await runAnimation(
        chromeBarLayer,
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: BAR_FADE_MS, easing: "ease-in", fill: "forwards" }
      );
      if (gen !== dismissGeneration) return;
      setChromeBarVisible(false);
    }

    function ensureBrandChars() {
      if (brandChars.length) return;
      for (const ch of BRAND_TEXT) {
        const span = document.createElement("span");
        span.className = "brand-char";
        span.textContent = ch;
        span.setAttribute("aria-hidden", "true");
        brandTitle.appendChild(span);
        brandChars.push(span);
      }
    }

    function setLetterVisual(span, revealed) {
      span.style.opacity = revealed ? "1" : "0";
      span.style.transform = revealed ? LETTER_SCALE_END_TRANSFORM : LETTER_SCALE_START_TRANSFORM;
      span.style.willChange = revealed ? "auto" : "transform, opacity";
    }

    function runAnimation(el, keyframes, options) {
      if (typeof el.animate !== "function") {
        return Promise.resolve();
      }
      const anim = el.animate(keyframes, options);
      return anim.finished.catch(() => {});
    }

    function expGrowthOpacityInFrames() {
      const denom = Math.exp(OPACITY_EXP_K) - 1;
      const frames = [];
      for (let i = 0; i <= OPACITY_CURVE_STEPS; i++) {
        const t = i / OPACITY_CURVE_STEPS;
        frames.push({
          opacity: (Math.exp(OPACITY_EXP_K * t) - 1) / denom,
          offset: t,
        });
      }
      return frames;
    }

    function expGrowthOpacityOutFrames() {
      const denom = Math.exp(OPACITY_EXP_K) - 1;
      const frames = [];
      for (let i = 0; i <= OPACITY_CURVE_STEPS; i++) {
        const t = i / OPACITY_CURVE_STEPS;
        frames.push({
          opacity: (Math.exp(OPACITY_EXP_K * (1 - t)) - 1) / denom,
          offset: t,
        });
      }
      return frames;
    }

    function setMenuBtnVisual(btn, revealed) {
      btn.style.opacity = revealed ? "1" : "0";
      btn.style.transform = revealed ? LETTER_SCALE_END_TRANSFORM : LETTER_SCALE_START_TRANSFORM;
      btn.style.willChange = revealed ? "auto" : "transform, opacity";
    }

    function setMenuVisible(visible) {
      for (const btn of menuBtns) {
        if (visible) {
          btn.classList.add("is-visible");
          setMenuBtnVisual(btn, true);
        } else {
          btn.classList.remove("is-visible");
          setMenuBtnVisual(btn, false);
        }
      }
      brandMenu.setAttribute("aria-hidden", visible ? "false" : "true");
    }

    function setLettersRevealed(revealed) {
      for (const span of brandChars) {
        setLetterVisual(span, revealed);
      }
    }

    function animateLetterReveal(el) {
      return Promise.all([
        runAnimation(
          el,
          [
            { transform: LETTER_SCALE_START_TRANSFORM },
            { transform: LETTER_SCALE_END_TRANSFORM },
          ],
          { duration: LETTER_DURATION_MS, easing: "ease-out", fill: "forwards" }
        ),
        runAnimation(el, expGrowthOpacityInFrames(), {
          duration: LETTER_DURATION_MS,
          fill: "forwards",
        }),
      ]);
    }

    function animateLetterHide(el) {
      return Promise.all([
        runAnimation(
          el,
          [
            { transform: LETTER_SCALE_END_TRANSFORM },
            { transform: LETTER_SCALE_START_TRANSFORM },
          ],
          { duration: LETTER_DURATION_MS, easing: "ease-in", fill: "forwards" }
        ),
        runAnimation(el, expGrowthOpacityOutFrames(), {
          duration: LETTER_DURATION_MS,
          fill: "forwards",
        }),
      ]);
    }

    async function revealLetters(gen) {
      ensureBrandChars();
      activateChromeContainer();
      setChromeState("revealingLogo");
      await fadeChromeBarIn(gen);
      if (gen !== dismissGeneration) return;

      brandMenu.setAttribute("aria-hidden", "false");
      for (const btn of menuBtns) btn.classList.add("is-visible");

      if (reducedMotion) {
        if (gen !== dismissGeneration) return;
        setLettersRevealed(true);
        setMenuVisible(true);
        setChromeState("showingMenu");
        resetInactivityTimer();
        return;
      }

      await Promise.all([
        ...brandChars.map((span) => animateLetterReveal(span)),
        ...menuBtns.map((btn) => animateLetterReveal(btn)),
      ]);
      if (gen !== dismissGeneration) return;
      for (const span of brandChars) {
        span.getAnimations().forEach((a) => a.cancel());
        setLetterVisual(span, true);
      }
      for (const btn of menuBtns) {
        btn.getAnimations().forEach((a) => a.cancel());
        setMenuBtnVisual(btn, true);
      }
      setChromeState("showingMenu");
      resetInactivityTimer();
    }

    async function hideLogoReverse(gen) {
      setChromeState("hidingLogo");
      brandMenu.setAttribute("aria-hidden", "true");

      if (reducedMotion) {
        if (gen !== dismissGeneration) return;
        setLettersRevealed(false);
        setMenuVisible(false);
        await fadeChromeBarOut(gen);
        if (gen !== dismissGeneration) return;
        finishHidden();
        return;
      }

      await Promise.all([
        ...brandChars.map((span) => animateLetterHide(span)),
        ...menuBtns.map((btn) => animateLetterHide(btn)),
      ]);
      if (gen !== dismissGeneration) return;
      for (const span of brandChars) {
        span.getAnimations().forEach((a) => a.cancel());
        setLetterVisual(span, false);
      }
      for (const btn of menuBtns) {
        btn.getAnimations().forEach((a) => a.cancel());
        btn.classList.remove("is-visible");
        setMenuBtnVisual(btn, false);
      }
      await fadeChromeBarOut(gen);
      if (gen !== dismissGeneration) return;
      finishHidden();
    }

    function finishHidden() {
      setChromeState("hidden");
      appChrome.style.pointerEvents = "";
      setChromeBarVisible(false);
      deactivateChromeContainer();
      clearInactivityTimer();
    }

    function snapHidden() {
      dismissGeneration += 1;
      setMenuVisible(false);
      if (brandChars.length) setLettersRevealed(false);
      setChromeBarVisible(false);
      finishHidden();
    }

    async function startDismiss() {
      if (chromeState === "hidden" || chromeState === "hidingMenu" || chromeState === "hidingLogo") {
        return;
      }
      if (chromeState === "revealingLogo") {
        return;
      }
      const gen = dismissGeneration;
      setChromeState("hidingMenu");
      await hideLogoReverse(gen);
    }

    async function startReveal() {
      if (chromeState !== "hidden") return;
      dismissGeneration += 1;
      const gen = dismissGeneration;
      await revealLetters(gen);
    }

    function onPointerActivity() {
      if (isDismissing()) return;
      if (chromeState === "hidden") {
        startReveal();
      } else if (chromeState === "showingMenu" || chromeState === "revealingLogo") {
        resetInactivityTimer();
      }
    }

    function isChromeTarget(target) {
      return appChrome.contains(target);
    }

    function handlePointerDown(ev) {
      if (isDismissing()) return;
      const target = ev.target;
      if (!(target instanceof Node)) return;

      if (chromeState === "hidden") {
        onPointerActivity();
        return;
      }

      if (isChromeTarget(target)) {
        if (chromeState === "showingMenu" || chromeState === "revealingLogo") {
          resetInactivityTimer();
        }
        return;
      }

      if (chromeState === "showingMenu") {
        startDismiss();
      }
    }

    let lastPointerMs = 0;
    document.addEventListener("pointermove", () => {
      const now = Date.now();
      if (now - lastPointerMs < POINTER_THROTTLE_MS) return;
      lastPointerMs = now;
      onPointerActivity();
    });

    document.addEventListener("pointerdown", handlePointerDown);

    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (document.documentElement.classList.contains("drawer-open")) {
        setSettingsDrawerOpen(false);
        return;
      }
      if (isDismissing()) return;
      if (chromeState === "showingMenu") {
        startDismiss();
      }
    });

    if (chromeSettingsBtn) {
      chromeSettingsBtn.setAttribute("aria-expanded", document.documentElement.classList.contains("drawer-open") ? "true" : "false");
      chromeSettingsBtn.addEventListener("click", () => {
        if (isDismissing()) return;
        resetInactivityTimer();
        const isOpen = document.documentElement.classList.contains("drawer-open");
        setSettingsDrawerOpen(!isOpen);
      });
    }

    if (chromeLockBtn) {
      chromeLockBtn.addEventListener("click", () => {
        if (isDismissing()) return;
        resetInactivityTimer();
        saveAutoTransitionsLocked(!autoTransitionsLocked);
      });
    }

    if (chromeAnalysisBtn) {
      chromeAnalysisBtn.addEventListener("click", () => {
        if (isDismissing()) return;
        resetInactivityTimer();
        saveAudioAnalysisVisible(!audioAnalysisVisible);
      });
    }

    for (const btn of menuBtns) {
      btn.addEventListener("pointerdown", () => {
        if (isDismissing()) return;
        resetInactivityTimer();
      });
    }

    deactivateChromeContainer();
    setChromeState("hidden");
  }

  initAppChrome();

  // --- Volume meters ---

  function channelSpectrumLevel(spectrumCh) {
    if (!spectrumCh || !spectrumCh.length) return 0;
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < spectrumCh.length; i++) {
      const v = spectrumCh[i];
      sum += v * v;
      if (v > peak) peak = v;
    }
    const rms = Math.sqrt(sum / spectrumCh.length);
    return Math.max(0, Math.min(1, rms * 0.7 + peak * 0.3));
  }

  function setVolumeMeters(levelL, levelR) {
    if (!meterFillL || !meterFillR) return;
    const l = Math.max(0, Math.min(1, levelL));
    const r = Math.max(0, Math.min(1, levelR));
    meterFillL.style.width = (l * 100).toFixed(1) + "%";
    meterFillR.style.width = (r * 100).toFixed(1) + "%";
    if (meterValueL) meterValueL.textContent = l.toFixed(2);
    if (meterValueR) meterValueR.textContent = r.toFixed(2);
  }

  function updateVolumeMeters(frame) {
    if (!frame || !audioAnalysisVisible) return;
    const rawL = channelSpectrumLevel(frame.spectrumData[0]);
    const rawR = channelSpectrumLevel(frame.spectrumData[1]);
    smoothedLevelL = smoothedLevelL * 0.85 + rawL * 0.15;
    smoothedLevelR = smoothedLevelR * 0.85 + rawR * 0.15;
    setVolumeMeters(smoothedLevelL, smoothedLevelR);
  }

  function resetVolumeMeters() {
    smoothedLevelL = 0;
    smoothedLevelR = 0;
    setVolumeMeters(0, 0);
  }

  // --- Public API ---

  window.AppChrome = {
    get autoTransitionsLocked() { return autoTransitionsLocked; },
    get audioAnalysisVisible() { return audioAnalysisVisible; },
    updateVolumeMeters: updateVolumeMeters,
    resetVolumeMeters: resetVolumeMeters,
  };
})();
