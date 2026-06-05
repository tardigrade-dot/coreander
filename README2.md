use crispasr start a TTS server for Chinese TTS
English TTS use supertonic


./build/bin/crispasr \
    --server \
    --backend vibevoice-tts \
    -m /Users/larry/Downloads/vibevoice-1.5b-tts-q8_0.gguf \
    --voice /Users/larry/Documents/resources/qinsheng-4s-isolated_fixed.wav \
    --port 8080

mage build osxapple && ./coreander -d localhost:3000 /Users/larry/Downloads/books

rm -rf output/ && npm start

--- gemma4

llama-server \
  -m /Volumes/sw/llama-cpp-models/gemma-4-12b-it-2/gemma-4-12b-it-Q4_K_M.gguf \
  --mmproj /Volumes/sw/llama-cpp-models/gemma-4-12b-it-2/mmproj-BF16.gguf \
  -ngl 99 \
  --ctx-size 4069

----- image
llama-server -m /Volumes/sw/llama-cpp-models/Qwopus3.5-4B-Coder-MTP-BF16.gguf -c 20480 --port 8080
