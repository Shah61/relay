import type { IncomingMessage, ServerResponse } from "node:http";
import { DeviceAuth } from "../security/devices.ts";
import { body } from "./gateway.ts";
export function localAdmin(auth: DeviceAuth) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith("/admin/")) return false;
    const send = (v: any) =>
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(JSON.stringify(v));
    if (req.method === "POST" && url.pathname === "/admin/pairings") {
      const input = await body(req, 4096);
      if (Object.keys(input).some((k) => !["role", "projects"].includes(k)))
        throw Error("Unknown fields");
      send(
        auth.pairing(input.role ?? "operator", input.projects ?? auth.projects),
      );
      return true;
    }
    if (req.method === "GET" && url.pathname === "/admin/devices") {
      send(auth.list());
      return true;
    }
    const match = url.pathname.match(
      /^\/admin\/devices\/([a-f0-9-]+)\/revoke$/,
    );
    if (req.method === "POST" && match) {
      auth.revoke(match[1]);
      send({ revoked: true });
      return true;
    }
    res.writeHead(404).end();
    return true;
  };
}
