# openclaw-team container verification image.
#
# Offline-first: the repository is dependency-free (bash + Node stdlib), so this
# image builds without apt/npm network access and reproduces on any machine.
# Verification runs HERE, never on the host (per project convention).
#
# Build:  docker build -f docker/Dockerfile -t openclaw-team:verify .
# Verify: docker run --rm openclaw-team:verify bash docker/verify-in-container.sh

FROM node:24-bookworm-slim

# Node ships the ICU tz database, so TZ takes effect without tzdata.
ENV TZ=Asia/Shanghai

WORKDIR /app

# Build context is trimmed by the repository-root .dockerignore.
COPY . .

# Run as the unprivileged `node` user already provided by the base image.
# Repo files may carry restrictive modes on the host; make them readable/executable
# for the unprivileged user (COPY preserves host modes).
RUN chmod -R a+rX /app && chown -R node:node /app

USER node

# Default to the verification suite so `docker run <image>` is a useful smoke test.
CMD ["bash", "docker/verify-in-container.sh"]
