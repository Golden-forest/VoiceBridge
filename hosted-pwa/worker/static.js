const HTML_ROUTES = new Map([
  ["/", "/index.html"],
  ["/zh-CN", "/zh-CN/index.html"],
  ["/zh-CN/", "/zh-CN/index.html"],
  ["/app", "/app.html"],
  ["/app/", "/app.html"],
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const assetPath = HTML_ROUTES.get(url.pathname);
    if (!assetPath) return env.ASSETS.fetch(request);

    const assetUrl = new URL(assetPath, url.origin);
    assetUrl.search = url.search;
    return env.ASSETS.fetch(new Request(assetUrl, request));
  },
};
