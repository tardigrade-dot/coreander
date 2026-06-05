(function () {
  console.log('[recorder-hook] Initializing inside browser (Fast Offline mode)...');

  const OriginalAudio = window.OriginalAudio || window.Audio;

  // Mock Audio class to run instantly
  window.Audio = function (src) {
    const audio = new OriginalAudio(src);

    // Mute real audio playback
    audio.muted = true;
    audio.volume = 0;

    // Override play to mock instant ended event
    audio.play = async function() {
      console.log('[recorder-hook] Intercepted play for:', src);

      // Wait for audio metadata to load so duration is populated
      if (isNaN(audio.duration) || audio.duration === Infinity) {
        await new Promise(resolve => {
          audio.addEventListener('loadedmetadata', resolve, { once: true });
          audio.addEventListener('error', resolve, { once: true });
        });
      }

      const duration = audio.duration || 1.0;
      console.log('[recorder-hook] Intercepted audio duration:', duration);

      // Send the audio blob back to Playwright
      if (src) {
        try {
          const response = await fetch(src);
          const blob = await response.blob();
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result;
            if (window.__onAudioChunkExposed) {
              window.__onAudioChunkExposed(base64, duration);
            }
          };
          reader.readAsDataURL(blob);
        } catch (e) {
          console.error('[recorder-hook] Failed to process audio blob:', e);
        }
      }

      // Wait 250ms to allow DOM highlight to render and Playwright to capture screenshot
      setTimeout(() => {
        audio.dispatchEvent(new Event('ended'));
      }, 250);

      return Promise.resolve();
    };

    return audio;
  };

  // Hook document.createElement('audio')
  const originalCreateElement = document.createElement;
  document.createElement = function (tagName, options) {
    const el = originalCreateElement.call(this, tagName, options);
    if (tagName && tagName.toLowerCase() === 'audio') {
      console.log('[recorder-hook] Intercepted document.createElement("audio")');
      return new window.Audio();
    }
    return el;
  };

  // Setup the dummy recorder bridge for compatibility
  window.__recorderBridge = {
    status: 'recording',
    startRecording: () => {
      console.log('[recorder-hook] startRecording (Fast Offline mode)');
    },
    stopRecording: async () => {
      console.log('[recorder-hook] stopRecording (Fast Offline mode)');
      return 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAAA'; // Tiny dummy wav header
    },
    getCurrentTime: () => 0,
    onMark: (mark, elapsed) => {
      // noop - handled via exposeFunction directly
    }
  };

  // Hook Custom Elements
  const originalDefine = window.customElements.define;
  window.customElements.define = function (name, constructor, options) {
    if (name === 'foliate-view') {
      console.log('[recorder-hook] Intercepting foliate-view registration');
      Object.defineProperty(constructor.prototype, 'tts', {
        get() {
          return this._tts;
        },
        set(val) {
          if (val && !val._isHooked) {
            console.log('[recorder-hook] Hooking tts.setMark via property setter');
            const originalSetMark = val.setMark;
            val.setMark = function (mark) {
              // In fast mode, we rely on __onAudioChunkExposed to trigger screenshots,
              // but we still call originalSetMark to draw the highlight on screen.
              return originalSetMark.call(this, mark);
            };
            val._isHooked = true;
          }
          this._tts = val;
        },
        configurable: true,
        enumerable: true
      });

      // Hook goTo to watch for chapter transitions
      const originalGoTo = constructor.prototype.goTo;
      constructor.prototype.goTo = async function(index, ...args) {
        console.log('[recorder-hook] goTo called with index:', index);
        if (window.__recorderBridge && typeof window.__recorderBridge.onGoTo === 'function') {
          window.__recorderBridge.onGoTo(index);
        }
        return originalGoTo.call(this, index, ...args);
      };
    }
    return originalDefine.call(this, name, constructor, options);
  };

  console.log('[recorder-hook] Hooks loaded successfully');
})();
