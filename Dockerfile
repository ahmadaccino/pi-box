FROM node:24-bookworm-slim

# Cloud runtime image for the PiBox container (device id `cloud`).
# Includes the mesh-era sidecar: Browser Rendering CDP, vault snapshots, skills,
# and device helpers used when the Worker dispatches work here.
# Deploy must rebuild this image (`npx wrangler deploy`). Do not ship Worker-only
# with `--containers-rollout=none` after sidecar changes.

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY container/package.json ./
RUN npm install --ignore-scripts --omit=dev

COPY container/*.mjs ./
COPY container/models.json ./
COPY container/skills /root/.pi/agent/skills
COPY plugins /app/plugins

RUN mkdir -p /workspace /root/.pi/agent/sessions

ENV PI_CODING_AGENT_DIR=/root/.pi/agent
ENV PI_PLUGINS_DIR=/app/plugins
ENV PORT=8788

WORKDIR /workspace
EXPOSE 8788
CMD ["node", "/app/server.mjs"]
