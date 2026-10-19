package plaf203

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

const (
	controlListRecordings      = 0x0318
	controlListRecordingsReply = 0x0319
	maxRecordingCount          = 100000
)

var (
	ErrRecordingsBusy     = errors.New("another SD card recording request is active")
	ErrRecordingsProtocol = errors.New("invalid SD card recording response")
	ErrRecordingsClosed   = errors.New("camera session closed")
)

// Recording follows the application's SAvEvent, with timestamps normalized to
// UTC Unix seconds. The original event and status values are retained.
type Recording struct {
	Start    int64  `json:"start"`
	Duration uint16 `json:"duration"`
	Event    uint8  `json:"event"`
	Status   uint8  `json:"status"`
}

type recordingMessage struct {
	command uint32
	data    []byte
	err     error
}

type recordingState struct {
	mu        sync.Mutex
	list      chan recordingMessage
	closed    bool
	play      chan recordingMessage
	secondary *recordingTransport
	deletion  chan recordingMessage
}

// ListRecordings requests the same LISTEVENT command as PlaybackController.
// There is one receiver for the authenticated UDP session: its control dispatch
// delivers the pages here while live video continues independently.
func (s *Session) ListRecordings(ctx context.Context, start, end int64) ([]Recording, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	argument, err := encodeRecordingList(start, end)
	if err != nil {
		return nil, err
	}
	s.recordings.mu.Lock()
	if s.recordings.closed {
		s.recordings.mu.Unlock()
		return nil, ErrRecordingsClosed
	}
	if s.recordings.list != nil || s.recordings.deletion != nil {
		s.recordings.mu.Unlock()
		return nil, ErrRecordingsBusy
	}
	responses := make(chan recordingMessage, 32)
	s.recordings.list = responses
	s.recordings.mu.Unlock()
	defer func() {
		s.recordings.mu.Lock()
		if s.recordings.list == responses {
			s.recordings.list = nil
		}
		s.recordings.mu.Unlock()
	}()
	if err := s.sendRecordingControl(controlListRecordings, argument); err != nil {
		return nil, err
	}
	pages := map[uint8][]Recording{}
	var total uint32
	var finalIndex *uint8
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case response := <-responses:
			if response.err != nil {
				return nil, response.err
			}
			page, err := decodeRecordingPage(response.data)
			if err != nil {
				return nil, err
			}
			if len(pages) > 0 && page.total != total {
				return nil, fmt.Errorf("%w: total changed between pages", ErrRecordingsProtocol)
			}
			total = page.total
			if old, duplicate := pages[page.index]; duplicate {
				if !sameRecordingPage(old, page.recordings) {
					return nil, fmt.Errorf("%w: conflicting duplicate page", ErrRecordingsProtocol)
				}
			} else {
				pages[page.index] = page.recordings
			}
			if page.end {
				n := page.index
				finalIndex = &n
			}
			if finalIndex == nil {
				continue
			}
			// Firmware may index pages from zero or one. Verify continuity and
			// the advertised total before accepting a completed day.
			all := make([]Recording, 0)
			complete := true
			firstIndex := 0
			if _, zeroBased := pages[0]; !zeroBased {
				firstIndex = 1
			}
			for n := firstIndex; n <= int(*finalIndex); n++ {
				items, exists := pages[uint8(n)]
				if !exists {
					complete = false
					break
				}
				all = append(all, items...)
			}
			if !complete {
				continue
			}
			if uint32(len(all)) < total {
				continue
			}
			if uint32(len(all)) > total {
				return nil, fmt.Errorf("%w: got %d of %d events", ErrRecordingsProtocol, len(all), total)
			}
			filtered := make([]Recording, 0, len(all))
			for _, item := range all {
				if item.Start >= start && item.Start <= end {
					filtered = append(filtered, item)
				}
			}
			sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].Start < filtered[j].Start })
			return filtered, nil
		}
	}
}

func sameRecordingPage(a, b []Recording) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (s *Session) sendRecordingControl(command uint32, argument []byte) error {
	payload := make([]byte, 4+len(argument))
	binary.LittleEndian.PutUint32(payload, command)
	copy(payload[4:], argument)
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	index := s.controlIndex
	s.controlIndex++
	return s.sendBodyLocked(encodeControlData(s.session25.nextOutboundCommand(), controlChannelSystem, index, payload))
}

// handleRecordingControl is called only by the session's receive goroutine.
func (s *Session) handleRecordingControl(inner []byte) bool {
	reply, valid := parseControlReply(inner)
	if !valid || reply.channel != controlChannelSystem || (reply.controlType != controlListRecordingsReply && reply.controlType != controlRecordingPlaybackReply && reply.controlType != controlRecordingSeekReply && reply.controlType != controlDeleteRecordingReply) {
		return false
	}
	length := int(binary.LittleEndian.Uint16(inner[24:26]))
	message := recordingMessage{command: reply.controlType}
	if length < 4 || length > len(inner)-controlInnerLength || inner[20] != 1 {
		message.err = fmt.Errorf("%w: invalid control payload length or fragmentation", ErrRecordingsProtocol)
	} else {
		message.data = append([]byte(nil), inner[controlInnerLength+4:controlInnerLength+length]...)
	}
	s.sendMu.Lock()
	s.session25.noteReceivedControlReply()
	s.sendMu.Unlock()
	s.recordings.mu.Lock()
	defer s.recordings.mu.Unlock()
	queue := s.recordings.list
	if reply.controlType != controlListRecordingsReply {
		queue = s.recordings.play
	}
	if reply.controlType == controlDeleteRecordingReply {
		queue = s.recordings.deletion
	}
	if queue != nil {
		select {
		case queue <- message:
		default:
			// Preserve an explicit failure when a device floods pages.
			select {
			case <-queue:
			default:
			}
			select {
			case queue <- recordingMessage{err: fmt.Errorf("%w: response queue overflow", ErrRecordingsProtocol)}:
			default:
			}
		}
	}
	return true
}

func (s *Session) closeRecordings() {
	s.recordings.mu.Lock()
	defer s.recordings.mu.Unlock()
	s.recordings.closed = true
	if s.recordings.deletion != nil {
		select {
		case s.recordings.deletion <- recordingMessage{err: ErrRecordingsClosed}:
		default:
		}
	}
	if s.recordings.list != nil {
		select {
		case s.recordings.list <- recordingMessage{err: ErrRecordingsClosed}:
		default:
		}
	}
	if s.recordings.play != nil {
		select {
		case s.recordings.play <- recordingMessage{err: ErrRecordingsClosed}:
		default:
		}
	}
	if s.recordings.secondary != nil {
		_ = s.recordings.secondary.Close()
	}
}

func encodeRecordingList(start, end int64) ([]byte, error) {
	if start <= 0 || end < start || end-start > 7*86400 {
		return nil, errors.New("recording range must be positive, ordered, and at most seven days")
	}
	data := make([]byte, 24)
	if err := encodeRecordingTime(data[4:12], start); err != nil {
		return nil, err
	}
	if err := encodeRecordingTime(data[12:20], end); err != nil {
		return nil, err
	}
	// channel, event type, and status are all zero, as in the app.
	return data, nil
}

func encodeRecordingTime(dst []byte, unix int64) error {
	t := time.Unix(unix, 0).UTC()
	if t.Year() < 1970 || t.Year() > 2099 {
		return errors.New("recording date outside supported range")
	}
	binary.LittleEndian.PutUint16(dst, uint16(t.Year()))
	dst[2], dst[3], dst[4] = byte(t.Month()), byte(t.Day()), byte(t.Weekday())
	dst[5], dst[6], dst[7] = byte(t.Hour()), byte(t.Minute()), byte(t.Second())
	return nil
}

func decodeRecordingTime(data []byte) (int64, error) {
	year := int(binary.LittleEndian.Uint16(data))
	month, day, hour, minute, second := int(data[2]), int(data[3]), int(data[5]), int(data[6]), int(data[7])
	if year < 1970 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59 {
		return 0, ErrRecordingsProtocol
	}
	t := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC)
	if t.Day() != day || int(t.Month()) != month {
		return 0, ErrRecordingsProtocol
	}
	return t.Unix(), nil
}

type recordingPage struct {
	total      uint32
	index      uint8
	end        bool
	recordings []Recording
}

func decodeRecordingPage(data []byte) (recordingPage, error) {
	if len(data) < 12 {
		return recordingPage{}, ErrRecordingsProtocol
	}
	count := int(data[10])
	if binary.LittleEndian.Uint32(data[:4]) != 0 || data[9] > 1 || len(data) != 12+count*12 {
		return recordingPage{}, ErrRecordingsProtocol
	}
	page := recordingPage{total: binary.LittleEndian.Uint32(data[4:8]), index: data[8], end: data[9] == 1, recordings: make([]Recording, 0, count)}
	if page.total > maxRecordingCount || uint32(count) > page.total {
		return recordingPage{}, ErrRecordingsProtocol
	}
	for n := 0; n < count; n++ {
		item := data[12+n*12 : 24+n*12]
		start, err := decodeRecordingTime(item[:8])
		if err != nil {
			return recordingPage{}, err
		}
		page.recordings = append(page.recordings, Recording{Start: start, Event: item[8], Status: item[9], Duration: binary.LittleEndian.Uint16(item[10:12])})
	}
	return page, nil
}
