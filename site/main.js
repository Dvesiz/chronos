/* 时序 · Chronos — 官网交互
   只做三件事：滚动揭示、导航状态、设备视差。全部可降级。 */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ── 滚动揭示 ─────────────────────────────────────── */
  var revealables = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));

  function revealAll() {
    revealables.forEach(function (el) { el.classList.add('is-in'); });
  }

  if (!('IntersectionObserver' in window) || reduceMotion.matches) {
    revealAll();
  } else {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        revealObserver.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

    revealables.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ── 导航：滚动后收紧 ─────────────────────────────── */
  var nav = document.getElementById('nav');
  var ticking = false;

  function syncNav() {
    if (nav) nav.classList.toggle('is-stuck', window.scrollY > 12);
    ticking = false;
  }

  if (nav) {
    syncNav();
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(syncNav);
    }, { passive: true });
  }

  /* ── 设备视差：跟随指针轻微倾斜 ───────────────────── */
  var tiltTargets = Array.prototype.slice.call(document.querySelectorAll('[data-tilt]'));

  if (tiltTargets.length && !reduceMotion.matches && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    tiltTargets.forEach(function (device) {
      var frame = null;
      var host = device.parentElement || device;

      function reset() {
        device.style.setProperty('--rx', '0deg');
        device.style.setProperty('--ry', '0deg');
      }

      host.addEventListener('pointermove', function (event) {
        if (frame) return;
        frame = window.requestAnimationFrame(function () {
          frame = null;
          var rect = host.getBoundingClientRect();
          var px = (event.clientX - rect.left) / rect.width - 0.5;
          var py = (event.clientY - rect.top) / rect.height - 0.5;
          var max = 6;
          device.style.setProperty('--ry', (px * max * 2).toFixed(2) + 'deg');
          device.style.setProperty('--rx', (-py * max * 2).toFixed(2) + 'deg');
        });
      }, { passive: true });

      host.addEventListener('pointerleave', reset);
    });
  }

  /* ── 数字滚动 ─────────────────────────────────────── */
  var counters = Array.prototype.slice.call(document.querySelectorAll('[data-count]'));

  function runCounter(el) {
    var target = Number(el.getAttribute('data-count')) || 0;
    if (reduceMotion.matches || target === 0) {
      el.textContent = String(target);
      return;
    }
    var started = null;
    var duration = 1100;

    function step(now) {
      if (started === null) started = now;
      var t = Math.min(1, (now - started) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(target * eased));
      if (t < 1) window.requestAnimationFrame(step);
    }

    window.requestAnimationFrame(step);
  }

  if (counters.length) {
    if (!('IntersectionObserver' in window)) {
      counters.forEach(runCounter);
    } else {
      var counterObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          runCounter(entry.target);
          counterObserver.unobserve(entry.target);
        });
      }, { threshold: 0.6 });
      counters.forEach(function (el) { counterObserver.observe(el); });
    }
  }

  /* ── 页脚年份 ─────────────────────────────────────── */
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();