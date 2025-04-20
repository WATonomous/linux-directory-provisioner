ARG BASE_IMAGE=node:20-bullseye-slim
FROM $BASE_IMAGE AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY babel.config.js ./
COPY src ./src

RUN npm ci
RUN npm pack
RUN mv *.tgz dist.tgz

FROM $BASE_IMAGE AS test-base

# Install user/group management utilities
RUN apt-get update \
    && apt-get install -y passwd \
    && rm -rf /var/lib/apt/lists/*

RUN npm config set update-notifier false

COPY --from=builder /app/dist.tgz /app/

WORKDIR /app

ENTRYPOINT ["npx"]
CMD ["--yes", "dist.tgz"]
