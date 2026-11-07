// Cloudflare Worker entry: wrangler deploy
import { route } from './core.js';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    }
    const { status, headers, body } = await route(new URL(request.url));
    return new Response(body, { status, headers });
  },
};
