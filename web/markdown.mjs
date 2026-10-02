import { marked } from "./vendor/marked.mjs";
import createDOMPurify from "./vendor/purify.mjs";

// Keep generated markup inert, even when a model or prompt contains raw HTML.
export function renderMarkdown(target, text) {
  const document = target.ownerDocument;
  const purify = createDOMPurify(document.defaultView);
  const fragment = purify.sanitize(
    marked.parse(String(text ?? ""), { gfm: true }),
    {
      ALLOWED_TAGS: [
        "p",
        "br",
        "hr",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "strong",
        "em",
        "del",
        "blockquote",
        "ul",
        "ol",
        "li",
        "pre",
        "code",
        "a",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "input",
      ],
      ALLOWED_ATTR: ["href", "title", "start", "type", "checked", "disabled"],
      RETURN_DOM_FRAGMENT: true,
    },
  );
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href") ?? "";
    // Local paths are useful evidence but must not navigate authenticated routes.
    if (/^(https?:\/\/|mailto:)/i.test(href)) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      link.setAttribute("referrerpolicy", "no-referrer");
    } else link.removeAttribute("href");
  }
  for (const input of fragment.querySelectorAll("input")) {
    if (input.getAttribute("type") !== "checkbox") input.remove();
    else input.disabled = true;
  }
  target.classList.add("markdown-body");
  target.replaceChildren(fragment);
}
