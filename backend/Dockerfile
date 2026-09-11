# DamSafe Twin backend — deployable image (Render / VPS).
#
# Stage 1 builds the real LISFLOOD-FP 5.9 engine (OpenEarth fork, pinned) so
# simulations run WITHOUT a Docker daemon via LISFLOOD_MODE=direct.
# Same pinned source as solver-workers/lisflood-adapter/Dockerfile.
ARG LISFLOOD_REF=11f2a9214f80e1194bfaea23bc52a8247b9924ad

FROM ubuntu:22.04 AS lisflood-build
ARG LISFLOOD_REF
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/openearth/lisflood-fp-bmi.git \
    && git fetch -q --depth 1 origin ${LISFLOOD_REF} && git checkout -q FETCH_HEAD \
    && git rev-parse HEAD
WORKDIR /src/lisflood-fp-bmi-v5.9
RUN make -j$(nproc) omp=1 && ls -l lisflood

# Stage 2: Python API + engine binary side by side.
FROM python:3.12-slim

WORKDIR /app

# Engine runtime libs (OpenMP).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    gdal-bin \
    libgdal-dev \
    gcc \
    g++ \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=lisflood-build /src/lisflood-fp-bmi-v5.9/lisflood /usr/local/bin/lisflood

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Direct (daemonless) engine execution inside this container.
ENV LISFLOOD_MODE=direct
ENV LISFLOOD_BIN=/usr/local/bin/lisflood

EXPOSE 8000

# Render injects $PORT; default 8000 keeps local `docker run` working.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
