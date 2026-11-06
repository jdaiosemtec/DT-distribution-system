#!/bin/sh
# Builds the Avaris DS engine (OWA EPANET 2.3, static) for Linux and Windows (needs gcc, mingw-w64, git).
#   sh engine/build.sh   -> service/bin/linux/avaris_ds_engine, service/bin/win/avaris_ds_engine.exe
set -e
cd "$(dirname "$0")/.."
SRC=${EPANET_SRC:-/tmp/epanet-2.3}
[ -d "$SRC" ] || git clone --depth 1 --branch v2.3 https://github.com/OpenWaterAnalytics/EPANET.git "$SRC"
C=$(ls "$SRC"/src/*.c)
gcc -O2 -I"$SRC/include" -I"$SRC/src" -o service/bin/linux/avaris_ds_engine engine/avaris_ds_engine.c $C -lm -static
x86_64-w64-mingw32-gcc -O2 '-DDLLEXPORT=' -I"$SRC/include" -I"$SRC/src" -o service/bin/win/avaris_ds_engine.exe engine/avaris_ds_engine.c $C -lm -static
echo built
