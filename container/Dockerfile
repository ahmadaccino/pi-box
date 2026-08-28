FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts --omit=dev

COPY server.mjs ./
COPY skills /root/.pi/agent/skills

RUN mkdir -p /workspace /root/.pi/agent/sessions

ENV PI_CODING_AGENT_DIR=/root/.pi/agent
ENV PORT=8788

WORKDIR /workspace
EXPOSE 8788
CMD ["node", "/app/server.mjs"]
