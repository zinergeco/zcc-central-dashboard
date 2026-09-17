# ZCC — Command Central

Internal operations dashboard for the Zinerge / Gulan Group portfolio.

Currently serving a coming-soon placeholder while the platform is built out.

## Stack

- Node.js (vanilla `http`), single static `index.html` served on `PORT` (default 3000)
- Deployed via Coolify (Dockerfile build), same instance and target server as postoque.com and roamola.com
- Domain: zcc.link

## Local dev

```
node server.js
```

Visit http://localhost:3000.

## Deployment

Built and run via the included Dockerfile (Coolify auto-detects it). The container listens on `PORT` (default 3000) — Coolify's "Ports exposes" should match.
