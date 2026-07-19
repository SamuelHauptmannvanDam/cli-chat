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
