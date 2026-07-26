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
      box.scrollTop = box.scrollHeight;
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
          if (i < l.t.length) { tt.textContent += l.t[i++]; box.scrollTop = box.scrollHeight; setTimeout(ch, 11 + Math.random() * 13); }
          else { p.querySelector('.caret').remove(); setTimeout(next, 375); }
        })();
      } else { put(l, l.h); setTimeout(next, (l.d || 1000) / 2); }
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
