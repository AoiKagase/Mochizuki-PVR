package wui

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPlaybackRequestSessionStopsRegisteredRequests(t *testing.T) {
	manager := newPlaybackRequestSessions()
	token := "session_1234567890"
	first, releaseFirst := manager.register(context.Background(), token)
	defer releaseFirst()
	second, releaseSecond := manager.register(context.Background(), token)
	defer releaseSecond()

	if stopped := manager.stop(token); stopped != 2 {
		t.Fatalf("stopped requests = %d, want 2", stopped)
	}
	for index, ctx := range []context.Context{first, second} {
		select {
		case <-ctx.Done():
		default:
			t.Fatalf("request %d was not cancelled", index)
		}
	}
}

func TestPlaybackRequestSessionRejectsInvalidToken(t *testing.T) {
	manager := newPlaybackRequestSessions()
	ctx, release := manager.register(context.Background(), "short")
	defer release()
	if stopped := manager.stop("short"); stopped != 0 {
		t.Fatalf("stopped requests = %d", stopped)
	}
	select {
	case <-ctx.Done():
		t.Fatal("invalid session token registered a cancellable request")
	default:
	}
}

func TestPlaybackRequestSessionWaitsForRegisteredRequestToFinish(t *testing.T) {
	manager := newPlaybackRequestSessions()
	token := "session_1234567890"
	registered, release := manager.register(context.Background(), token)
	stopped := make(chan int, 1)
	go func() {
		stopped <- manager.stopAndWait(context.Background(), token)
	}()

	select {
	case <-registered.Done():
	case <-time.After(time.Second):
		t.Fatal("stopAndWait did not cancel the request")
	}
	select {
	case <-stopped:
		t.Fatal("stopAndWait returned before the request finished")
	default:
	}

	release()
	select {
	case count := <-stopped:
		if count != 1 {
			t.Fatalf("stopped requests = %d, want 1", count)
		}
	case <-time.After(time.Second):
		t.Fatal("stopAndWait did not return after the request finished")
	}
}

func TestServerPlaybackDeleteCancelsMatchingRequest(t *testing.T) {
	server := &server{playbackRequests: newPlaybackRequestSessions()}
	token := "session_1234567890"
	request := httptest.NewRequest(http.MethodGet, "/api/channel/abc/watch.mp4?session="+token, nil)
	registered, release := server.beginPlaybackRequest(request)
	defer release()

	response := httptest.NewRecorder()
	stop := httptest.NewRequest(http.MethodDelete, "/api/channel/abc/watch.mp4?session="+token, nil)
	finished := make(chan struct{})
	go func() {
		server.stopPlaybackRequest(response, stop)
		close(finished)
	}()

	select {
	case <-registered.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("DELETE did not cancel the matching playback request")
	}
	release()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("DELETE did not finish after the playback request ended")
	}
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestSubtitleDeleteKeepsVideoRequest(t *testing.T) {
	for _, collection := range []string{"recorded", "recording", "channel"} {
		t.Run(collection, func(t *testing.T) {
			s := &server{playbackRequests: newPlaybackRequestSessions()}
			token := "subtitle_scope_1234567890"
			base := "/api/" + collection + "/abc/"
			video, releaseVideo := s.beginPlaybackRequest(httptest.NewRequest("GET", base+"watch.mp4?session="+token, nil))
			defer releaseVideo()
			captions, releaseCaptions := s.beginPlaybackRequest(httptest.NewRequest("GET", base+"subtitles.vtt?session="+token, nil))
			go func() { <-captions.Context().Done(); releaseCaptions() }()
			// Release a cancelled video even on the broken implementation so DELETE cannot hang.
			go func() { <-video.Context().Done(); releaseVideo() }()
			response := httptest.NewRecorder()
			s.stopPlaybackRequest(response, httptest.NewRequest("DELETE", base+"subtitles.vtt?session="+token, nil))
			if response.Code != http.StatusNoContent || captions.Context().Err() != context.Canceled {
				t.Fatalf("subtitle stop: status=%d error=%v", response.Code, captions.Context().Err())
			}
			if err := video.Context().Err(); err != nil {
				t.Fatalf("subtitle DELETE cancelled video: %v", err)
			}
		})
	}
}

func TestSubtitleDeleteKeepsSharedMSESession(t *testing.T) {
	token := "mse_subtitle_scope_1234567890"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { <-ctx.Done(); close(done) }()
	s := &server{liveMSE: newLiveMSESessionManager(), playbackRequests: newPlaybackRequestSessions()}
	s.liveMSE.sessions[token] = &liveMSESession{ctx: ctx, cancel: cancel, done: done}
	response := httptest.NewRecorder()
	s.stopPlaybackRequest(response, httptest.NewRequest("DELETE", "/api/channel/abc/subtitles.vtt?mode=mse&session="+token, nil))
	if ctx.Err() != nil {
		t.Fatal("subtitle DELETE stopped the shared MSE video session")
	}
	if s.liveMSE.sessions[token] == nil {
		t.Fatal("subtitle DELETE removed the shared MSE session")
	}
}
