package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mochizuki/internal/config"
	legacy "mochizuki/internal/domain"
	"mochizuki/internal/programstore"
	"mochizuki/internal/storage"
)

func TestMochizukiUsesExistingStrataData(t *testing.T) {
	t.Chdir(t.TempDir())
	doc := config.DefaultDocument()
	doc.Schema = config.LegacySchema
	if err := storage.WriteJSONAtomic(filepath.Join("data", "config.json"), doc, true); err != nil {
		t.Fatal(err)
	}
	p := runtimePaths()
	ctx := context.Background()
	if err := programstore.Write(ctx, p.database, programstore.Recorded, []legacy.Program{{ID: "existing-recording", Title: "既存の録画"}}); err != nil {
		t.Fatal(err)
	}
	if err := requireMochizukiRuntime(p); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(p.config)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Run(ctx, []string{"recorded"}, &out, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "existing-recording") {
		t.Fatalf("existing recording missing: %s", out.String())
	}
	after, err := os.ReadFile(p.config)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("reading recordings rewrote the legacy config")
	}
	if _, err := os.Stat(filepath.Join("data", "mochizuki.db")); !os.IsNotExist(err) {
		t.Fatal("upgrade created a second database")
	}
}
