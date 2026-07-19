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
  var RADIUS = 80;  // px of influence above/below the cursor
  var GROW = 0.35;  // extra scale at the cursor itself
  var probe = links.filter(function (a) { return !a.classList.contains('active'); })[0] || links[0];
  var baseOp = parseFloat(getComputedStyle(probe).opacity) || 0.45;
  nav.addEventListener('mousemove', function (e) {
    var navTop = nav.getBoundingClientRect().top;
    links.forEach(function (a) {
      var mid = navTop + a.offsetTop + a.offsetHeight / 2;
      var d = Math.abs(e.clientY - mid);
      var f = d >= RADIUS ? 0 : Math.cos((d / RADIUS) * (Math.PI / 2));
      a.style.transform = f ? 'scale(' + (1 + GROW * f).toFixed(3) + ')' : '';
      var base = a.classList.contains('active') ? 1 : baseOp;
      a.style.opacity = f ? (base + (1 - base) * f).toFixed(3) : '';
    });
  });
  nav.addEventListener('mouseleave', function () {
    links.forEach(function (a) { a.style.transform = ''; a.style.opacity = ''; });
  });
})();
