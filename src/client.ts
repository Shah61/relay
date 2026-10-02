import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const dir = resolve(import.meta.dirname, "../.bridge");
export async function request(
  path: string,
  body?: any,
  operationId: string = randomUUID(),
) {
  const { url } = JSON.parse(readFileSync(`${dir}/connection.json`, "utf8"));
  const token = readFileSync(`${dir}/token`, "utf8");
  if (body !== undefined && process.argv[1] === import.meta.filename)
    console.error(`Operation ID: ${operationId}`);
  const r = await fetch(url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(body !== undefined ? { "Idempotency-Key": operationId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r;
}
export async function api(path: string, body?: any, operationId?: string) {
  const value = await (
    await request(
      path,
      body,
      operationId ?? process.env.BRIDGE_CLIENT_OPERATION_ID,
    )
  ).json();
  return value.operation ? value.operation.result : value;
}
if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--operation-id");
  if (index >= 0) {
    process.env.BRIDGE_CLIENT_OPERATION_ID = args[index + 1];
    args.splice(index, 2);
  }
  const [cmd, id, ...rest] = args;
  try {
    if (cmd === "operation") console.log(await api(`/operations/${id}`));
    else if (cmd === "events") {
      const r = await request(`/sessions/${id}/events`);
      for await (const b of r.body!) process.stdout.write(Buffer.from(b));
    } else if (cmd === "start")
      console.log(
        await api("/sessions", { project: id, agent: rest[0] ?? "codex" }),
      );
    else if (cmd === "status")
      console.log(await api(id ? `/sessions/${id}` : "/sessions"));
    else if (["prompt", "steer", "queue"].includes(cmd))
      console.log(
        await api(`/sessions/${id}/${cmd}`, { text: rest.join(" ") }),
      );
    else if (cmd === "agents")
      console.log(JSON.stringify(await api("/agents"), null, 2));
    else if (["stop", "close", "resume"].includes(cmd))
      console.log(await api(`/sessions/${id}/${cmd}`, {}));
    else if (cmd === "interrupt")
      console.log(await api(`/sessions/${id}/interrupt`, {}));
    else if (cmd === "approve")
      console.log(
        await api(`/sessions/${id}/approvals`, {
          approvalId: rest[0],
          generation: rest[1],
          decision: rest[2],
          ...(rest[3] ? { answers: JSON.parse(rest[3]) } : {}),
        }),
      );
    else
      throw new Error(
        "Usage: agents | start project [codex|claude] | status [session] | prompt/steer/queue session text | interrupt/events/close/resume session | approve session approvalId generation accept/decline/cancel/answer [answersJSON]",
      );
  } catch (e) {
    console.error(String(e));
    process.exitCode = 1;
  }
}
