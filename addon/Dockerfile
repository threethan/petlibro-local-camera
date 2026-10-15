FROM ghcr.io/alexxit/go2rtc:1.9.14 AS go2rtc

FROM --platform=$BUILDPLATFORM ghcr.io/home-assistant/base-python:latest AS camera-bridge-build

ARG TARGETOS
ARG TARGETARCH
ARG CAMERA_BRIDGE_REV=6136304ea023d2d32742d2432bc5ca07bc738430

RUN apk add --no-cache git go
RUN git init /src \
	&& git -C /src remote add origin https://github.com/aerodomigue/petlibro_granary_local_relay.git \
	&& git -C /src fetch --depth 1 origin ${CAMERA_BRIDGE_REV} \
	&& git -C /src checkout --detach FETCH_HEAD
COPY camera-bridge-sps-pps.patch /tmp/camera-bridge-sps-pps.patch
RUN git -C /src apply --check /tmp/camera-bridge-sps-pps.patch \
	&& git -C /src apply /tmp/camera-bridge-sps-pps.patch
WORKDIR /src/camera-bridge
COPY camera-bridge-talkback.patch /tmp/camera-bridge-talkback.patch
RUN git -C /src apply --check /tmp/camera-bridge-talkback.patch \
	&& git -C /src apply /tmp/camera-bridge-talkback.patch
COPY camera-talkback/ /src/camera-bridge/
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
COPY --from=go2rtc /usr/local/bin/go2rtc /usr/local/bin/go2rtc

COPY run.sh /
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]
