'use strict';

// External file on purpose: the page sets its own CSP (`default-src 'self'`),
// which blocks inline <script> and inline event handlers. The status bridge
// used to live in an inline script, so it never ran: the splash kept its
// hard-coded "Starting…" through the whole boot and no status ever reached the
// user (2026-10-15 — the CSP violation was the only [renderer] line of an
// otherwise healthy launch).
const status = document.getElementById('status');
if (window.desktop !== undefined) {
  window.desktop.onStatus((text) => {
    status.textContent = text;
  });
}

const logo = document.querySelector('.logo');
if (logo !== null) {
  logo.addEventListener('error', () => {
    logo.style.display = 'none';
  });
}
