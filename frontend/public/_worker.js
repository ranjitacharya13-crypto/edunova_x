// Persistent AI stays behind the API. Edge streams bytes, never loads weights.
//
// Client-IP forwarding (IMPORTANT for login rate limiting):
// The backend rate limiter must key by the real visitor, not by this
// worker's egress IP. `CF-Connecting-IP` on the incoming request is set by
// Cloudflare itself (visitors cannot spoof it through the worker), so we
// copy it onto the outgoing request — OVERWRITING any client-supplied
// value — and append it to X-Forwarded-For. When PROXY_SECRET is set on
// both this worker and the backend, we also send X-Proxy-Secret so the
// backend only trusts the forwarded IP for requests that really came
// through this worker (direct-to-Render requests cannot forge it).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) {
      const backend = env.BACKEND_URL || env.API_URL;
      if (!backend) return Response.json({ success: false, error: { code: 'API_NOT_CONFIGURED', message: 'API proxy is not configured' } }, { status: 503 });
      try {
        const target = new URL(backend);
        const path = target.pathname.replace(/\/+$/, '');
        const relative = path.endsWith('/api') && url.pathname.startsWith('/api/') ? url.pathname.slice(4) : url.pathname;
        const upstream = new URL(path + relative + url.search, target.origin);
        const headers = new Headers(request.headers);
        const clientIp = request.headers.get('CF-Connecting-IP')
          || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim();
        if (clientIp) {
          headers.set('CF-Connecting-IP', clientIp);
          const prior = headers.get('X-Forwarded-For');
          headers.set('X-Forwarded-For', prior ? `${prior}, ${clientIp}` : clientIp);
        }
        if (env.PROXY_SECRET) headers.set('X-Proxy-Secret', env.PROXY_SECRET);
        // Streaming body passes through unchanged (including SSE keep-alives).
        const proxied = new Request(request, { headers });
        return await fetch(new Request(upstream, proxied));
      } catch {
        return Response.json({ success: false, error: { code: 'UPSTREAM_UNREACHABLE', message: 'EduNova API could not be reached' } }, { status: 502 });
      }
    }
    if (!env.ASSETS) return new Response('Assets unavailable', { status: 503 });
    return env.ASSETS.fetch(request);
  }
};
