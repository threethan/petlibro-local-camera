package bridge

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTalkbackReadsAccessUnitsAcrossArbitraryChunks(t *testing.T) {
	frame := []byte{0xff, 0xf1, 0x50, 0x40, 0x01, 0x5f, 0xfc, 0x11, 0x22, 0x33}
	r := io.MultiReader(bytes.NewReader(frame[:2]), bytes.NewReader(frame[2:8]), bytes.NewReader(frame[8:]), bytes.NewReader(frame))
	for i := 0; i < 2; i++ {
		got, err := readTalkbackFrame(r)
		if err != nil || !bytes.Equal(got, frame) {
			t.Fatalf("frame=%x error=%v", got, err)
		}
	}
	if _, err := readTalkbackFrame(r); err != io.EOF {
		t.Fatalf("EOF=%v", err)
	}
	if _, err := readTalkbackFrame(bytes.NewReader(frame[:8])); err == nil {
		t.Fatal("truncated frame accepted")
	}
}

func TestTalkbackRejectsNonAudioRequestBeforeConnecting(t *testing.T) {
	r := NewRegistryWithConnector(nil)
	req := httptest.NewRequest(http.MethodPost, "/devices/test/talkback", nil)
	w := httptest.NewRecorder()
	NewHandler(r).ServeHTTP(w, req)
	if w.Code != 415 {
		t.Fatalf("status=%d", w.Code)
	}
}
