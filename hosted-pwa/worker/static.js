const HTML_ROUTES = new Map([
  ["/", "/index.html"],
  ["/zh-CN", "/zh-CN/index.html"],
  ["/zh-CN/", "/zh-CN/index.html"],
  ["/app", "/app.html"],
  ["/app/", "/app.html"],
  ["/terms", "/terms.html"],
  ["/terms/", "/terms.html"],
  ["/privacy", "/privacy.html"],
  ["/privacy/", "/privacy.html"],
  ["/refund", "/refund.html"],
  ["/refund/", "/refund.html"],
  ["/faq", "/faq.html"],
  ["/faq/", "/faq.html"],
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
