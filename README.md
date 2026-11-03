# ZCC — Central Command (v2 "Nebula")

The live control room for the Zinerge / Gulan Group portfolio: an animated, sci-fi-styled command mesh covering the full 65-agent roster across 11 divisions (Command, Knowledge & mesh, Social, Growth & CRM, Email & comms, Web & content, Delivery, Retainer clients, Global partners, International team, Agency ops), the Agent Bus protocol, the Block Registry lifecycle, the decision engine, guardrails, the tool stack, the data model, the interface spec and the build roadmap — plus a "Connected apps" view pinging every live property in the portfolio in real time (Postoque, Roamola, Sivelar, Turingminds, and this dashboard itself).

This is v2 of the dashboard: a full rebuild of the earlier 32-agent/7-division version, based on the ZCC Agents Master Plan v2 ("Nebula" interface revision, October 2026). It replaces that version entirely rather than extending it.

Gated behind a demo login on load, with two roles. Credentials are shown on the sign-in screen itself:

```
Viewer — Username: demo   Password: zinerge2026
Admin  — Username: admin  Password: zinerge2026admin
```

Viewers see everything but can't tick off roadmap build steps; admins can. This is a client-side demo gate (checked in the browser, persisted via `localStorage`), not production authentication — good enough to walk someone through the product, not to protect anything sensitive. Real auth (Supabase Auth, Cloudflare Access, etc.) and the rest of the actual agent-mesh backend (Agent Bus, Decision Arbiter, token service, Supabase schema, 65 agent blocks) are a separate, much larger build — see `docs/MASTER-PLAN-v2.md` in the project's knowledge base for the full spec and phased roadmap. This repo is the dashboard only.

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
