package webserver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
)

const defaultLlamaURL = "http://127.0.0.1:8080/completion"

type translateRequest struct {
	Text string `json:"text"`
}

type translateResponse struct {
	Translation string `json:"translation"`
}

func translateHandler(c fiber.Ctx) error {
	var req translateRequest
	if err := json.Unmarshal(c.Body(), &req); err != nil {
		return fiber.ErrBadRequest
	}

	text := strings.TrimSpace(req.Text)
	if text == "" {
		return c.JSON(translateResponse{Translation: ""})
	}

	// Prepare prompt as requested by user
	prompt := fmt.Sprintf("将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：%s", text)

	payload, err := json.Marshal(map[string]any{
		"prompt":      prompt,
		"temperature": 0.2,
		"n_predict":   1024,
	})
	if err != nil {
		return fiber.ErrInternalServerError
	}

	llamaURL := defaultLlamaURL
	if envURL := strings.TrimSpace(os.Getenv("COREANDER_LLAMA_URL")); envURL != "" {
		llamaURL = envURL
	}

	httpClient := &http.Client{Timeout: 60 * time.Second}
	upstreamReq, err := http.NewRequestWithContext(c.Context(), http.MethodPost, llamaURL, bytes.NewReader(payload))
	if err != nil {
		return fiber.ErrInternalServerError
	}
	upstreamReq.Header.Set("Content-Type", "application/json")

	upstreamRes, err := httpClient.Do(upstreamReq)
	if err != nil {
		log.Printf("Llama.cpp translation request failed: %v", err)
		return fiber.NewError(fiber.StatusBadGateway, "Translation service unavailable")
	}
	defer upstreamRes.Body.Close()

	if upstreamRes.StatusCode < 200 || upstreamRes.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(upstreamRes.Body, 4096))
		log.Printf("Llama.cpp service returned %d: %s", upstreamRes.StatusCode, strings.TrimSpace(string(body)))
		return fiber.NewError(fiber.StatusBadGateway, "Translation service returned an error")
	}

	var llamaRes struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(upstreamRes.Body).Decode(&llamaRes); err != nil {
		return fiber.ErrInternalServerError
	}

	translation := strings.TrimSpace(llamaRes.Content)

	return c.JSON(translateResponse{Translation: translation})
}
