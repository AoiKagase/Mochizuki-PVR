package operator

import (
	"fmt"
	"io"
	"os"
)

// Mirakurun returns 188-byte MPEG-TS packets, independently of HTTP read
// boundaries. Closing the stream can leave a partial packet in the output.
// Keep all complete packets; this does not attempt to repair incomplete video
// frames or discontinuities already present in the source stream.
func truncateIncompleteTSPacket(out *os.File) error {
	const packetSize = 188
	info, err := out.Stat()
	if err != nil {
		return fmt.Errorf("stat recording tail: %w", err)
	}
	if info.Size()%packetSize == 0 {
		return nil
	}
	// Verify sync bytes before treating the file as TS. Read only the header,
	// so finalizing even a long recording takes constant memory and I/O.
	var header [3 * packetSize]byte
	n, err := out.ReadAt(header[:], 0)
	if err != nil && err != io.EOF {
		return fmt.Errorf("read recording header: %w", err)
	}
	for offset := 0; offset < n; offset += packetSize {
		if header[offset] != 0x47 {
			return nil
		}
	}
	if err := out.Truncate(info.Size() - info.Size()%packetSize); err != nil {
		return fmt.Errorf("truncate incomplete TS packet: %w", err)
	}
	return nil
}
