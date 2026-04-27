import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const PORT = Number.parseInt(process.env.KIFU_SERVER_PORT ?? '3001', 10);
const OUTPUT_DIR =
  process.env.KIFU_OUTPUT_DIR ??
  path.join(os.homedir(), 'Desktop', 'game records');
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/save-kifu') {
    sendJson(res, 404, { ok: false, error: 'not_found' });
    return;
  }

  let chunks = [];
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return;
    }

    const rawName =
      typeof payload?.filename === 'string' && payload.filename.trim().length > 0
        ? payload.filename.trim()
        : `kifu_${Date.now()}.txt`;
    const safeName = sanitizeFilename(path.basename(rawName));
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!text) {
      sendJson(res, 400, { ok: false, error: 'empty_text' });
      return;
    }

    try {
      await fs.mkdir(OUTPUT_DIR, { recursive: true });
      const filePath = path.join(OUTPUT_DIR, safeName);
      await fs.writeFile(filePath, text, 'utf8');
      sendJson(res, 200, { ok: true, path: filePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: message });
    }
  });
});

server.listen(PORT, () => {
  console.log(`kifu server listening on http://localhost:${PORT}`);
  console.log(`output dir: ${OUTPUT_DIR}`);
});
