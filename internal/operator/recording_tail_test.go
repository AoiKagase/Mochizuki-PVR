package operator

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"mochizuki/internal/config"
	legacy "mochizuki/internal/domain"
	"mochizuki/internal/programstore"
)

func TestUserStoppedRecordingEndsAtCompleteTSPacket(t *testing.T) {
	packet := bytes.Repeat([]byte{0xff}, 188)
	copy(packet, []byte{0x47, 0x1f, 0xff, 0x10})
	for _, packets := range []int{0, 1, 3} {
		for _, tail := range []int{0, 1, 93, 187} {
			t.Run(strconv.Itoa(packets)+"packets_"+strconv.Itoa(tail), func(t *testing.T) {
				dir := t.TempDir()
				db := filepath.Join(dir, "strata.db")
				program := legacy.Program{ID: "tailstop", Start: time.Now().Add(-time.Minute).UnixMilli(), End: time.Now().Add(time.Hour).UnixMilli(), Abort: true, AbortReason: programstore.AbortReasonUser}
				if err := programstore.Upsert(context.Background(), db, programstore.Recording, program); err != nil {
					t.Fatal(err)
				}
				complete := bytes.Repeat(packet, packets)
				body := append(append([]byte(nil), complete...), packet[:tail]...)
				cfg := &config.Config{RecordedDir: filepath.Join(dir, "recorded"), RecordedFormat: "<id>.m2ts"}
				completed, err := recordProgramWithLog(context.Background(), db, "", cfg, &fakeStreamer{body: string(body)}, program)
				if packets == 0 {
					if !errors.Is(err, errUserStoppedWithoutData) {
						t.Fatalf("error = %v, want stopped without complete packets", err)
					}
					for _, path := range []string{completed.Recorded, completed.Recorded + ".part"} {
						if _, err := os.Stat(path); !os.IsNotExist(err) {
							t.Fatalf("empty recording remains at %s: %v", path, err)
						}
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				data, err := os.ReadFile(completed.Recorded)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(data, complete) {
					t.Fatalf("saved %d bytes, want %d complete TS bytes", len(data), len(complete))
				}
			})
		}
	}
}
