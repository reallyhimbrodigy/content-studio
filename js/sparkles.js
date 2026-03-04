/* ============================================================
   Sparkles Canvas — vanilla JS particle background
   Renders only below hero trust bar and adapts to theme vars
   ============================================================ */
(function () {
  var canvas = document.getElementById('sparklesCanvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var particles = [];
  var particleCount = 90;
  var rafId = 0;
  var dpr = 1;
  var width = 0;
  var height = 0;
  var clipTop = 0;
  var hidden = false;
  var sparkleRgb = '255, 255, 255';
  var maxOpacity = 0.6;

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function readThemeVars() {
    sparkleRgb = cssVar('--sparkle-color', '255, 255, 255');
    var parsed = parseFloat(cssVar('--sparkle-opacity-max', '0.6'));
    maxOpacity = Number.isFinite(parsed) ? parsed : 0.6;
  }

  function updateCanvasSize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function getClipTop() {
    var trust = document.querySelector('.hero-v3__trust-bar');
    if (!trust) return 0;
    var rect = trust.getBoundingClientRect();
    return Math.max(0, Math.min(height, rect.bottom));
  }

  function randomIn(min, max) {
    return min + Math.random() * (max - min);
  }

  function createParticle() {
    var minY = clipTop;
    var maxY = Math.max(minY + 1, height);
    var speed = randomIn(0.15, 0.5);
    return {
      x: randomIn(0, width),
      y: randomIn(minY, maxY),
      r: randomIn(0.8, 2.4),
      vx: (Math.random() < 0.5 ? -1 : 1) * speed,
      vy: randomIn(-0.12, 0.12),
      o: randomIn(0.02, Math.max(0.03, maxOpacity)),
      od: (Math.random() < 0.5 ? -1 : 1) * 0.008
    };
  }

  function seedParticles() {
    particles = [];
    for (var i = 0; i < particleCount; i++) {
      particles.push(createParticle());
    }
  }

  function keepInZone(p) {
    var minY = clipTop;
    var maxY = Math.max(minY + 1, height);

    if (p.x < -4) p.x = width + 4;
    if (p.x > width + 4) p.x = -4;

    if (p.y < minY - 4) p.y = maxY + 2;
    if (p.y > maxY + 4) p.y = minY + 2;
  }

  function tick() {
    if (hidden) return;

    clipTop = getClipTop();
    ctx.clearRect(0, 0, width, height);

    if (clipTop < height) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, clipTop, width, height - clipTop);
      ctx.clip();

      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.x += p.vx;
        p.y += p.vy;

        p.o += p.od;
        if (p.o >= maxOpacity) {
          p.o = maxOpacity;
          p.od *= -1;
        }
        if (p.o <= 0.02) {
          p.o = 0.02;
          p.od *= -1;
        }

        keepInZone(p);

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + sparkleRgb + ', ' + p.o.toFixed(3) + ')';
        ctx.fill();
      }

      ctx.restore();
    }

    rafId = requestAnimationFrame(tick);
  }

  function restart() {
    readThemeVars();
    updateCanvasSize();
    clipTop = getClipTop();
    seedParticles();
    if (!hidden) {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    }
  }

  window.addEventListener('resize', restart, { passive: true });
  window.addEventListener('orientationchange', restart, { passive: true });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', restart);
  window.addEventListener('load', restart);

  document.addEventListener('visibilitychange', function () {
    hidden = document.hidden;
    if (hidden) {
      cancelAnimationFrame(rafId);
      return;
    }
    restart();
  });

  restart();
  requestAnimationFrame(function () {
    canvas.classList.add('is-ready');
  });
})();
