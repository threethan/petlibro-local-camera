package plaf203

import (
	"context"
	"encoding/binary"
	"errors"

	"github.com/AlexxIT/go2rtc/pkg/tutk"
)

var ErrTalkbackBusy = errors.New("another microphone is already using the speaker")

const (
	talkbackSessionMagicVersion = 0x1D
	talkbackSessionFlags        = 0x0B
)

type talkbackState struct {
	connected    bool
	frame        uint32
}

// StartTalkback enables the speaker on the current Session16 stream. The
// official client sends microphone media back on channel 0x0103; this firmware
// does not open a separate reverse AV session.
func (s *Session) StartTalkback(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.talkMu.Lock()
	if s.talkClosed {
		s.talkMu.Unlock()
		return errors.New("camera session is closed")
	}
	if s.talk != nil {
		s.talkMu.Unlock()
		return ErrTalkbackBusy
	}
	talk := &talkbackState{}
	s.talk = talk
	err := s.sendTalkControl(0x0350)
	if err != nil {
		s.talk = nil
		s.talkMu.Unlock()
		return err
	}
	talk.connected = true
	s.talkMu.Unlock()
	return nil
}

func (s *Session) StopTalkback() error {
	s.talkMu.Lock()
	defer s.talkMu.Unlock()
	if s.talk == nil {
		return nil
	}
	s.talk = nil
	return s.sendTalkControl(0x0351)
}

// Talkback uses the V3.0.30 client envelope seen in the official capture.
// Video and inbound media retain the bridge's established transport path.
func (s *Session) sendTalkControl(control uint32) error {
	payload := make([]byte, 12)
	binary.LittleEndian.PutUint32(payload, control)
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	if s.controlIndex < 3 {
		s.controlIndex = 3
	}
	index := s.controlIndex
	s.controlIndex++
	body := encodeControlData(s.session25.nextOutboundCommand(), controlChannelSystem, index, payload)
	return s.sendTalkbackBodyLocked(body)
}

func (s *Session) closeTalkback() {
	s.talkMu.Lock()
	s.talkClosed = true
	s.talkMu.Unlock()
	_ = s.StopTalkback()
}

// WriteTalkback sends exactly one 44.1 kHz mono AAC-LC ADTS access unit.
// Limiting each frame to one datagram keeps latency and buffering bounded.
func (s *Session) WriteTalkback(frame []byte) error {
	if err := validateTalkbackADTS(frame); err != nil {
		return err
	}
	s.talkMu.Lock()
	defer s.talkMu.Unlock()
	t := s.talk
	if t == nil || !t.connected {
		return errors.New("speaker is not connected")
	}
	body := make([]byte, 36+len(frame)+16)
	copy(body, "\x0c\x01\x0c\x00")
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	binary.LittleEndian.PutUint32(body[4:], uint32(s.session25.nextOutboundCommand()))
	binary.LittleEndian.PutUint32(body[8:], 0x14000000+(t.frame<<16))
	binary.LittleEndian.PutUint32(body[12:], 1)
	binary.LittleEndian.PutUint16(body[16:], 0x0103)
	binary.LittleEndian.PutUint16(body[18:], uint16(t.frame))
	body[20] = 1
	binary.LittleEndian.PutUint16(body[22:], 0x0010)
	binary.LittleEndian.PutUint16(body[24:], uint16(len(frame)+16))
	stamp := uint32(s.clock().UnixMilli())
	binary.LittleEndian.PutUint16(body[26:], uint16(stamp))
	binary.LittleEndian.PutUint32(body[28:], t.frame)
	binary.LittleEndian.PutUint32(body[32:], t.frame+1)
	copy(body[36:], frame)
	info := body[36+len(frame):]
	info[0], info[2] = 0x87, 0x1e
	binary.LittleEndian.PutUint32(info[12:], stamp)
	t.frame++
	return s.sendTalkbackBodyLocked(body)
}

// sendTalkbackBodyLocked is called with sendMu held. The official Android
// client marks only speaker traffic as 0x1d/0x0b and uses blob encryption.
func (s *Session) sendTalkbackBodyLocked(body []byte) error {
	sequence := s.sequence
	s.sequence++
	packet := make([]byte, sessionHeaderLength+len(body))
	packet[0], packet[1] = 0x04, 0x02
	packet[2], packet[3] = talkbackSessionMagicVersion, talkbackSessionFlags
	binary.LittleEndian.PutUint16(packet[4:], uint16(len(packet)-16))
	binary.LittleEndian.PutUint16(packet[6:], sequence)
	binary.LittleEndian.PutUint16(packet[8:], clientSessionOpcode)
	binary.LittleEndian.PutUint16(packet[10:], clientSessionSubtype)
	copy(packet[12:28], sessionID16(s.ID))
	copy(packet[sessionHeaderLength:], body)
	return s.transport.SendTo(tutk.TransCodeBlob(packet), s.Address)
}

func validateTalkbackADTS(frame []byte) error {
	if len(frame) < 7 || len(frame) > 1024 || frame[0] != 0xff || frame[1]&0xf7 != 0xf1 || frame[2]>>6 != 1 || (frame[2]>>2)&15 != 4 || ((frame[2]&1)<<2)|(frame[3]>>6) != 1 || frame[6]&3 != 0 {
		return errors.New("expected one AAC-LC ADTS frame at 44100 Hz mono")
	}
	n := int(frame[3]&3)<<11 | int(frame[4])<<3 | int(frame[5]>>5)
	if n != len(frame) {
		return errors.New("invalid AAC frame length")
	}
	return nil
}
