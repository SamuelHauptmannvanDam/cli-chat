/* cli-chat.dev — shared behavior for all pages.
   Copy button on every .codeblock: copies the snippet minus # comment lines.
   Loaded with defer, so blocks are in the DOM when this runs. */
(function () {
  document.querySelectorAll('.codeblock').forEach(function (cb) {
    var btn = cb.querySelector('.copy');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var text = cb.querySelector('pre').innerText
        .split('\n')
        .filter(function (l) { return !/^\s*#/.test(l); })
        .join('\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'copied ✓';
        setTimeout(function () { btn.textContent = 'copy'; }, 1600);
      });
    });
  });
})();

/* Dock zoom on the agenda nav: links swell as the cursor nears them and
   taper with distance, mac-Dock style. Positions come from offsetTop (layout,
   unaffected by the transforms), so scaled neighbours don't shift the math. */
(function () {
  var nav = document.getElementById('agenda');
  if (!nav) return;
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches ||
      matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var links = Array.prototype.slice.call(nav.querySelectorAll('a'));
  if (!links.length) return;
  var GROW = 0.65;  // extra scale at the cursor itself
  // Influence field derived from the list's actual item spacing, LINEAR falloff:
  // the hovered link gets the full effect, its immediate neighbours exactly half,
  // and the second item out sits at the field's edge — no effect at all.
  var spacing = links.length > 1
    ? (links[links.length - 1].offsetTop - links[0].offsetTop) / (links.length - 1)
    : 40;
  var RADIUS = spacing * 2;
  var probe = links.filter(function (a) { return !a.classList.contains('active'); })[0] || links[0];
  var baseOp = parseFloat(getComputedStyle(probe).opacity) || 0.45;
  nav.addEventListener('mousemove', function (e) {
    var navTop = nav.getBoundingClientRect().top;
    links.forEach(function (a) {
      var mid = navTop + a.offsetTop + a.offsetHeight / 2;
      var d = Math.abs(e.clientY - mid);
      var f = d >= RADIUS ? 0 : 1 - d / RADIUS;
      a.style.transform = f ? 'scale(' + (1 + GROW * f).toFixed(3) + ')' : '';
      var base = a.classList.contains('active') ? 1 : baseOp;
      a.style.opacity = f ? (base + (1 - base) * f).toFixed(3) : '';
    });
  });
  nav.addEventListener('mouseleave', function () {
    links.forEach(function (a) { a.style.transform = ''; a.style.opacity = ''; });
  });
})();

/* ---- livefeed player for playbook pages ----
   A page declares its animated terminals inline, before this deferred file runs:
     window.FEEDS = [[boxId, lines, startDelayMs?], ...]
   Same player as the landing page's mode feeds: `t` lines type char-by-char
   behind their prompt `pre`; `h` lines land whole after `d` ms. Starts when
   scrolled into view, plays once, holds the finished state. Static render for
   reduced-motion / touch. (The landing page keeps its own inline copy — its
   feeds share closure state with the hero demo.) */
(function () {
  if (!window.FEEDS) return;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var touch = window.matchMedia('(hover: none)').matches;
  function livefeed(id, L, delay) {
    var box = document.getElementById(id);
    if (!box) return;
    var pins = [], idleEl = null;
    function put(l, h) {
      var p = document.createElement('p');
      if (l.c) p.className = l.c;
      p.innerHTML = h;
      if (l.idle) { box.appendChild(p); idleEl = p; }
      else if (l.pin) { if (idleEl) box.insertBefore(p, idleEl); else box.appendChild(p); pins.push(p); }
      else { var anchor = pins[0] || idleEl; if (anchor) box.insertBefore(p, anchor); else box.appendChild(p); }
      return p;
    }
    if (reduced || touch) {
      L.forEach(function (l) { put(l, l.t != null ? (l.pre || '') + l.t : l.h); });
      return;
    }
    var li = 0;
    function next() {
      if (li >= L.length) return;
      var l = L[li++];
      if (l.t != null) {
        var p = put(l, (l.pre || '') + '<span class="typed"></span><span class="caret"></span>');
        var tt = p.querySelector('.typed'), i = 0;
        (function ch() {
          if (i < l.t.length) { tt.textContent += l.t[i++]; setTimeout(ch, 45 + Math.random() * 55); }
          else { p.querySelector('.caret').remove(); setTimeout(next, 750); }
        })();
      } else { put(l, l.h); setTimeout(next, l.d || 1000); }
    }
    function start() { if (delay) setTimeout(next, delay); else next(); }
    var started = false;
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting && !started) { started = true; start(); io.disconnect(); } });
      }, { threshold: .25 });
      io.observe(box);
    } else start();
  }
  window.FEEDS.forEach(function (f) { livefeed(f[0], f[1], f[2]); });
})();
