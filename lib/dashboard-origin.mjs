// Shared by the build and account proxy so origin checks use the same address.
export function dashboardOrigin(env = process.env) {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  const value = env.DASHBOARD_ORIGIN || (host ? `https://${host}` : "");
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.origin === value)
      return url.origin;
  } catch {}
  throw Error(
    "Set DASHBOARD_ORIGIN to an exact HTTPS origin, or build on Vercel with VERCEL_PROJECT_PRODUCTION_URL or VERCEL_URL available.",
  );
}
