package webserver_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/svera/coreander/v4/internal/webserver"
	"github.com/svera/coreander/v4/internal/webserver/infrastructure"
)

func TestTranslateEndpoint(t *testing.T) {
	// Start a mock llama.cpp server
	mockLlamaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("Expected POST request, got %s", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Expected Content-Type application/json, got %s", r.Header.Get("Content-Type"))
		}

		var req struct {
			Prompt      string  `json:"prompt"`
			Temperature float64 `json:"temperature"`
			NPredict    int     `json:"n_predict"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("Failed to decode mock request: %v", err)
		}

		// Verify prompt contains expected instruction
		if !bytes.Contains([]byte(req.Prompt), []byte("将以下文本翻译为中文")) {
			t.Errorf("Prompt did not contain expected translation instruction: %s", req.Prompt)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"content": "测试翻译结果",
		})
	}))
	defer mockLlamaServer.Close()

	// Set env variable to point to our mock server
	os.Setenv("COREANDER_LLAMA_URL", mockLlamaServer.URL)
	defer os.Unsetenv("COREANDER_LLAMA_URL")

	db := infrastructure.Connect(":memory:", 250)
	appFS := loadDirInMemoryFs("fixtures/library")
	app := bootstrapApp(db, &infrastructure.NoEmail{}, appFS, webserver.Config{})

	// Post translation request
	reqPayload, _ := json.Marshal(map[string]string{
		"text": "Hello world",
	})
	req, err := http.NewRequest(http.MethodPost, "/translate", bytes.NewReader(reqPayload))
	if err != nil {
		t.Fatalf("Unexpected error creating request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	response, err := app.Test(req)
	if err != nil {
		t.Fatalf("Unexpected error running test: %v", err)
	}

	if response.StatusCode != http.StatusOK {
		t.Fatalf("Expected status %d, got %d", http.StatusOK, response.StatusCode)
	}

	var res struct {
		Translation string `json:"translation"`
	}
	if err := json.NewDecoder(response.Body).Decode(&res); err != nil {
		t.Fatalf("Failed to decode response: %v", err)
	}

	if res.Translation != "测试翻译结果" {
		t.Errorf("Expected translation '测试翻译结果', got %q", res.Translation)
	}
}
