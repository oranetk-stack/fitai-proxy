import { Buffer } from "buffer";

export function requireProxyKey(req, res) {
  const proxyKey = req.headers["x-proxy-key"] || req.headers["X-Proxy-Key"];
  if (!process.env.PROXY_SECRET) {
    console.warn("PROXY_SECRET not set - proxy is open (development only).");
    return true;
  }
  if (!proxyKey || proxyKey !== process.env.PROXY_SECRET) {
    res.status(401).json({ error: "Unauthorized - invalid proxy key" });
    return false;
  }
  return true;
}

export function extractBase64(dataUrlOrBase64) {
  if (!dataUrlOrBase64) return null;
  const prefix = "base64,";
  const idx = dataUrlOrBase64.indexOf(prefix);
  if (idx !== -1) {
    return dataUrlOrBase64.substring(idx + prefix.length);
  }
  return dataUrlOrBase64;
}
