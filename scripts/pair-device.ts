import { api } from "../src/client.ts";
const [command = "create", role = "operator", ...projects] =
  process.argv.slice(2);
if (command === "create") {
  const p = await api("/admin/pairings", {
    role,
    ...(projects.length ? { projects } : {}),
  });
  console.log(
    `Pairing code (one use, expires in 10 minutes):\n${p.code}\nRole: ${p.role}\nProjects: ${p.projects.join(", ")}\nOpen the dashboard on your device and enter this code.`,
  );
} else if (command === "list") console.log(await api("/admin/devices"));
else if (command === "revoke")
  console.log(await api(`/admin/devices/${role}/revoke`, {}));
else
  throw Error(
    "Use create [owner|operator|viewer] [project IDs], list, or revoke DEVICE_ID",
  );
