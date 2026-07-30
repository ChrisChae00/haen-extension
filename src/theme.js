// Applies the theme synchronously, before first paint, so the panel never
// flashes the wrong theme while chrome.storage resolves asynchronously.
// chrome.storage stays the source of truth (written in src/popup.js);
// this localStorage value is a same-origin, synchronously-readable mirror.
(function () {
  var pref = localStorage.getItem('haen-theme');
  var dark = pref === 'dark' ||
    (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.documentElement.classList.add('no-transition');
})();
