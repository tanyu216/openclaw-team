# ui-fidelity image — pinned browser + fonts so pixel diffs are deterministic.
#
# Network-required build (pulls the Playwright base image and npm deps); this is
# deliberately separate from the offline `docker/verify.sh` image.
#
# Build:  docker build -f docker/ui-fidelity/Dockerfile -t openclaw-team:ui-fidelity .
# Test:   docker run --rm openclaw-team:ui-fidelity bash self-test.sh

ARG PLAYWRIGHT_VERSION=1.55.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy

ENV TZ=Asia/Shanghai
WORKDIR /app

# Install dependencies first (layer cache), then the harness itself.
COPY tools/ui-fidelity/package.json ./package.json
RUN npm install --no-audit --no-fund

COPY tools/ui-fidelity/ ./
RUN chmod -R a+rX /app

CMD ["bash", "self-test.sh"]
