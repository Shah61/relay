export class ApiError extends Error {
  constructor(status, data) {
    super(data?.message ?? data?.error ?? `Request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}
export class Client {
  constructor({
    fetcher = globalThis.fetch.bind(globalThis),
    storage = globalThis.localStorage,
  } = {}) {
    this.fetcher = fetcher;
    this.storage = storage;
    this.csrf = "";
    this.device = null;
  }
  async get(path, options = {}) {
    const r = await this.fetcher(path, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(15000),
      ...options,
    });
    const data = await r.json();
    if (!r.ok) throw new ApiError(r.status, data);
    return data;
  }
  async connect() {
    const me = await this.get("/auth/me");
    if (me.contractVersion !== 1)
      throw Error(
        "Unsupported bridge contract. Update the dashboard before continuing.",
      );
    this.csrf = me.csrf;
    this.device = me.device;
    return me;
  }
  key() {
    if (!this.device) throw Error("Device not connected");
    return `relay.outbox.${this.device.id}`;
  }
  pending() {
    try {
      return JSON.parse(this.storage.getItem(this.key()) ?? "[]");
    } catch {
      return [];
    }
  }
  remember(record) {
    const rows = this.pending().filter((x) => x.id !== record.id);
    rows.push(record);
    if (rows.length > 100)
      throw Error("Resolve pending operations before sending more");
    this.storage.setItem(this.key(), JSON.stringify(rows));
  }
  forget(id) {
    this.storage.setItem(
      this.key(),
      JSON.stringify(this.pending().filter((x) => x.id !== id)),
    );
  }
  async mutate(path, payload = {}, id = crypto.randomUUID()) {
    const record = { id, path, at: Date.now(), state: "sending" };
    this.remember(record);
    try {
      const r = await this.fetcher(path, {
        method: "POST",
        signal: AbortSignal.timeout(30000),
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": this.csrf,
          "Idempotency-Key": id,
        },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (data.operation) {
        record.state = data.operation.state;
        this.remember(record);
        if (["completed", "failed"].includes(record.state)) this.forget(id);
        return data;
      }
      if (!r.ok) {
        record.state = "not_acknowledged";
        this.remember(record);
        throw new ApiError(r.status, data);
      }
      this.forget(id);
      return data;
    } catch (e) {
      if (!(e instanceof ApiError)) {
        record.state = "delivery_unknown";
        this.remember(record);
      }
      throw e;
    }
  }
  async reconcile() {
    const rows = [];
    for (const record of this.pending()) {
      try {
        const operation = await this.get(`/api/operations/${record.id}`);
        if (["completed", "failed"].includes(operation.state))
          this.forget(record.id);
        else this.remember({ ...record, state: operation.state });
        rows.push({ ...record, operation });
      } catch (e) {
        rows.push({
          ...record,
          state:
            e.status === 404 ? "not_found_do_not_resend" : "lookup_unavailable",
        });
      }
    }
    return rows;
  }
}
export async function readEvents(response, onEvent, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 262144) throw Error("Event frame too large");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const type =
          block
            .split("\n")
            .find((l) => l.startsWith("event:"))
            ?.slice(6)
            .trim() ?? "message";
        const id = block
          .split("\n")
          .find((l) => l.startsWith("id:"))
          ?.slice(3)
          .trim();
        await onEvent({
          type,
          id: id ? Number(id) : null,
          data: JSON.parse(data),
        });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
