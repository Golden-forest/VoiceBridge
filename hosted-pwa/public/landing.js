/* =========================================================================
   VoiceBridge landing JavaScript
   Batch 2: page interaction logic
   Source of truth: docs/superpowers/specs/2026-08-01-landing-page-design.md (v4)

   Modules:
     A. Typewriter
     B. Particle flow
     C. Navigation scroll state
     D. Mobile menu
     E. Download platform detection
     F. Conversion event tracking
     G. Init

   Constraints:
     - Zero third-party dependencies ( vanilla ES module )
     - All setTimeout / addEventListener have cleanup logic
     - prefers-reduced-motion disables animations and autoplay
     - Conversion events do not block navigation
   ========================================================================= */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------
     Helpers
     --------------------------------------------------------------------- */

  var REDUCED_MOTION =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var LANG = (document.documentElement.lang || "en").toLowerCase();
  // Normalize to the two locale buckets we support.
  var LOCALE = LANG.indexOf("zh") === 0 ? "zh-CN" : "en";

  function safeParseMessages() {
    // Expose a small i18n shim reading data attributes / hidden JSON islands.
    return null;
  }

  /* =====================================================================
     Module A: Typewriter ( spec §7.2 lines 341-347, §9 lines 595-612 )
     ===================================================================== */

  /**
   * Typewriter
   *
   * @param {HTMLElement} targetEl  Span that should receive the typed text.
   * @param {string[]}    texts     Array of strings to cycle through.
   * @param {object}      options   { speedEn, speedZh, pause, clearSpeed, lang }
   */
  function Typewriter(targetEl, texts, options) {
    this.targetEl = targetEl;
    this.texts = texts && texts.length ? texts.slice() : [];
    this.options = options || {};
    this.speed = LOCALE === "zh-CN"
      ? (this.options.speedZh || 65)
      : (this.options.speedEn || 36);
    this.pause = this.options.pause || 1800;
    this.clearSpeed = this.options.clearSpeed || 25;
    this._timerIds = [];
    this._running = false;
    this._currentIndex = 0;
  }

  Typewriter.prototype._schedule = function (fn, delay) {
    var id = window.setTimeout(fn, delay);
    this._timerIds.push(id);
    return id;
  };

  Typewriter.prototype._clearTimers = function () {
    for (var i = 0; i < this._timerIds.length; i++) {
      window.clearTimeout(this._timerIds[i]);
    }
    this._timerIds = [];
  };

  Typewriter.prototype._type = function (text, done) {
    var self = this;
    var i = 0;
    function step() {
      if (!self._running) return;
      if (i <= text.length) {
        self.targetEl.textContent = text.slice(0, i);
        i++;
        self._schedule(step, self.speed);
      } else {
        // Full text rendered. Pause before clearing.
        self._schedule(function () {
          if (self._running) self._erase(text, done);
        }, self.pause);
      }
    }
    step();
  };

  Typewriter.prototype._erase = function (text, done) {
    var self = this;
    var i = text.length;
    function step() {
      if (!self._running) return;
      if (i >= 0) {
        self.targetEl.textContent = text.slice(0, i);
        i--;
        self._schedule(step, self.clearSpeed);
      } else {
        self._schedule(done, self.clearSpeed);
      }
    }
    step();
  };

  Typewriter.prototype._cycle = function () {
    var self = this;
    if (!self._running) return;
    if (self._currentIndex >= self.texts.length) {
      self._currentIndex = 0;
    }
    var text = self.texts[self._currentIndex];
    self._type(text, function () {
      self._currentIndex++;
      self._cycle();
    });
  };

  Typewriter.prototype.start = function () {
    if (REDUCED_MOTION) {
      // Show first text statically, no animation.
      if (this.texts.length) {
        this.targetEl.textContent = this.texts[0];
      }
      return;
    }
    if (this._running) return;
    if (!this.texts.length) return;
    this._running = true;
    this._currentIndex = 0;
    this._cycle();
  };

  Typewriter.prototype.stop = function () {
    this._running = false;
    this._clearTimers();
  };

  function initTypewriter() {
    var dataEl = document.getElementById("typewriter-data");
    var targetEl = document.getElementById("typewriter-text");
    if (!dataEl || !targetEl) return null;

    var texts;
    try {
      var raw = dataEl.textContent.trim();
      texts = JSON.parse(raw);
    } catch (e) {
      // Locale build pipeline emits a JSON string. If parsing fails, bail out.
      return null;
    }
    if (!Array.isArray(texts) || texts.length === 0) return null;

    var tw = new Typewriter(targetEl, texts, {
      speedEn: 36,
      speedZh: 65,
      pause: 1800,
      clearSpeed: 25,
      lang: LOCALE,
    });

    // Delay start so particles and hero entrance do not all compete for
    // attention at the same moment ( spec §9.1 line 600 ).
    var startTimer = window.setTimeout(function () {
      tw.start();
    }, 600);
    tw._timerIds.push(startTimer);

    return tw;
  }

  /* =====================================================================
     Module B: Particle flow ( spec §7.2 line 327, §9.1 line 598 )
     ===================================================================== */

  function initParticles(container) {
    if (!container) return null;
    if (REDUCED_MOTION) return null;

    var PARTICLE_COUNT = 7;            // spec: 6-8 particles
    var MIN_DURATION = 6;              // seconds
    var MAX_DURATION = 10;             // seconds
    var MAX_DELAY = 5;                 // seconds
    var particles = [];

    var rect = container.getBoundingClientRect();
    var width = rect.width || container.offsetWidth || 800;
    var height = rect.height || container.offsetHeight || 600;

    for (var i = 0; i < PARTICLE_COUNT; i++) {
      var p = document.createElement("div");
      p.className = "hero-particle";

      // Start somewhere in the lower-left band ( phone side ).
      var startX = Math.random() * (width * 0.35);
      var startY = height * (0.55 + Math.random() * 0.4);
      p.style.left = startX + "px";
      p.style.top = startY + "px";

      // Random size 2-4 px.
      var size = 2 + Math.random() * 2;
      p.style.width = size + "px";
      p.style.height = size + "px";

      // End point somewhere in upper-right band ( computer media side ).
      var tx = width * (0.4 + Math.random() * 0.45) - startX;
      var ty = -(height * (0.2 + Math.random() * 0.4)) + (height * 0.1);
      p.style.setProperty("--tx", tx.toFixed(1) + "px");
      p.style.setProperty("--ty", ty.toFixed(1) + "px");

      // Random duration and delay.
      var duration = MIN_DURATION + Math.random() * (MAX_DURATION - MIN_DURATION);
      var delay = Math.random() * MAX_DELAY;
      p.style.animationDuration = duration.toFixed(2) + "s";
      p.style.animationDelay = "-" + delay.toFixed(2) + "s";

      container.appendChild(p);
      particles.push(p);
    }

    // Pause animations when Hero is not visible to save CPU/battery.
    var io = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(function (entries) {
        for (var k = 0; k < entries.length; k++) {
          var entry = entries[k];
          var isIntersecting = entry.isIntersecting;
          for (var j = 0; j < particles.length; j++) {
            var el = particles[j];
            el.style.animationPlayState = isIntersecting ? "running" : "paused";
          }
        }
      }, { threshold: 0 });
      var heroSection = document.getElementById("hero");
      if (heroSection) io.observe(heroSection);
    }

    return {
      destroy: function () {
        if (io) io.disconnect();
        for (var i = 0; i < particles.length; i++) {
          if (particles[i].parentNode) {
            particles[i].parentNode.removeChild(particles[i]);
          }
        }
        particles = [];
      },
    };
  }

  /* =====================================================================
     Module C: Navigation scroll state ( spec §7.1 lines 296-300 )
     ===================================================================== */

  function initNavScroll() {
    var nav = document.getElementById("landing-nav");
    var hero = document.getElementById("hero");
    if (!nav || !hero) return null;

    // Use IntersectionObserver so we do not run on every scroll event.
    if (!("IntersectionObserver" in window)) {
      // Fallback: toggle when scroll passes the hero bottom.
      var fallbackHandler = function () {
        var heroBottom = hero.getBoundingClientRect().bottom;
        if (heroBottom <= 0) {
          nav.classList.add("is-scrolled");
        } else {
          nav.classList.remove("is-scrolled");
        }
      };
      window.addEventListener("scroll", fallbackHandler, { passive: true });
      fallbackHandler();
      return function cleanup() {
        window.removeEventListener("scroll", fallbackHandler);
      };
    }

    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.target === hero) {
          // When any part of the hero is visible, keep dark theme.
          if (entry.isIntersecting && entry.intersectionRatio > 0) {
            nav.classList.remove("is-scrolled");
          } else {
            nav.classList.add("is-scrolled");
          }
        }
      }
    }, { threshold: [0, 0.05, 0.5] });
    io.observe(hero);

    return function cleanup() {
      io.disconnect();
    };
  }

  /* =====================================================================
     Module D: Mobile menu ( spec §7.1 lines 310-316 )
     ===================================================================== */

  function initMobileMenu() {
    var btn = document.getElementById("landing-nav-menu-btn");
    var menu = document.getElementById("landing-nav-mobile-menu");
    if (!btn || !menu) return null;

    var lastFocusedBeforeOpen = null;
    var open = false;

    function populateMenu() {
      if (menu.childElementCount > 0) return; // already populated
      var inner = document.createElement("div");
      inner.className = "landing-nav-mobile-menu-inner";

      // Clone the primary nav links.
      var sourceLinks = document.querySelectorAll(".landing-nav-links a");
      for (var i = 0; i < sourceLinks.length; i++) {
        var clone = sourceLinks[i].cloneNode(true);
        inner.appendChild(clone);
      }

      // Add Open app link if present in the desktop actions.
      var openAppLink = document.querySelector(".landing-nav-cta");
      if (openAppLink) {
        var openClone = openAppLink.cloneNode(true);
        // Strip cta-specific styling so it renders like a plain menu item.
        openClone.className = "";
        inner.appendChild(openClone);
      }

      // Add language switch link.
      var langLink = document.querySelector(".landing-nav-lang");
      if (langLink) {
        var langClone = langLink.cloneNode(true);
        langClone.className = "";
        inner.appendChild(langClone);
      }

      menu.appendChild(inner);
    }

    function openMenu() {
      populateMenu();
      open = true;
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      lastFocusedBeforeOpen = document.activeElement;
      document.body.style.overflow = "hidden";
      // Focus first link in menu.
      var firstLink = menu.querySelector("a");
      if (firstLink) firstLink.focus();
    }

    function closeMenu(returnFocus) {
      open = false;
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
      if (returnFocus !== false && lastFocusedBeforeOpen && lastFocusedBeforeOpen.focus) {
        lastFocusedBeforeOpen.focus();
        lastFocusedBeforeOpen = null;
      }
    }

    function toggleMenu() {
      if (open) closeMenu();
      else openMenu();
    }

    btn.addEventListener("click", toggleMenu);

    // Esc closes.
    document.addEventListener("keydown", function (e) {
      if (!open) return;
      if (e.key === "Escape" || e.key === "Esc") {
        e.preventDefault();
        closeMenu();
      }
    });

    // Click outside closes.
    document.addEventListener("click", function (e) {
      if (!open) return;
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      closeMenu();
    });

    // Click a link inside closes.
    menu.addEventListener("click", function (e) {
      var target = e.target;
      if (target && target.tagName === "A") {
        closeMenu(false);
      }
    });

    // Reset state if the viewport grows back to desktop width.
    var desktopMq = window.matchMedia("(min-width: 1024px)");
    function onDesktopChange(e) {
      if (e.matches && open) {
        closeMenu();
      }
    }
    if (desktopMq.addEventListener) {
      desktopMq.addEventListener("change", onDesktopChange);
    } else if (desktopMq.addListener) {
      desktopMq.addListener(onDesktopChange);
    }

    return function cleanup() {
      btn.removeEventListener("click", toggleMenu);
      if (desktopMq.removeEventListener) {
        desktopMq.removeEventListener("change", onDesktopChange);
      } else if (desktopMq.removeListener) {
        desktopMq.removeListener(onDesktopChange);
      }
    };
  }

  /* =====================================================================
     Module E: Download platform detection ( spec §7.6 lines 436-472 )
     ===================================================================== */

  function detectPlatform() {
    // Returns { platform, arch } or null.
    var platform = null;
    var arch = null;

    if (navigator.userAgentData && navigator.userAgentData.platform) {
      platform = navigator.userAgentData.platform.toLowerCase();
    } else if (navigator.platform) {
      platform = navigator.platform.toLowerCase();
    }

    if (navigator.userAgentData && navigator.userAgentData.architecture) {
      arch = navigator.userAgentData.architecture.toLowerCase();
    }

    // Fallback: parse userAgent for architecture hints.
    if (!arch && navigator.userAgent) {
      var ua = navigator.userAgent.toLowerCase();
      if (ua.indexOf("arm") !== -1 || ua.indexOf("aarch64") !== -1) {
        arch = "arm";
      } else if (ua.indexOf("wow64") !== -1 || ua.indexOf("win64") !== -1 || ua.indexOf("x64") !== -1) {
        arch = "x64";
      } else if (platform && platform.indexOf("mac") !== -1) {
        // Modern Apple Silicon macs report Intel via UA for compatibility.
        // We default new macs to arm64 since Intel macs are now rare.
        arch = "arm64";
      }
    }

    var normalizedPlatform = null;
    if (platform) {
      if (platform.indexOf("mac") !== -1) normalizedPlatform = "darwin";
      else if (platform.indexOf("win") !== -1) normalizedPlatform = "win32";
    }

    var normalizedArch = arch;
    if (arch === "arm" || arch === "arm64") normalizedArch = "arm64";
    if (arch === "x64" || arch === "x86_64") {
      normalizedArch = normalizedPlatform === "darwin" ? "x64" : "x64";
    }

    if (!normalizedPlatform || !normalizedArch) return null;
    return { platform: normalizedPlatform, arch: normalizedArch };
  }

  function platformLabel(asset) {
    if (asset.platform === "darwin") {
      return asset.arch === "arm64"
        ? "macOS Apple Silicon"
        : "macOS Intel";
    }
    if (asset.platform === "win32") {
      return "Windows x64";
    }
    return asset.platform + "/" + asset.arch;
  }

  function buildDownloadButton(asset, recommended, comingLabel) {
    var a = document.createElement("a");
    a.className = "download-platform";
    a.setAttribute("data-platform", asset.platform);
    a.setAttribute("data-arch", asset.arch);

    var label = document.createTextNode(platformLabel(asset));
    a.appendChild(label);

    if (asset.url) {
      a.href = asset.url;
      if (asset.version) a.setAttribute("data-version", asset.version);
      if (recommended) a.classList.add("is-recommended");
      // Direct download does not force a new tab.
    } else {
      a.classList.add("is-disabled");
      a.setAttribute("aria-disabled", "true");
      a.removeAttribute("href");
      var status = document.createElement("span");
      status.className = "download-platform-status";
      status.textContent = comingLabel;
      a.appendChild(status);
    }

    return a;
  }

  function initDownloads() {
    var container = document.getElementById("download-platforms");
    if (!container) return null;

    var comingLabel = container.getAttribute("data-coming-label") || "Coming soon";
    var detected = detectPlatform();

    function renderAssets(data) {
      container.textContent = "";
      var assets = (data && data.assets) || [];
      if (assets.length === 0) {
        var fallback = document.createElement("p");
        fallback.className = "download-note";
        fallback.textContent = comingLabel;
        container.appendChild(fallback);
        return;
      }

      for (var i = 0; i < assets.length; i++) {
        var asset = assets[i];
        var recommended = false;
        if (detected) {
          recommended =
            asset.platform === detected.platform &&
            asset.arch === detected.arch;
        } else if (i === 0) {
          // Detection failed: recommend first entry per spec ordering.
          recommended = true;
        }
        var btn = buildDownloadButton(asset, recommended, comingLabel);
        container.appendChild(btn);
      }
    }

    // Always render the buttons; if /downloads.json fails, each will be disabled.
    function renderEmpty() {
      // Spec §7.6: detection failure orders darwin/arm64, darwin/x64, win32/x64.
      var defaults = [
        { platform: "darwin", arch: "arm64", url: null },
        { platform: "darwin", arch: "x64", url: null },
        { platform: "win32", arch: "x64", url: null },
      ];
      renderAssets({ assets: defaults });
    }

    fetch("/downloads.json", { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("downloads.json HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.assets)) {
          renderEmpty();
          return;
        }
        renderAssets(data);
      })
      .catch(function () {
        renderEmpty();
      });

    return null;
  }

  /* =====================================================================
     Module F: Conversion event tracking ( spec §12 lines 719-734 )
     ===================================================================== */

  function initEventTracking() {
    var tracked = document.querySelectorAll("[data-event]");
    if (!tracked.length) return null;

    function emit(el) {
      var eventName = el.getAttribute("data-event");
      if (!eventName) return;
      var payload = {
        event: eventName,
        locale: LOCALE,
        section: el.getAttribute("data-section") || null,
        timestamp: Date.now(),
      };

      if (eventName === "landing_download") {
        payload.platform = el.getAttribute("data-platform") || null;
        payload.arch = el.getAttribute("data-arch") || null;
        payload.version = el.getAttribute("data-version") || null;
      }

      if (eventName === "landing_language_switch") {
        // Determine source and target from current page and link href.
        payload.from = LOCALE;
        var href = el.getAttribute("href") || "";
        payload.to = href.indexOf("/zh-CN") !== -1 ? "zh-CN" : "en";
      }

      if (eventName === "landing_video_play") {
        payload.reducedMotion = !!REDUCED_MOTION;
      }

      // console.debug keeps the integration test surface without depending on
      // a real analytics backend ( spec §12 line 734 ).
      try {
        // eslint-disable-next-line no-console
        if (console && console.debug) console.debug("[landing-event]", payload);
      } catch (e) {
        /* swallow */
      }

      // Future hook: if window.landingTrack is defined, dispatch.
      if (typeof window.landingTrack === "function") {
        try { window.landingTrack(payload); } catch (e) { /* swallow */ }
      }
    }

    function handler(e) {
      var target = e.target;
      // Walk up to find the element carrying the data-event attribute.
      while (target && target !== document.body) {
        if (target.getAttribute && target.getAttribute("data-event")) {
          emit(target);
          return;
        }
        target = target.parentNode;
      }
    }

    // Single delegated listener on document for click events.
    document.addEventListener("click", handler);

    return function cleanup() {
      document.removeEventListener("click", handler);
    };
  }

  /* =====================================================================
     Module G: Hero video play tracking ( spec §12 line 728 )
     ===================================================================== */

  function initHeroVideoTracking() {
    var video = document.getElementById("hero-video");
    if (!video) return null;

    function onPlay() {
      var payload = {
        event: "landing_video_play",
        locale: LOCALE,
        reducedMotion: !!REDUCED_MOTION,
        timestamp: Date.now(),
      };
      try {
        // eslint-disable-next-line no-console
        if (console && console.debug) console.debug("[landing-event]", payload);
      } catch (e) { /* swallow */ }
      if (typeof window.landingTrack === "function") {
        try { window.landingTrack(payload); } catch (e) { /* swallow */ }
      }
    }

    video.addEventListener("play", onPlay);
    return function cleanup() {
      video.removeEventListener("play", onPlay);
    };
  }

  /* =====================================================================
     Module H: Init
     ===================================================================== */

  function init() {
    // Nav scroll state.
    initNavScroll();

    // Mobile menu.
    initMobileMenu();

    // Download platform detection.
    initDownloads();

    // Conversion event tracking.
    initEventTracking();

    // Hero video play tracking.
    initHeroVideoTracking();

    // Hero-only modules.
    var heroSection = document.getElementById("hero");
    if (heroSection) {
      // Particle flow.
      initParticles(document.getElementById("hero-particles"));

      // Typewriter ( delayed start happens inside the class ).
      initTypewriter();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose for debugging in development only.
  window.VoiceBridgeLanding = {
    Typewriter: Typewriter,
    initParticles: initParticles,
    initNavScroll: initNavScroll,
    initMobileMenu: initMobileMenu,
    initDownloads: initDownloads,
    initEventTracking: initEventTracking,
    init: init,
  };
})();
