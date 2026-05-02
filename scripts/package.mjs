import { spawnSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localcertVersion = process.env.LOCALCERT_VERSION ?? "0.1.0";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;
const mkcertVersion = process.env.MKCERT_VERSION ?? "1.4.4";
const localcertRef = process.env.LOCALCERT_UPSTREAM_REF ?? "aa0035df821847b36e38446fc5ec772c52ddeb37";

const targets = {
  win32: {
    archiveType: "zip",
    goos: "windows",
    executableSuffix: ".exe",
    mkcertAsset: `mkcert-v${mkcertVersion}-windows-amd64.exe`,
    mkcertName: "mkcert.exe",
    localcertName: "localcert.exe",
  },
  linux: {
    archiveType: "tar.gz",
    goos: "linux",
    executableSuffix: "",
    mkcertAsset: `mkcert-v${mkcertVersion}-linux-amd64`,
    mkcertName: "mkcert",
    localcertName: "localcert",
  },
  darwin: {
    archiveType: "tar.gz",
    goos: "darwin",
    executableSuffix: "",
    mkcertAsset: `mkcert-v${mkcertVersion}-darwin-amd64`,
    mkcertName: "mkcert",
    localcertName: "localcert",
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

async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, bytes);
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

async function copyMkcertBinary(target, packageRoot) {
  const mkcertPath = path.join(packageRoot, target.mkcertName);
  const url = `https://github.com/FiloSottile/mkcert/releases/download/v${mkcertVersion}/${target.mkcertAsset}`;
  await downloadFile(url, mkcertPath);
  if (target.executableSuffix === "") {
    await chmod(mkcertPath, 0o755);
  }
  return mkcertPath;
}

async function buildLocalcertBinary(target, packageRoot, platform) {
  const upstreamRoot = path.join(repoRoot, "output", "upstream", "localcert", localcertRef);
  const outputPath = path.join(packageRoot, target.localcertName);

  if (!existsSync(path.join(upstreamRoot, ".git"))) {
    await rm(upstreamRoot, { recursive: true, force: true });
    await mkdir(path.dirname(upstreamRoot), { recursive: true });
    run("git", ["clone", "https://github.com/lann/localcert.git", upstreamRoot]);
    run("git", ["checkout", localcertRef], { cwd: upstreamRoot });
  }

  run("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", outputPath, "./cmd/localcert"], {
    cwd: upstreamRoot,
    env: {
      ...process.env,
      GOOS: target.goos,
      GOARCH: "amd64",
      CGO_ENABLED: "0",
    },
  });

  if (target.executableSuffix === "") {
    await chmod(outputPath, 0o755);
  }

  const expectedSuffix = target.executableSuffix;
  if (!outputPath.endsWith(`${target.localcertName}`) || !target.localcertName.endsWith(expectedSuffix)) {
    throw new Error(`Unexpected localcert binary name for ${platform}: ${target.localcertName}`);
  }

  return outputPath;
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
  const assetName = versionedAssetName(version, platform, target.archiveType);
  const outputPath = path.join(repoRoot, "dist", assetName);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  await copyMkcertBinary(target, packageRoot);
  await buildLocalcertBinary(target, packageRoot, platform);

  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "@localcert",
        upstream: {
          mkcert: {
            repo: "FiloSottile/mkcert",
            version: mkcertVersion,
            asset: target.mkcertAsset,
          },
          localcert: {
            repo: "lann/localcert",
            ref: localcertRef,
          },
        },
        packagedBy: "service-lasso/lasso-localcert",
        version,
        platform,
        arch: "x64",
        exports: ["CERT_FILE", "CERT_KEY", "CERT_PFX", "CAROOT_KEY", "CAROOT_CERT"],
        setupOutputs: ["mkcert.pfx", "mkcert.key", "mkcert.pem", "rootCA-key.pem", "rootCA.pem"],
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
