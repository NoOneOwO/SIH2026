# LISFLOOD-FP (University of Bristol lineage) — lean CPU build for DamSafe Twin.
#
# Engine: LISFLOOD-FP 5.9 via OpenEarth (Basic Model Interface fork), pinned via
# LISFLOOD_REF. Plain g++/OpenMP build, ASCII I/O only — exactly what the
# DamSafe adapter stages and parses.
#
# NOTE on the referenced 8.2_update fork (urabbani/lisflood-fp_8.2_update):
# that snapshot does not compile CPU-only (its `Arrays` struct was refactored
# to std::vector while legacy .cpp files still do raw pointer arithmetic, plus
# unguarded CUDA includes). Parameter conventions used by the adapter
# (DEMfile/startfile/weirfile/bcifile/resroot/saveint/sim_time/fpfric/voutput)
# are valid in BOTH versions — verified against this 5.9 source (pars.cpp,
# input.cpp) and the 8.2_update PARAMETER_FILE.md + examples/dam_breach.par.
#
# Build (from repo root):
#   docker build -f solver-workers/lisflood-adapter/Dockerfile \
#       -t damsafe-lisflood:cpu solver-workers/lisflood-adapter
# Test:
#   docker run --rm damsafe-lisflood:cpu -h
ARG LISFLOOD_REF=11f2a9214f80e1194bfaea23bc52a8247b9924ad

FROM ubuntu:22.04 AS builder
ARG LISFLOOD_REF
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/openearth/lisflood-fp-bmi.git \
    && git fetch -q --depth 1 origin ${LISFLOOD_REF} && git checkout -q FETCH_HEAD \
    && git rev-parse HEAD && ls lisflood-fp-bmi-v5.9/makefile
WORKDIR /src/lisflood-fp-bmi-v5.9
RUN make -j$(nproc) omp=1 && ls -l lisflood && ./lisflood -h 2>&1 | head -8

FROM ubuntu:22.04 AS runtime
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/lisflood-fp-bmi-v5.9/lisflood /usr/local/bin/lisflood
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/lisflood"]
