package wui

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"mochizuki/internal/config"
)

func TestFaviconAvailableBeforeLogin(t *testing.T) {
	handler := newHandler(testPaths(t.TempDir()).runtime(), &config.Config{
		WUIAccounts: []config.WebUser{{Username: "admin", PasswordHash: "configured"}},
	}, true)
	for _, path := range []string{"/favicon.ico", "/favicon.png"} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, httptest.NewRequest(method, path, nil))
			if res.Code != http.StatusOK {
				t.Fatalf("%s %s = %d", method, path, res.Code)
			}
			if method == http.MethodGet && res.Body.Len() == 0 {
				t.Fatal("empty favicon")
			}
			if method == http.MethodHead && res.Body.Len() != 0 {
				t.Fatal("HEAD returned a body")
			}
		}
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/config", nil))
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("protected config = %d", res.Code)
	}
}
