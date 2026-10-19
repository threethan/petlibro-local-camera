package plaf203

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/tutk"
)

func TestRecordingDeleteMatchesAPKBytes(t *testing.T) {
	data, err := encodeRecordingDelete(1792109989)
	if err != nil {
		t.Fatal(err)
	}
	want := make([]byte, 24)
	want[0], want[5], want[6] = 1, 1, 1
	binary.LittleEndian.PutUint32(want[8:], 1792109989)
	if string(data) != string(want) {
		t.Fatalf("delete bytes=%x want=%x", data, want)
	}
	for _, start := range []int64{-1, 0, 0x80000000} {
		if _, err := encodeRecordingDelete(start); err == nil {
			t.Fatal("invalid timestamp accepted")
		}
	}
}

func TestRecordingDeleteRequiresMatchingSuccessAcknowledgement(t *testing.T) {
	for _, success := range []bool{true, false} {
		t.Run(map[bool]string{true: "confirmed", false: "rejected"}[success], func(t *testing.T) {
			s, transport := recordingTestSession()
			record := Recording{Start: 1792109989, Duration: 31}
			deletes := 0
			transport.onSend = func(wire []byte, _ *net.UDPAddr) {
				packet := tutk.ReverseTransCodeBlob(wire)
				if len(packet) < 68 {
					return
				}
				switch binary.LittleEndian.Uint32(packet[64:]) {
				case controlListRecordings:
					go s.handleRecordingControl(recordingTestReply(controlListRecordingsReply, recordingTestPage(0, true, 1, record)))
				case controlDeleteRecording:
					deletes++
					go func() {
						wrong := make([]byte, 8)
						binary.LittleEndian.PutUint32(wrong, 1)
						binary.LittleEndian.PutUint32(wrong[4:], uint32(record.Start-1))
						s.handleRecordingControl(recordingTestReply(controlDeleteRecordingReply, wrong))
						ack := make([]byte, 8)
						if success {
							binary.LittleEndian.PutUint32(ack, 1)
						}
						binary.LittleEndian.PutUint32(ack[4:], uint32(record.Start))
						s.handleRecordingControl(recordingTestReply(controlDeleteRecordingReply, ack))
					}()
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err := s.DeleteRecording(ctx, record.Start)
			if success && err != nil {
				t.Fatal(err)
			}
			if !success && err == nil {
				t.Fatal("unconfirmed deletion succeeded")
			}
			if deletes != 1 || s.recordings.deletion != nil {
				t.Fatal("invalid command count or ownership leaked")
			}
		})
	}
}

func TestRecordingDeleteMissingClipSendsNoDelete(t *testing.T) {
	s, transport := recordingTestSession()
	deletes := 0
	transport.onSend = func(wire []byte, _ *net.UDPAddr) {
		p := tutk.ReverseTransCodeBlob(wire)
		if len(p) < 68 {
			return
		}
		switch binary.LittleEndian.Uint32(p[64:]) {
		case controlListRecordings:
			go s.handleRecordingControl(recordingTestReply(controlListRecordingsReply, recordingTestPage(0, true, 0)))
		case controlDeleteRecording:
			deletes++
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := s.DeleteRecording(ctx, 1792109989); !errors.Is(err, ErrRecordingNotFound) {
		t.Fatal(err)
	}
	if deletes != 0 {
		t.Fatal("missing recording triggered delete")
	}
}
