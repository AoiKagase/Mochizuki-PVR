package wui

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"mochizuki/internal/config"
	"mochizuki/internal/storage"
)

func TestLegacyBearerTokenStillAuthenticates(t *testing.T) {
	secret := "strata_existing-token-secret"
	hash := sha256.Sum256([]byte(secret))
	s := &server{cfg: &config.Config{WUIAPITokens: []config.APIToken{{
		ID: "existing", Name: "existing integration", TokenHash: hex.EncodeToString(hash[:]),
	}}}}
	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.Header.Set("Authorization", "Bearer "+secret)
	identity, ok := s.bearerIdentity(req)
	if !ok || identity.principal != "token:existing" || !identity.bearer {
		t.Fatal("existing API token stopped authenticating after rename")
	}
}

func TestLegacyConfigUpgradePreservesSecrets(t *testing.T) {
	for _, submittedSchema := range []string{config.MochizukiSchema, config.LegacySchema} {
		t.Run(submittedSchema, func(t *testing.T) {
			paths := testPaths(t.TempDir())
			doc := config.DefaultDocument()
			doc.Schema = config.LegacySchema
			doc.Web.Authentication.Users = []config.WebUser{{Username: "admin", PasswordHash: "existing-password-hash"}}
			doc.Web.Authentication.APITokens = []config.APIToken{{ID: "old", Name: "existing", TokenHash: "existing-token-hash", CreatedAt: "2026-10-25T00:00:00Z"}}
			if err := storage.WriteJSONAtomic(paths.Config, doc, true); err != nil {
				t.Fatal(err)
			}
			original := mustReadFile(t, paths.Config)
			handler := newTestHandler(t, paths, &config.Config{})
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/config", nil))
			if res.Code != http.StatusOK {
				t.Fatalf("GET: %d %s", res.Code, res.Body.String())
			}
			var public map[string]any
			if err := json.Unmarshal(res.Body.Bytes(), &public); err != nil {
				t.Fatal(err)
			}
			if public["schema"] != config.MochizukiSchema || bytes.Contains(res.Body.Bytes(), []byte("existing-password-hash")) || bytes.Contains(res.Body.Bytes(), []byte("existing-token-hash")) {
				t.Fatalf("unexpected public configuration: %s", res.Body.String())
			}
			if !bytes.Equal(original, mustReadFile(t, paths.Config)) {
				t.Fatal("GET changed existing configuration")
			}
			public["schema"] = submittedSchema
			body, err := json.Marshal(public)
			if err != nil {
				t.Fatal(err)
			}
			res = httptest.NewRecorder()
			handler.ServeHTTP(res, httptest.NewRequest(http.MethodPut, "/api/config", bytes.NewReader(body)))
			if res.Code != http.StatusOK {
				t.Fatalf("PUT: %d %s", res.Code, res.Body.String())
			}
			var saved config.Document
			if err := json.Unmarshal(mustReadFile(t, paths.Config), &saved); err != nil {
				t.Fatal(err)
			}
			if saved.Schema != config.MochizukiSchema || saved.Web.Authentication.Users[0].PasswordHash != doc.Web.Authentication.Users[0].PasswordHash || saved.Web.Authentication.APITokens[0].TokenHash != doc.Web.Authentication.APITokens[0].TokenHash {
				t.Fatalf("upgrade did not preserve secrets: %#v", saved)
			}
			if _, err := os.Stat(paths.Config); err != nil {
				t.Fatal(err)
			}
		})
	}
}
