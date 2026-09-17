// Cloudflare Worker — TWSE/TAIFEX/FinMind CORS Proxy
// 部署方式：Cloudflare Dashboard → Workers & Pages → Create → 貼上此檔 → Deploy
const ALLOWED_ORIGINS = [
  'https://leonavibe.github.io',
  'http://localhost:4208',
  'http://127.0.0.1:4208',
  'http://localhost:8080',
];

const ALLOWED_TARGETS = [
  'https://mis.twse.com.tw',
  'https://www.twse.com.tw',
  'https://www.tpex.org.tw',
  'https://mis.taifex.com.tw',
  'https://api.finmindtrade.com',
  'https://news.google.com',
  'https://www.moneydj.com',
  'https://opendata.tdcc.com.tw',
  'https://openapi.twse.com.tw',
];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) {
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    try { new URL(target); } catch {
      return new Response(JSON.stringify({ error: 'Invalid URL' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!ALLOWED_TARGETS.some(prefix => target.startsWith(prefix))) {
      return new Response(JSON.stringify({ error: 'Target not allowed' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    try {
      const fetchOpts = { method: request.method, headers: { 'User-Agent': 'twstock-pages/1.0' } };
      if (request.method === 'POST') {
        fetchOpts.body = await request.text();
        fetchOpts.headers['Content-Type'] = request.headers.get('Content-Type') || 'application/json';
      }
      const resp = await fetch(target, fetchOpts);
      const body = await resp.arrayBuffer();
      return new Response(body, {
        status: resp.status,
        headers: { ...corsHeaders, 'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};
