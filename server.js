// Local server: node server.js  ->  http://127.0.0.1:7000/manifest.json
import http from 'node:http';
import { route } from './src/core.js';

const PORT = Number(process.env.PORT) || 7000;

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }
  const { status, headers, body } = await route(new URL(req.url, `http://127.0.0.1:${PORT}`));
  res.writeHead(status, headers);
  res.end(body);
}).listen(PORT, '127.0.0.1', () => console.log(`Dulo addon: http://127.0.0.1:${PORT}/manifest.json`));
