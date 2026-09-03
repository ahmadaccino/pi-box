// Cloudflare Assets html_handling redirects /foo.html → /foo (307). A Worker
// ASSETS.fetch("/foo.html") with run_worker_first therefore 307-loops on /foo.
const PRETTY_PAGES = ["/plugins", "/vault"] as const;

export function prettyAssetPath(pathname: string): string | null {
  for (const page of PRETTY_PAGES) {
    if (pathname === page || pathname === `${page}.html`) return page;
  }
  return null;
}

export function prettyAssetRequest(request: Request): Request | null {
  const url = new URL(request.url);
  const pretty = prettyAssetPath(url.pathname);
  if (!pretty) return null;
  return new Request(new URL(pretty + url.search, request.url), {
    method: request.method,
    headers: request.headers,
    redirect: "manual",
  });
}

export async function fetchPrettyAsset(
  assets: { fetch(request: Request): Promise<Response> },
  request: Request,
): Promise<Response | null> {
  const assetReq = prettyAssetRequest(request);
  if (!assetReq) return null;
  return assets.fetch(assetReq);
}
