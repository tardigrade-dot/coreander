import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Config, FrameEntry } from './types';

export class RecordController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private frames: FrameEntry[] = [];
  private audioChunks: string[] = [];
  private outputDir: string;
  private framesDir: string;
  private audioChunksDir: string;

  constructor(private config: Config) {
    this.outputDir = config.outputDir || path.join(__dirname, '../output');
    this.framesDir = path.join(this.outputDir, 'frames');
    this.audioChunksDir = path.join(this.outputDir, 'audio_chunks');
  }

  async record(): Promise<{ frames: FrameEntry[]; audioChunks: string[] }> {
    console.log('[Controller] Starting record process (Fast Offline mode)...');
    
    // 1. Clean and prepare output directories
    await fs.mkdir(this.outputDir, { recursive: true });
    try {
      await fs.rm(this.framesDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore if directory doesn't exist
    }
    await fs.mkdir(this.framesDir, { recursive: true });

    try {
      await fs.rm(this.audioChunksDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
    await fs.mkdir(this.audioChunksDir, { recursive: true });

    // 2. Launch browser
    const headless = this.config.headless !== false;
    const width = this.config.resolution?.width || 1280;
    const height = this.config.resolution?.height || 720;
    
    console.log(`[Controller] Launching Chromium (headless: ${headless}, size: ${width}x${height})...`);
    this.browser = await chromium.launch({
      headless,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--mute-audio=false'
      ]
    });

    this.context = await this.browser.newContext({
      viewport: { width, height },
      bypassCSP: true // Helps with Web Audio source nodes in some settings
    });

    // 3. Inject hook script before page loads
    const hookPath = path.join(__dirname, 'recorder-hook.js');
    console.log(`[Controller] Registering initScript from: ${hookPath}`);
    await this.context.addInitScript({ path: hookPath });

    this.page = await this.context.newPage();

    // Forward browser console logs to terminal
    this.page.on('console', msg => {
      console.log(`[Browser Console] [${msg.type()}] ${msg.text()}`);
    });

    const baseUrl = this.config.baseUrl || 'http://localhost:3000';

    // 4. Handle authentication if configured
    if (this.config.auth && this.config.auth.email && this.config.auth.password) {
      console.log('[Controller] Performing authentication...');
      await this.page.goto(`${baseUrl}/sessions/new`);
      await this.page.waitForSelector('#floatingInput');
      await this.page.fill('#floatingInput', this.config.auth.email);
      await this.page.fill('#floatingPassword', this.config.auth.password);
      
      // Wait a moment for input events to register
      await this.page.waitForTimeout(500);

      // Press Enter to submit the form (more reliable than clicking sometimes)
      await this.page.press('#floatingPassword', 'Enter');

      // Also try clicking the submit button as a fallback
      try {
        await this.page.click('button[type="submit"]', { timeout: 2000 });
      } catch (e) {
        // Ignored
      }

      // Wait for navigation away from login pages
      try {
        await this.page.waitForURL(
          url => !url.pathname.includes('/sessions/new') && !url.pathname.endsWith('/sessions'),
          { timeout: 10000 }
        );
        console.log('[Controller] Authentication successful');
      } catch (err) {
        // Check if there is an error message displayed on the login page
        const errorText = await this.page.evaluate(() => {
          // Look for alert danger or other error containers
          const alert = document.querySelector('.alert-danger, .error, [role="alert"]');
          return alert ? alert.textContent?.trim() : null;
        }).catch(() => null);

        if (errorText) {
          throw new Error(`[Controller] Authentication failed: "${errorText}". Please verify your credentials in config.json.`);
        } else {
          throw new Error('[Controller] Authentication timed out. Please check your credentials in config.json.');
        }
      }
    }

    // 5. Navigate to reader with video mode query parameter
    const readerUrl = `${baseUrl}/documents/${this.config.slug}/read?mode=video`;
    console.log(`[Controller] Navigating to reader: ${readerUrl}`);
    await this.page.goto(readerUrl);

    // Wait for the loading spinner to be removed
    console.log('[Controller] Waiting for document to load...');
    await this.page.waitForSelector('#spinner-container', { state: 'detached', timeout: 30000 });
    console.log('[Controller] Document loaded successfully');

    // Give a short delay to ensure everything is initialized
    await this.page.waitForTimeout(2000);

    const sections = await this.page.evaluate(() => {
      const win = window as any;
      if (win.reader && win.reader.view && win.reader.view.book) {
        return win.reader.view.book.sections.map((s: any, idx: number) => ({
          index: idx,
          id: s.id,
          title: s.title || `Section ${idx + 1}`,
          href: s.href
        }));
      }
      return [];
    });

    console.log('\n--- Available Chapters ---');
    sections.forEach((s: any) => {
      console.log(`Index: ${s.index} | ID: ${s.id} | Title: ${s.title}`);
    });
    console.log('--------------------------\n');

    // 7. Find target index and navigate if needed
    let targetIndex = 0;
    if (typeof this.config.chapterIndex === 'number') {
      targetIndex = this.config.chapterIndex;
    } else if (Array.isArray(this.config.chapters) && this.config.chapters.length > 0 && typeof this.config.chapters[0] === 'number') {
      targetIndex = this.config.chapters[0];
    } else if (this.config.chapterId) {
      const match = sections.find((s: any) => 
        s.id === this.config.chapterId || 
        s.href === this.config.chapterId || 
        s.title.includes(this.config.chapterId)
      );
      if (match) {
        targetIndex = match.index;
      } else {
        console.warn(`[Controller] Chapter identifier "${this.config.chapterId}" not found. Using chapter index 0.`);
      }
    }

    if (targetIndex >= 0) {
      console.log(`[Controller] Navigating to chapter index: ${targetIndex}...`);
      await this.page.evaluate(async (idx) => {
        const win = window as any;
        if (win.reader && win.reader.view) {
          await win.reader.view.goTo(idx);
        }
      }, targetIndex);

      // Wait for loading spinner to detach again
      try {
        await this.page.waitForSelector('#spinner-container', { state: 'detached', timeout: 10000 });
      } catch (e) {
        // Ignored
      }
      await this.page.waitForTimeout(2000);
      console.log('[Controller] Navigation and rendering complete');
    }

    // 8. Setup bridge callbacks
    let isFinished = false;

    // Check if the current index is in the specified chapters range/list
    const isChapterAllowed = (index: number) => {
      if (Array.isArray(this.config.chapters)) {
        return this.config.chapters.includes(index);
      }
      const start = this.config.chapterIndex ?? 0;
      const end = this.config.chapterIndexEnd;
      if (typeof end === 'number') {
        return index >= start && index <= end;
      }
      return index === start;
    };

    // Expose __onAudioChunkExposed callback
    await this.page.exposeFunction('__onAudioChunkExposed', async (base64: string, duration: number) => {
      if (isFinished) return;
      const idx = this.audioChunks.length;

      // Save audio chunk
      const audioFilename = `chunk_${String(idx).padStart(4, '0')}.wav`;
      const audioFilepath = path.join(this.audioChunksDir, audioFilename);
      const audioBuffer = Buffer.from(base64.split(',')[1], 'base64');
      await fs.writeFile(audioFilepath, audioBuffer);
      this.audioChunks.push(audioFilepath);

      // Take screenshot of highlighted text
      const frameFilename = `frame_${String(idx).padStart(4, '0')}.png`;
      const frameFilepath = path.join(this.framesDir, frameFilename);
      await this.page!.screenshot({ path: frameFilepath });

      this.frames.push({
        file: frameFilename,
        timestamp: duration
      });

      console.log(`[Controller] Captured sentence ${idx} (Duration: ${duration.toFixed(3)}s)`);
    });

    // Expose onGoTo callback to stop recording when shifting chapters
    await this.page.exposeFunction('__onGoToExposed', (index: number) => {
      console.log(`[Controller] Chapter transition detected: ${index}`);
      if (!this.config.recordAllChapters && !isChapterAllowed(index)) {
        console.log(`[Controller] Left chapter range. Stopping recording.`);
        isFinished = true;
      }
    });

    // Wire exposed functions to the bridge
    await this.page.evaluate(() => {
      const win = window as any;
      if (win.__recorderBridge) {
        win.__recorderBridge.onGoTo = (index: number) => {
          win.__onGoToExposed(index);
        };
      }
    });

    // 11. Trigger TTS play button
    console.log('[Controller] Selecting TTS engine and triggering Play button programmatically...');
    await this.page.waitForSelector('#tts-play:not([disabled])', { state: 'attached' });
    
    await this.page.evaluate((engineOption) => {
      // 1. Click language button if specified
      if (engineOption) {
        const langBtn = document.querySelector(`.tts-lang-btn[data-engine="${engineOption}"]`) as HTMLButtonElement;
        if (langBtn) {
          langBtn.click();
          console.log(`[Browser] Selected TTS engine: ${engineOption}`);
        }
      }
      // 2. Click play button
      const playBtn = document.getElementById('tts-play') as HTMLButtonElement;
      if (playBtn) {
        playBtn.click();
        console.log('[Browser] Triggered TTS Play programmatically');
      } else {
        console.error('[Browser] TTS Play button not found!');
      }
    }, this.config.ttsEngine || 'supertonic');

    // 12. Run state monitoring loop
    console.log('[Controller] Monitoring recording...');
    let idleCounter = 0;

    while (!isFinished) {
      await this.page.waitForTimeout(500);

      // Query TTS state
      const ttsState = await this.page.evaluate(() => {
        const win = window as any;
        if (win.reader && win.reader.tts) {
          return win.reader.tts.state;
        }
        return 'idle';
      });

      if (ttsState === 'idle') {
        idleCounter++;
        // If state stays idle for 2 seconds (4 * 500ms), we consider the segment finished
        if (idleCounter >= 4) {
          console.log('[Controller] TTS state has been idle. Stop recording.');
          isFinished = true;
        }
      } else {
        idleCounter = 0;
      }
    }

    // 13. Close browser
    console.log('[Controller] Closing browser...');
    await this.browser.close();

    return {
      frames: this.frames,
      audioChunks: this.audioChunks
    };
  }
}
