#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, ".binary-build");
const releaseDir = join(root, "release");
const hostPlatform = platform();
const target = process.env.ATHENA_BINARY_TARGET ?? `${hostPlatform}-${arch()}`;
const [targetPlatform, targetArch] = target.split("-");
if (!targetPlatform || !targetArch) {
  throw new Error(`ATHENA_BINARY_TARGET must look like linux-x64 or darwin-arm64, got: ${target}`);
}
const outDir = join(releaseDir, `athena-${target}`);
const exe = targetPlatform === "win32" ? ".exe" : "";
const nodeBinary = process.env.ATHENA_NODE_BINARY ?? process.execPath;
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const entries = [
  {
    name: "athena",
    entry: "apps/cli/src/index.ts"
  },
  {
    name: "athena-mcp",
    entry: "apps/mcp-server/src/index.ts"
  }
];

rmSync(buildDir, { recursive: true, force: true });
rmSync(outDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

for (const entry of entries) {
  const bundled = join(buildDir, `${entry.name}.cjs`);
  const seaConfig = join(buildDir, `${entry.name}.sea.json`);
  const blob = join(buildDir, `${entry.name}.blob`);
  const binary = join(outDir, `${entry.name}${exe}`);

  run("pnpm", [
    "exec",
    "esbuild",
    entry.entry,
    "--bundle",
    "--platform=node",
    "--target=node20",
    "--format=cjs",
    `--outfile=${bundled}`
  ]);

  writeFileSync(
    seaConfig,
    JSON.stringify(
      {
        main: bundled,
        output: blob,
        disableExperimentalSEAWarning: true
      },
      null,
      2
    )
  );

  run(process.execPath, ["--experimental-sea-config", seaConfig]);
  copyFileSync(nodeBinary, binary);

  if (targetPlatform === "darwin") {
    runIfAvailable("codesign", ["--remove-signature", binary]);
  }

  run("pnpm", [
    "exec",
    "postject",
    binary,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    fuse,
    ...(targetPlatform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])
  ]);

  if (targetPlatform === "darwin") {
    runIfAvailable("codesign", ["--sign", "-", binary]);
  }

  if (targetPlatform !== "win32") {
    run("chmod", ["755", binary]);
  }

}

writeFileSync(
  join(outDir, "README.txt"),
  [
    "MVP Athena client binaries",
    "",
    "Commands:",
    `  ./athena${exe}`,
    `  ./athena-mcp${exe}`,
    "",
    "Set ATHENA_API_URL and ATHENA_TOKEN before use.",
    ""
  ].join("\n")
);

const archive = join(releaseDir, `athena-${target}.tar.gz`);
rmSync(archive, { force: true });
if (existsSyncCommand("tar")) {
  run("tar", ["-czf", archive, "-C", releaseDir, `athena-${target}`]);
  writeFileSync(`${archive}.sha256`, `${sha256File(archive)}  ${`athena-${target}.tar.gz`}\n`);
  console.log(`Wrote ${archive}`);
} else {
  console.log(`Wrote ${outDir}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: hostPlatform === "win32"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function runIfAvailable(command, args) {
  if (existsSyncCommand(command)) {
    run(command, args);
  }
}

function existsSyncCommand(command) {
  const result = spawnSync(hostPlatform === "win32" ? "where" : "command", hostPlatform === "win32" ? [command] : ["-v", command], {
    stdio: "ignore",
    shell: hostPlatform !== "win32"
  });
  return result.status === 0;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
