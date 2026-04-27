import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageLocalcert } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const version = process.env.LOCALCERT_VERSION ?? "0.1.0";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function assertFile(filePath) {
  const result = await stat(filePath);
  if (!result.isFile() || result.size === 0) {
    throw new Error(`Expected non-empty file at ${filePath}`);
  }
}

const manifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
if (
  manifest.id !== "localcert" ||
  manifest.role !== "provider" ||
  manifest.artifact?.source?.repo !== "service-lasso/lasso-localcert" ||
  manifest.artifact?.source?.channel !== "latest"
) {
  throw new Error(`Unexpected localcert manifest identity: ${JSON.stringify(manifest)}`);
}

for (const key of ["LOCALCERT_ROOT", "CERT_FILE", "CERT_KEY", "CERT_PFX", "CAROOT_CERT"]) {
  if (typeof manifest.globalenv?.[key] !== "string" || !manifest.globalenv[key].includes("SERVICE_ARTIFACT_ROOT")) {
    throw new Error(`Expected ${key} to resolve from SERVICE_ARTIFACT_ROOT.`);
  }
}

const artifact = await packageLocalcert(platform, version);
const verifyRoot = path.join(repoRoot, "output", "verify", version, platform);
const extractRoot = path.join(verifyRoot, "extract");

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
await run("tar", ["-xf", artifact, "-C", extractRoot]);

const packageMetadata = JSON.parse(
  await readFile(path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json"), "utf8"),
);
if (
  packageMetadata.serviceId !== "localcert" ||
  packageMetadata.packagedBy !== "service-lasso/lasso-localcert" ||
  packageMetadata.version !== version ||
  packageMetadata.platform !== platform
) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(packageMetadata)}`);
}

const certsRoot = path.join(extractRoot, "runtime", "certs");
for (const file of ["localhost.crt", "localhost.key", "localhost.pfx", "caroot.crt"]) {
  await assertFile(path.join(certsRoot, file));
}

console.log(`[lasso-localcert] verification passed for ${version} on ${platform}`);
