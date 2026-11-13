package scheduler

import (
	"encoding/json"
	"strconv"
	"testing"

	"mochizuki/internal/config"
	"mochizuki/internal/mirakurun"
)

func TestSharedProgramMetadataPreservesIdentityAndOwnFields(t *testing.T) {
	var programs []mirakurun.Program
	err := json.Unmarshal([]byte(`[
		{"id":1001,"networkId":1,"serviceId":101,"eventId":7,"name":"[字]共有番組","description":"共有説明","genres":[{"lv1":7}],"extended":{"出演者":"ゲスト"},"startAt":1000,"duration":60000},
		{"id":2001,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":101,"eventId":7}]},
		{"id":3001,"networkId":1,"serviceId":103,"eventId":7,"name":"独自番組名","description":"独自説明","genres":[{"lv1":1}],"extended":{"独自":"内容"},"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":101,"eventId":7}]},
		{"id":4001,"networkId":1,"serviceId":104,"eventId":7,"name":"部分的な独自名","description":"  ","startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":101,"eventId":7}]}
	]`), &programs)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(programs)
	services := []mirakurun.Service{
		{ID: 101, NetworkID: 1, ServiceID: 101, Name: "main"},
		{ID: 102, NetworkID: 1, ServiceID: 102, Name: "sub"},
		{ID: 103, NetworkID: 1, ServiceID: 103, Name: "own"},
		{ID: 104, NetworkID: 1, ServiceID: 104, Name: "partial"},
	}
	schedule := BuildSchedule(&config.Config{ExcludeServices: []int64{101}}, services, programs)
	if len(schedule) != 3 {
		t.Fatalf("channels = %d, want 3", len(schedule))
	}
	shared := schedule[0].Programs[0]
	if shared.Title != "共有番組" || shared.FullTitle != "[字]共有番組" || shared.Category != "anime" || shared.Detail != "共有説明\n◇出演者\nゲスト" || shared.Description != "共有説明" {
		t.Fatalf("shared metadata was not inherited: %#v", shared)
	}
	if shared.ID != strconv.FormatInt(2001, 36) || shared.Channel.SID != 102 || shared.Channel.Name != "sub" || shared.Start != 1000 || shared.End != 61000 || shared.Seconds != 60 {
		t.Fatalf("recipient identity changed: %#v", shared)
	}
	if len(shared.Flags) != 1 || shared.Flags[0] != "字" {
		t.Fatalf("shared flags = %#v", shared.Flags)
	}
	own := schedule[1].Programs[0]
	if own.Title != "独自番組名" || own.Category != "sports" || own.Detail != "独自説明\n◇独自\n内容" {
		t.Fatalf("own metadata was overwritten: %#v", own)
	}
	partial := schedule[2].Programs[0]
	if partial.Title != "部分的な独自名" || partial.Category != "anime" || partial.Description != "共有説明" {
		t.Fatalf("missing fields were not filled independently: %#v", partial)
	}
	after, _ := json.Marshal(programs)
	if string(before) != string(after) {
		t.Fatal("BuildSchedule mutated its input programs")
	}
}

func TestSharedProgramMetadataLongCycleConverges(t *testing.T) {
	programs := make([]mirakurun.Program, 256)
	for i := range programs {
		programs[i] = mirakurun.Program{
			ID: int64(i + 1), NetworkID: 1, ServiceID: int64(i + 100), EventID: 7,
			StartAt: 1000, Duration: 60000,
			RelatedItems: []mirakurun.ProgramRelatedItem{{Type: "shared", ServiceID: int64((i+1)%len(programs) + 100), EventID: 7}},
		}
	}
	programs[len(programs)-1].Name = "共有名"
	programs[0].Description = "共有説明"
	resolved := resolveSharedProgramMetadata(programs)
	for i, program := range resolved {
		if program.Name != "共有名" || program.Description != "共有説明" || program.ID != programs[i].ID || program.ServiceID != programs[i].ServiceID {
			t.Fatalf("cycle did not converge at %d: %#v", i, program)
		}
	}
	if programs[0].Name != "" || programs[len(programs)-1].Description != "" {
		t.Fatal("input programs were mutated")
	}
}

func TestSharedProgramMetadataReferenceSafety(t *testing.T) {
	tests := []struct {
		name string
		json string
		want string
	}{
		{"missing reference", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":101,"eventId":7}]}]`, ""},
		{"self reference", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":102,"eventId":7}]}]`, ""},
		{"relay is not shared", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"relay","serviceId":101,"eventId":7}]},{"id":2,"networkId":1,"serviceId":101,"eventId":7,"name":"relay","startAt":1000,"duration":60000}]`, ""},
		{"movement is not shared", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"movement","serviceId":101,"eventId":7}]},{"id":2,"networkId":1,"serviceId":101,"eventId":7,"name":"movement","startAt":1000,"duration":60000}]`, ""},
		{"different time", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":101,"eventId":7}]},{"id":2,"networkId":1,"serviceId":101,"eventId":7,"name":"wrong time","startAt":2000,"duration":60000}]`, ""},
		{"different duration", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":101,"eventId":7}]},{"id":2,"networkId":1,"serviceId":101,"eventId":7,"name":"wrong duration","startAt":1000,"duration":120000}]`, ""},
		{"network isolation", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":101,"eventId":7}]},{"id":2,"networkId":2,"serviceId":101,"eventId":7,"name":"wrong network","startAt":1000,"duration":60000}]`, ""},
		{"explicit network", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","networkId":2,"serviceId":101,"eventId":7}]},{"id":2,"networkId":1,"serviceId":101,"eventId":7,"name":"wrong network","startAt":1000,"duration":60000},{"id":3,"networkId":2,"serviceId":101,"eventId":7,"name":"correct network","startAt":1000,"duration":60000}]`, "correct network"},
		{"cycle without metadata", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":103,"eventId":7}]},{"id":2,"networkId":1,"serviceId":103,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":102,"eventId":7}]}]`, ""},
		{"cycle with metadata donor", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":103,"eventId":7}]},{"id":2,"networkId":1,"serviceId":103,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":102,"eventId":7},{"type":"shared","serviceId":101,"eventId":7}]},{"id":3,"networkId":1,"serviceId":101,"eventId":7,"name":"anchor","startAt":1000,"duration":60000}]`, "anchor"},
		{"event isolation", `[{"id":1,"networkId":1,"serviceId":102,"eventId":7,"startAt":1000,"duration":60000,"relatedItems":[{"type":"shared","serviceId":101,"eventId":8}]},{"id":2,"networkId":1,"serviceId":101,"eventId":7,"name":"wrong event","startAt":1000,"duration":60000}]`, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var programs []mirakurun.Program
			if err := json.Unmarshal([]byte(tt.json), &programs); err != nil {
				t.Fatal(err)
			}
			services := []mirakurun.Service{{ID: 102, NetworkID: 1, ServiceID: 102}}
			schedule := BuildSchedule(&config.Config{}, services, programs)
			if got := schedule[0].Programs[0].FullTitle; got != tt.want {
				t.Fatalf("title = %q, want %q", got, tt.want)
			}
		})
	}
}
