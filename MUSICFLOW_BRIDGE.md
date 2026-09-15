# TizenTube MusicFlow Bridge

This fork keeps TizenTube's normal YouTube TV behavior and adds a local request bridge for MusicFlow.

## Install in TizenBrew

Add this module to TizenBrew:

```text
gh/pml13210/TizenTube-MusicFlow@main
```

TizenBrew downloads the module through jsDelivr, so the repository keeps the compiled files `dist/userScript.js` and `dist/service.js` on `main`.

## Local endpoints

When loaded through TizenBrew, the service listens on port `8085`:

```text
GET  /musicflow/health
POST /musicflow/request
GET  /musicflow/jobs/next
POST /musicflow/jobs/:id/result
```

The injected `musicflowBridge.js` polls the local service, executes the requested operation from inside the real YouTube TV page using `KabukiInnerTubeClient.fetch()`, and posts the normalized result back.

Supported actions:

- `search`
- `metadata`
- `stream`
- `video`
- `prefetch`

## MusicFlow configuration

For a backend running on the same LAN as the TV:

```bash
TIZENTUBE_BRIDGE_URL=http://TV_IP:8085/musicflow
```

The direct bridge is intended for trusted LAN use. Do not expose port 8085 directly to the Internet.

## Security

The service supports an optional shared token through `MUSICFLOW_BRIDGE_TOKEN`. MusicFlow sends the same value with `TIZENTUBE_BRIDGE_TOKEN` in the `x-musicflow-token` header.

If the TizenBrew service environment cannot provide a token, leave both variables unset and keep the bridge LAN-only.

## Upstream

Upstream project: `reisxd/TizenTube`.

This fork remains GPL-3.0-only, matching upstream.
