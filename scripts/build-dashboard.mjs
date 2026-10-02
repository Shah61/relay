import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  cpSync,
} from "node:fs";
const url = new URL(process.env.RELAY_PUBLIC_URL ?? "");
const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? "";
if (
  url.protocol !== "wss:" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  url.pathname !== "/"
)
  throw Error("Set RELAY_PUBLIC_URL to the exact wss:// Railway origin");
if (!/^https:\/\/[^/]+$/.test(dashboardOrigin))
  throw Error("Set DASHBOARD_ORIGIN to the exact Vercel HTTPS origin");
mkdirSync("dist-web", { recursive: true });
for (const name of [
  "app.mjs",
  "client.mjs",
  "relay-client.mjs",
  "e2e.mjs",
  "style.css",
  "icon.svg",
  "manifest.webmanifest",
  "account.mjs",
  "account.css",
  "access-crypto.mjs",
])
  copyFileSync(`web/${name}`, `dist-web/${name}`);
const policy = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${url.origin}; manifest-src 'self'; base-uri 'none'; form-action 'self'`;
writeFileSync(
  "dist-web/workspace.html",
  readFileSync("web/index.html", "utf8").replace(
    "<head>",
    `<head>\n<meta name="relay-hosted" content="true">\n<meta http-equiv="Content-Security-Policy" content="${policy}">`,
  ),
);
writeFileSync(
  "dist-web/index.html",
  readFileSync("web/account.html", "utf8").replace(
    "<head>",
    `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`,
  ),
);
cpSync("node_modules/@simplewebauthn/browser/esm", "dist-web/vendor/webauthn", {
  recursive: true,
});
console.log(
  "Built static dashboard with a single allowed relay origin. No credentials included.",
);
