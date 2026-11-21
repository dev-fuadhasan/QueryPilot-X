import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());


import { getSuspiciousSalesAlerts } from "./supabase-audit";

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is missing from .env.local");
  }

  console.log("Checking Supabase audit log...");

  const alerts = await getSuspiciousSalesAlerts(connectionString);

  console.log("Suspicious alerts found:", alerts.length);
  console.log(JSON.stringify(alerts, null, 2));
}

main().catch((error) => {
  console.error("Supabase test failed:", error.message);
  process.exitCode = 1;
});
