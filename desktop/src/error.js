'use strict';

// External file on purpose: the page sets its own CSP (`default-src 'self'`),
// which blocks inline <script> and inline event handlers. With the wiring
// inline, the startup-problem page rendered empty and every button (retry /
// reveal log / VC++ download / quit) was dead (2026-10-15).
const vcredistBtn = document.getElementById('vcredist');
vcredistBtn.addEventListener('click', () => window.desktop.openVCRedistDownload());
document.getElementById('retry').addEventListener('click', () => window.desktop.retry());
document.getElementById('reveal').addEventListener('click', () => window.desktop.revealLog());
document.getElementById('quit').addEventListener('click', () => window.desktop.quit());
window.desktop.onError((payload) => {
  document.getElementById('message').textContent = payload.message;
  document.getElementById('log').textContent = payload.log || '(no host output captured)';
  if (payload.isMissingVCRedist) {
    vcredistBtn.style.display = 'inline-block';
  } else {
    vcredistBtn.style.display = 'none';
  }
  document.title = 'DSH Trading — startup problem';
});
