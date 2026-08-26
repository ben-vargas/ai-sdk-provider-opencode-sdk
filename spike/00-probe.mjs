// Q9 (migration.v1.status), server identity, model/agent catalog discovery.
import { client, capture, saveArtifact } from "./lib.mjs";

const results = {};
results.health = await capture("health.get", () => client.health.get());
results.server = await capture("server.get", () => client.server.get());
results.migration = await capture("migration.v1.status", () =>
  client.migration.v1.status(),
);
results.modelDefault = await capture("model.default", () =>
  client.model.default(),
);
results.providers = await capture("provider.list", async () => {
  const providers = await client.provider.list();
  // Trim: provider ids + connection state only.
  return providers.map((p) => ({
    id: p.id ?? p.providerID ?? p.name,
    keys: Object.keys(p),
    raw: p,
  }));
});
results.models = await capture("model.list", async () => {
  const models = await client.model.list();
  return models;
});
results.agents = await capture("agent.list", async () => {
  const agents = await client.agent.list();
  return agents.map((a) => ({ name: a.name, keys: Object.keys(a) }));
});
results.config = await capture("config.get", () => client.config.get());

saveArtifact("00-probe", results);
for (const [k, v] of Object.entries(results)) {
  console.log(k, v.ok ? "ok" : `ERROR ${v.error?.name ?? v.error}`);
}
