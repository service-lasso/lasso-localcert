# lasso-localcert

`lasso-localcert` is the Service Lasso core provider for local TLS certificate
generation. It packages `mkcert` and `localcert` binaries, then Service Lasso
runs manifest-owned setup steps to generate certificates into the service data
directory.

This service is not a long-running daemon by default. It is installed and
configured as `@localcert`, then setup creates the files consumed by routing
services such as `@traefik`.

## What It Publishes

Each release publishes:

- `lasso-localcert-0.1.0-win32.zip`
- `lasso-localcert-0.1.0-linux.tar.gz`
- `lasso-localcert-0.1.0-darwin.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

Release tags use the Service Lasso version pattern:

```text
yyyy.m.d-<shortsha>
```

The released `service.json` uses `artifact.source.channel: "latest"` for new
consumers. Core `service-lasso` pins a verified release tag in its checked-in
baseline manifest.

## Runtime Contract

The manifest declares:

- service id `@localcert`
- provider role
- dependency on `@java` for Java trust-store support
- `CAROOT`, `TRUST_STORES`, `HOME`, `PATH`, `CERTS_DOMAINS`, and
  `SERVICE_DATA_FILE_*` environment values
- global outputs `CERT_FILE`, `CERT_KEY`, `CERT_PFX`, `CAROOT_KEY`, and
  `CAROOT_CERT`
- setup steps for `mkcert` PFX generation, `mkcert` key/cert generation,
  optional root CA installation, and optional `localcert` renewal

Generated certificate material is written to `${SERVICE_DATA_PATH}`. Release
archives must not contain fake pre-generated runtime certificates.

## Local Verification

```powershell
npm test
```

Verification packages the current target platform, extracts the archive, checks
that `mkcert` and `localcert` binaries are present, proves static generated
certificates are not packaged, and runs the non-manual `mkcert` setup flow on
the host platform to prove generated outputs exist in the service data path.
