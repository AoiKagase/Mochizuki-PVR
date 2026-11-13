package wui

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	passwordauth "mochizuki/internal/auth"
	"mochizuki/internal/config"
)

func TestAuthenticationResponsesAreNotStored(t *testing.T) {
	hash, err := passwordauth.HashPassword("test-password")
	if err != nil {
		t.Fatal(err)
	}
	handler := newTestHandler(t, testPaths(t.TempDir()), &config.Config{
		WUIAccounts: []config.WebUser{{Username: "test-user", PasswordHash: hash}},
	})
	for _, target := range []string{"/", "/theme.js", "/api/status"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if got := response.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("unauthenticated %s Cache-Control=%q", target, got)
		}
	}
	login := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"test-user","password":"test-password"}`))
	login.Header.Set("Origin", "http://example.com")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, login)
	if response.Code != http.StatusNoContent {
		t.Fatalf("login status=%d", response.Code)
	}
	if got := response.Header().Get("Clear-Site-Data"); got != `"cache"` {
		t.Fatalf("login cache recovery header=%q", got)
	}
	cookie := response.Result().Cookies()[0]
	for _, target := range []string{"/", "/api/status"} {
		request := httptest.NewRequest(http.MethodGet, target, nil)
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("authenticated %s status=%d Cache-Control=%q", target, response.Code, response.Header().Get("Cache-Control"))
		}
	}
}

func TestRequestOriginTrustsForwardedHeadersOnlyWhenEnabled(t *testing.T) {
	request := httptest.NewRequest("GET", "http://local.example/", nil)
	request.Header.Set("X-Forwarded-Proto", "https")
	request.Header.Set("X-Forwarded-Host", "public.example")

	server := &server{cfg: &config.Config{}}
	if got, want := server.requestOrigin(request), "http://local.example"; got != want {
		t.Fatalf("default origin = %q, want %q", got, want)
	}

	server.cfg.WUITrustForwardedHeaders = true
	server.cfg.WUITrustedProxies = []string{"127.0.0.1"}
	request.RemoteAddr = "127.0.0.1:12345"
	if got, want := server.requestOrigin(request), "https://public.example"; got != want {
		t.Fatalf("forwarded origin = %q, want %q", got, want)
	}
}

func TestPlaybackTicketBindsMediaQueryButAllowsRangeRequests(t *testing.T) {
	s := &server{playbackTickets: make(map[string]playbackTicket)}
	ticket, err := s.createPlaybackTicket("/api/recorded/abc/watch.m2ts", url.Values{"t": {"30"}})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "/api/recorded/abc/watch.m2ts?t=30&playback="+ticket, nil)
	request.Header.Set("Range", "bytes=5-8")
	if _, ok := s.playbackTicketIdentity(request); !ok {
		t.Fatal("ticket did not authorize its issued query with a Range request")
	}
	changed := httptest.NewRequest("GET", "/api/recorded/abc/watch.m2ts?t=60&playback="+ticket, nil)
	if _, ok := s.playbackTicketIdentity(changed); ok {
		t.Fatal("ticket authorized a changed media query")
	}
}
