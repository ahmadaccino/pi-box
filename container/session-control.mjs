/**
 * Stop and steer for the sidecar session that owns the running Pi turn.
 */
function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export async function handleSessionControl(req, res, url, runtime) {
  const matched = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(abort|steer)$/);
  if (!matched) return false;
  const method = (req.method || "GET").toUpperCase();
  if (method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return true;
  }
  const sessionId = decodeURIComponent(matched[1]);
  const op = matched[2];
  if (op === "abort") {
    const out = await runtime.abort(sessionId);
    json(res, 200, out);
    return true;
  }
  let body = {};
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "invalid json" });
    return true;
  }
  const out = await runtime.steer(sessionId, body.message);
  json(res, out.ok ? 200 : out.error === "idle" ? 409 : 400, out);
  return true;
}
