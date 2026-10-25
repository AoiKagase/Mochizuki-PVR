package config

import (
	"encoding/json"
	"testing"
)

func TestMochizukiSchemaCompatibility(t *testing.T) {
	if got := DefaultDocument().Schema; got != "mochizuki/config" {
		t.Fatalf("new installs use %q, want mochizuki/config", got)
	}
	for _, schema := range []string{"mochizuki/config", "strata/config"} {
		t.Run(schema, func(t *testing.T) {
			doc := DefaultDocument()
			doc.Schema = schema
			doc.Recording.Directory = "./existing-recordings/"
			doc.Web.Authentication.APITokens = []APIToken{{ID: "old", Name: "existing", TokenHash: "saved-hash", CreatedAt: "2026-10-25T00:00:00Z"}}
			data, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			parsed, err := ParseDocument(data)
			if err != nil {
				t.Fatal(err)
			}
			if parsed.Schema != "mochizuki/config" || parsed.Recording.Directory != doc.Recording.Directory || parsed.Web.Authentication.APITokens[0].TokenHash != "saved-hash" {
				t.Fatalf("configuration not preserved/normalized: %#v", parsed)
			}
			if _, err := Parse(data); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSchemaCompatibilityDoesNotBypassValidation(t *testing.T) {
	for _, schema := range []string{"mochizuki/config", "strata/config", "unknown/config"} {
		doc := DefaultDocument()
		doc.Schema = schema
		doc.Version = 2
		data, err := json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ParseDocument(data); err == nil {
			t.Fatalf("accepted unsupported version for %s", schema)
		}
		doc.Version = 1
		doc.Web.Port = 0
		data, err = json.Marshal(doc)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ParseDocument(data); err == nil {
			t.Fatalf("accepted invalid configuration for %s", schema)
		}
	}
}
