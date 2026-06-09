#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";
import {
  buildPublicHost,
  DEFAULT_ADMIN_URL,
  DEFAULT_CADDY_SERVER,
  openUrl,
  registerCaddyRoute,
  resolveProjectName,
  unregisterCaddyRoute,
} from "./index.js";

type CliOptions = {
  command: "next" | "run";
  name?: string;
  domain: string;
  adminUrl: string;
  serverName: string;
  listen: string[];
  host: string;
  startPort: number;
  open: boolean;
  cleanup: boolean;
  strict: boolean;
  passthrough: string[];
};

type RegisteredProcess = {
  host: string;
  url: string;
  target: string;
  childCommand: string;
  childArgs: string[];
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_START_PORT = 3000;

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`nslocalhost: ${message}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "next") {
    await runDevServer(options, "next", (port) => [
      "dev",
      "-p",
      String(port),
      "-H",
      options.host,
      ...options.passthrough,
    ]);
    return;
  }

  const separatorIndex = options.passthrough.indexOf("--");
  const commandArgs = separatorIndex >= 0
    ? options.passthrough.slice(separatorIndex + 1)
    : options.passthrough;

  if (commandArgs.length === 0) {
    throw new Error("run requires a command after --, for example: nslocalhost run --name app -- bun run dev");
  }

  await runDevServer(options, commandArgs[0]!, () => commandArgs.slice(1));
}

async function runDevServer(
  options: CliOptions,
  command: string,
  argsForPort: (port: number) => string[],
): Promise<void> {
  const projectName = resolveProjectName(process.cwd(), options.name);
  const publicHost = buildPublicHost(projectName, options.domain);
  const port = await findAvailablePort(options.startPort, options.host);
  const upstreamDial = `${options.host}:${port}`;
  const registered = await registerRoute(options, publicHost, upstreamDial, command, argsForPort(port));

  console.log(`nslocalhost: ${registered.url} -> ${registered.target}`);

  if (options.open) {
    openUrl(registered.url, (message) => console.warn(message));
  }

  const child = spawn(registered.childCommand, registered.childArgs, {
    env: {
      ...process.env,
      HOST: options.host,
      HOSTNAME: options.host,
      PORT: String(port),
    },
    stdio: "inherit",
  });

  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp || !options.cleanup) {
      return;
    }

    cleanedUp = true;
    await unregisterCaddyRoute({
      adminUrl: options.adminUrl,
      serverName: options.serverName,
      host: publicHost,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`nslocalhost cleanup: ${message}`);
    });
  };

  process.once("SIGINT", () => {
    child.kill("SIGINT");
  });
  process.once("SIGTERM", () => {
    child.kill("SIGTERM");
  });

  child.once("exit", (code, signal) => {
    void cleanup().finally(() => {
      process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
    });
  });
}

async function registerRoute(
  options: CliOptions,
  publicHost: string,
  upstreamDial: string,
  childCommand: string,
  childArgs: string[],
): Promise<RegisteredProcess> {
  try {
    await registerCaddyRoute({
      adminUrl: options.adminUrl,
      serverName: options.serverName,
      listen: options.listen,
      host: publicHost,
      upstreamDial,
    });
  } catch (error: unknown) {
    if (options.strict) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.warn(`nslocalhost: ${message}`);
  }

  return {
    host: publicHost,
    url: `http://${publicHost}`,
    target: `http://${upstreamDial}`,
    childCommand,
    childArgs,
  };
}

async function findAvailablePort(startPort: number, host: string): Promise<number> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await canListen(port, host)) {
      return port;
    }
  }

  throw new Error(`no available port found from ${startPort} to ${startPort + 99}`);
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function parseArgs(args: string[]): CliOptions {
  const [command, ...rest] = args;

  if (command === "--help" || command === "-h" || !command) {
    printHelp();
    process.exit(0);
  }

  if (command !== "next" && command !== "run") {
    throw new Error(`unknown command "${command}". Expected "next" or "run".`);
  }

  const options: CliOptions = {
    command,
    domain: "localhost",
    adminUrl: DEFAULT_ADMIN_URL,
    serverName: DEFAULT_CADDY_SERVER,
    listen: [":80"],
    host: DEFAULT_HOST,
    startPort: DEFAULT_START_PORT,
    open: true,
    cleanup: true,
    strict: true,
    passthrough: [],
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;

    if (arg === "--") {
      options.passthrough = rest.slice(index + 1);
      break;
    }

    if (arg === "--name") {
      options.name = readValue(rest, ++index, arg);
    } else if (arg === "--domain") {
      options.domain = readValue(rest, ++index, arg);
    } else if (arg === "--caddy-admin-url") {
      options.adminUrl = readValue(rest, ++index, arg);
    } else if (arg === "--caddy-server-name") {
      options.serverName = readValue(rest, ++index, arg);
    } else if (arg === "--listen") {
      options.listen = [readValue(rest, ++index, arg)];
    } else if (arg === "--host") {
      options.host = readValue(rest, ++index, arg);
    } else if (arg === "--port") {
      options.startPort = Number.parseInt(readValue(rest, ++index, arg), 10);
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg === "--no-cleanup") {
      options.cleanup = false;
    } else if (arg === "--no-strict") {
      options.strict = false;
    } else {
      options.passthrough = rest.slice(index);
      break;
    }
  }

  if (!Number.isInteger(options.startPort) || options.startPort < 1 || options.startPort > 65535) {
    throw new Error("--port must be a valid TCP port number");
  }

  return options;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function printHelp(): void {
  console.log(`nslocalhost

Usage:
  nslocalhost next [options] [-- next-dev-args...]
  nslocalhost run [options] -- <command> [args...]

Options:
  --name <name>                 Host prefix. Defaults to package.json name.
  --domain <domain>             Host suffix. Defaults to localhost.
  --port <port>                 First port to try. Defaults to 3000.
  --host <host>                 Upstream host. Defaults to 127.0.0.1.
  --listen <addr>               Caddy listen address. Defaults to :80.
  --caddy-admin-url <url>       Caddy Admin API. Defaults to http://127.0.0.1:2019.
  --caddy-server-name <name>    Caddy server name. Defaults to nslocalhost.
  --no-open                     Do not open the public URL.
  --no-cleanup                  Keep the Caddy route after shutdown.
  --no-strict                   Keep running if Caddy registration fails.
`);
}
