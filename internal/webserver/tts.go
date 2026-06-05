package webserver

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/svera/coreander/v4/internal/supertonic"
)

const defaultTTSSpeechURL = "http://127.0.0.1:8090/v1/audio/speech"

var ttsFootnoteReferencePattern = regexp.MustCompile(`[［\[]\s*\d+(?:\s*[-,，、]\s*\d+)*\s*[］\]]`)
var supertonicTTS = supertonic.NewService(os.Getenv("COREANDER_SUPERTONIC_MODEL_DIR"))

type ttsSpeechRequest struct {
	Input  string `json:"input"`
	Engine string `json:"engine"`
}

func ttsSpeech(c fiber.Ctx) error {
	var req ttsSpeechRequest
	if c.Method() == "GET" {
		req.Input = c.Query("input")
		req.Engine = c.Query("engine")
	} else {
		if err := json.Unmarshal(c.Body(), &req); err != nil {
			return fiber.ErrBadRequest
		}
	}

	input := cleanTTSSpeechInput(req.Input)
	if input == "" {
		return fiber.ErrBadRequest
	}
	if strings.EqualFold(req.Engine, "supertonic") {
		wav, err := supertonicTTS.SpeechWAV(input)
		if err != nil {
			log.Printf("Supertonic TTS failed: %v", err)
			return fiber.NewError(fiber.StatusBadGateway, "Supertonic TTS unavailable")
		}
		c.Set(fiber.HeaderContentType, "audio/wav")
		return c.Send(wav)
	}

	payload, err := json.Marshal(map[string]string{
		"model": ttsModel(),
		"input": input,
	})
	if err != nil {
		return fiber.ErrInternalServerError
	}

	httpClient := &http.Client{Timeout: 2 * time.Minute}
	upstreamReq, err := http.NewRequestWithContext(c.Context(), http.MethodPost, ttsSpeechURL(), bytes.NewReader(payload))
	if err != nil {
		return fiber.ErrInternalServerError
	}
	upstreamReq.Header.Set("Content-Type", "application/json")

	upstreamRes, err := httpClient.Do(upstreamReq)
	if err != nil {
		log.Printf("TTS service request failed: %v", err)
		return fiber.NewError(fiber.StatusBadGateway, "TTS service unavailable")
	}
	defer upstreamRes.Body.Close()

	if upstreamRes.StatusCode < 200 || upstreamRes.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(upstreamRes.Body, 4096))
		log.Printf("TTS service returned %d: %s", upstreamRes.StatusCode, strings.TrimSpace(string(body)))
		return fiber.NewError(fiber.StatusBadGateway, "TTS service returned an error")
	}

	contentType := upstreamRes.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "audio/mpeg"
	}
	c.Set(fiber.HeaderContentType, contentType)

	if _, err := io.Copy(c.Response().BodyWriter(), upstreamRes.Body); err != nil {
		return fiber.ErrInternalServerError
	}
	return nil
}

func ttsSpeechURL() string {
	if url := strings.TrimSpace(os.Getenv("COREANDER_TTS_SPEECH_URL")); url != "" {
		return url
	}
	return defaultTTSSpeechURL
}

func ttsModel() string {
	if model := strings.TrimSpace(os.Getenv("COREANDER_TTS_MODEL")); model != "" {
		return model
	}
	return "vibevoice"
}

func cleanTTSSpeechInput(input string) string {
	input = ttsFootnoteReferencePattern.ReplaceAllString(input, "")
	return strings.Join(strings.Fields(input), " ")
}
