#!/usr/bin/env python3
"""One-time masked-entry server for the Crustdata API key.

Serves a single HTTPS page (self-signed cert). The key POSTed by the user is
written straight into /home/ubuntu/tracezeta/.env and never logged or echoed.
The server exits after one successful capture.
"""
import http.server, ssl, os, sys, threading

ENV_FILE = '/home/ubuntu/tracezeta/.env'
PORT = 8443

PAGE = """<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TraceZeta key entry</title>
<style>
body{font-family:system-ui,sans-serif;background:#111827;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1f2937;border-radius:16px;padding:32px;max-width:420px;width:90%}
h1{font-size:20px;margin:0 0 8px} p{color:#9ca3af;font-size:14px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;padding:14px;border-radius:10px;border:1px solid #374151;background:#111827;color:#fff;font-size:15px;margin-bottom:14px}
button{width:100%;padding:14px;border-radius:10px;border:0;background:#6366f1;color:#fff;font-size:15px;font-weight:600}
.done{color:#34d399;font-size:15px;margin-top:16px;display:none}
</style></head>
<body><div class="card">
<h1>Paste your Crustdata API key</h1>
<p>Goes directly into TraceZeta's .env on the server. It never appears in chat and is never logged. This page works once.</p>
<input type="password" id="k" placeholder="crust_... / your API key" autofocus>
<button onclick="send()">Save key</button>
<div class="done" id="d">&#10003; Key saved. You can close this page.</div>
<script>
async function send(){
  const v = document.getElementById('k').value.trim();
  if(!v) return;
  const r = await fetch('/save', {method:'POST', body: v});
  if(r.ok){ document.getElementById('d').style.display='block'; }
}
</script>
</div></body></html>"""

class H(http.server.BaseHTTPRequestHandler):
    captured = False

    def log_message(self, *a):  # never log requests
        pass

    def _page(self, already=False):
        body = (PAGE if not already else PAGE.replace(
            '<p>Goes directly', '<p>&#10003; Already captured. Nothing more to do.</p><p style="display:none">Goes directly')).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if H.captured:
            self._page(already=True)
            return
        self._page()

    def do_POST(self):
        if H.captured:
            self.send_response(409); self.end_headers(); return
        n = int(self.headers.get('Content-Length', 0))
        key = self.rfile.read(n).decode().strip()
        if not key or len(key) < 8:
            self.send_response(400); self.end_headers(); return
        # write into .env: replace existing line or append
        lines = []
        if os.path.exists(ENV_FILE):
            lines = open(ENV_FILE).read().splitlines()
        lines = [l for l in lines if not l.startswith('CRUSTDATA_API_KEY=')]
        lines.append(f'CRUSTDATA_API_KEY={key}')
        with open(ENV_FILE, 'w') as f:
            f.write('\n'.join(lines) + '\n')
        os.chmod(ENV_FILE, 0o600)
        H.captured = True
        self.send_response(200); self.end_headers()
        threading.Thread(target=lambda: os._exit(0), daemon=True).start()

httpd = http.server.HTTPServer(('0.0.0.0', PORT), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('/etc/ssl/crust-key.pem', '/etc/ssl/crust-key.pem')
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print(f'listening on :{PORT} (one-shot)', flush=True)
httpd.serve_forever()
