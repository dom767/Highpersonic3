/**
 * "Baffled Cat presents..." intro splash shown before the main boot screen.
 *
 * Exposes window.BaffledCatIntro.show() -> Promise<void>
 */
(function () {
  "use strict";

  let hideTimeout = null;

  function buildLetterSpans(text, baseDelayS, letterStepS, startIndex) {
    const fragments = [];
    let animatedLetters = startIndex;
    const words = text.split(" ");

    for (let w = 0; w < words.length; w++) {
      if (w > 0) fragments.push(document.createTextNode(" "));
      const wordWrap = document.createElement("span");
      wordWrap.className = "intro-word";
      for (let i = 0; i < words[w].length; i++) {
        const span = document.createElement("span");
        span.className = "intro-letter";
        span.textContent = words[w][i];
        span.style.setProperty("--delay", (baseDelayS + animatedLetters * letterStepS) + "s");
        wordWrap.appendChild(span);
        animatedLetters++;
      }
      fragments.push(wordWrap);
    }

    return { fragments, animatedLetters };
  }

  function show() {
    return new Promise((resolve) => {
      const overlay = document.getElementById("intro-overlay");
      if (!overlay) {
        resolve();
        return;
      }

      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }

      const textEl = document.getElementById("intro-logo-text");
      if (!textEl) {
        resolve();
        return;
      }

      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const titleWords = "Baffled Cat";
      const subtitle = "presents...";
      const baseDelayS = 0.3;
      const letterStepS = 0.05;
      const letterDurationS = 0.5;
      const textRevealDurationS = 0.6;

      textEl.innerHTML = "";

      const title = buildLetterSpans(titleWords, baseDelayS, letterStepS, 0);
      for (const node of title.fragments) textEl.appendChild(node);

      const presentsWrap = document.createElement("span");
      presentsWrap.className = "intro-presents";
      const presentsBaseDelay = baseDelayS + title.animatedLetters * letterStepS;
      let animatedLetters = title.animatedLetters;
      for (let j = 0; j < subtitle.length; j++) {
        const ch = subtitle[j];
        if (ch === " ") {
          presentsWrap.appendChild(document.createTextNode(" "));
          continue;
        }
        const span = document.createElement("span");
        span.className = "intro-letter";
        span.textContent = ch;
        span.style.setProperty("--delay", (presentsBaseDelay + j * letterStepS) + "s");
        presentsWrap.appendChild(span);
        animatedLetters++;
      }
      textEl.appendChild(presentsWrap);

      const wasVisible = overlay.classList.contains("visible");
      if (wasVisible) {
        overlay.classList.remove("visible");
        void overlay.offsetHeight;
      }
      overlay.classList.add("visible");
      overlay.setAttribute("aria-hidden", "false");

      const finish = () => {
        overlay.classList.remove("visible");
        overlay.setAttribute("aria-hidden", "true");
        document.documentElement.classList.remove("intro-boot");
        document.body.classList.remove("intro-boot");
        resolve();
      };

      if (reducedMotion) {
        hideTimeout = setTimeout(finish, 900);
        return;
      }

      const lastLetterDelayS = baseDelayS + (animatedLetters > 0 ? (animatedLetters - 1) * letterStepS : 0);
      const computedHideAfterMs = (Math.max(baseDelayS + textRevealDurationS, lastLetterDelayS + letterDurationS) * 1000) + 200;
      const minVisibleMs = 5000;
      const hideAfterMs = Math.max(computedHideAfterMs, minVisibleMs);

      hideTimeout = setTimeout(finish, hideAfterMs);
    });
  }

  window.BaffledCatIntro = { show };
})();
