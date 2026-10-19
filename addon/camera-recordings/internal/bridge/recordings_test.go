package bridge

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/AlexxIT/go2rtc/pkg/h264/annexb"
	"github.com/AlexxIT/go2rtc/pkg/mpegts"

	"github.com/aerodomigue/petlibro-camera-bridge/internal/plaf203"
)

func TestRecordingsRange(t *testing.T) {
	for _, query := range []string{"", "start=1", "start=1&end=0", "start=1&end=99999999", "start=abc&end=2"} {
		if _, _, err := recordingRange(httptest.NewRequest("GET", "/?"+query, nil)); err == nil {
			t.Fatal(query)
		}
	}
	if start, end, err := recordingRange(httptest.NewRequest("GET", "/?start=1792108800&end=1792195199", nil)); err != nil || end-start != 86399 {
		t.Fatalf("%d %d %v", start, end, err)
	}
}

func TestRecordingMPEGTSPreservesDeviceCadence(t *testing.T) {
	muxer := mpegts.NewMuxer()
	pid := muxer.AddTrack(mpegts.StreamTypeH264)
	stream := append([]byte(nil), muxer.GetHeader()...)
	for _, stamp := range []uint64{0, 67, 133, 200} {
		stream = append(stream, recordingAVTSPayload(muxer, pid, stamp, 0, annexb.EncodeToAVCC([]byte{0, 0, 0, 1, 0x65, 0x88}))...)
	}
	demuxer := mpegts.NewDemuxer()
	reader := bytes.NewReader(stream)
	if _, err := demuxer.ReadPacket(reader); err != nil {
		t.Fatal(err)
	} // Track header.
	for _, want := range []uint32{0, 6030, 11970} {
		frame, err := demuxer.ReadPacket(reader)
		if err != nil {
			t.Fatal(err)
		}
		if frame.Timestamp != want {
			t.Fatalf("got timestamp%d want%d; original15fps cadence was lost", frame.Timestamp, want)
		}
	}
}

func TestRecordingMPEGTSAudioUsesVideoOrigin(t *testing.T) {
	muxer := mpegts.NewMuxer()
	videoPID := muxer.AddTrack(mpegts.StreamTypeH264)
	audioPID := muxer.AddTrack(mpegts.StreamTypeAAC)
	for _, tc := range []struct {
		pid   uint16
		stamp uint64
		data  []byte
	}{
		{videoPID, 10000, annexb.EncodeToAVCC([]byte{0, 0, 0, 1, 0x65, 0x88})},
		{audioPID, 10023, []byte{0xff, 0xf1, 0x50, 0x40, 0x01, 0x5f, 0xfc, 1, 2, 3}},
		{videoPID, 10067, annexb.EncodeToAVCC([]byte{0, 0, 0, 1, 0x61, 0x88})},
		{audioPID, 10046, bytes.Repeat([]byte{0x55}, 300)},
	} {
		packet := recordingAVTSPayload(muxer, tc.pid, tc.stamp, 10000, tc.data)
		start := 4
		if packet[3]&0x20 != 0 {
			start += 1 + int(packet[4])
		}
		want := make([]byte, 5)
		mpegts.WriteTime(want, uint32((tc.stamp-10000)*90))
		if !bytes.Equal(packet[start+9:start+14], want) {
			t.Fatalf("PID %d lost A/V offset at %d", tc.pid, tc.stamp)
		}
	}
}

func TestRecordingInitialMediaDetectsAudioAndVideoOnlyEOF(t *testing.T) {
	for _, withAudio := range []bool{false, true} {
		frames := make(chan *plaf203.VideoFrame, 1)
		frames <- &plaf203.VideoFrame{Timestamp: 10000}
		audio := make(chan *plaf203.AudioFrame, 1)
		if withAudio {
			audio <- &plaf203.AudioFrame{Timestamp: 10023}
		}
		done := make(chan struct{})
		close(done)
		playback := &plaf203.RecordingPlayback{Frames: frames, Audio: audio, Done: done, Err: func() error { return nil }}
		buffered, firstAudio, err := recordingInitialMedia(context.Background(), playback)
		if err != nil || (firstAudio != nil) != withAudio {
			t.Fatalf("audio=%v first=%v err=%v", withAudio, firstAudio, err)
		}
		// Startup must retain every video frame, including immediate EOF.
		if len(buffered)+len(frames) != 1 {
			t.Fatal("startup discarded video")
		}
	}
}

func TestRecordingHTTPError(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
	}{
		{ErrDeviceNotFound, 404}, {plaf203.ErrRecordingsBusy, 409},
		{context.DeadlineExceeded, 504}, {plaf203.ErrRecordingsProtocol, 502},
		{plaf203.ErrRecordingsClosed, 503}, {errors.New("unavailable"), 502},
	} {
		w := httptest.NewRecorder()
		recordingHTTPError(w, tc.err)
		if w.Code != tc.status {
			t.Fatalf("%v: %d", tc.err, w.Code)
		}
	}
}

func TestRecordingsRouteValidation(t *testing.T) {
	handler := NewHandler(NewRegistry())
	for _, tc := range []struct {
		url    string
		status int
	}{
		{"/devices/unknown/recordings", http.StatusBadRequest},
		{"/devices/unknown/recordings?start=1792108800&end=1792195199", http.StatusNotFound},
	} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", tc.url, nil))
		if w.Code != tc.status {
			t.Fatalf("%s: %d", tc.url, w.Code)
		}
	}
}
