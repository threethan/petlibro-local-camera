package plaf203

import (
	"context"
	"encoding/binary"
	"errors"
	"time"
)

const controlDeleteRecording = 0x3000000a
const controlDeleteRecordingReply = 0x3000000b

// encodeRecordingDelete matches this APK's CommandPlaybackDelete.request:
// one item, page0, end1, count1, Unix seconds at offset8; remaining bytes0.
func encodeRecordingDelete(start int64) ([]byte, error) {
	if start <= 0 || start > 0x7fffffff {
		return nil, errors.New("invalid recording start")
	}
	data := make([]byte, 24)
	binary.LittleEndian.PutUint32(data, 1)
	data[5], data[6] = 1, 1
	binary.LittleEndian.PutUint32(data[8:], uint32(start))
	return data, nil
}

func (s *Session) DeleteRecording(ctx context.Context, start int64) error {
	data, err := encodeRecordingDelete(start)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	// Revalidate against the device before issuing any destructive command.
	day := time.Unix(start, 0).UTC().Truncate(24 * time.Hour).Unix()
	items, err := s.ListRecordings(ctx, day, day+86399)
	if err != nil {
		return err
	}
	found := false
	for _, item := range items {
		if item.Start == start {
			found = true
			break
		}
	}
	if !found {
		return ErrRecordingNotFound
	}
	s.recordings.mu.Lock()
	if s.recordings.closed {
		s.recordings.mu.Unlock()
		return ErrRecordingsClosed
	}
	if s.recordings.deletion != nil || s.recordings.play != nil || s.recordings.list != nil {
		s.recordings.mu.Unlock()
		return ErrRecordingsBusy
	}
	replies := make(chan recordingMessage, 4)
	s.recordings.deletion = replies
	s.recordings.mu.Unlock()
	defer func() {
		s.recordings.mu.Lock()
		if s.recordings.deletion == replies {
			s.recordings.deletion = nil
		}
		s.recordings.mu.Unlock()
	}()
	if err := s.sendRecordingControl(controlDeleteRecording, data); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case reply := <-replies:
			if reply.err != nil {
				return reply.err
			}
			if len(reply.data) < 8 {
				return ErrRecordingsProtocol
			}
			if int64(binary.LittleEndian.Uint32(reply.data[4:])) != start {
				continue
			}
			if binary.LittleEndian.Uint32(reply.data) != 1 {
				return errors.New("device did not confirm recording deletion")
			}
			return nil
		}
	}
}
