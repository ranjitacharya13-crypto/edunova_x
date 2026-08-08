export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Optional API proxying if BACKEND_URL, API_URL, or VITE_API_URL is configured in Cloudflare environment
    const backendUrl = env.BACKEND_URL || env.API_URL || env.VITE_API_URL;
    if (backendUrl && (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io'))) {
      try {
        const target = new URL(backendUrl);
        const targetPath = url.pathname.startsWith('/api') && target.pathname.endsWith('/api')
          ? url.pathname.replace(/^\/api/, '')
          : url.pathname;
        const proxyUrl = new URL(target.pathname.replace(/\/+$/, '') + targetPath + url.search, target.origin);
        const newReq = new Request(proxyUrl.toString(), request);
        return await fetch(newReq);
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Proxy error', message: e.message }), {
          status: 502,
          headers: { 'content-type': 'application/json' }
        });
      }
    }

    // Serve static assets with SPA single-page-application fallback
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
      headers: { 'content-type': 'text/plain' }
    });
  }
};
