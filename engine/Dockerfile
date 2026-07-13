# Build container with both toolchains pinned.
#
# Stage 1: emsdk (Emscripten, version pinned via EMSDK_VERSION below) for the
#          browser/Tauri target.
# Stage 2: wasi-sdk for the Node/Wasmtime target.
# Stage 3: final image with both toolchains, plus the deps texlive-source's
#          configure needs (perl, python, gperf, p7zip, build-essential, etc.).
#
# Pin both toolchain versions explicitly — the C-side TL build is sensitive to
# Emscripten changes and we want reproducible artifacts. Everything the image
# pulls from the network is therefore pinned by digest or sha256, and each pin
# carries the command that refreshes it. A bump is a reviewed edit here, never
# a silent upstream change.

# Base image pinned by manifest digest (tag kept for readability; the digest
# wins). Resolved 2026-07-13. Refresh:
#   docker buildx imagetools inspect debian:bookworm-slim --format '{{.Manifest.Digest}}'
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

ARG EMSDK_VERSION=5.0.7
# The emsdk repo is the *installer*: it maps EMSDK_VERSION onto a prebuilt
# emscripten-releases toolchain. Cloning its HEAD left that mapping — and the
# install logic itself — floating, so the checkout is pinned to the tag that
# matches EMSDK_VERSION, and asserted against the commit that tag pointed at
# (tags can be re-pointed; commits cannot). Refresh:
#   git ls-remote --tags https://github.com/emscripten-core/emsdk.git
ARG EMSDK_COMMIT=41190c21c662e9cc1962aea94e71cbae9fd2fc87

ARG WASI_SDK_VERSION=33
ARG WASI_SDK_RELEASE=wasi-sdk-33
# sha256 of wasi-sdk-33.0-x86_64-linux.tar.gz, cross-checked against the digest
# GitHub reports for that release asset. Same contract as
# engine/scripts/fetch-verify.sh (verify before use), inlined rather than
# COPYing the script so the image stays independent of the build context
# layout. Refresh after bumping WASI_SDK_RELEASE:
#   curl -fsSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/wasi-sdk-33.0-x86_64-linux.tar.gz | sha256sum
ARG WASI_SDK_SHA256=0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce

# ------------------------------------------------------------------ emsdk stage
FROM ${DEBIAN_IMAGE} AS emsdk-stage
ARG EMSDK_VERSION
ARG EMSDK_COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${EMSDK_VERSION} \
      https://github.com/emscripten-core/emsdk.git /opt/emsdk \
  && cd /opt/emsdk \
  && test "$(git rev-parse HEAD)" = "${EMSDK_COMMIT}" \
  && ./emsdk install ${EMSDK_VERSION} \
  && ./emsdk activate ${EMSDK_VERSION}

# --------------------------------------------------------------- wasi-sdk stage
FROM ${DEBIAN_IMAGE} AS wasi-sdk-stage
ARG WASI_SDK_VERSION
ARG WASI_SDK_RELEASE
ARG WASI_SDK_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --retry 3 --retry-delay 2 -o /tmp/wasi-sdk.tar.gz \
    "https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/wasi-sdk-${WASI_SDK_VERSION}.0-x86_64-linux.tar.gz" \
  && echo "${WASI_SDK_SHA256}  /tmp/wasi-sdk.tar.gz" | sha256sum -c - \
  && mkdir -p /opt/wasi-sdk \
  && tar -xzf /tmp/wasi-sdk.tar.gz -C /opt/wasi-sdk --strip-components=1 \
  && rm /tmp/wasi-sdk.tar.gz

# --------------------------------------------------------------------- final
FROM ${DEBIAN_IMAGE} AS final
ARG EMSDK_VERSION
ARG WASI_SDK_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git \
    build-essential cmake gperf m4 autoconf automake libtool pkg-config \
    bison flex \
    python3 perl \
    p7zip-full xz-utils \
    nodejs npm \
    rsync \
    # Needed by TL's libs/luajit native sub-build (gcc -m32 + libm32).
    gcc-multilib g++-multilib libc6-dev-i386 \
    # TL's web2c builds .info docs via makeinfo; help2man for man pages.
    texinfo help2man \
  && rm -rf /var/lib/apt/lists/*

COPY --from=emsdk-stage /opt/emsdk /opt/emsdk
COPY --from=wasi-sdk-stage /opt/wasi-sdk /opt/wasi-sdk

ENV EMSDK=/opt/emsdk \
    WASI_SDK_PATH=/opt/wasi-sdk \
    PATH=/opt/emsdk:/opt/emsdk/upstream/emscripten:/opt/wasi-sdk/bin:${PATH}

# Source emsdk env in every interactive bash shell (sets EM_CONFIG, PATH for
# the emsdk-pinned Node, etc.). For non-interactive `docker run`, the caller
# should prefix commands with `source /opt/emsdk/emsdk_env.sh && ...`.
RUN echo "source /opt/emsdk/emsdk_env.sh > /dev/null 2>&1" >> /etc/bash.bashrc

# Smoke-check the toolchain works at image-build time. Saves us debugging
# half-broken images later.
RUN bash -c 'source /opt/emsdk/emsdk_env.sh && emcc --version | head -1' \
 && bash -c 'source /opt/emsdk/emsdk_env.sh && em++ --version | head -1' \
 && /opt/wasi-sdk/bin/clang --version | head -1

WORKDIR /workspace
SHELL ["/bin/bash", "-lc"]
CMD ["bash", "-l"]
