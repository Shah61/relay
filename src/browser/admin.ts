import type { IncomingMessage, ServerResponse } from "node:http";
import { DeviceAuth } from "../security/devices.ts";
import { body } from "./gateway.ts";
import type { RelayHost } from '../relay/host.ts';
import type { Sessions } from '../sessions/manager.ts';
import { realpathSync, statSync } from 'node:fs';
export function localAdmin(auth: DeviceAuth, getRelay?: () => RelayHost | undefined, sessions?: Sessions) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!url.pathname.startsWith("/admin/")) return false;
    const send = (v: any) =>
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        })
        .end(JSON.stringify(v));
    if (getRelay && req.method === 'GET' && url.pathname === '/admin/companion/status') { send(getRelay()?.status() ?? { state: 'starting' }); return true; }
    if (getRelay && req.method === 'POST' && url.pathname === '/admin/companion/connect') {
      const relay = getRelay(); if (!relay?.managed) throw Error('Managed companion required');
      send(relay.configure(await body(req, 8192))); return true;
    }
    if (getRelay && req.method === 'POST' && url.pathname === '/admin/companion/pair') {
      const relay = getRelay(); if (!relay?.managed) throw Error('Managed companion required');
      send(await relay.invitation('operator', auth.projects)); return true;
    }
    if (sessions && req.method === 'POST' && url.pathname === '/admin/companion/project') {
      const input = await body(req, 4096);
      if (typeof input.path !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id)) throw Error('Invalid project');
      const path = realpathSync(input.path); if (!statSync(path).isDirectory()) throw Error('Invalid project directory');
      if (Object.hasOwn(sessions.projects, input.id) && sessions.projects[input.id] !== path) throw Error('Project already exists');
      sessions.projects[input.id] = path; if (!auth.projects.includes(input.id)) auth.projects.push(input.id);
      send({ added: true }); return true;
    }
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
