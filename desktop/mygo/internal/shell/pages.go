package shell

// The two local pages the shell shows before the GUI is up and when the host
// failed. They are loaded with Page.LoadHTML, so they carry no CSP and no
// external assets: the shell owns both files and the window has to paint them
// without a network.
const splashPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DSH Trading</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: #0b1220; color: #dbe4f5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    user-select: none; cursor: default;
  }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; letter-spacing: 0.02em; }
  .status { font-size: 13px; color: #8fa3c7; min-height: 18px; }
  .spinner {
    margin-top: 28px; width: 28px; height: 28px; border-radius: 50%;
    border: 3px solid rgba(143, 163, 199, 0.25); border-top-color: #6ea8fe;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <h1>DSH Trading</h1>
  <div class="status" id="status">Starting…</div>
  <div class="spinner"></div>
  <script>
    window.__dshShellPage = 'splash';
    window.desktop.onStatus(function (text) {
      document.getElementById('status').textContent = text;
    });
  </script>
</body>
</html>
`

const errorPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DSH Trading — startup problem</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    background: #0b1220; color: #dbe4f5; padding: 40px; box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  }
  h1 { font-size: 18px; margin: 0 0 8px; }
  .message { color: #f2a6a6; font-size: 14px; margin-bottom: 16px; }
  pre {
    background: #111a2e; border: 1px solid #24314f; border-radius: 8px;
    padding: 12px; font-size: 12px; line-height: 1.5; overflow: auto;
    max-height: 50vh; white-space: pre-wrap; word-break: break-all; color: #9db1d6;
  }
  .actions { margin-top: 16px; display: flex; gap: 12px; }
  button {
    background: #1d2a47; color: #dbe4f5; border: 1px solid #34507f;
    border-radius: 6px; padding: 8px 18px; font-size: 13px; cursor: pointer;
  }
  button:hover { background: #263a63; }
</style>
</head>
<body>
  <h1>The dsh host could not start / 后台服务启动失败</h1>
  <div class="message" id="message"></div>
  <pre id="log"></pre>
  <div class="actions">
    <button id="vcredist" style="display: none; background: #1c4b31; border-color: #2e8b57; color: #a3f7bf; font-weight: 500;">下载 VC++ 运行库 (x64)</button>
    <button id="retry">Retry / 重试</button>
    <button id="reveal">Reveal log file / 查看日志</button>
    <button id="quit">Quit / 退出</button>
  </div>
  <script>
    window.__dshShellPage = 'error';
    document.getElementById('vcredist').addEventListener('click', function () { window.desktop.openVCRedistDownload(); });
    document.getElementById('retry').addEventListener('click', function () { window.desktop.retry(); });
    document.getElementById('reveal').addEventListener('click', function () { window.desktop.revealLog(); });
    document.getElementById('quit').addEventListener('click', function () { window.desktop.quit(); });
    window.desktop.onError(function (payload) {
      document.getElementById('message').textContent = payload.message;
      document.getElementById('log').textContent = payload.log || '(no host output captured)';
      document.getElementById('vcredist').style.display = payload.isMissingVCRedist ? 'inline-block' : 'none';
    });
  </script>
</body>
</html>
`
