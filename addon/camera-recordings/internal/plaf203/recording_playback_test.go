package plaf203

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/tutk"
)

func recordingTestSession() (*Session, *fakeTransport) {
	t := &fakeTransport{}
	s := &Session{ID: [8]byte{1, 2, 3, 4, 5, 6, 7, 8}, Address: &net.UDPAddr{IP: net.IPv4(192, 0, 2, 5), Port: 40000}, transport: t, clock: time.Now, controlIndex: 3, session25: newSession25State(), media: NewMediaReceiver()}
	return s, t
}

func recordingTestReply(command uint32, data []byte) []byte {
	payload := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(payload, command)
	copy(payload[4:], data)
	return encodeControlData(0, controlChannelSystem, 0, payload)
}

func TestRecordingListCollectsOutOfOrderPages(t *testing.T) {
	s, transport := recordingTestSession()
	first := Recording{Start: 1792108800, Duration: 50, Event: 1}
	second := Recording{Start: 1792108900, Duration: 60, Event: 48}
	transport.onSend = func(wire []byte, _ *net.UDPAddr) {
		p := tutk.ReverseTransCodeBlob(wire)
		if len(p) > 68 && binary.LittleEndian.Uint32(p[64:]) == controlListRecordings {
			go func() {
				s.handleRecordingControl(recordingTestReply(controlListRecordingsReply, recordingTestPage(1, true, 2, second)))
				s.handleRecordingControl(recordingTestReply(controlListRecordingsReply, recordingTestPage(0, false, 2, first)))
			}()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	items, err := s.ListRecordings(ctx, first.Start, second.Start)
	if err != nil || len(items) != 2 || items[0] != first || items[1] != second {
		t.Fatalf("items=%+v err=%v", items, err)
	}
	if s.recordings.list != nil {
		t.Fatal("list ownership leaked")
	}
}

func TestRecordingListMissingPageTimesOut(t *testing.T) {
	s, transport := recordingTestSession()
	transport.onSend = func(_ []byte, _ *net.UDPAddr) {
		go func() {
			s.handleRecordingControl(recordingTestReply(controlListRecordingsReply, recordingTestPage(1, true, 2, Recording{Start: 1792108800, Duration: 2})))
		}()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err := s.ListRecordings(ctx, 1792108800, 1792108900)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if s.recordings.list != nil {
		t.Fatal("list ownership leaked")
	}
}

func TestRecordingListAcceptsOneBasedPages(t *testing.T) {
	s, transport := recordingTestSession()
	item := Recording{Start: 1792108800, Duration: 60}
	transport.onSend = func(_ []byte, _ *net.UDPAddr) {
		go func() {
			s.handleRecordingControl(recordingTestReply(controlListRecordingsReply, recordingTestPage(1, true, 1, item)))
		}()
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	items, err := s.ListRecordings(ctx, item.Start, item.Start+60)
	if err != nil || len(items) != 1 || items[0] != item {
		t.Fatalf("%+v %v", items, err)
	}
}

func TestRecordingSetupFailureStopsAllocatedDevicePlayback(t *testing.T) {
	for _, channel := range []uint32{2, 32} {
		t.Run(string(rune('A'+channel)), func(t *testing.T) {
			s, transport := recordingTestSession()
			record := Recording{Start: 1792108800, Duration: 60}
			var stops atomic.Int32
			transport.onSend = func(wire []byte, _ *net.UDPAddr) {
				p := tutk.ReverseTransCodeBlob(wire)
				if len(p) < 68 || p[28] != 0x0c {
					return
				}
				switch binary.LittleEndian.Uint32(p[64:]) {
				case controlListRecordings:
					go s.handleRecordingControl(recordingTestReply(controlListRecordingsReply, recordingTestPage(0, true, 1, record)))
				case controlRecordingPlayback:
					if binary.LittleEndian.Uint32(p[72:]) == 1 {
						stops.Add(1)
						return
					}
					data := make([]byte, 12)
					binary.LittleEndian.PutUint32(data, 16)
					binary.LittleEndian.PutUint32(data[4:], channel)
					go s.handleRecordingControl(recordingTestReply(controlRecordingPlaybackReply, data))
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
			defer cancel()
			_, err := s.StartRecording(ctx, record.Start, 0)
			if channel == 2 && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("expected login timeout, got%v", err)
			}
			if channel == 32 && !errors.Is(err, ErrRecordingsProtocol) {
				t.Fatalf("expected unsupported channel, got%v", err)
			}
			if stops.Load() != 1 || s.recordings.play != nil || s.recordings.secondary != nil || transport.CloseCount() != 0 {
				t.Fatal("failed startup leaked playback or closed live session")
			}
		})
	}
}

func TestRecordingPlaybackUsesSecondaryChannelAndStopsIt(t *testing.T) {
	s, transport := recordingTestSession()
	record := Recording{Start: 1792108800, Duration: 60, Event: 48}
	var primaryStop, secondaryStop, audioStart, audioStop atomic.Int32
	loginAttempts := 0
	var initialLogin []byte
	transport.onSend = func(wire []byte, peer *net.UDPAddr) {
		decoded := tutk.ReverseTransCodeBlob(wire)
		if len(decoded) == loginRequestLength && decoded[14] == 2 {
			loginAttempts++
			if loginAttempts == 1 {
				initialLogin = append([]byte(nil), wire...)
			}
			if loginAttempts <= 2 {
				return // The allocated AV server is not ready for the first pair.
			}
			if loginAttempts == 3 && string(wire) != string(initialLogin) {
				t.Error("login retry changed its sequence, timestamp or payload")
			}
			if decoded[2] != 0x1c || decoded[3] != 0x0a {
				t.Error("secondary login must use the feeder's playback envelope")
			}
			response := testLoginSuccess(s.ID)
			response[3] = 0x0b
			response[14] = 2
			s.handleRecordingPacket(response, peer)
			return
		}
		if len(decoded) < 68 || decoded[28] != 0x0c {
			return
		}
		command := binary.LittleEndian.Uint32(decoded[64:])
		switch command {
		case controlListRecordings:
			go func() {
				s.handleRecordingControl(recordingTestReply(controlListRecordingsReply, recordingTestPage(0, true, 1, record)))
			}()
		case controlRecordingPlayback:
			operation := binary.LittleEndian.Uint32(decoded[72:])
			if operation == 1 {
				primaryStop.Add(1)
				return
			}
			if operation == 16 {
				if decoded[14] != 0 {
					t.Error("playback prepare left primary channel")
				}
				data := make([]byte, 12)
				binary.LittleEndian.PutUint32(data, 16)
				binary.LittleEndian.PutUint32(data[4:], 2)
				go func() { s.handleRecordingControl(recordingTestReply(controlRecordingPlaybackReply, data)) }()
			}
		case controlStartVideo:
			if decoded[14] != 2 || binary.LittleEndian.Uint32(decoded[68:]) != 2 {
				t.Errorf("wrong playback START: outer=%d argument=%d", decoded[14], binary.LittleEndian.Uint32(decoded[68:]))
			}
			frame := testVideoFragment(s.ID, 0x4000, 1, 0, true, 1, append([]byte{0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x65, 0x88}, testMediaTrailer(1234)...))
			frame[14] = 2
			frame[3] = 0x0b
			if !s.handleRecordingPacket(frame, peer) {
				t.Error("recording frame rejected")
			}
		case controlStartAudio:
			if decoded[14] != 2 || binary.LittleEndian.Uint32(decoded[68:]) != 2 {
				t.Error("audio START must address the secondary playback channel")
			}
			audioStart.Add(1)
			for i, stamp := range []uint32{1200, 1257} {
				frame := testVideoFragment(s.ID, uint16(0xc000+i), 1, 0, true, uint32(i), append(testAACADTSFrame(), testMediaTrailer(stamp)...))
				frame[14] = 2
				frame[sessionHeaderLength+16] = aacChannel
				frame[sessionHeaderLength+17] = 1
				s.handleRecordingPacket(frame, peer)
			}
		case controlStopAudio:
			if decoded[14] != 2 || binary.LittleEndian.Uint32(decoded[68:]) != 2 {
				t.Error("audio STOP must address the secondary playback channel")
			}
			audioStop.Add(1)
		case 0x02ff:
			if decoded[14] == 2 && binary.LittleEndian.Uint32(decoded[68:]) == 2 {
				secondaryStop.Add(1)
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	playback, err := s.StartRecording(ctx, record.Start, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.StartRecording(ctx, record.Start, 0); !errors.Is(err, ErrRecordingsBusy) {
		t.Fatal("second playback accepted", err)
	}
	select {
	case frame := <-playback.Frames:
		if frame.Timestamp != 1234 || !frame.Keyframe {
			t.Fatal(frame)
		}
	case <-ctx.Done():
		t.Fatal("no recording frame")
	}
	endData := make([]byte, 12)
	select {
	case frame := <-playback.Audio:
		if frame.Timestamp != 1257 || string(frame.Data) != string(testAACADTSFrame()) {
			t.Fatal("incorrect historical audio or pre-seek audio leaked", frame)
		}
	case <-ctx.Done():
		t.Fatal("no recording audio")
	}
	binary.LittleEndian.PutUint32(endData, 7)
	endPacket := encodeClientSessionPacket(s.ID, 0, recordingTestReply(controlRecordingPlaybackReply, endData))
	endPacket[2], endPacket[3], endPacket[14] = deviceSessionMagicVersion, sessionFlags, 2
	binary.LittleEndian.PutUint16(endPacket[8:], deviceSessionOpcode)
	binary.LittleEndian.PutUint16(endPacket[10:], deviceLoginSubtype)
	if !s.handleRecordingPacket(endPacket, s.Address) {
		t.Fatal("secondary EOF rejected")
	}
	select {
	case <-playback.Done:
	case <-ctx.Done():
		t.Fatal("secondary EOF did not stop playback")
	}
	if playback.Err() != nil {
		t.Fatal(playback.Err())
	}
	playback.Stop()
	playback.Stop()
	if primaryStop.Load() != 1 || secondaryStop.Load() != 1 {
		t.Fatalf("primary stop=%d secondary stop=%d", primaryStop.Load(), secondaryStop.Load())
	}
	if audioStart.Load() != 1 || audioStop.Load() != 1 {
		t.Fatalf("audio start=%d stop=%d", audioStart.Load(), audioStop.Load())
	}
	if transport.CloseCount() != 0 {
		t.Fatal("playback closed live transport")
	}
	if s.recordings.play != nil || s.recordings.secondary != nil {
		t.Fatal("playback ownership leaked")
	}
}

func TestRecordingSecondaryRejectsWrongPeerAndSession(t *testing.T) {
	s, _ := recordingTestSession()
	s.recordings.secondary = &recordingTransport{parent: s, channel: 2, packets: make(chan recordingDatagram, 1), done: make(chan struct{})}
	packet := testLoginSuccess(s.ID)
	packet[14] = 2
	wrongPeer := cloneUDPAddress(s.Address)
	wrongPeer.Port++
	if s.handleRecordingPacket(packet, wrongPeer) {
		t.Fatal("wrong peer accepted")
	}
	packet[20] ^= 1
	if s.handleRecordingPacket(packet, s.Address) {
		t.Fatal("wrong session accepted")
	}
}

func TestRecordingSeekStartsVideoBeforeProgressAndDiscardsOldFrames(t *testing.T) {
	s, transport := recordingTestSession()
	record := Recording{Start: 1792108800, Duration: 60}
	var started, resumed atomic.Bool
	deliver := func(stamp uint32, seq uint16) {
		frame := testVideoFragment(s.ID, seq, 1, 0, true, uint32(seq), append([]byte{0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x65, 0x88}, testMediaTrailer(stamp)...))
		frame[14] = 2
		s.handleRecordingPacket(frame, s.Address)
	}
	transport.onSend = func(wire []byte, peer *net.UDPAddr) {
		p := tutk.ReverseTransCodeBlob(wire)
		if len(p) == loginRequestLength && p[14] == 2 {
			response := testLoginSuccess(s.ID)
			response[14] = 2
			s.handleRecordingPacket(response, peer)
			return
		}
		if len(p) < 68 || p[28] != 0x0c {
			return
		}
		switch binary.LittleEndian.Uint32(p[64:]) {
		case controlListRecordings:
			go s.handleRecordingControl(recordingTestReply(controlListRecordingsReply, recordingTestPage(0, true, 1, record)))
		case controlRecordingPlayback:
			op := binary.LittleEndian.Uint32(p[72:])
			if op == 16 {
				data := make([]byte, 12)
				binary.LittleEndian.PutUint32(data, 16)
				binary.LittleEndian.PutUint32(data[4:], 2)
				go s.handleRecordingControl(recordingTestReply(controlRecordingPlaybackReply, data))
			}
			if op == 8 {
				resumed.Store(true)
			}
		case controlStartVideo:
			started.Store(true)
			deliver(1234, 0x4000)
		case controlRecordingSeek:
			if !started.Load() || binary.LittleEndian.Uint32(p[80:]) != 10 {
				t.Error("seek did not follow video START with requested offset")
			}
			go func() {
				data := make([]byte, 4)
				binary.LittleEndian.PutUint32(data, 1)
				ack := encodeClientSessionPacket(s.ID, 0, recordingTestReply(controlRecordingSeekReply, data))
				ack[2], ack[3], ack[14] = deviceSessionMagicVersion, 0x0b, 2
				binary.LittleEndian.PutUint16(ack[8:], deviceSessionOpcode)
				binary.LittleEndian.PutUint16(ack[10:], deviceLoginSubtype)
				s.handleRecordingPacket(ack, peer)
				deliver(2000, 0x4001) // A late buffered frame must be ignored.
				deliver(10000, 0x4002)
			}()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	playback, err := s.StartRecording(ctx, record.Start, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer playback.Stop()
	if !resumed.Load() {
		t.Fatal("seek did not resume playback")
	}
	select {
	case frame := <-playback.Frames:
		if frame.Timestamp != 10000 {
			t.Fatalf("published pre-seek frame%d", frame.Timestamp)
		}
	case <-ctx.Done():
		t.Fatal("no seek frame")
	}
}
