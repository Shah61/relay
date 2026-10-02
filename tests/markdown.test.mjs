import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderMarkdown } from "../web/markdown.mjs";
function render(text) {
  const dom = new JSDOM("<div id='body'></div>");
  const target = dom.window.document.querySelector("#body");
  renderMarkdown(target, text);
  return target;
}
test("Markdown renders headings, lists, code, quotes, tables and task checkboxes", () => {
  const target = render(
    "# Result\n\n**Done** with `code`.\n\n- One\n- Two\n\n> Quote\n\n```js\nconst n = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] Finished",
  );
  for (const tag of [
    "h1",
    "strong",
    "code",
    "ul",
    "blockquote",
    "pre",
    "table",
  ])
    assert(target.querySelector(tag), tag);
  assert.equal(target.querySelector("input").disabled, true);
  assert.equal(target.querySelector("input").checked, true);
});
test("Untrusted HTML and unsafe links cannot create executable or fetching elements", () => {
  const target = render(
    '<script>alert(1)</script><img src="https://tracker.invalid/pixel" onerror="alert(1)"><svg onload="alert(1)"></svg><iframe src="/auth/me"></iframe><form action="/auth/pair"><input name="code"></form>\n\n[bad](javascript:alert%281%29) [data](data:text/html,evil) [local](/auth/me) [good](https://example.com)',
  );
  assert.equal(target.querySelector("script,img,svg,iframe,form,input"), null);
  assert.equal(
    target.querySelector("[onerror],[onload],[name],[action]"),
    null,
  );
  const links = [...target.querySelectorAll("a")];
  assert.equal(links.filter((a) => a.hasAttribute("href")).length, 1);
  assert.equal(links.at(-1).getAttribute("rel"), "noopener noreferrer");
  assert.equal(links.at(-1).getAttribute("referrerpolicy"), "no-referrer");
});
test("Code remains literal and rerender replaces an unfinished Markdown block", () => {
  const target = render("```html\n<script>alert(1)</script>");
  assert.equal(target.querySelector("script"), null);
  assert(target.querySelector("code").textContent.includes("<script>"));
  renderMarkdown(target, "**Complete**");
  assert.equal(target.querySelector("pre"), null);
  assert.equal(target.querySelector("strong").textContent, "Complete");
});
