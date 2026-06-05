package supertonic

import (
	"bytes"
	"os"
	"testing"
)

func TestEncodeWAV(t *testing.T) {
	wav, err := encodeWAV([]float32{0, 0.25, -0.25}, 24000)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(wav, []byte("RIFF")) {
		t.Fatalf("WAV data should start with RIFF, got %q", wav[:4])
	}
	if string(wav[8:12]) != "WAVE" {
		t.Fatalf("WAV data should contain WAVE header, got %q", wav[8:12])
	}
}

func TestServiceSpeechWAV(t *testing.T) {
	if os.Getenv("COREANDER_RUN_SUPERTONIC_TEST") == "" {
		t.Skip("set COREANDER_RUN_SUPERTONIC_TEST=1 to run the local Supertonic model")
	}

	service := NewService("")
	wav, err := service.SpeechWAV("Hello from Supertonic.")
	if err != nil {
		t.Fatal(err)
	}
	if len(wav) < 44 || !bytes.HasPrefix(wav, []byte("RIFF")) {
		t.Fatalf("generated WAV looks invalid: %d bytes", len(wav))
	}
}
