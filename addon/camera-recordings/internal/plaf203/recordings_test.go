package plaf203

import (
	"context"
	"encoding/binary"
	"errors"
	"testing"
	"time"
)

func TestRecordingListAPKLayout(t *testing.T) {
	start := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC).Unix()
	data, err := encodeRecordingList(start, start+86399)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{0, 0, 0, 0, 0xea, 7, 10, 16, 5, 0, 0, 0, 0xea, 7, 10, 16, 5, 23, 59, 59, 0, 0, 0, 0}
	if string(data) != string(want) {
		t.Fatalf("got %x want %x", data, want)
	}
}

func recordingTestPage(index byte, end bool, total uint32, items ...Recording) []byte {
	data := make([]byte, 12+len(items)*12)
	binary.LittleEndian.PutUint32(data[4:8], total)
	data[8], data[10] = index, byte(len(items))
	if end {
		data[9] = 1
	}
	for n, item := range items {
		p := data[12+n*12 : 24+n*12]
		_ = encodeRecordingTime(p, item.Start)
		p[8], p[9] = item.Event, item.Status
		binary.LittleEndian.PutUint16(p[10:], item.Duration)
	}
	return data
}

func TestRecordingPageValidation(t *testing.T) {
	item := Recording{Start: 1792108800, Duration: 300, Event: 18, Status: 1}
	data := recordingTestPage(0, true, 1, item)
	page, err := decodeRecordingPage(data)
	if err != nil || len(page.recordings) != 1 || page.recordings[0] != item || !page.end {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	for _, mutate := range []func([]byte) []byte{
		func(p []byte) []byte { return p[:len(p)-1] },
		func(p []byte) []byte { p[9] = 2; return p },
		func(p []byte) []byte { p[16] = 99; p[15] = 31; p[14] = 2; return p },
		func(p []byte) []byte { p[4] = 0; return p },
		func(p []byte) []byte { p[0] = 1; return p },
	} {
		if _, err := decodeRecordingPage(mutate(append([]byte(nil), data...))); !errors.Is(err, ErrRecordingsProtocol) {
			t.Fatalf("expected protocol error, got %v", err)
		}
	}
}

func TestRecordingSessionClosedBusyAndCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Session{}).ListRecordings(ctx, 1792108800, 1792195199); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	s := &Session{recordings: recordingState{closed: true}}
	if _, err := s.ListRecordings(context.Background(), 1792108800, 1792195199); !errors.Is(err, ErrRecordingsClosed) {
		t.Fatal(err)
	}
	s.recordings.closed = false
	s.recordings.list = make(chan recordingMessage, 1)
	if _, err := s.ListRecordings(context.Background(), 1792108800, 1792195199); !errors.Is(err, ErrRecordingsBusy) {
		t.Fatal(err)
	}
	s.closeRecordings()
	if msg := <-s.recordings.list; !errors.Is(msg.err, ErrRecordingsClosed) {
		t.Fatal(msg.err)
	}
}

func TestRecordingTimeRejectsImpossibleDate(t *testing.T) {
	data := []byte{0xea, 7, 2, 30, 1, 0, 0, 0}
	if _, err := decodeRecordingTime(data); !errors.Is(err, ErrRecordingsProtocol) {
		t.Fatal(err)
	}
}
