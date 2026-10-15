package bridge

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/aerodomigue/petlibro-camera-bridge/internal/plaf203"
)

// acquireTalkSession holds the existing shared feeder connection alive, even
// when no video viewer is open. The returned release belongs to this request.
func (r *Registry) acquireTalkSession(ctx context.Context, id string) (*plaf203.Session, func(), error) {
	r.mu.Lock()
	record, ok := r.devices[id]
	if !ok {
		r.mu.Unlock()
		return nil, nil, ErrDeviceNotFound
	}
	if record.idleTimer != nil {
		record.idleTimer.Stop()
		record.idleTimer = nil
	}
	record.device.MediaConsumers++
	r.devices[id] = record
	r.mu.Unlock()
	var once sync.Once
	release := func() { once.Do(func() { r.releaseMediaConsumer(id) }) }
	if _, _, err := r.Connect(id); err != nil {
		release()
		return nil, nil, err
	}
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		r.mu.RLock()
		record, ok = r.devices[id]
		r.mu.RUnlock()
		if !ok {
			release()
			return nil, nil, ErrDeviceNotFound
		}
		if record.session != nil {
			return record.session, release, nil
		}
		if record.device.ConnectionState == plaf203.StateFailed {
			release()
			return nil, nil, errors.New("camera connection failed")
		}
		select {
		case <-ctx.Done():
			release()
			return nil, nil, ctx.Err()
		case <-tick.C:
		}
	}
}

func (r *Registry) talkbackHandler(w http.ResponseWriter, req *http.Request) {
	if req.Header.Get("Content-Type") != "audio/aac" {
		http.Error(w, "expected audio/aac", 415)
		return
	}
	controller := http.NewResponseController(w)
	if err := controller.EnableFullDuplex(); err != nil {
		http.Error(w, "streaming unavailable", 503)
		return
	}
	setupCtx, setupCancel := context.WithTimeout(req.Context(), 15*time.Second)
	defer setupCancel()
	session, release, err := r.acquireTalkSession(setupCtx, req.PathValue("device_id"))
	if err != nil {
		http.Error(w, "camera is unavailable", 503)
		return
	}
	defer release()
	if err = session.StartTalkback(setupCtx); err != nil {
		status := 503
		if errors.Is(err, plaf203.ErrTalkbackBusy) {
			status = 409
		}
		http.Error(w, err.Error(), status)
		return
	}
	defer session.StopTalkback()
	w.Header().Set("Content-Type", "text/plain")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	if controller.Flush() != nil {
		return
	}
	reader := io.LimitReader(req.Body, 8*1024*1024)
	end := time.Now().Add(120 * time.Second)
	var start time.Time
	var frames int64
	for time.Now().Before(end) {
		deadline := time.Now().Add(5 * time.Second)
		if end.Before(deadline) {
			deadline = end
		}
		if controller.SetReadDeadline(deadline) != nil {
			return
		}
		frame, readErr := readTalkbackFrame(reader)
		if readErr != nil {
			return
		}
		if start.IsZero() {
			start = time.Now()
		}
		due := start.Add(time.Duration(frames) * 1024 * time.Second / 44100)
		if wait := time.Until(due); wait > 0 {
			timer := time.NewTimer(wait)
			select {
			case <-req.Context().Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
		if session.WriteTalkback(frame) != nil {
			return
		}
		frames++
	}
}

func readTalkbackFrame(reader io.Reader) ([]byte, error) {
	header := make([]byte, 7)
	if _, err := io.ReadFull(reader, header); err != nil {
		return nil, err
	}
	if binary.BigEndian.Uint16(header[:2])&0xfff7 != 0xfff1 {
		return nil, errors.New("invalid AAC ADTS sync")
	}
	n := int(header[3]&3)<<11 | int(header[4])<<3 | int(header[5]>>5)
	if n < 7 || n > 1024 {
		return nil, errors.New("invalid AAC ADTS length")
	}
	frame := make([]byte, n)
	copy(frame, header)
	_, err := io.ReadFull(reader, frame[7:])
	return frame, err
}
