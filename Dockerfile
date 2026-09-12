FROM node:24-bookworm-slim AS workspace
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/control-api/package.json apps/control-api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/communications/package.json apps/communications/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM oven/bun:1.2.22 AS bun-service
WORKDIR /workspace
COPY --from=workspace /workspace /workspace

FROM workspace AS node-service

FROM python:3.12-slim AS voice-runtime
ENV PYTHONUNBUFFERED=1
WORKDIR /service
COPY apps/voice-runtime/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/voice-runtime/app ./app
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4100"]
