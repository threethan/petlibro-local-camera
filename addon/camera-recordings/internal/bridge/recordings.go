package bridge

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/h264/annexb"
	"github.com/AlexxIT/go2rtc/pkg/mpegts"

	"github.com/aerodomigue/petlibro-camera-bridge/internal/plaf203"
)

func recordingRange(request *http.Request) (int64, int64, error) {
	start, err := strconv.ParseInt(request.URL.Query().Get("start"), 10, 64)
	if err != nil {
		return 0, 0, errors.New("start must be Unix seconds")
	}
	end, err := strconv.ParseInt(request.URL.Query().Get("end"), 10, 64)
	if err != nil {
		return 0, 0, errors.New("end must be Unix seconds")
	}
	if start <= 0 || end < start || end-start > 7*86400 {
		return 0, 0, errors.New("recording range must be positive, ordered, and at most seven days")
	}
	return start, end, nil
}

func (r *Registry) recordingsHandler(w http.ResponseWriter, request *http.Request) {
	start, end, err := recordingRange(request)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 20*time.Second)
	defer cancel()
	session, release, err := r.acquireTalkSession(ctx, request.PathValue("device_id"))
	if err != nil {
		recordingHTTPError(w, err)
		return
	}
	defer release()
	recordings, err := session.ListRecordings(ctx, start, end)
	if err != nil {
		recordingHTTPError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"recordings": recordings, "complete": true, "start": start, "end": end})
}

func recordingHTTPError(w http.ResponseWriter, err error) {
	log.Printf("SD RECORDING REQUEST FAILED: %v", err)
	status, message := http.StatusBadGateway, "SD card recording request failed"
	switch {
	case errors.Is(err, ErrDeviceNotFound):
		status, message = http.StatusNotFound, "device is not registered"
	case errors.Is(err, plaf203.ErrRecordingsBusy):
		status, message = http.StatusConflict, err.Error()
	case errors.Is(err, plaf203.ErrRecordingNotFound):
		status, message = http.StatusNotFound, err.Error()
	case errors.Is(err, plaf203.ErrRecordingOffset):
		status, message = http.StatusBadRequest, err.Error()
	case errors.Is(err, context.DeadlineExceeded):
		status, message = http.StatusGatewayTimeout, "device did not answer the SD card recording request"
	case errors.Is(err, context.Canceled):
		status, message = 499, "recording request canceled"
	case errors.Is(err, plaf203.ErrRecordingsClosed):
		status, message = http.StatusServiceUnavailable, "camera session closed"
	case errors.Is(err, plaf203.ErrRecordingsProtocol):
		message = "device returned an invalid or incomplete SD card recording list"
	}
	writeError(w, status, message)
}

func (r *Registry) recordingDeleteHandler(w http.ResponseWriter, request *http.Request) {
	start, err := strconv.ParseInt(request.PathValue("start"), 10, 64)
	if err != nil || start <= 0 || start > 0x7fffffff {
		writeError(w, http.StatusBadRequest, "invalid recording start")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 25*time.Second)
	defer cancel()
	session, release, err := r.acquireTalkSession(ctx, request.PathValue("device_id"))
	if err != nil {
		recordingHTTPError(w, err)
		return
	}
	defer release()
	if err = session.DeleteRecording(ctx, start); err != nil {
		recordingHTTPError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"deleted": start})
}

func (r *Registry) recordingStreamHandler(w http.ResponseWriter, request *http.Request) {
	format := request.URL.Query().Get("format")
	if format != "" && format != "h264" && format != "mpegts" {
		writeError(w, http.StatusBadRequest, "format must be h264 or mpegts")
		return
	}
	start, err := strconv.ParseInt(request.URL.Query().Get("start"), 10, 64)
	if err != nil || start <= 0 {
		writeError(w, http.StatusBadRequest, "start must be positive Unix seconds")
		return
	}
	var offset uint64
	if value := request.URL.Query().Get("offset"); value != "" {
		offset, err = strconv.ParseUint(value, 10, 32)
		if err != nil {
			writeError(w, http.StatusBadRequest, "offset must be nonnegative seconds")
			return
		}
	}
	setupCtx, cancel := context.WithTimeout(request.Context(), 15*time.Second)
	session, release, err := r.acquireTalkSession(setupCtx, request.PathValue("device_id"))
	cancel()
	if err != nil {
		recordingHTTPError(w, err)
		return
	}
	defer release()
	playback, err := session.StartRecording(request.Context(), start, uint32(offset))
	if err != nil {
		recordingHTTPError(w, err)
		return
	}
	defer playback.Stop()
	var initialFrames []*plaf203.VideoFrame
	var firstAudio *plaf203.AudioFrame
	if format == "mpegts" {
		initialFrames, firstAudio, err = recordingInitialMedia(request.Context(), playback)
		if err != nil {
			recordingHTTPError(w, err)
			return
		}
	}
	w.Header().Set("Content-Type", "video/h264")
	var muxer *mpegts.Muxer
	var pid uint16
	var audioPID uint16
	if format == "mpegts" {
		w.Header().Set("Content-Type", "video/mp2t")
		muxer = mpegts.NewMuxer()
		pid = muxer.AddTrack(mpegts.StreamTypeH264)
		if firstAudio != nil {
			audioPID = muxer.AddTrack(mpegts.StreamTypeAAC)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	controller := http.NewResponseController(w)
	if muxer != nil {
		if _, err = w.Write(muxer.GetHeader()); err != nil {
			return
		}
	}
	writeData := func(data []byte) error {
		// A stalled downstream client must release its SD playback channel.
		_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, writeErr := w.Write(data); writeErr != nil {
			return writeErr
		}
		return controller.Flush()
	}
	writeFrame := func(frame *plaf203.VideoFrame) error {
		data := frame.Data
		if muxer != nil {
			data = recordingAVTSPayload(muxer, pid, frame.Timestamp, playback.StartTimestamp, annexb.EncodeToAVCC(data))
		}
		return writeData(data)
	}
	writeAudio := func(frame *plaf203.AudioFrame) error {
		if muxer == nil || firstAudio == nil || frame.Timestamp < playback.StartTimestamp {
			return nil // The raw H.264 diagnostic endpoint remains video only.
		}
		return writeData(recordingAVTSPayload(muxer, audioPID, frame.Timestamp, playback.StartTimestamp, frame.Data))
	}
	for _, frame := range initialFrames {
		if writeFrame(frame) != nil {
			return
		}
	}
	if firstAudio != nil && writeAudio(firstAudio) != nil {
		return
	}
	for {
		select {
		case <-request.Context().Done():
			return
		case <-playback.Done:
			if playback.Err() != nil {
				// Abort the chunked transfer so the relay can distinguish a lost
				// device stream from the recording's normal end.
				panic(http.ErrAbortHandler)
			}
			// EOF can follow the last frame immediately; flush queued frames.
			for {
				select {
				case frame := <-playback.Frames:
					if writeFrame(frame) != nil {
						return
					}
				case frame := <-playback.Audio:
					if writeAudio(frame) != nil {
						return
					}
				default:
					return
				}
			}
		case frame := <-playback.Frames:
			if writeFrame(frame) != nil {
				return
			}
		case frame := <-playback.Audio:
			if writeAudio(frame) != nil {
				return
			}
		}
	}
}

func recordingInitialMedia(ctx context.Context, playback *plaf203.RecordingPlayback) ([]*plaf203.VideoFrame, *plaf203.AudioFrame, error) {
	// Do not advertise an empty AAC track: ffmpeg cannot initialize its audio
	// encoder when an older/silent clip contains no audio codec parameters.
	// Drain video while probing so a video-only clip cannot overflow its queue.
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	var frames []*plaf203.VideoFrame
	for {
		select {
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case frame := <-playback.Frames:
			frames = append(frames, frame)
			if len(frames) >= 128 {
				return frames, nil, nil
			}
		case frame := <-playback.Audio:
			return frames, frame, nil
		case <-playback.Done:
			select {
			case frame := <-playback.Audio:
				return frames, frame, playback.Err()
			default:
				return frames, nil, playback.Err()
			}
		case <-timer.C:
			return frames, nil, nil
		}
	}
}

func recordingAVTSPayload(muxer *mpegts.Muxer, pid uint16, timestamp, origin uint64, data []byte) []byte {
	packet := muxer.GetPayload(pid, uint32(timestamp*90+90000), data)
	// go2rtc independently rebases every track to its first packet. Use one
	// origin for both tracks so delayed audio and seeks keep device A/V timing.
	// The muxer puts the PES header in the first TS packet, after adaptation.
	start := 4
	if packet[3]&0x20 != 0 {
		start += 1 + int(packet[4])
	}
	mpegts.WriteTime(packet[start+9:], timestampPTS(timestamp, origin))
	return packet
}

func timestampPTS(timestamp, origin uint64) uint32 {
	if timestamp < origin {
		return 0
	}
	return uint32((timestamp - origin) * 90)
}
