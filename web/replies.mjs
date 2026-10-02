const MAX_REPLIES = 100;
const MAX_TEXT = 128000;
export function isTruncated(value) {
  return (
    !!value &&
    typeof value === "object" &&
    (value.truncated === true ||
      !!value._truncation ||
      Object.values(value).some(isTruncated))
  );
}

// Rebuild from retained events; native completed items replace their streamed text.
export class Replies {
  constructor() {
    this.clear();
  }
  clear() {
    this.rows = new Map();
    this.sequence = 0;
    this.claudeMessage = null;
  }
  ingest(e) {
    if (e.sequence <= this.sequence) return false;
    this.sequence = e.sequence;
    const raw = e.raw ?? {},
      p = raw.params ?? raw;
    const turn = e.turnId ?? p.turnId ?? "unknown";
    const generation = e.processGeneration ?? e.generation ?? "";
    const prefix = `${generation}:${turn}:`;
    if (raw.event?.type === "message_start")
      this.claudeMessage = raw.event.message?.id;
    if (
      ["turn.completed", "turn.failed", "turn.interrupted"].includes(e.type)
    ) {
      for (const row of this.rows.values()) {
        if (row.turn === turn && row.streaming) {
          row.streaming = false;
          row.status =
            e.type === "turn.completed"
              ? "Complete"
              : e.type === "turn.failed"
                ? "Turn failed"
                : "Interrupted";
        }
      }
      this.claudeMessage = null;
      return true;
    }
    const item = p.item;
    let id,
      text,
      delta = false,
      complete = false,
      phase;
    if (
      item?.type === "agentMessage" &&
      ["item/started", "item/completed"].includes(raw.method)
    ) {
      id = item.id;
      text = item.text;
      phase = item.phase;
      complete = raw.method === "item/completed";
    } else if (raw.method === "item/agentMessage/delta") {
      id = p.itemId;
      text = p.delta;
      delta = true;
    } else if (e.type === "agent.message.delta") {
      id = this.claudeMessage ?? "claude-stream";
      text = raw.event?.delta?.text;
      delta = true;
    } else if (e.type === "agent.message" && raw.message?.content) {
      id = raw.message.id ?? this.claudeMessage ?? raw.uuid ?? e.messageId;
      text = raw.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      complete = true;
    } else if (e.type === "agent.message" && typeof p.text === "string") {
      id = e.itemId ?? e.messageId ?? e.sequence;
      text = p.text;
      complete = true;
    } else return false;
    if (id == null || typeof text !== "string") return false;
    const key = prefix + id;
    let row = this.rows.get(key);
    if (!row) {
      row = {
        key,
        turn,
        text: "",
        timestamp: e.timestamp,
        streaming: true,
        phase,
        truncated: false,
      };
      this.rows.set(key, row);
    }
    if (delta && !row.streaming) return false;
    const next = delta ? row.text + text : text;
    row.text = next.slice(0, MAX_TEXT);
    row.truncated = row.truncated || isTruncated(e) || next.length > MAX_TEXT;
    row.phase = phase ?? row.phase;
    row.streaming = !complete;
    row.status = complete ? "Complete" : "Receiving…";
    while (this.rows.size > MAX_REPLIES)
      this.rows.delete(this.rows.keys().next().value);
    return true;
  }
}
