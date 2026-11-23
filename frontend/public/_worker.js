// Persistent AI stays behind the API. Edge streams bytes, never loads weights.
//
// Client-IP forwarding (for same-origin /api/* Worker fallback):
// Production builds call the Render API directly via VITE_API_URL /
// DEFAULT_PROD_API_URL, so Render's Cloudflare edge sees each visitor's real
// IP directly. When a request instead traverses this Worker, Render's own
// Cloudflare edge overwrites `CF-Connecting-IP` on the subrequest with the
// Worker's shared egress IP (`2a06:98c0:3600::103`). We therefore:
//   1. Strip any client-supplied `X-EduNova-Client-IP` and `X-Proxy-Secret`.
//   2. Copy Cloudflare's verified incoming `CF-Connecting-IP` into
//      `X-EduNova-Client-IP` and replace `X-Forwarded-For` cleanly.
//   3. Attach `X-Proxy-Secret` when configured so the backend verifies this
//      Worker's identity before trusting `X-EduNova-Client-IP`.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) {
      const backend = env.BACKEND_URL || env.API_URL;
      if (!backend) {
        return Response.json(
          {
            success: false,
            code: 'API_NOT_CONFIGURED',
            error: 'The server is temporarily unavailable. Please try again shortly.',
          },
          { status: 503 }
        );
      }
      try {
        const target = new URL(backend);
        const path = target.pathname.replace(/\/+$/, '');
        const relative = path.endsWith('/api') && url.pathname.startsWith('/api/') ? url.pathname.slice(4) : url.pathname;
        const upstream = new URL(path + relative + url.search, target.origin);

        const headers = new Headers(request.headers);
        headers.delete('x-edunova-client-ip');
        headers.delete('x-proxy-secret');

        const visitorIp = (request.headers.get('CF-Connecting-IP') || '').trim();
        if (visitorIp) {
          headers.set('X-EduNova-Client-IP', visitorIp);
          headers.set('X-Forwarded-For', visitorIp);
        }
        if (env.PROXY_SECRET) {
          headers.set('X-Proxy-Secret', env.PROXY_SECRET);
        }

        // Streaming body passes through unchanged (including SSE keep-alives).
        const proxied = new Request(request, { headers });
        return await fetch(new Request(upstream, proxied));
      } catch {
        return Response.json(
          {
            success: false,
            code: 'UPSTREAM_UNREACHABLE',
            error: 'The server is temporarily unavailable. Please try again shortly.',
          },
          { status: 502 }
        );
      }
    }
    if (!env.ASSETS) return new Response('Assets unavailable', { status: 503 });
    return env.ASSETS.fetch(request);
  }
};
