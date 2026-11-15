// Single-container start for hosts without background workers (for example a
// free Render web service): apply migrations once, optionally provision
// demonstration tenants, then run the API and the sweep worker side by side.
// If either process exits, the other is stopped and the container exits
// non-zero so the platform restarts both together.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CHILDREN = [
  { name: "api", cwd: "apps/api", entry: "dist/server.js" },
  { name: "worker", cwd: "apps/worker", entry: "dist/worker.js" },
];

export function childEnvironment(env) {
  // Migrations already ran in this process; children must not race them.
  return { ...env, CAIAE_RUN_MIGRATIONS: "false" };
}

/**
 * Starts every child and resolves with the exit code the supervisor should
 * use. A shutdown signal is forwarded to all children; the first unexpected
 * child exit stops the rest and yields a failure code.
 */
export function supervise({
  children = CHILDREN,
  spawnChild,
  signals,
  graceMs = 15000,
  log = (event) => console.log(JSON.stringify(event)),
}) {
  return new Promise((resolve) => {
    const running = new Map();
    let stopping = false;
    let exitCode = 0;
    let forceTimer;

    const stopAll = (signal) => {
      for (const child of running.values()) child.kill(signal);
      forceTimer = setTimeout(() => {
        for (const child of running.values()) child.kill("SIGKILL");
      }, graceMs);
      forceTimer.unref?.();
    };

    for (const spec of children) {
      const child = spawnChild(spec);
      running.set(spec.name, child);
      child.once("exit", (code, signal) => {
        running.delete(spec.name);
        log({ event: "caiae_supervisor.child_exited", child: spec.name, code, signal });
        if (!stopping) {
          stopping = true;
          exitCode = 1;
          stopAll("SIGTERM");
        }
        if (running.size === 0) {
          clearTimeout(forceTimer);
          resolve(exitCode);
        }
      });
    }

    for (const signal of ["SIGTERM", "SIGINT"]) {
      signals.once(signal, () => {
        if (stopping) return;
        stopping = true;
        log({ event: "caiae_supervisor.stopping", signal });
        stopAll(signal);
      });
    }
  });
}

async function prepareDatabase(env) {
  const { createPool, runMigrations } = await import("@caiae/db");
  const pool = createPool(env.DATABASE_URL_UNPOOLED || env.DATABASE_URL);
  try {
    await runMigrations(pool);
    console.log(JSON.stringify({ event: "caiae_supervisor.migrations_applied" }));
    if (env.CAIAE_DEMO_TENANTS) {
      const { provisionDemoTenantsFromEnvironment } = await import("./provision-demo-tenants.mjs");
      await provisionDemoTenantsFromEnvironment(pool, env);
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  if (process.env.CAIAE_RUN_MIGRATIONS !== "false") {
    await prepareDatabase(process.env);
  }
  const env = childEnvironment(process.env);
  const code = await supervise({
    spawnChild: (spec) => spawn(process.execPath, [spec.entry], {
      cwd: path.join(root, spec.cwd), env, stdio: "inherit",
    }),
    signals: process,
    graceMs: Number(process.env.CAIAE_SHUTDOWN_GRACE_MS) || 15000,
  });
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("CAIAE startup failed: " + (error instanceof Error ? error.message : "unknown error"));
    process.exit(1);
  });
}
