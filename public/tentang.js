// terapkan tema yang sama dengan game (disimpan di localStorage)
(function () {
  let t = null;
  try { t = localStorage.getItem('theme'); } catch {}
  if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
})();
