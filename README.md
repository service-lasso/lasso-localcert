# lasso-localcert

`lasso-localcert` is the canonical Service Lasso service repo for the
`localcert` core utility provider.

It publishes small platform archives that contain deterministic local
development certificate material for services such as Traefik. The provider is
not a long-running daemon; Service Lasso installs/configures it, then exposes
certificate paths through global environment values.

## Release Assets

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

The released `service.json` keeps `artifact.source.channel` set to `latest` for
new consumers. Core `service-lasso` pins a verified release tag in its checked-in
baseline manifest.

## Service Lasso Contract

The service manifest declares:

- provider role with no managed daemon start requirement
- native archive acquisition from GitHub releases
- certificate material under `${SERVICE_ARTIFACT_ROOT}/runtime/certs`
- donor-aligned global environment outputs: `CERT_FILE`, `CERT_KEY`,
  `CERT_PFX`, and `CAROOT_CERT`

## Local Verification

```powershell
npm test
```

This packages the current platform, extracts the archive, verifies the package
metadata, and checks the expected certificate files and manifest globals.
