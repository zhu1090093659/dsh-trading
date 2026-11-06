// Page-side assertions of the window.desktop contract, evaluated in the GUI by
// cmd/drill. A page that is not the shell's own has no window.desktop at all,
// which is exactly what this reports as missing.
(function () {
  var members = ['onStatus', 'onError', 'retry', 'revealLog', 'openVCRedistDownload', 'quit', 'relaunch'];
  var present = [];
  var missing = [];
  for (var i = 0; i < members.length; i++) {
    var ok = typeof window.desktop === 'object' && window.desktop !== null && typeof window.desktop[members[i]] === 'function';
    if (ok) { present.push(members[i]); } else { missing.push(members[i]); }
  }
  var body = document.body ? (document.body.innerText || '') : '';
  var seen = {};
  var pluginStyles = 0;
  var nodes = document.querySelectorAll('style[data-plugin]');
  for (var j = 0; j < nodes.length; j++) {
    var key = nodes[j].dataset.plugin;
    if (!seen[key]) { seen[key] = 1; pluginStyles++; }
  }
  return {
    origin: String(location.origin),
    href: String(location.href).replace(/([?&]token=)[^&]*/, '$1***'),
    title: String(document.title),
    readyState: String(document.readyState),
    textLen: body.length,
    pluginStyles: pluginStyles,
    present: present,
    missing: missing,
    desktopPresent: typeof window.desktop === 'object' && window.desktop !== null
  };
})()
