package supertonic

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"

	ort "github.com/yalue/onnxruntime_go"
)

const (
	defaultModelDir  = "/Users/larry/Documents/supertonic-3"
	defaultVoiceName = "F1"
)

type Service struct {
	mu             sync.Mutex
	modelDir       string
	onnxDir        string
	voiceStylePath string
	tts            *TextToSpeech
	style          *Style
}

func NewService(modelDir string) *Service {
	if modelDir == "" {
		modelDir = defaultModelDir
	}
	return &Service{
		modelDir:       modelDir,
		onnxDir:        filepath.Join(modelDir, "onnx"),
		voiceStylePath: filepath.Join(modelDir, "voice_styles", defaultVoiceName+".json"),
	}
}

func (s *Service) SpeechWAV(text string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.load(); err != nil {
		return nil, err
	}

	wavData, duration, err := s.tts.Call(text, "en", s.style, 8, 1.05, 0.3)
	if err != nil {
		return nil, err
	}

	wavLen := int(float32(s.tts.SampleRate) * duration)
	if wavLen > len(wavData) {
		wavLen = len(wavData)
	}
	return encodeWAV(wavData[:wavLen], s.tts.SampleRate)
}

func (s *Service) load() error {
	if s.tts != nil && s.style != nil {
		return nil
	}
	if _, err := os.Stat(s.onnxDir); err != nil {
		return fmt.Errorf("supertonic model directory is unavailable: %w", err)
	}
	if _, err := os.Stat(s.voiceStylePath); err != nil {
		return fmt.Errorf("supertonic voice style is unavailable: %w", err)
	}

	if !ort.IsInitialized() {
		if err := InitializeONNXRuntime(); err != nil {
			return err
		}
	}

	cfg, err := LoadCfgs(s.onnxDir)
	if err != nil {
		return err
	}
	tts, err := LoadTextToSpeech(s.onnxDir, false, cfg)
	if err != nil {
		return err
	}
	style, err := LoadVoiceStyle([]string{s.voiceStylePath}, false)
	if err != nil {
		tts.Destroy()
		return err
	}

	s.tts = tts
	s.style = style
	return nil
}

func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.tts != nil {
		s.tts.Destroy()
		s.tts = nil
	}
	if s.style != nil {
		s.style.Destroy()
		s.style = nil
	}
	ort.DestroyEnvironment()
}

func encodeWAV(samples []float32, sampleRate int) ([]byte, error) {
	var buf bytes.Buffer
	dataSize := uint32(len(samples) * 2)

	buf.WriteString("RIFF")
	if err := binary.Write(&buf, binary.LittleEndian, uint32(36)+dataSize); err != nil {
		return nil, err
	}
	buf.WriteString("WAVE")
	buf.WriteString("fmt ")
	if err := binary.Write(&buf, binary.LittleEndian, uint32(16)); err != nil {
		return nil, err
	}
	if err := binary.Write(&buf, binary.LittleEndian, uint16(1)); err != nil {
		return nil, err
	}
	if err := binary.Write(&buf, binary.LittleEndian, uint16(1)); err != nil {
		return nil, err
	}
	if err := binary.Write(&buf, binary.LittleEndian, uint32(sampleRate)); err != nil {
		return nil, err
	}
	if err := binary.Write(&buf, binary.LittleEndian, uint32(sampleRate*2)); err != nil {
		return nil, err
	}
	if err := binary.Write(&buf, binary.LittleEndian, uint16(2)); err != nil {
		return nil, err
	}
	if err := binary.Write(&buf, binary.LittleEndian, uint16(16)); err != nil {
		return nil, err
	}
	buf.WriteString("data")
	if err := binary.Write(&buf, binary.LittleEndian, dataSize); err != nil {
		return nil, err
	}

	for i, sample := range samples {
		clamped := math.Max(-1.0, math.Min(1.0, float64(sample)))
		if err := binary.Write(&buf, binary.LittleEndian, int16(clamped*32767)); err != nil {
			return nil, fmt.Errorf("failed to encode wav sample %d: %w", i, err)
		}
	}
	return buf.Bytes(), nil
}
