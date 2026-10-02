These browser modules are vendored so local, hosted, and packaged dashboards use the same files without a CDN.

- `marked.mjs`: marked 18.0.14, copied from `node_modules/marked/lib/marked.esm.js`; license in `marked-LICENSE`.
- `purify.mjs`: DOMPurify 3.4.16, copied from `node_modules/dompurify/dist/purify.es.mjs`; license in `dompurify-LICENSE`.

When upgrading the corresponding package dependencies, refresh these copies and licenses, then run `npm run test:client`. The dashboard build copies this directory; the Companion build copies all of `web/`.
