# Relay transport v1

This extends the existing browser contract; it does not replace its authorization or durable operation journal. The local HTTP/OpenAPI contract remains applicable. Host setup endpoints (`/api/host/status`, `/configure`, `/pairings`, `/cancel` under that prefix) are local-owner-only and unavailable through remote routing.

## Routing

Railway exposes `GET /health`, WebSocket `/host` and `/client`. Host upgrades require a high-entropy `RELAY_HOST_TOKEN` bearer and no Origin. Browser upgrades require an exact allowed Origin. Origin checking is defense in depth, not client authentication: non-browser callers can forge it, but cannot forge encrypted messages without a pairing/device secret.

A host sends `{type:"hello",hostId}`. A client sends `{type:"hello",hostId,channelId}`. IDs are UUIDs. Relay allocates a link UUID, informs the host with `{type:"open",linkId,channelId}`, and routes only messages for that host's links. Hosts may send `challenge`, `frame`, and `close`; clients may send only `frame`. Client-supplied routing IDs cannot redirect traffic. An active host ID cannot be replaced by a second socket. Disconnect clears routing; commands are not buffered or replayed.

## Encryption and pairing

Each host open creates a 32-byte random challenge. AES-256-GCM keys are imported non-exportable from SHA-256 over `relay-e2e-v1:` plus the high-entropy secret. Invitations use a random 24-byte secret; devices use 32 bytes. This derivation is for random secrets, not passwords. Each frame uses a fresh 12-byte random IV, an increasing per-direction counter and AAD encoding `[1,hostId,channelId,linkId,challenge,direction,counter]`. Frames with a wrong counter/context/key/tag fail closed. Counters restart only with a fresh host challenge. Keys have no forward secrecy. Maximum encrypted-frame data is 400,000 base64 characters; WebSocket payload limit is 512 KiB and compression is disabled.

QR fragments encode relay origin, host ID/name, invitation channel ID and invitation secret. Fragments are removed immediately and never sent in an HTTP request. The browser sends an encrypted `PAIR` with a device name. Host consumes the existing ten-minute, one-use SQLite pairing, persists the newly issued device secret encrypted at rest, and returns device identity/secret/CSRF encrypted under the invitation key. Browser derives and stores only the non-exportable device CryptoKey plus routing metadata in IndexedDB, then reconnects using the device ID. Lost pairing responses require a fresh QR; an orphan browser credential can be revoked locally.

## Requests

Encrypted requests have a UUID `id`, method, path, optional JSON string body and operation ID. Only an explicit subset of existing browser routes is accepted; no target URLs, local setup, root admin, arbitrary headers, bearer tokens or cookies are accepted from the phone. Host supplies the loopback device cookie/CSRF itself and proxies to the existing gateway, which checks device validity, role, project scope and idempotency. Browser receives encrypted status/body messages. `/auth/me` reports `encrypted_relay`.

SSE is carried as encrypted `start`, `data` and `end` messages under a request ID. Browser reconstructs a bounded readable stream. `CANCEL` aborts an outstanding local fetch; this does **not** guarantee cancellation of an agent command already delivered. Device revocation and expiry terminate access and active streams. Responses to commands lost in transit remain recoverable through the device-scoped operation journal. Browser never retries a mutation automatically.

Limits: 16 hosts, 128 relay sockets total, 32 client links per host, eight concurrent proxied requests per link, existing gateway stream/rate limits, bounded outgoing buffering. Unauthenticated upgrade floods can still cause denial of service; use hosting edge protections for a public deployment. The deployment is intended for a single owner, one replica and one region.

Trust: frontend/repository/deployment accounts and both endpoints are trusted. Relay can deny service and observe metadata, but cannot decrypt protocol payloads without endpoint secrets. A compromised frontend can use browser keys; a compromised local user can read agent files and local tokens. This custom protocol has not had an independent security audit.
