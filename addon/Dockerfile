FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS camera-bridge-build

ARG TARGETOS
ARG TARGETARCH
ARG CAMERA_BRIDGE_REV=6136304ea023d2d32742d2432bc5ca07bc738430

RUN apk add --no-cache git
RUN git init /src \
	&& git -C /src remote add origin https://github.com/aerodomigue/petlibro_granary_local_relay.git \
	&& git -C /src fetch --depth 1 origin ${CAMERA_BRIDGE_REV} \
	&& git -C /src checkout --detach FETCH_HEAD
WORKDIR /src/camera-bridge
RUN go test ./... \
    && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build \
    -trimpath -ldflags="-s -w" -o /petlibro-camera-bridge ./cmd/petlibro-camera-bridge

# build 2026.08.1
FROM ghcr.io/home-assistant/base-python:latest

RUN apk add --no-cache ffmpeg

RUN pip3 install --no-cache-dir aiohttp aiomqtt tzdata

COPY app/ /app/
COPY icon.png /app/icon.png
COPY --from=camera-bridge-build /petlibro-camera-bridge /usr/local/bin/petlibro-camera-bridge

COPY run.sh /
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]
