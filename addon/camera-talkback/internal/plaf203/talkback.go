package plaf203

import (
	"context"
	"encoding/binary"
	"errors"
)

var ErrTalkbackBusy = errors.New("another microphone is already using the speaker")

type talkbackState struct {
	connected    bool
	frame        uint32
	controlIndex uint32
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
	talk := &talkbackState{controlIndex: 3}
	s.talk = talk
	err := s.sendTalkControl(0x0350, talk.controlIndex)
	talk.controlIndex++
	if err != nil {
		s.talk = nil
		s.talkMu.Unlock()
		return err
	}
	talk.connected = true
	s.talkMu.Unlock()
	return nil
}

func (s *Session) sendTalkControl(control uint32, index uint32) error {
	payload := make([]byte, 12)
	binary.LittleEndian.PutUint32(payload, control)
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	body := encodeControlData(s.session25.nextOutboundCommand(), controlChannelSystem, index, payload)
	return s.sendBodyLocked(body)
}

func (s *Session) StopTalkback() error {
	s.talkMu.Lock()
	defer s.talkMu.Unlock()
	if s.talk == nil {
		return nil
	}
	talk := s.talk
	s.talk = nil
	err := s.sendTalkControl(0x0351, talk.controlIndex)
	talk.controlIndex++
	return err
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
	binary.LittleEndian.PutUint32(body[28:], t.frame)
	binary.LittleEndian.PutUint32(body[32:], t.frame+1)
	copy(body[36:], frame)
	info := body[36+len(frame):]
	info[0], info[2] = 0x87, 0x1e
	binary.LittleEndian.PutUint32(info[12:], uint32(s.clock().UnixMilli()))
	t.frame++
	return s.sendBodyLocked(body)
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
