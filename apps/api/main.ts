import { buildApi } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig();
const app = await buildApi({ config });
await app.listen({ port: config.port, host: config.host });
process.stdout.write(
  `Plan B API listening on ${config.host}:${config.port}; AI ${config.aiEnabled ? "enabled" : "disabled"}; personal AI ${config.personalAiEnabled ? "configured" : "disabled"}\n`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
