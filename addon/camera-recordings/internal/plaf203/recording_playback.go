package plaf203

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/AlexxIT/go2rtc/pkg/tutk"
)

const (
	controlRecordingPlayback      = 0x031a
	controlRecordingPlaybackReply = 0x031b
	controlRecordingSeek          = 0x033c
	controlRecordingSeekReply     = 0x033d
)

var ErrRecordingNotFound = errors.New("SD card recording not found")
var ErrRecordingOffset = errors.New("offset must be within the recording duration")

// RecordingPlayback owns one secondary camera AV channel. Frames never come
// from the primary live channel. Stop releases the device playback allocation.
type RecordingPlayback struct {
	Frames         <-chan *VideoFrame
	Audio          <-chan *AudioFrame
	StartTimestamp uint64
	Done           <-chan struct{}
	Err            func() error
	Stop           func()
}

type recordingDatagram struct {
	data []byte
	peer *net.UDPAddr
}

// recordingTransport multiplexes a secondary AV channel over the existing
// authenticated IOTC socket. The APK passes the playback channel unchanged to
// IOTC_Session_Write; native IOTC writes it at outer packet byte 14. Normalizing
// that byte lets the existing, independently counted Session16 parser operate.
type recordingTransport struct {
	parent  *Session
	channel byte
	packets chan recordingDatagram
	done    chan struct{}
	once    sync.Once
}

func (t *recordingTransport) SendTo(wire []byte, peer *net.UDPAddr) error {
	select {
	case <-t.done:
		return ErrRecordingsClosed
	default:
	}
	decoded := tutk.ReverseTransCodeBlob(wire)
	if len(decoded) < sessionHeaderLength {
		return ErrRecordingsProtocol
	}
	decoded[14] = t.channel
	// The PLAF203 playback AV channel accepts the SDK's 1c/0a envelope.
	// Forcing the live client's 1d/0b framing here makes authentication time
	// out, even though the primary channel successfully allocated playback.
	// Retain this framing for login, counters, media controls and stop.
	decoded[2], decoded[3] = 0x1c, 0x0a
	return t.parent.transport.SendTo(tutk.TransCodeBlob(decoded), peer)
}
func (t *recordingTransport) Receive(ctx context.Context) ([]byte, *net.UDPAddr, error) {
	select {
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	case <-t.done:
		return nil, nil, ErrRecordingsClosed
	case packet := <-t.packets:
		return packet.data, packet.peer, nil
	}
}
func (t *recordingTransport) LocalAddress() *net.UDPAddr { return t.parent.transport.LocalAddress() }
func (t *recordingTransport) Close() error               { t.once.Do(func() { close(t.done) }); return nil }

func (s *Session) handleRecordingPacket(decoded []byte, peer *net.UDPAddr) bool {
	if len(decoded) < sessionHeaderLength || decoded[14] == 0 {
		return false
	}
	if peer == nil || s.Address == nil || !peer.IP.Equal(s.Address.IP) || peer.Port != s.Address.Port {
		return false
	}
	s.recordings.mu.Lock()
	t := s.recordings.secondary
	s.recordings.mu.Unlock()
	if t == nil || decoded[14] != t.channel {
		return false
	}
	normalized := append([]byte(nil), decoded...)
	normalized[14] = 0
	if _, err := decodeDeviceSession(normalized, s.ID); err != nil {
		return false
	}
	packet := recordingDatagram{data: tutk.TransCodeBlob(normalized), peer: cloneUDPAddress(peer)}
	select {
	case <-t.done:
	case t.packets <- packet:
	default:
		_ = t.Close() // Never block the live channel's UDP receiver.
	}
	return true
}

func encodePlaybackControl(record Recording, command uint32) ([]byte, error) {
	data := make([]byte, 24)
	binary.LittleEndian.PutUint32(data[4:], command)
	if err := encodeRecordingTime(data[12:20], record.Start); err != nil {
		return nil, err
	}
	binary.LittleEndian.PutUint32(data[20:], uint32(record.Duration))
	return data, nil
}

func (s *Session) StartRecording(ctx context.Context, start int64, offset uint32) (_ *RecordingPlayback, returnErr error) {
	playbackCtx := ctx
	ctx, setupCancel := context.WithTimeout(ctx, 25*time.Second)
	defer setupCancel()
	s.recordings.mu.Lock()
	if s.recordings.closed {
		s.recordings.mu.Unlock()
		return nil, ErrRecordingsClosed
	}
	if s.recordings.play != nil || s.recordings.deletion != nil {
		s.recordings.mu.Unlock()
		return nil, ErrRecordingsBusy
	}
	controls := make(chan recordingMessage, 16)
	s.recordings.play = controls
	s.recordings.mu.Unlock()
	var child *Session
	var transport *recordingTransport
	var record Recording
	var stopOnce sync.Once
	var unsubscribe func()
	var unsubscribeAudio func()
	var audioStarted bool
	var prepared bool
	done := make(chan struct{})
	var errMu sync.Mutex
	var playbackErr error
	finish := func(err error) {
		stopOnce.Do(func() {
			errMu.Lock()
			playbackErr = err
			errMu.Unlock()
			if unsubscribe != nil {
				unsubscribe()
			}
			if unsubscribeAudio != nil {
				unsubscribeAudio()
			}
			if child != nil && transport != nil {
				argument := make([]byte, 8)
				binary.LittleEndian.PutUint32(argument, uint32(transport.channel))
				if audioStarted {
					_ = child.sendRecordingControl(controlStopAudio, argument)
				}
				_ = child.sendRecordingControl(0x02ff, argument)
			}
			if prepared {
				argument, _ := encodePlaybackControl(record, 1)
				_ = s.sendRecordingControl(controlRecordingPlayback, argument)
			}
			if transport != nil {
				_ = transport.Close()
			}
			if child != nil {
				_ = child.Close()
			}
			s.recordings.mu.Lock()
			if s.recordings.play == controls {
				s.recordings.play = nil
				s.recordings.secondary = nil
			}
			s.recordings.mu.Unlock()
			close(done)
		})
	}
	defer func() {
		if returnErr != nil {
			finish(returnErr)
		}
	}()
	// The public playback URL identifies a clip by its original start time.
	// Query the device for its duration instead of inventing one.
	day := time.Unix(start, 0).UTC().Truncate(24 * time.Hour).Unix()
	items, err := s.ListRecordings(ctx, day, day+86399)
	if err != nil {
		return nil, err
	}
	found := false
	for _, item := range items {
		if item.Start == start {
			record = item
			found = true
			break
		}
	}
	if !found {
		return nil, ErrRecordingNotFound
	}
	if record.Duration == 0 || offset >= uint32(record.Duration) {
		return nil, ErrRecordingOffset
	}
	argument, err := encodePlaybackControl(record, 16)
	if err != nil {
		return nil, err
	}
	if err = s.sendRecordingControl(controlRecordingPlayback, argument); err != nil {
		return nil, err
	}
	prepared = true
	var channel uint32
	for channel == 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case message := <-controls:
			if message.err != nil {
				return nil, message.err
			}
			if message.command != controlRecordingPlaybackReply {
				continue
			}
			if len(message.data) < 12 {
				return nil, ErrRecordingsProtocol
			}
			if binary.LittleEndian.Uint32(message.data) != 16 {
				continue
			}
			channel = binary.LittleEndian.Uint32(message.data[4:8])
			if channel == 0 || channel > 31 {
				return nil, fmt.Errorf("%w: device rejected playback channel", ErrRecordingsProtocol)
			}
		}
	}
	transport = &recordingTransport{parent: s, channel: byte(channel), packets: make(chan recordingDatagram, 256), done: make(chan struct{})}
	s.recordings.mu.Lock()
	if s.recordings.closed {
		s.recordings.mu.Unlock()
		return nil, ErrRecordingsClosed
	}
	s.recordings.secondary = transport
	s.recordings.mu.Unlock()
	child = &Session{ID: s.ID, Address: cloneUDPAddress(s.Address), transport: transport, clock: s.clock, session25: newSession25State(), media: NewMediaReceiver()}
	// The official observer accepts playback controls on either AV channel.
	// Share only the reply queue; media/counters remain independent.
	child.recordings.play = controls
	// Firmware can acknowledge allocation before its playback AV server is
	// ready. Replay the same login datagrams until acknowledged; advancing
	// sequence numbers would turn a retry into an incomplete new exchange.
	loginPackets := make([][]byte, 0, 2)
	stamp := uint32(s.clock().UnixMilli())
	for _, variant := range []LoginVariant{LoginPrimary, LoginSecondary} {
		packet, encodeErr := (LoginRequest{SessionID: child.ID, Sequence: child.nextSequence(),
			Variant: variant, TimestampMillis: stamp + uint32(variant)}).Encode()
		if encodeErr != nil {
			return nil, encodeErr
		}
		loginPackets = append(loginPackets, packet)
	}
	sendLogin := func() error {
		for _, packet := range loginPackets {
			if err := child.sendPacket(packet); err != nil {
				return err
			}
		}
		return nil
	}
	if err = sendLogin(); err != nil {
		return nil, err
	}
	loginCtx, loginCancel := context.WithTimeout(ctx, defaultLoginTimeout)
	defer loginCancel()
	for {
		retryCtx, retryCancel := context.WithTimeout(loginCtx, 300*time.Millisecond)
		wire, _, receiveErr := transport.Receive(retryCtx)
		retryCancel()
		if errors.Is(receiveErr, context.DeadlineExceeded) && loginCtx.Err() == nil {
			if err = sendLogin(); err != nil {
				return nil, err
			}
			continue
		}
		if receiveErr != nil {
			return nil, fmt.Errorf("authenticate recording channel: %w", receiveErr)
		}
		decoded := tutk.ReverseTransCodeBlob(wire)
		if _, decodeErr := DecodeLoginResponse(decoded, s.ID); decodeErr == nil {
			break
		}
	}
	diagnostics := newBootstrapDiagnostics(s.ID, nil)
	if err = child.sendLoginPair(uint32(s.clock().UnixMilli())); err != nil {
		return nil, err
	}
	if err = child.sendBody(encodeBootstrapHeartbeat(child.nextSession25ControlCounter(), uint32(s.clock().UnixMilli()))); err != nil {
		return nil, err
	}
	if err = child.sendSession25Counters(diagnostics); err != nil {
		return nil, err
	}
	// APK x.java sends CommandStartVideo.request(AVChannel.getChannel()).
	streamArgument := make([]byte, 8)
	binary.LittleEndian.PutUint32(streamArgument, channel)
	if err = child.sendRecordingControl(controlStartVideo, streamArgument); err != nil {
		return nil, err
	}
	if err = child.sendSession25Counters(diagnostics); err != nil {
		return nil, err
	}
	firstFrame, err := child.waitForVideo(ctx, diagnostics)
	if err != nil {
		return nil, fmt.Errorf("receive recording video: %w", err)
	}
	if offset > 0 {
		// Match ReplayController: establish playback before seeking. Nothing
		// from the initial position has been published to the HTTP consumer.
		// Discard already queued pre-seek packets before issuing progress.
	clearPending:
		for {
			select {
			case <-transport.packets:
			default:
				break clearPending
			}
		}
		seek := make([]byte, 20)
		_ = encodeRecordingTime(seek[4:12], record.Start)
		binary.LittleEndian.PutUint32(seek[12:], offset)
		binary.LittleEndian.PutUint32(seek[16:], uint32(record.Duration))
		if err = s.sendRecordingControl(controlRecordingSeek, seek); err != nil {
			return nil, err
		}
	waitForSeek:
		for {
			// Prefer an already received ACK to consuming the first post-seek
			// keyframe from the secondary queue.
			select {
			case message := <-controls:
				if message.err != nil {
					return nil, message.err
				}
				if message.command == controlRecordingSeekReply {
					if len(message.data) < 4 || int32(binary.LittleEndian.Uint32(message.data)) < 0 {
						return nil, fmt.Errorf("%w: device rejected seek", ErrRecordingsProtocol)
					}
					break waitForSeek
				}
			default:
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case packet := <-transport.packets:
				// Firmware may answer progress on either AV channel. While the
				// media receiver has not started, this goroutine owns secondary
				// reads and forwards its control replies to the shared queue.
				decoded := tutk.ReverseTransCodeBlob(packet.data)
				if handled, err := child.replySessionHeartbeat(decoded, packet.peer, diagnostics); err != nil {
					return nil, err
				} else if handled {
					continue
				}
				if inner, err := decodeDeviceSession(decoded, child.ID); err == nil {
					if child.handleRecordingControl(inner) {
						_ = child.sendSession25Counters(diagnostics)
					} else if _, err := child.replySession25Counters(inner, packet.peer, diagnostics); err != nil {
						return nil, err
					}
				}
				continue
			case message := <-controls:
				if message.err != nil {
					return nil, message.err
				}
				if message.command != controlRecordingSeekReply {
					continue
				}
				if len(message.data) < 4 || int32(binary.LittleEndian.Uint32(message.data)) < 0 {
					return nil, fmt.Errorf("%w: device rejected seek", ErrRecordingsProtocol)
				}
			}
			break
		}
		resume, _ := encodePlaybackControl(record, 8)
		if err = s.sendRecordingControl(controlRecordingPlayback, resume); err != nil {
			return nil, err
		}
		// The app verifies seek progress against AV frame milliseconds. Wait
		// for a decodable frame at or beyond the requested point rather than
		// showing pre-seek buffered video as if the seek succeeded.
		for {
			firstFrame, err = child.waitForVideo(ctx, diagnostics)
			if err != nil {
				return nil, fmt.Errorf("receive recording seek video: %w", err)
			}
			if firstFrame.Keyframe && firstFrame.Timestamp >= uint64(offset)*1000 && firstFrame.Timestamp <= uint64(record.Duration)*1000+5000 {
				break
			}
		}
	}
	frames := make(chan *VideoFrame, 16)
	audio := make(chan *AudioFrame, 256)
	frames <- firstFrame
	overflow := make(chan struct{}, 1)
	unsubscribe = child.SubscribeFrames(func(frame *VideoFrame) {
		select {
		case frames <- cloneVideoFrame(frame):
		default:
			select {
			case overflow <- struct{}{}:
			default:
			}
		}
	})
	// Enable audio only after seeking, on the historical AV channel. The live
	// session's microphone subscription must never enter a recording.
	unsubscribeAudio = child.SubscribeAudio(func(frame *AudioFrame) {
		if frame.Timestamp < firstFrame.Timestamp {
			return
		}
		copyFrame := *frame
		copyFrame.Data = append([]byte(nil), frame.Data...)
		select {
		case audio <- &copyFrame:
		default:
			select {
			case overflow <- struct{}{}:
			default:
			}
		}
	})
	if err = child.sendRecordingControl(controlStartAudio, streamArgument); err != nil {
		return nil, err
	}
	audioStarted = true
	child.startMediaReceiver()
	go func() {
		idle := time.NewTimer(15 * time.Second)
		defer idle.Stop()
		// A hard duration bound releases camera resources if firmware omits EOF.
		end := time.NewTimer(time.Duration(uint32(record.Duration)-offset)*time.Second + 15*time.Second)
		defer end.Stop()
		for {
			select {
			case <-playbackCtx.Done():
				finish(playbackCtx.Err())
				return
			case <-done:
				return
			case <-transport.done:
				finish(ErrRecordingsClosed)
				return
			case <-overflow:
				finish(errors.New("recording consumer is too slow"))
				return
			case <-end.C:
				finish(nil)
				return
			case <-idle.C:
				stats := child.MediaStats()
				if stats.LastFrameAt.IsZero() || time.Since(stats.LastFrameAt) > 15*time.Second {
					finish(errors.New("recording video timed out"))
					return
				}
				idle.Reset(15 * time.Second)
			case message := <-controls:
				if message.err != nil {
					finish(message.err)
					return
				}
				if message.command == controlRecordingPlaybackReply && len(message.data) >= 12 {
					command := binary.LittleEndian.Uint32(message.data)
					if command == 1 || command == 7 {
						finish(nil)
						return
					}
				}
			}
		}
	}()
	return &RecordingPlayback{Frames: frames, Audio: audio, StartTimestamp: firstFrame.Timestamp, Done: done, Err: func() error { errMu.Lock(); defer errMu.Unlock(); return playbackErr }, Stop: func() { finish(nil) }}, nil
}

var _ DatagramTransport = (*recordingTransport)(nil)
