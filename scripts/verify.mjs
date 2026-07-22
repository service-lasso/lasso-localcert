import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageLocalcert } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const version = process.env.LOCALCERT_VERSION ?? "0.1.0";

const binaryNames = {
  win32: {
    mkcert: "mkcert.exe",
    localcert: "localcert.exe",
  },
  linux: {
    mkcert: "mkcert",
    localcert: "localcert",
  },
  darwin: {
    mkcert: "mkcert",
    localcert: "localcert",
  },
};

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

function resolveTemplate(value, variables) {
  return value.replace(/\$\{([^}]+)\}/g, (_match, key) => variables[key.trim()] ?? _match);
}

function assertManifestContract(manifest) {
  if (
    manifest.id !== "@localcert" ||
    manifest.role !== "provider" ||
    manifest.artifact?.source?.repo !== "service-lasso/lasso-localcert" ||
    manifest.artifact?.source?.channel !== "latest"
  ) {
    throw new Error(`Unexpected localcert manifest identity: ${JSON.stringify(manifest)}`);
  }

  for (const key of ["CAROOT", "TRUST_STORES", "HOME", "PATH", "CERTS_DOMAINS", "SERVICE_DATA_FILE_PFX", "SERVICE_DATA_FILE_KEY", "SERVICE_DATA_FILE_CERT"]) {
    if (typeof manifest.env?.[key] !== "string") {
      throw new Error(`Expected manifest env.${key}.`);
    }
  }

  for (const key of ["CERT_FILE", "CERT_KEY", "CERT_PFX", "CAROOT_KEY", "CAROOT_CERT"]) {
    if (typeof manifest.globalenv?.[key] !== "string" || !manifest.globalenv[key].includes("SERVICE_DATA_PATH")) {
      throw new Error(`Expected ${key} to resolve from SERVICE_DATA_PATH.`);
    }
  }

  const endpointById = new Map((manifest.endpoints ?? []).map((entry) => [entry.id, entry]));
  const expectedEndpointUrls = {
    cert_pem: "${SERVICE_DATA_PATH}/mkcert.pem",
    cert_key: "${SERVICE_DATA_PATH}/mkcert.key",
    cert_pfx: "${SERVICE_DATA_PATH}/mkcert.pfx",
    root_ca_cert: "${SERVICE_DATA_PATH}/rootCA.pem",
    root_ca_key: "${SERVICE_DATA_PATH}/rootCA-key.pem",
  };
  for (const [id, url] of Object.entries(expectedEndpointUrls)) {
    const endpoint = endpointById.get(id);
    if (!endpoint) {
      throw new Error(`Expected manifest endpoint ${id}.`);
    }
    if (endpoint.kind !== "url" || endpoint.url !== url || endpoint.exposure !== "local" || endpoint.required !== true) {
      throw new Error(`Unexpected manifest endpoint ${id}: ${JSON.stringify(endpoint)}`);
    }
    for (const unsupported of ["env", "globalenv", "export", "exports"]) {
      if (endpoint[unsupported] !== undefined) {
        throw new Error(`Endpoint ${id} must not contain ${unsupported}.`);
      }
    }
  }

  const expectedGlobalAliases = {
    CERT_FILE: expectedEndpointUrls.cert_pem,
    CERT_KEY: expectedEndpointUrls.cert_key,
    CERT_PFX: expectedEndpointUrls.cert_pfx,
    CAROOT_CERT: expectedEndpointUrls.root_ca_cert,
    CAROOT_KEY: expectedEndpointUrls.root_ca_key,
  };
  for (const [key, value] of Object.entries(expectedGlobalAliases)) {
    if (manifest.globalenv[key] !== value) {
      throw new Error(`Expected globalenv.${key} to stay aligned with canonical endpoint resource ${value}.`);
    }
  }

  for (const stepId of ["generate-pfx", "generate-key-cert", "install-root-ca", "renew-localcert"]) {
    if (!manifest.setup?.steps?.[stepId]) {
      throw new Error(`Expected setup step ${stepId}.`);
    }
  }

  if (manifest.setup.steps["install-root-ca"].rerun !== "manual" || manifest.setup.steps["renew-localcert"].rerun !== "manual") {
    throw new Error("Trust-store install and localcert renewal steps must be explicit manual setup steps.");
  }
}

async function verifySetupExecution(extractRoot, manifest) {
  if (platform !== process.platform) {
    console.log(`[lasso-localcert] skipped live setup verification for target ${platform} on host ${process.platform}`);
    return;
  }

  const names = binaryNames[platform];
  const serviceRoot = path.join(repoRoot, "output", "verify", version, platform, "service");
  const dataRoot = path.join(serviceRoot, "data");
  await rm(serviceRoot, { recursive: true, force: true });
  await mkdir(dataRoot, { recursive: true });

  const variables = {
    SERVICE_DATA_PATH: dataRoot.replace(/\\/g, "/"),
    SERVICE_EXECUTABLE_HOME: extractRoot.replace(/\\/g, "/"),
  };
  const env = {
    ...process.env,
    CAROOT: resolveTemplate(manifest.env.CAROOT, variables),
    TRUST_STORES: manifest.env.TRUST_STORES,
    HOME: resolveTemplate(manifest.env.HOME, variables),
    PATH: `${extractRoot}${path.delimiter}${process.env.PATH ?? ""}`,
    CERTS_DOMAINS: manifest.env.CERTS_DOMAINS,
    SERVICE_DATA_FILE_PFX: resolveTemplate(manifest.env.SERVICE_DATA_FILE_PFX, variables),
    SERVICE_DATA_FILE_KEY: resolveTemplate(manifest.env.SERVICE_DATA_FILE_KEY, variables),
    SERVICE_DATA_FILE_CERT: resolveTemplate(manifest.env.SERVICE_DATA_FILE_CERT, variables),
  };
  const domains = env.CERTS_DOMAINS.split(/\s+/).filter(Boolean);

  await run(path.join(extractRoot, names.mkcert), [
    "-pkcs12",
    "-p12-file",
    env.SERVICE_DATA_FILE_PFX,
    "-client",
    ...domains,
  ], { env });
  await run(path.join(extractRoot, names.mkcert), [
    "-key-file",
    env.SERVICE_DATA_FILE_KEY,
    "-cert-file",
    env.SERVICE_DATA_FILE_CERT,
    "-client",
    ...domains,
  ], { env });

  for (const file of [
    env.SERVICE_DATA_FILE_PFX,
    env.SERVICE_DATA_FILE_KEY,
    env.SERVICE_DATA_FILE_CERT,
    path.join(dataRoot, "rootCA-key.pem"),
    path.join(dataRoot, "rootCA.pem"),
  ]) {
    await assertFile(file);
  }
}

const manifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
assertManifestContract(manifest);

const artifact = await packageLocalcert(platform, version);
const verifyRoot = path.join(repoRoot, "output", "verify", version, platform);
const extractRoot = path.join(verifyRoot, "extract");

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
await run("tar", ["-xf", artifact, "-C", extractRoot]);

const names = binaryNames[platform];
if (!names) {
  throw new Error(`Unsupported verification platform: ${platform}`);
}

const packageMetadata = JSON.parse(await readFile(path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json"), "utf8"));
if (
  packageMetadata.serviceId !== "@localcert" ||
  packageMetadata.packagedBy !== "service-lasso/lasso-localcert" ||
  packageMetadata.version !== version ||
  packageMetadata.platform !== platform
) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(packageMetadata)}`);
}

for (const file of ["SERVICE-LASSO-PACKAGE.json", names.mkcert, names.localcert]) {
  await assertFile(path.join(extractRoot, file));
}

for (const staticRuntimeFile of ["runtime/certs/localhost.crt", "runtime/certs/localhost.key", "runtime/certs/localhost.pfx", "runtime/certs/caroot.crt"]) {
  try {
    await stat(path.join(extractRoot, staticRuntimeFile));
    throw new Error(`Package must not contain static generated certificate material: ${staticRuntimeFile}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

await verifySetupExecution(extractRoot, manifest);

console.log(`[lasso-localcert] verification passed for ${version} on ${platform}`);
