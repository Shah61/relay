export const contract = {
  version: 1,
  application: "Relay",
  authentication: "HttpOnly device cookie; one-time locally issued pairing",
  roles: {
    viewer: ["read assigned projects"],
    operator: ["read and control assigned projects"],
    owner: [
      "read and control assigned projects",
      "list and revoke browser devices",
      "read diagnostics",
    ],
  },
  mutations: {
    idempotencyHeader: "Idempotency-Key",
    csrfHeader: "X-CSRF-Token",
    sameOriginRequired: true,
    completedMeans:
      "Bridge request handling finished; native turn status is separate",
    lostResponse: "Look up original operation ID; never automatically resend",
  },
  events: {
    cursor: "after or Last-Event-ID",
    retentionGap: "resync_required; fetch authoritative snapshot",
    disconnect: "Does not stop the agent",
  },
  errors: [
    "authentication_required",
    "device_expired_or_revoked",
    "csrf_invalid",
    "origin_forbidden",
    "project_forbidden",
    "read_only_device",
    "owner_required",
    "rate_limited",
    "resync_required",
  ],
  controls: {
    interrupt: "Interrupt current native turn; descendants may survive",
    stop: "Stop owned parent; retain worktree reservation",
    close: "Close control; does not stop parent or release worktree",
    release: "Local audited operator action only",
  },
  claude: "Implemented; runtime unverified until separately tested",
};

export function truncated(value: any): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value.truncated === true ||
      !!value._truncation ||
      Object.values(value).some(truncated))
  );
}
