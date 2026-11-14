package wui

import (
	"context"
	"regexp"
	"sync"
)

var playbackSessionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

type playbackRequestSessions struct {
	mu       sync.Mutex
	nextID   uint64
	sessions map[string]map[uint64]*playbackRequest
}

type playbackRequest struct {
	cancel   context.CancelFunc
	done     chan struct{}
	resource string
}

func newPlaybackRequestSessions() *playbackRequestSessions {
	return &playbackRequestSessions{sessions: make(map[string]map[uint64]*playbackRequest)}
}

func (m *playbackRequestSessions) register(parent context.Context, token string) (context.Context, func()) {
	return m.registerResource(parent, token, "")
}

func (m *playbackRequestSessions) registerResource(parent context.Context, token, resource string) (context.Context, func()) {
	if m == nil || !playbackSessionPattern.MatchString(token) {
		return parent, func() {}
	}
	ctx, cancel := context.WithCancel(parent)
	m.mu.Lock()
	m.nextID++
	id := m.nextID
	requests := m.sessions[token]
	if requests == nil {
		requests = make(map[uint64]*playbackRequest)
		m.sessions[token] = requests
	}
	request := &playbackRequest{cancel: cancel, done: make(chan struct{}), resource: resource}
	requests[id] = request
	m.mu.Unlock()

	var once sync.Once
	release := func() {
		once.Do(func() {
			m.mu.Lock()
			if requests := m.sessions[token]; requests != nil {
				delete(requests, id)
				if len(requests) == 0 {
					delete(m.sessions, token)
				}
			}
			m.mu.Unlock()
			cancel()
			close(request.done)
		})
	}
	return ctx, release
}

func (m *playbackRequestSessions) stop(token string) int {
	requests := m.take(token)
	for _, request := range requests {
		request.cancel()
	}
	return len(requests)
}

func (m *playbackRequestSessions) stopAndWait(ctx context.Context, token string) int {
	return m.stopResourceAndWait(ctx, token, "")
}

// An empty resource stops the entire viewing session; subtitle toggles stop
// only their request, leaving the shared video session alive.
func (m *playbackRequestSessions) stopResourceAndWait(ctx context.Context, token, resource string) int {
	requests := m.takeResource(token, resource)
	for _, request := range requests {
		request.cancel()
	}
	for _, request := range requests {
		select {
		case <-request.done:
		case <-ctx.Done():
			return len(requests)
		}
	}
	return len(requests)
}

func (m *playbackRequestSessions) take(token string) map[uint64]*playbackRequest {
	return m.takeResource(token, "")
}

func (m *playbackRequestSessions) takeResource(token, resource string) map[uint64]*playbackRequest {
	if m == nil || !playbackSessionPattern.MatchString(token) {
		return nil
	}
	m.mu.Lock()
	requests := make(map[uint64]*playbackRequest)
	for id, request := range m.sessions[token] {
		if resource == "" || request.resource == resource {
			requests[id] = request
			delete(m.sessions[token], id)
		}
	}
	if len(m.sessions[token]) == 0 {
		delete(m.sessions, token)
	}
	m.mu.Unlock()
	return requests
}
