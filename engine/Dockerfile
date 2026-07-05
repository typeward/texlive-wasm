# Build container with both toolchains pinned.
#
# Stage 1: emsdk (Emscripten, version pinned via EMSDK_VERSION below) for the
#          browser/Tauri target.
# Stage 2: wasi-sdk for the Node/Wasmtime target.
# Stage 3: final image with both toolchains, plus the deps texlive-source's
#          configure needs (perl, python, gperf, p7zip, build-essential, etc.).
#
# Pin both toolchain versions explicitly — the C-side TL build is sensitive to
# Emscripten changes and we want reproducible artifacts.

ARG EMSDK_VERSION=5.0.7
ARG WASI_SDK_VERSION=33
ARG WASI_SDK_RELEASE=wasi-sdk-33
ARG DEBIAN_VERSION=bookworm

# ------------------------------------------------------------------ emsdk stage
FROM debian:${DEBIAN_VERSION}-slim AS emsdk-stage
ARG EMSDK_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/emscripten-core/emsdk.git /opt/emsdk \
  && cd /opt/emsdk \
  && ./emsdk install ${EMSDK_VERSION} \
  && ./emsdk activate ${EMSDK_VERSION}

# --------------------------------------------------------------- wasi-sdk stage
FROM debian:${DEBIAN_VERSION}-slim AS wasi-sdk-stage
ARG WASI_SDK_VERSION
ARG WASI_SDK_RELEASE
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/wasi-sdk.tar.gz \
    "https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/wasi-sdk-${WASI_SDK_VERSION}.0-x86_64-linux.tar.gz" \
  && mkdir -p /opt/wasi-sdk \
  && tar -xzf /tmp/wasi-sdk.tar.gz -C /opt/wasi-sdk --strip-components=1 \
  && rm /tmp/wasi-sdk.tar.gz

# --------------------------------------------------------------------- final
FROM debian:${DEBIAN_VERSION}-slim AS final
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
