package mirakurun

import (
	"encoding/json"
	"io"
)

type Service struct {
	ID          int64  `json:"id"`
	ServiceID   int64  `json:"serviceId"`
	NetworkID   int64  `json:"networkId"`
	Name        string `json:"name"`
	HasLogoData bool   `json:"hasLogoData"`
	Channel     struct {
		Type    string `json:"type"`
		Channel string `json:"channel"`
	} `json:"channel"`
}

type Program struct {
	ID           int64                `json:"id"`
	EventID      int64                `json:"eventId"`
	NetworkID    int64                `json:"networkId"`
	ServiceID    int64                `json:"serviceId"`
	Name         string               `json:"name"`
	Description  string               `json:"description"`
	StartAt      int64                `json:"startAt"`
	Duration     int64                `json:"duration"`
	Genres       []Genre              `json:"genres"`
	Extended     map[string]string    `json:"extended"`
	RelatedItems []ProgramRelatedItem `json:"relatedItems"`
}

type ProgramRelatedItem struct {
	Type      string `json:"type"`
	NetworkID *int64 `json:"networkId,omitempty"`
	ServiceID int64  `json:"serviceId"`
	EventID   int64  `json:"eventId"`
}

type Genre struct {
	Lv1 int `json:"lv1"`
}

type Tuner struct {
	Name  string   `json:"name"`
	Types []string `json:"types"`
}

func decodeJSON(r io.Reader, dst any) error {
	return json.NewDecoder(r).Decode(dst)
}
