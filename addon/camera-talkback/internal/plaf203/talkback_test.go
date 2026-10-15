package plaf203

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/tutk"
)

func speakerTestSession() (*Session, *fakeTransport) {
	transport := &fakeTransport{}
	return &Session{ID: [8]byte{1, 2, 3, 4, 5, 6, 7, 8}, Address: &net.UDPAddr{IP: net.ParseIP("192.0.2.5"), Port: 40000}, transport: transport, clock: time.Now, controlIndex: 3, session25: newSession25State()}, transport
}

func TestTalkbackUsesOfficialSession16CommandAndAudioFraming(t *testing.T) {
	s, transport := speakerTestSession()
	if err := s.StartTalkback(context.Background()); err != nil {
		t.Fatalf("error=%v", err)
	}
	transport.mu.Lock()
	packets := append([][]byte(nil), transport.sent...)
	transport.mu.Unlock()
	if len(packets) != 1 {
		t.Fatalf("START packet count=%d want=1", len(packets))
	}
	start := tutk.ReverseTransCodeBlob(packets[0])
	if start[2] != talkbackSessionMagicVersion || start[3] != talkbackSessionFlags || binary.LittleEndian.Uint32(start[64:]) != 0x0350 || string(start[68:76]) != string(make([]byte, 8)) {
		t.Fatalf("invalid SPEAKERSTART packet %x", start[28:])
	}
	if err := s.WriteTalkback(testAACADTSFrame()); err != nil {
		t.Fatal(err)
	}
	transport.mu.Lock()
	packets = append([][]byte(nil), transport.sent...)
	transport.mu.Unlock()
	if len(packets) != 2 {
		t.Fatalf("START + audio packet count=%d want=2", len(packets))
	}
	audio := tutk.ReverseTransCodeBlob(packets[1])
	if audio[2] != talkbackSessionMagicVersion || audio[3] != talkbackSessionFlags || binary.LittleEndian.Uint16(audio[44:46]) != 0x0103 || binary.LittleEndian.Uint16(audio[50:52]) != 0x0010 || binary.LittleEndian.Uint16(audio[54:56]) != uint16(binary.LittleEndian.Uint32(audio[len(audio)-4:])) || !bytes.Equal(audio[64:64+len(testAACADTSFrame())], testAACADTSFrame()) || audio[len(audio)-16] != 0x87 || audio[len(audio)-14] != 0x1e {
		t.Fatalf("invalid Session16 AAC packet header=%x", audio[28:64])
	}
	if !errors.Is(s.StartTalkback(context.Background()), ErrTalkbackBusy) {
		t.Fatal("second owner accepted")
	}
	if err := s.StopTalkback(); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteTalkback(testAACADTSFrame()); err == nil {
		t.Fatal("audio accepted after stop")
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	if len(transport.sent) != 3 {
		t.Fatalf("audio after stop or repeated stop changed packet count: %d", len(transport.sent))
	}
	stop := tutk.ReverseTransCodeBlob(transport.sent[2])
	if binary.LittleEndian.Uint32(stop[64:]) != 0x0351 || string(stop[68:76]) != string(make([]byte, 8)) {
		t.Fatal("invalid SPEAKERSTOP packet")
	}
	if err := s.StopTalkback(); err != nil {
		t.Fatal(err)
	}
}

func TestTalkbackRejectsWrongAACFormat(t *testing.T) {
	good := testAACADTSFrame()
	if validateTalkbackADTS(good) != nil {
		t.Fatal("valid AAC rejected")
	}
	for _, index := range []int{0, 1, 2, 3, 5, 6} {
		bad := append([]byte(nil), good...)
		bad[index] ^= 0xff
		if validateTalkbackADTS(bad) == nil {
			t.Fatalf("corrupted field %d accepted", index)
		}
	}
}

func TestTalkbackSharesRuntimeControlIndexesWithCameraAudio(t *testing.T) {
	s, transport := speakerTestSession()
	if err := s.StartAudio(); err != nil { t.Fatal(err) }
	if err := s.StartTalkback(context.Background()); err != nil { t.Fatal(err) }
	if err := s.StopTalkback(); err != nil { t.Fatal(err) }
	if err := s.StopAudio(); err != nil { t.Fatal(err) }
	if len(transport.sent) != 4 { t.Fatalf("controls sent=%d want=4", len(transport.sent)) }
	for i, wire := range transport.sent {
		packet := tutk.ReverseTransCodeBlob(wire)
		if index := binary.LittleEndian.Uint32(packet[56:60]); index != uint32(i+3) {
			t.Fatalf("control %d index=%d want=%d", i, index, i+3)
		}
	}
}
