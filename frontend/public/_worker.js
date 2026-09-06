// Persistent AI stays behind the API. Edge streams bytes, never loads weights.
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
        // Streaming body passes through unchanged (including SSE keep-alives).
        return await fetch(new Request(upstream, request));
      } catch {
        return Response.json({ success: false, error: { code: 'UPSTREAM_UNREACHABLE', message: 'EduNova API could not be reached' } }, { status: 502 });
      }
    }
    if (!env.ASSETS) return new Response('Assets unavailable', { status: 503 });
    return env.ASSETS.fetch(request);
  }
};
