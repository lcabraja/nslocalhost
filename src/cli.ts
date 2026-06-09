#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
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

type InstallCaddyOptions = {
  pathToCaddy?: string;
  label: string;
  configPath: string;
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
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
const DEFAULT_CADDY_LABEL = "dev.nslocalhost.caddy";
const DEFAULT_CADDY_CONFIG_PATH = "/Library/Application Support/nslocalhost/caddy/bootstrap.json";
const DEFAULT_CADDY_PLIST_PATH = `/Library/LaunchDaemons/${DEFAULT_CADDY_LABEL}.plist`;
const DEFAULT_CADDY_STDOUT_PATH = "/var/log/nslocalhost-caddy.log";
const DEFAULT_CADDY_STDERR_PATH = "/var/log/nslocalhost-caddy.error.log";

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`nslocalhost: ${message}`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "install-caddy-macos") {
    await installCaddyMacos(parseInstallCaddyArgs(rest));
    return;
  }

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

async function installCaddyMacos(options: InstallCaddyOptions): Promise<void> {
  if (os.platform() !== "darwin") {
    throw new Error("install-caddy-macos only supports macOS.");
  }

  const caddyPath = resolveCaddyPath(options.pathToCaddy);
  const bundledConfigPath = getBundledCaddyConfigPath();
  const plist = createLaunchDaemonPlist({
    caddyPath,
    configPath: options.configPath,
    label: options.label,
    stderrPath: options.stderrPath,
    stdoutPath: options.stdoutPath,
  });
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "nslocalhost-caddy-"));
  const tempConfigPath = path.join(tempDir, "bootstrap.json");
  const tempPlistPath = path.join(tempDir, `${options.label}.plist`);

  writeFileSync(tempConfigPath, readBundledConfig(bundledConfigPath));
  writeFileSync(tempPlistPath, plist);

  await sudo("install", ["-d", "-m", "0755", path.dirname(options.configPath)]);
  await sudo("install", ["-m", "0644", tempConfigPath, options.configPath]);
  await sudo("install", ["-m", "0644", tempPlistPath, options.plistPath]);
  await sudo("launchctl", ["bootout", "system", options.plistPath], { allowFailure: true });
  await sudo("launchctl", ["bootstrap", "system", options.plistPath]);
  await sudo("launchctl", ["enable", `system/${options.label}`]);
  await sudo("launchctl", ["kickstart", "-k", `system/${options.label}`]);

  console.log(`nslocalhost: installed ${options.label}`);
  console.log(`nslocalhost: caddy: ${caddyPath}`);
  console.log(`nslocalhost: config: ${options.configPath}`);
  console.log(`nslocalhost: logs: ${options.stdoutPath}, ${options.stderrPath}`);
  console.log(`nslocalhost: admin API: ${DEFAULT_ADMIN_URL}`);
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
    throw new Error(`unknown command "${command}". Expected "next", "run", or "install-caddy-macos".`);
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

function parseInstallCaddyArgs(args: string[]): InstallCaddyOptions {
  const options: InstallCaddyOptions = {
    label: DEFAULT_CADDY_LABEL,
    configPath: DEFAULT_CADDY_CONFIG_PATH,
    plistPath: DEFAULT_CADDY_PLIST_PATH,
    stdoutPath: DEFAULT_CADDY_STDOUT_PATH,
    stderrPath: DEFAULT_CADDY_STDERR_PATH,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--help" || arg === "-h") {
      printInstallCaddyHelp();
      process.exit(0);
    }

    if (arg === "--path-to-caddy") {
      options.pathToCaddy = readValue(args, ++index, arg);
    } else if (arg === "--label") {
      options.label = readValue(args, ++index, arg);
      options.plistPath = `/Library/LaunchDaemons/${options.label}.plist`;
    } else if (arg === "--config-path") {
      options.configPath = readValue(args, ++index, arg);
    } else if (arg === "--plist-path") {
      options.plistPath = readValue(args, ++index, arg);
    } else if (arg === "--stdout-path") {
      options.stdoutPath = readValue(args, ++index, arg);
    } else if (arg === "--stderr-path") {
      options.stderrPath = readValue(args, ++index, arg);
    } else {
      throw new Error(`unknown install-caddy-macos option "${arg}".`);
    }
  }

  return options;
}

function resolveCaddyPath(explicitPath?: string): string {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);

    if (!isExecutableFile(resolved)) {
      throw new Error(`--path-to-caddy does not point to an executable file: ${resolved}`);
    }

    return resolved;
  }

  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  for (const dir of pathDirs) {
    const candidate = path.join(dir, "caddy");

    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  throw new Error("caddy was not found in PATH. Install Caddy or pass --path-to-caddy /absolute/path/to/caddy.");
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stats = statSync(candidate);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function getBundledCaddyConfigPath(): string {
  const cliPath = fileURLToPath(import.meta.url);
  const bundledConfigPath = path.resolve(path.dirname(cliPath), "..", "caddy", "bootstrap.json");

  if (!existsSync(bundledConfigPath)) {
    throw new Error(`bundled Caddy config was not found at ${bundledConfigPath}`);
  }

  return bundledConfigPath;
}

function readBundledConfig(configPath: string): string {
  return readFileSync(configPath, "utf8");
}

function createLaunchDaemonPlist(input: {
  caddyPath: string;
  configPath: string;
  label: string;
  stderrPath: string;
  stdoutPath: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapePlist(input.caddyPath)}</string>
    <string>run</string>
    <string>--config</string>
    <string>${escapePlist(input.configPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(input.stderrPath)}</string>
</dict>
</plist>
`;
}

function escapePlist(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function sudo(command: string, args: string[], options: { allowFailure?: boolean } = {}): Promise<void> {
  const result = await runCommand("/usr/bin/sudo", [command, ...args]);

  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(`sudo ${command} ${args.join(" ")} failed with exit code ${result.code}`);
  }
}

function runCommand(command: string, args: string[]): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({ code });
    });
  });
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
  nslocalhost install-caddy-macos [options]

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

function printInstallCaddyHelp(): void {
  console.log(`nslocalhost install-caddy-macos

Installs the bundled Caddy bootstrap config as a macOS LaunchDaemon.

Usage:
  nslocalhost install-caddy-macos [options]

Options:
  --path-to-caddy <path>     Caddy executable to use. Required when caddy is not in PATH.
  --label <label>            LaunchDaemon label. Defaults to ${DEFAULT_CADDY_LABEL}.
  --config-path <path>       Installed config path. Defaults to ${DEFAULT_CADDY_CONFIG_PATH}.
  --plist-path <path>        Installed plist path. Defaults to ${DEFAULT_CADDY_PLIST_PATH}.
  --stdout-path <path>       stdout log path. Defaults to ${DEFAULT_CADDY_STDOUT_PATH}.
  --stderr-path <path>       stderr log path. Defaults to ${DEFAULT_CADDY_STDERR_PATH}.
`);
}
