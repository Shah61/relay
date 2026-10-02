import test from "node:test";
import assert from "node:assert/strict";
import { Replies } from "../web/replies.mjs";
const event = (sequence, method, params, extra = {}) => ({ sequence, turnId: "turn-1", processGeneration: "gen-1", raw: { method, params }, ...extra });
test("Codex deltas become one reply, completed text replaces it, and replay cannot duplicate it", () => {
  const replies = new Replies();
  replies.ingest(event(1, "item/started", { item: { type: "agentMessage", id: "a", text: "", phase: "final_answer" } }));
  const delta = event(2, "item/agentMessage/delta", { itemId: "a", delta: "**Done" });
  replies.ingest(delta); replies.ingest(delta);
  replies.ingest(event(3, "item/agentMessage/delta", { itemId: "a", delta: "**" }));
  assert.equal([...replies.rows.values()][0].text, "**Done**");
  replies.ingest(event(4, "item/completed", { item: { type: "agentMessage", id: "a", text: "**Done**\n\nFinal answer", phase: "final_answer" } }));
  replies.ingest(event(5, "item/agentMessage/delta", { itemId: "a", delta: "late" }));
  assert.equal(replies.rows.size, 1);
  assert.equal([...replies.rows.values()][0].text, "**Done**\n\nFinal answer");
  assert.equal([...replies.rows.values()][0].streaming, false);
});
test("Completed-only replay works and progress, answers and turns stay separate from tools", () => {
  const replies = new Replies();
  replies.ingest(event(1, "item/completed", { item: { type: "agentMessage", id: "a", text: "Progress", phase: "commentary" } }));
  replies.ingest(event(2, "item/completed", { item: { type: "commandExecution", id: "tool", text: "tool output" } }));
  replies.ingest(event(3, "item/completed", { item: { type: "agentMessage", id: "b", text: "Answer" } }));
  replies.ingest(event(4, "item/completed", { item: { type: "agentMessage", id: "b", text: "Next turn" } }, { turnId: "turn-2" }));
  assert.deepEqual([...replies.rows.values()].map(r => r.text), ["Progress", "Answer", "Next turn"]);
});
test("Truncated and interrupted streaming replies are marked and reset clears the session", () => {
  const replies = new Replies();
  replies.ingest(event(1, "item/agentMessage/delta", { itemId: "a", delta: "Partial", _truncation: {} }));
  replies.ingest(event(2, "turn/completed", {}, { type: "turn.interrupted" }));
  assert.equal([...replies.rows.values()][0].truncated, true);
  assert.equal([...replies.rows.values()][0].status, "Interrupted");
  replies.clear();
  assert.equal(replies.rows.size, 0); assert.equal(replies.sequence, 0);
});
test("Claude text blocks and streaming completion combine without showing tool content", () => {
  const replies = new Replies();
  replies.ingest({ sequence: 1, turnId: "c", raw: { event: { type: "message_start", message: { id: "msg" } } } });
  replies.ingest({ sequence: 2, turnId: "c", type: "agent.message.delta", raw: { event: { delta: { text: "Hello" } } } });
  replies.ingest({ sequence: 3, turnId: "c", type: "agent.message", raw: { message: { id: "msg", content: [{ type: "text", text: "Hello world" }, { type: "tool_use", name: "Read" }] } } });
  assert.equal(replies.rows.size, 1);
  assert.equal([...replies.rows.values()][0].text, "Hello world");
});
test("Reply count and text are bounded", () => {
  const replies = new Replies();
  for (let n = 1; n <= 105; n++) replies.ingest(event(n, "item/completed", { item: { type: "agentMessage", id: String(n), text: "Reply" } }));
  assert.equal(replies.rows.size, 100);
  replies.ingest(event(106, "item/agentMessage/delta", { itemId: "long", delta: "x".repeat(128001) }));
  const last = [...replies.rows.values()].at(-1);
  assert.equal(last.text.length, 128000); assert.equal(last.truncated, true);
});
