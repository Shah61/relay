// The dashboard authenticates the launch; app traffic goes directly to the Railway preview origin.
import { dashboardOrigin } from "../lib/dashboard-origin.mjs";
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    const url = new URL(req.url, dashboardOrigin());
    const id = url.pathname.startsWith("/p/")
      ? url.pathname.slice(3)
      : url.searchParams.get("id");
    if (
      req.method !== "GET" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        id ?? "",
      )
    )
      return res.status(404).end("Preview not found");
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res.status(403).end("Open this preview from Prompt Manager");
    const base = new URL(process.env.RELAY_PUBLIC_URL ?? "");
    if (base.protocol !== "wss:" || base.origin + "/" !== base.href)
      throw Error("invalid_release_configuration");
    const upstream = await fetch(
      base.origin.replace(/^wss:/, "https:") +
        "/account-api/previews/open?id=" +
        id,
      {
        headers: {
          Cookie: req.headers.cookie ?? "",
          Origin: dashboardOrigin(),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    const data = await upstream.json();
    if (!upstream.ok)
      return res
        .status(upstream.status === 401 ? 401 : 404)
        .end(
          "Preview unavailable. Sign in and open it again from your workspace.",
        );
    const target = new URL(data.url);
    if (
      target.protocol !== "https:" ||
      !target.hostname.startsWith(id + ".") ||
      target.pathname !== "/_pm/connect"
    )
      throw Error("invalid_preview_url");
    res.writeHead(303, { Location: target.href }).end();
  } catch {
    res.status(503).end("Preview service unavailable");
  }
}
