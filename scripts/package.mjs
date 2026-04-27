import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localcertVersion = process.env.LOCALCERT_VERSION ?? "0.1.0";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;

const targets = {
  win32: {
    archiveType: "zip",
  },
  linux: {
    archiveType: "tar.gz",
  },
  darwin: {
    archiveType: "tar.gz",
  },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function versionedAssetName(version, platform, archiveType) {
  return `lasso-localcert-${version}-${platform}.${archiveType === "zip" ? "zip" : "tar.gz"}`;
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${JSON.stringify(path.join(packageRoot, "*"))} -DestinationPath ${JSON.stringify(outputPath)} -Force`,
    ]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

async function writeCertificateMaterial(certsRoot) {
  await mkdir(certsRoot, { recursive: true });

  const keyPath = path.join(certsRoot, "localhost.key");
  const certPath = path.join(certsRoot, "localhost.crt");
  const pfxPath = path.join(certsRoot, "localhost.pfx");
  const caRootPath = path.join(certsRoot, "caroot.crt");

  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "3650",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);

  run("openssl", [
    "pkcs12",
    "-export",
    "-out",
    pfxPath,
    "-inkey",
    keyPath,
    "-in",
    certPath,
    "-passout",
    "pass:",
  ]);

  await writeFile(caRootPath, await import("node:fs/promises").then(({ readFile }) => readFile(certPath)));
}

export async function packageLocalcert(platform = targetPlatform, version = localcertVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected localcert version like "0.1.0", got "${version}".`);
  }

  const outputRoot = path.join(repoRoot, "output", "package", version, platform);
  const packageRoot = path.join(outputRoot, "payload");
  const certsRoot = path.join(packageRoot, "runtime", "certs");
  const assetName = versionedAssetName(version, platform, target.archiveType);
  const outputPath = path.join(repoRoot, "dist", assetName);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  await writeCertificateMaterial(certsRoot);

  if (!existsSync(path.join(certsRoot, "localhost.crt")) || !existsSync(path.join(certsRoot, "localhost.key"))) {
    throw new Error(`Expected local certificate files were not created in ${certsRoot}`);
  }

  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "localcert",
        upstream: {
          type: "generated-local-dev-certificate",
          subject: "CN=localhost",
          sans: ["DNS:localhost", "IP:127.0.0.1"],
        },
        packagedBy: "service-lasso/lasso-localcert",
        version,
        platform,
        arch: "x64",
        exports: ["CERT_FILE", "CERT_KEY", "CERT_PFX", "CAROOT_CERT"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-localcert] packaged ${outputPath}`);
  return outputPath;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageLocalcert();
}
