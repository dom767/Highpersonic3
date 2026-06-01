/**
 * Application chrome: boot splash, bottom-left brand menu with reveal/hide animations,
 * settings drawer toggle, lock/analysis toggles, and L/R volume meters.
 *
 * Exposes window.AppChrome with:
 *   .autoTransitionsLocked  (boolean, live)
 *   .audioAnalysisVisible   (boolean, live)
 *   .updateVolumeMeters(frame)
 *   .resetVolumeMeters()
 *   .waitForBrandFont()
 *   .primeBootLayout()
 *   .revealBootSplash()
 *   .showBootDevicePanel()
 *   .dismissBootSplash()
 *   .registerPlaybackToggleHandler(fn)
 *   .setPlaybackPaused(paused, options)
 *   .playbackPaused  (boolean, live)
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
  const chromePlaybackBtn = document.getElementById("chrome-playback");
  const bassMeter = document.getElementById("bass-meter");
  const trebleMeter = document.getElementById("treble-meter");
  const bassBeatBox = document.getElementById("bass-beat-box");
  const trebleBeatBox = document.getElementById("treble-beat-box");
  const kickDebugFill = document.getElementById("kick-debug-fill");
  const bassPeakMarker = document.getElementById("bass-peak-marker");
  const treblePeakMarker = document.getElementById("treble-peak-marker");
  const bassSustainMarker = document.getElementById("bass-sustain-marker");
  const trebleSustainMarker = document.getElementById("treble-sustain-marker");
  const bootOverlay = document.getElementById("boot-overlay");
  const bootBrandTitle = document.getElementById("boot-brand-title");
  const bootDevicePanel = document.getElementById("boot-device-panel");

  const DRAWER_OPEN_KEY = "highpersonic3.settingsDrawerOpen";
  const AUTO_TRANSITIONS_LOCKED_KEY = "highpersonic3.autoTransitionsLocked";
  const AUDIO_ANALYSIS_VISIBLE_KEY = "highpersonic3.audioAnalysisVisible";

  let autoTransitionsLocked = false;
  let audioAnalysisVisible = true;
  const METER_SEGMENTS = 32;
  const PEAK_FADE_MS = 2000;
  const BEAT_BOX_FLASH_MS = 100;
  let playbackPaused = false;
  let playbackToggleHandler = null;

  const BRAND_TEXT = "HIGHPERSONIC 3";
  const BRAND_FONT_FAMILY = "Gruppo";
  const BRAND_FONT_LOAD_SPEC = '400 1em "' + BRAND_FONT_FAMILY + '"';
  const CHROME_INACTIVITY_MS = 5000;
  const LETTER_DURATION_MS = 720;
  const LETTER_SCALE_START = 30;
  const LETTER_SCALE_START_TRANSFORM = "scaleX(" + LETTER_SCALE_START + ")";
  const LETTER_SCALE_END_TRANSFORM = "scaleX(1)";
  const POINTER_THROTTLE_MS = 80;
  const BAR_FADE_MS = 660;
  const BOOT_OVERLAY_FADE_MS = 720;
  // Lower exponent so logo letters become visible earlier in the fade.
  const OPACITY_EXP_K = 1.2;
  const OPACITY_CURVE_STEPS = 24;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function whenDocumentVisible() {
    if (!document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      const onVisible = () => {
        if (!document.hidden) {
          document.removeEventListener("visibilitychange", onVisible);
          resolve();
        }
      };
      document.addEventListener("visibilitychange", onVisible);
    });
  }

  function waitForNextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  async function runAnimation(el, keyframes, options) {
    if (!el || typeof el.animate !== "function") {
      return Promise.resolve();
    }
    await whenDocumentVisible();
    await waitForNextPaint();
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

  function setLetterVisual(span, revealed) {
    span.style.opacity = revealed ? "1" : "0";
    span.style.transform = revealed ? LETTER_SCALE_END_TRANSFORM : LETTER_SCALE_START_TRANSFORM;
    // Keep the letter promoted to its own compositing layer even when revealed.
    // Dropping the hint to "auto" tears down the layer and forces an inline
    // re-rasterization of the glyph, which reads as a visible "pop" the instant
    // the reveal animation completes.
    span.style.willChange = "transform, opacity";
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

  function ensureBrandChars(container, charList) {
    if (charList.length) return;
    for (const ch of BRAND_TEXT) {
      const span = document.createElement("span");
      span.className = "brand-char";
      span.textContent = ch;
      span.setAttribute("aria-hidden", "true");
      container.appendChild(span);
      charList.push(span);
    }
  }

  function setLettersRevealed(charList, revealed) {
    for (const span of charList) {
      setLetterVisual(span, revealed);
    }
  }

  async function revealLetterList(container, charList) {
    ensureBrandChars(container, charList);
    if (reducedMotion) {
      setLettersRevealed(charList, true);
      return;
    }
    await Promise.all(charList.map((span) => animateLetterReveal(span)));
    for (const span of charList) {
      span.getAnimations().forEach((a) => a.cancel());
      setLetterVisual(span, true);
    }
  }

  async function hideLetterList(charList) {
    if (!charList.length) return;
    if (reducedMotion) {
      setLettersRevealed(charList, false);
      return;
    }
    await Promise.all(charList.map((span) => animateLetterHide(span)));
    for (const span of charList) {
      span.getAnimations().forEach((a) => a.cancel());
      setLetterVisual(span, false);
    }
  }

  // --- Boot splash ---

  let bootBrandChars = [];
  let bootDismissGeneration = 0;
  let brandFontReadyPromise = null;
  const BOOT_LETTER_STAGGER_MS = 36;
  const BOOT_LETTER_FADE_MS = 260;

  function getBrandFontSizesPx() {
    const sizes = new Set();
    for (const el of [bootBrandTitle, brandTitle]) {
      if (!el) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (Number.isFinite(px) && px > 0) sizes.add(px);
    }
    if (!sizes.size) {
      sizes.add(84);
      sizes.add(26);
    }
    return sizes;
  }

  function warmBrandFontGlyphs() {
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.textContent = BRAND_TEXT;
    probe.style.position = "fixed";
    probe.style.left = "-9999px";
    probe.style.top = "0";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    probe.style.whiteSpace = "nowrap";
    probe.style.fontFamily = '"' + BRAND_FONT_FAMILY + '", sans-serif';
    probe.style.fontWeight = "400";
    const ref = bootBrandTitle || brandTitle;
    if (ref) {
      const cs = getComputedStyle(ref);
      probe.style.fontSize = cs.fontSize;
      probe.style.letterSpacing = cs.letterSpacing;
    } else {
      probe.style.fontSize = "5.25rem";
    }
    document.body.appendChild(probe);
    void probe.offsetWidth;
    document.body.removeChild(probe);
  }

  function waitForBrandFont() {
    if (brandFontReadyPromise) return brandFontReadyPromise;

    brandFontReadyPromise = (async () => {
      if (!document.fonts || typeof document.fonts.load !== "function") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return;
      }

      const loads = [document.fonts.load(BRAND_FONT_LOAD_SPEC)];
      for (const px of getBrandFontSizesPx()) {
        loads.push(document.fonts.load('400 ' + px + 'px "' + BRAND_FONT_FAMILY + '"'));
      }

      try {
        await Promise.all(loads);
        await document.fonts.ready;
      } catch {
        await document.fonts.ready;
      }

      warmBrandFontGlyphs();
    })();

    return brandFontReadyPromise;
  }

  function primeBootLayout() {
    if (!bootOverlay || !bootBrandTitle) return;
    ensureBrandChars(bootBrandTitle, bootBrandChars);
    setLettersRevealed(bootBrandChars, false);
    for (const span of bootBrandChars) {
      span.style.transform = LETTER_SCALE_END_TRANSFORM;
      span.style.willChange = "opacity";
    }
    if (bootDevicePanel) {
      bootDevicePanel.classList.remove("is-visible");
      bootDevicePanel.setAttribute("aria-hidden", "true");
    }
    bootOverlay.classList.add("boot-layout-ready");
    warmBrandFontGlyphs();
  }

  async function revealBootSplash() {
    if (!bootOverlay || !bootBrandTitle) return;
    await waitForBrandFont();
    warmBrandFontGlyphs();
    bootDismissGeneration += 1;
    bootOverlay.classList.remove("is-dismissing");
    bootOverlay.style.opacity = "1";
    ensureBrandChars(bootBrandTitle, bootBrandChars);
    for (const span of bootBrandChars) {
      span.style.opacity = "0";
      span.style.transform = LETTER_SCALE_END_TRANSFORM;
      span.style.willChange = "opacity";
    }

    if (reducedMotion) {
      for (const span of bootBrandChars) {
        span.style.opacity = "1";
        span.style.willChange = "auto";
      }
      return;
    }

    await Promise.all(
      bootBrandChars.map((span, idx) => runAnimation(
        span,
        [{ opacity: 0 }, { opacity: 1 }],
        {
          delay: idx * BOOT_LETTER_STAGGER_MS,
          duration: BOOT_LETTER_FADE_MS,
          easing: "ease-out",
          fill: "forwards"
        }
      ))
    );
    for (const span of bootBrandChars) {
      span.getAnimations().forEach((a) => a.cancel());
      span.style.opacity = "1";
      span.style.transform = LETTER_SCALE_END_TRANSFORM;
      span.style.willChange = "auto";
    }
  }

  function showBootDevicePanel() {
    if (!bootDevicePanel) return;
    bootDevicePanel.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      bootDevicePanel.classList.add("is-visible");
    });
  }

  async function dismissBootSplash() {
    if (!bootOverlay) return;
    const gen = bootDismissGeneration;
    if (bootDevicePanel) {
      bootDevicePanel.classList.remove("is-visible");
      bootDevicePanel.setAttribute("aria-hidden", "true");
    }
    await hideLetterList(bootBrandChars);
    if (gen !== bootDismissGeneration) return;

    bootOverlay.classList.add("is-dismissing");
    if (reducedMotion) {
      bootOverlay.style.opacity = "0";
    } else {
      bootOverlay.style.opacity = "1";
      await runAnimation(
        bootOverlay,
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: BOOT_OVERLAY_FADE_MS, easing: "ease-in", fill: "forwards" }
      );
      if (gen !== bootDismissGeneration) return;
      bootOverlay.style.opacity = "0";
    }
  }

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
    // Always start with the settings drawer minimized on app boot.
    setSettingsDrawerOpen(false, { persist: false });
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

  function syncPlaybackChromeUi() {
    if (!chromePlaybackBtn) return;
    chromePlaybackBtn.setAttribute("aria-pressed", playbackPaused ? "true" : "false");
    chromePlaybackBtn.setAttribute(
      "aria-label",
      playbackPaused ? "Resume processing" : "Pause processing"
    );
    chromePlaybackBtn.title = playbackPaused ? "Resume processing" : "Pause processing";
  }

  function setPlaybackPaused(paused, options) {
    const next = !!paused;
    if (next === playbackPaused && (!options || !options.force)) return;
    playbackPaused = next;
    syncPlaybackChromeUi();
    if (!options || !options.silent) {
      if (typeof playbackToggleHandler === "function") {
        playbackToggleHandler(playbackPaused);
      }
    }
  }

  function registerPlaybackToggleHandler(fn) {
    playbackToggleHandler = typeof fn === "function" ? fn : null;
  }

  // --- Chrome state machine & animations ---

  function initAppChrome() {
    if (!appChrome || !brandTitle || !brandMenu) return;

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
      if (chromeState === "showingMenu" && !document.hidden) {
        inactivityTimer = setTimeout(() => {
          if (!document.hidden) startDismiss();
        }, CHROME_INACTIVITY_MS);
      }
    }

    function cancelChromeAnimations() {
      for (const span of brandChars) {
        span.getAnimations().forEach((a) => a.cancel());
      }
      for (const btn of menuBtns) {
        btn.getAnimations().forEach((a) => a.cancel());
      }
      if (chromeBarLayer) {
        chromeBarLayer.getAnimations().forEach((a) => a.cancel());
      }
    }

    function syncChromeVisualsToState() {
      cancelChromeAnimations();
      if (chromeState === "showingMenu") {
        activateChromeContainer();
        setLettersRevealed(brandChars, true);
        setMenuVisible(true);
        setChromeBarVisible(true);
        brandMenu.setAttribute("aria-hidden", "false");
        resetInactivityTimer();
        return;
      }
      if (chromeState === "revealingLogo" || chromeState === "hidingMenu" || chromeState === "hidingLogo") {
        setChromeState("hidden");
      }
      setLettersRevealed(brandChars, false);
      setMenuVisible(false);
      setChromeBarVisible(false);
      deactivateChromeContainer();
      clearInactivityTimer();
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

    function ensureBottomBrandChars() {
      ensureBrandChars(brandTitle, brandChars);
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

    async function revealLetters(gen) {
      await waitForBrandFont();
      ensureBottomBrandChars();
      activateChromeContainer();
      setChromeState("revealingLogo");
      await fadeChromeBarIn(gen);
      if (gen !== dismissGeneration) return;

      brandMenu.setAttribute("aria-hidden", "false");
      for (const btn of menuBtns) btn.classList.add("is-visible");

      if (reducedMotion) {
        if (gen !== dismissGeneration) return;
        setLettersRevealed(brandChars, true);
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
        setLettersRevealed(brandChars, false);
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
      if (brandChars.length) setLettersRevealed(brandChars, false);
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
      if (document.documentElement.classList.contains("boot-active")) return;
      dismissGeneration += 1;
      const gen = dismissGeneration;
      await revealLetters(gen);
    }

    function onPointerActivity() {
      if (document.documentElement.classList.contains("boot-active")) return;
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
      if (document.documentElement.classList.contains("boot-active")) return;
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

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearInactivityTimer();
        return;
      }
      syncChromeVisualsToState();
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (document.documentElement.classList.contains("boot-active")) return;
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

    if (chromePlaybackBtn) {
      chromePlaybackBtn.addEventListener("click", () => {
        if (isDismissing()) return;
        resetInactivityTimer();
        setPlaybackPaused(!playbackPaused);
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      waitForBrandFont();
    });
  } else {
    waitForBrandFont();
  }

  // --- Volume meters ---

  function buildSegments(container) {
    if (!container) return [];
    const segments = [];
    for (let i = 0; i < METER_SEGMENTS; i++) {
      const seg = document.createElement("span");
      seg.className = "level-segment";
      seg.dataset.level = String(i);
      container.appendChild(seg);
      segments.push(seg);
    }
    return segments;
  }

  const bassSegments = buildSegments(bassMeter);
  const trebleSegments = buildSegments(trebleMeter);
  const meterPeakState = {
    bass: { value: 0, hitAtMs: 0, active: false },
    treble: { value: 0, hitAtMs: 0, active: false },
  };
  const beatBoxState = {
    bass: { hitAtMs: 0, active: false },
    treble: { hitAtMs: 0, active: false },
  };

  function setSegmentMeter(segments, markerEl, peakMarkerEl, peakState, beatBoxEl, beatBoxStateEntry, level, sustain, beat, nowMs) {
    if (!segments || !segments.length) return;
    const clamped = Math.max(0, Math.min(1, Number(level) || 0));
    const sustainClamped = Math.max(0, Math.min(1, Number(sustain) || 0));
    const active = Math.round(clamped * METER_SEGMENTS);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const on = i < active;
      seg.classList.toggle("is-on", on);
      seg.classList.remove("low", "mid", "high");
      if (!on) continue;
      if (i < 24) seg.classList.add("low");
      else if (i < 30) seg.classList.add("mid");
      else seg.classList.add("high");
    }

    if (markerEl) {
      markerEl.style.bottom = (sustainClamped * 100).toFixed(2) + "%";
    }

    if (peakMarkerEl && peakState) {
      if (beat) {
        peakState.value = clamped;
        peakState.hitAtMs = nowMs;
        peakState.active = true;
      }
      if (peakState.active && peakState.hitAtMs > 0) {
        const peakAge = Math.max(0, nowMs - peakState.hitAtMs);
        const alpha = Math.max(0, 1 - (peakAge / PEAK_FADE_MS));
        peakMarkerEl.style.bottom = (peakState.value * 100).toFixed(2) + "%";
        peakMarkerEl.style.opacity = alpha.toFixed(3);
        if (peakAge >= PEAK_FADE_MS) {
          peakState.active = false;
          peakState.hitAtMs = 0;
          peakState.value = 0;
        }
      } else {
        peakMarkerEl.style.opacity = "0";
      }
    }

    if (beatBoxEl && beatBoxStateEntry) {
      if (beat) {
        beatBoxStateEntry.hitAtMs = nowMs;
        beatBoxStateEntry.active = true;
      }
      if (beatBoxStateEntry.active && beatBoxStateEntry.hitAtMs > 0) {
        const beatAge = Math.max(0, nowMs - beatBoxStateEntry.hitAtMs);
        if (beatAge <= BEAT_BOX_FLASH_MS) {
          beatBoxEl.classList.add("is-hit");
        } else {
          beatBoxEl.classList.remove("is-hit");
          beatBoxStateEntry.active = false;
          beatBoxStateEntry.hitAtMs = 0;
        }
      } else {
        beatBoxEl.classList.remove("is-hit");
      }
    }
  }

  function updateKickDebug(frame) {
    if (!kickDebugFill) return;
    const threshold = frame.kickThreshold || 0;
    const energy = frame.kickEnergy || 0;
    // Threshold sits at the 50% tick, so energy == threshold fills half the bar.
    const ratio = threshold > 0 ? energy / threshold : 0;
    kickDebugFill.style.width = Math.max(0, Math.min(100, ratio * 50)).toFixed(1) + "%";
    const gated = frame.kickVolumeOk === false || frame.kickLoudnessOk === false;
    const over = !gated && energy >= threshold && energy >= (frame.kickFloor || 0);
    kickDebugFill.classList.toggle("is-gated", gated);
    kickDebugFill.classList.toggle("is-over", over);
  }

  function updateVolumeMeters(frame) {
    if (!frame || !audioAnalysisVisible) return;
    const nowMs = performance.now();
    updateKickDebug(frame);
    setSegmentMeter(
      bassSegments,
      bassSustainMarker,
      bassPeakMarker,
      meterPeakState.bass,
      bassBeatBox,
      beatBoxState.bass,
      frame.bassLevel,
      frame.bassSustain,
      !!frame.bassBeat,
      nowMs
    );
    setSegmentMeter(
      trebleSegments,
      trebleSustainMarker,
      treblePeakMarker,
      meterPeakState.treble,
      trebleBeatBox,
      beatBoxState.treble,
      frame.trebleLevel,
      frame.trebleSustain,
      !!frame.trebleBeat,
      nowMs
    );
  }

  function resetVolumeMeters() {
    meterPeakState.bass.value = 0;
    meterPeakState.bass.hitAtMs = 0;
    meterPeakState.bass.active = false;
    meterPeakState.treble.value = 0;
    meterPeakState.treble.hitAtMs = 0;
    meterPeakState.treble.active = false;
    beatBoxState.bass.hitAtMs = 0;
    beatBoxState.bass.active = false;
    beatBoxState.treble.hitAtMs = 0;
    beatBoxState.treble.active = false;
    if (kickDebugFill) {
      kickDebugFill.style.width = "0%";
      kickDebugFill.classList.remove("is-over");
      kickDebugFill.classList.remove("is-gated");
    }
    const nowMs = performance.now();
    setSegmentMeter(bassSegments, bassSustainMarker, bassPeakMarker, meterPeakState.bass, bassBeatBox, beatBoxState.bass, 0, 0, false, nowMs);
    setSegmentMeter(trebleSegments, trebleSustainMarker, treblePeakMarker, meterPeakState.treble, trebleBeatBox, beatBoxState.treble, 0, 0, false, nowMs);
  }

  // --- Public API ---

  window.AppChrome = {
    get autoTransitionsLocked() { return autoTransitionsLocked; },
    get audioAnalysisVisible() { return audioAnalysisVisible; },
    get playbackPaused() { return playbackPaused; },
    updateVolumeMeters: updateVolumeMeters,
    resetVolumeMeters: resetVolumeMeters,
    waitForBrandFont: waitForBrandFont,
    primeBootLayout: primeBootLayout,
    revealBootSplash: revealBootSplash,
    showBootDevicePanel: showBootDevicePanel,
    dismissBootSplash: dismissBootSplash,
    registerPlaybackToggleHandler: registerPlaybackToggleHandler,
    setPlaybackPaused: setPlaybackPaused,
  };
})();
