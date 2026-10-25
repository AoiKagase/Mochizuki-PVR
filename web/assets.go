package web

import "embed"

// FS contains the Web UI assets shipped with the mochizuki binary.
//
// Keep this file in the web directory so the assets can be embedded without
// duplicating them under internal/wui. The directory remains usable as a
// normal external asset directory during local development.
//
//go:embed *.html *.css *.js favicon.ico favicon.png
var FS embed.FS
