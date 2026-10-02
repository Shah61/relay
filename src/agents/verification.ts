import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Availability, Capabilities, Feature } from "./types.ts";
export const verificationPath = resolve(
  import.meta.dirname,
  "../../.bridge/claude-verification.json",
);
// Only the explicit local live harness writes this record. HTTP clients cannot promote capabilities.
export function applyLiveEvidence(
  base: Capabilities,
  availability?: Availability,
  path = verificationPath,
) {
  if (!availability?.version || !availability.sdkVersion) return base;
  try {
    const r = JSON.parse(readFileSync(path, "utf8"));
    if (
      r.kind !== "claude-live-acceptance" ||
      r.status !== "passed" ||
      r.version !== availability.version ||
      r.sdkVersion !== availability.sdkVersion
    )
      return base;
    const bytes = readFileSync(r.eventsPath);
    if (createHash("sha256").update(bytes).digest("hex") !== r.eventsSha256)
      return base;
    for (const feature of Object.keys(base) as Feature[]) {
      if (
        r.checks?.[feature] === true &&
        base[feature].implemented &&
        base[feature].supported
      ) {
        base[feature].verification = "verified";
        base[feature].evidence = path;
      }
    }
  } catch {}
  return base;
}
