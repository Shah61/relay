// Never replace an unrelated Serve mapping or coexist with a public Funnel.
export function assertPrivateMapping(
  config: any,
  host: string,
  port: number,
  allowEmpty = false,
) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw Error("Invalid Tailscale Serve status");
  if (Object.values(config.AllowFunnel ?? {}).some(Boolean))
    throw Error(
      "Funnel is enabled. Disable public exposure before using this private gateway.",
    );
  if (
    Object.keys(config).some((k) => !["TCP", "Web", "AllowFunnel"].includes(k))
  )
    throw Error(
      "Unrecognized or separately managed Serve configuration; refusing to change it",
    );
  const web = config.Web ?? {},
    tcp = config.TCP ?? {},
    entries = Object.entries(web);
  if (entries.length === 0 && Object.keys(tcp).length === 0 && allowEmpty)
    return;
  const expected = `${host}:443`;
  const handler = (web as any)[expected]?.Handlers;
  if (
    entries.length !== 1 ||
    entries[0][0] !== expected ||
    !handler ||
    Object.keys(handler).length !== 1 ||
    handler["/"]?.Proxy !== `http://127.0.0.1:${port}` ||
    Object.keys(tcp).length !== 1 ||
    tcp["443"]?.HTTPS !== true ||
    (config.Services && Object.keys(config.Services).length)
  )
    throw Error(
      "Existing Serve configuration is not exclusively the Relay gateway. Refusing to change it.",
    );
}
