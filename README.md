# ZCC — Central Command

The live control room for the Zinerge / Gulan Group portfolio: the full 32-agent roster across 7 divisions, the architecture, the connector catalogue, the build guides, and the roadmap — plus a "Connected properties" panel linking out to every live app in the portfolio (Postoque, Roamola, Sivelar, Turingminds, and this dashboard itself).

Gated behind a demo login on load. Demo credentials are shown on the sign-in screen itself:

```
Username: demo
Password: zinerge2026
```

This is a client-side demo gate (checked in the browser, persisted via `localStorage`), not production authentication — good enough to walk someone through the product, not to protect anything sensitive. Swapping in real auth (Supabase Auth, Cloudflare Access, etc.) is one of the roadmap items already listed in the "Foundations" phase inside the app.

## Stack

Single static `index.html` (self-contained: all CSS/JS inline, no build step) served by a vanilla Node `http` server on `PORT` (default 3000). Deployed via Coolify (Dockerfile build), same instance and target server as postoque.com, roamola.com, sivelar.com and turingminds.co.uk. Domain: z-cc.link.

## Local dev

```
node server.js
```

Visit http://localhost:3000.

## Deployment

Built and run via the included Dockerfile (Coolify auto-detects it). The container listens on `PORT` (default 3000) — Coolify's Port mapping for this app must stay `3003:3000` on the `turingminds-live-p16g` server (this VPS routes each domain to a fixed host port via its own system nginx, not Coolify's Traefik proxy — see the project's infrastructure notes).

Push to `main` and Coolify's GitHub App webhook redeploys automatically.
