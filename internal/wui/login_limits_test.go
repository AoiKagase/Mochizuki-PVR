package wui

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	passwordauth "mochizuki/internal/auth"
	"mochizuki/internal/config"
)

func TestLoginAttemptsDiscardExpiredUsernames(t *testing.T) {
	s := &server{}
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	now := time.Unix(1_800_000_000, 0)
	for i := 0; i < 1000; i++ {
		r.RemoteAddr = fmt.Sprintf("192.0.%d.%d:1234", i/256, i%256)
		if !s.allowLoginAttemptAt(r, fmt.Sprintf("expired-%d", i), now) {
			t.Fatalf("fixture attempt %d rejected", i)
		}
	}
	if !s.allowLoginAttemptAt(r, "new-user", now.Add(time.Minute)) {
		t.Fatal("capacity not recovered after expiry")
	}
	if got := len(s.loginAttempts); got != 1 {
		t.Fatalf("retained username records = %d, want 1", got)
	}
	if got := len(s.loginSourceAttempts); got != 1 {
		t.Fatalf("retained source records = %d, want 1", got)
	}
}

func TestLoginAttemptsLimitSourceAcrossUsernames(t *testing.T) {
	s := &server{}
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	for i := 0; i < 30; i++ {
		if !s.allowLoginAttempt(r, fmt.Sprintf("user-%d", i)) {
			t.Fatalf("source attempt %d rejected", i+1)
		}
	}
	if s.allowLoginAttempt(r, "another-user") {
		t.Fatal("31st source attempt accepted after changing username")
	}
	r.RemoteAddr = "127.0.0.2:1234"
	if !s.allowLoginAttempt(r, "another-user") {
		t.Fatal("independent source rejected")
	}
}

func TestLoginAttemptsBoundTotalRecords(t *testing.T) {
	s := &server{}
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	now := time.Unix(1_800_000_000, 0)
	for i := 0; i < 2047; i++ {
		r.RemoteAddr = fmt.Sprintf("192.0.%d.%d:1234", i/256, i%256)
		if !s.allowLoginAttemptAt(r, "user", now) {
			t.Fatalf("fixture attempt %d rejected", i)
		}
	}
	if !s.allowLoginAttemptAt(r, "second-user", now) {
		t.Fatal("existing source cannot use penultimate entry")
	}
	r.RemoteAddr = "203.0.113.1:1234"
	if s.allowLoginAttemptAt(r, "new-user", now) {
		t.Fatal("two-record registration accepted with only one entry free")
	}
	r.RemoteAddr = "192.0.0.0:1234"
	if !s.allowLoginAttemptAt(r, "last-user", now) {
		t.Fatal("existing source cannot use final entry")
	}
	if got := len(s.loginAttempts) + len(s.loginSourceAttempts); got != 4096 {
		t.Fatalf("record count = %d, want 4096", got)
	}
	if !s.allowLoginAttemptAt(r, "user", now) {
		t.Fatal("known identity rejected solely because capacity is full")
	}
	if s.allowLoginAttemptAt(r, "new-user", now) {
		t.Fatal("new identity accepted with full record capacity")
	}
	r.RemoteAddr = "203.0.113.1:1234"
	if !s.allowLoginAttemptAt(r, "new-user", now.Add(time.Minute)) {
		t.Fatal("capacity did not recover at expiration")
	}
}

func TestLoginAttemptsWindowBoundaryAndRejectedAttempts(t *testing.T) {
	s := &server{}
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	now := time.Unix(1_800_000_000, 0)
	for i := 0; i < 5; i++ {
		if !s.allowLoginAttemptAt(r, "alice", now) {
			t.Fatalf("attempt %d rejected", i+1)
		}
	}
	if s.allowLoginAttemptAt(r, "alice", now.Add(time.Minute-time.Nanosecond)) {
		t.Fatal("sixth attempt accepted before expiration")
	}
	if !s.allowLoginAttemptAt(r, "alice", now.Add(time.Minute)) {
		t.Fatal("rejection extended the fixed window")
	}
}

func TestLoginAttemptsSuccessOnlyResetsUsername(t *testing.T) {
	s := &server{}
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	now := time.Unix(1_800_000_000, 0)
	for batch := 0; batch < 6; batch++ {
		for i := 0; i < 5; i++ {
			if !s.allowLoginAttemptAt(r, "alice", now) {
				t.Fatalf("attempt %d rejected", batch*5+i+1)
			}
		}
		s.clearLoginAttempts(r, "alice")
	}
	if s.allowLoginAttemptAt(r, "alice", now) {
		t.Fatal("successful logins reset source rate limit")
	}
	if !s.allowLoginAttemptAt(r, "alice", now.Add(time.Minute)) {
		t.Fatal("source limit did not expire")
	}
}

func TestLoginAttemptsConcurrentLimits(t *testing.T) {
	for _, sources := range []int{1, 256} {
		t.Run(fmt.Sprintf("sources-%d", sources), func(t *testing.T) {
			s := &server{}
			now := time.Unix(1_800_000_000, 0)
			var allowed atomic.Int32
			var wg sync.WaitGroup
			for source := 0; source < sources; source++ {
				for i := 0; i < 40; i++ {
					wg.Add(1)
					go func(source, i int) {
						defer wg.Done()
						r := httptest.NewRequest("POST", "/api/auth/login", nil)
						r.RemoteAddr = fmt.Sprintf("192.0.2.%d:1234", source)
						if s.allowLoginAttemptAt(r, fmt.Sprintf("user-%d", i), now) {
							allowed.Add(1)
						}
					}(source, i)
				}
			}
			wg.Wait()
			if sources == 1 && allowed.Load() != 30 {
				t.Fatalf("concurrent source attempts allowed = %d, want 30", allowed.Load())
			}
			if got := len(s.loginAttempts) + len(s.loginSourceAttempts); got > 4096 {
				t.Fatalf("concurrent record count = %d, exceeds 4096", got)
			}
		})
	}
}

func TestLoginAttemptsHTTPReturnsRetryAfter(t *testing.T) {
	paths := testPaths(t.TempDir())
	handler := newTestHandler(t, paths, &config.Config{WUIAccounts: []config.WebUser{{Username: "admin", PasswordHash: "invalid-hash"}}})
	for i := 0; i < 31; i++ {
		body := fmt.Sprintf(`{"username":"missing-%d","password":"wrong"}`, i)
		r := httptest.NewRequest(http.MethodPost, "http://localhost/api/auth/login", strings.NewReader(body))
		r.Header.Set("Origin", "http://localhost")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		want := http.StatusUnauthorized
		if i == 30 {
			want = http.StatusTooManyRequests
			if got := w.Header().Get("Retry-After"); got != "60" {
				t.Fatalf("Retry-After = %q, want 60", got)
			}
		}
		if w.Code != want {
			t.Fatalf("attempt %d status = %d, want %d", i+1, w.Code, want)
		}
	}
}

// Opt in with STRATA_SECURITY_BROWSER_NODE; ordinary unit tests need no browser.
func TestLoginSecurityBrowser(t *testing.T) {
	node := os.Getenv("STRATA_SECURITY_BROWSER_NODE")
	if node == "" {
		t.Skip("set STRATA_SECURITY_BROWSER_NODE to run the Playwright security check")
	}
	hash, err := passwordauth.HashPassword("audit-password")
	if err != nil {
		t.Fatal(err)
	}
	handler := newTestHandler(t, testPaths(t.TempDir()), &config.Config{
		WUIAccounts: []config.WebUser{{Username: "security-audit", PasswordHash: hash}},
	})
	fixture := httptest.NewServer(handler)
	defer fixture.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join("..", "..", "scripts", "security-login-check.cjs"), fixture.URL)
	output, err := command.CombinedOutput()
	t.Logf("Playwright: %s", output)
	if err != nil {
		t.Fatalf("Playwright security check: %v", err)
	}
}
