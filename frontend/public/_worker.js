export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ─── API Proxy ─────────────────────────────────────────────────────
    // Only proxy when a backend URL is explicitly configured as a Cloudflare
    // runtime variable. The production frontend normally calls the Render API
    // directly (VITE_API_URL is baked into the JS bundle at build time), so
    // this proxy is a safety net for builds that missed the env var.
    const backendUrl = env.BACKEND_URL || env.API_URL;
    if (backendUrl && (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io'))) {
      try {
        const target = new URL(backendUrl);
        const targetPath = url.pathname.startsWith('/api') && target.pathname.endsWith('/api')
          ? url.pathname.replace(/^\/api/, '')
          : url.pathname;
        const proxyUrl = new URL(target.pathname.replace(/\/+$/, '') + targetPath + url.search, target.origin);

        // Use AbortController for a 30-second timeout so sleeping Render
        // services don't hang the browser indefinitely.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const newReq = new Request(proxyUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
          redirect: 'follow',
          signal: controller.signal,
        });

        const response = await fetch(newReq);
        clearTimeout(timeout);
        return response;
      } catch (e) {
        const isTimeout = e.name === 'AbortError';
        const status = isTimeout ? 504 : 502;
        const message = isTimeout
          ? 'Backend request timed out (30s). The API service may be starting up.'
          : `Proxy error: ${e.message}`;

        return new Response(JSON.stringify({
          success: false,
          error: message,
        }), {
          status,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
          },
        });
      }
    }

    // ─── Static Assets (SPA) ──────────────────────────────────────────
    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      if (response.status === 404 && !url.pathname.includes('.') && request.method === 'GET') {
        const indexRequest = new Request(new URL('/index.html', request.url), request);
        return await env.ASSETS.fetch(indexRequest);
      }
      return response;
    }

    return new Response('EduNova X is running.', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  },
};
