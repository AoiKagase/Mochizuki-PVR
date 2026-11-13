package scheduler

import (
	"strings"

	"mochizuki/internal/mirakurun"
)

type sharedProgramKey struct {
	networkID int64
	serviceID int64
	eventID   int64
}

func resolveSharedProgramMetadata(programs []mirakurun.Program) []mirakurun.Program {
	resolved := append([]mirakurun.Program(nil), programs...)
	byKey := make(map[sharedProgramKey]int, len(programs))
	for i, program := range programs {
		byKey[sharedProgramKey{program.NetworkID, program.ServiceID, program.EventID}] = i
	}
	donors := make([][]int, len(programs))
	dependents := make([][]int, len(programs))
	queue := make([]int, len(programs))
	queued := make([]bool, len(programs))
	for i, program := range programs {
		queue[i], queued[i] = i, true
		for _, related := range program.RelatedItems {
			if related.Type != "shared" {
				continue
			}
			networkID := program.NetworkID
			if related.NetworkID != nil {
				networkID = *related.NetworkID
			}
			j, ok := byKey[sharedProgramKey{networkID, related.ServiceID, related.EventID}]
			if !ok || i == j {
				continue
			}
			source := programs[j]
			if source.StartAt != program.StartAt || source.Duration != program.Duration {
				continue
			}
			donors[i] = append(donors[i], j)
			dependents[j] = append(dependents[j], i)
		}
	}
	// Each field can only transition from missing to populated. Revisit dependent
	// programs after such a transition so chains and cycles converge without recursion.
	for head := 0; head < len(queue); head++ {
		i := queue[head]
		queued[i] = false
		changed := false
		for _, donor := range donors[i] {
			if inheritSharedProgramMetadata(&resolved[i], resolved[donor]) {
				changed = true
			}
		}
		if changed {
			for _, dependent := range dependents[i] {
				if !queued[dependent] {
					queue = append(queue, dependent)
					queued[dependent] = true
				}
			}
		}
	}
	return resolved
}

func inheritSharedProgramMetadata(target *mirakurun.Program, source mirakurun.Program) bool {
	changed := false
	if strings.TrimSpace(target.Name) == "" && strings.TrimSpace(source.Name) != "" {
		target.Name = source.Name
		changed = true
	}
	if strings.TrimSpace(target.Description) == "" && strings.TrimSpace(source.Description) != "" {
		target.Description = source.Description
		changed = true
	}
	if len(target.Genres) == 0 && len(source.Genres) > 0 {
		target.Genres = source.Genres
		changed = true
	}
	if len(target.Extended) == 0 && len(source.Extended) > 0 {
		target.Extended = source.Extended
		changed = true
	}
	return changed
}
