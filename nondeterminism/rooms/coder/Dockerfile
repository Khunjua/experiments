# The coder room's image: the stand's Node image plus Claude Code, pinned to the version
# every old run was made with. The npm package pulls the binary for this machine's
# architecture at build time, so the room never downloads anything at run time.
# Auto-update and non-essential traffic are off: the room only ever needs the API.

FROM node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec

RUN npm install -g @anthropic-ai/claude-code@2.1.310 && npm cache clean --force

ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Last, so the layer above stays cached: the label scripts/clean.sh removes images by.
LABEL stand=1
