import * as path from 'path';
import * as fs from 'fs/promises';
import { RecordController } from './controller';
import { VideoComposer } from './composer';
import { Config } from './types';

async function main() {
  console.log('=== EPUB-to-Video Compiler ===');
  const configPath = path.join(__dirname, '../config.json');
  
  let config: Config;

  try {
    const configData = await fs.readFile(configPath, 'utf8');
    config = JSON.parse(configData);
    console.log('[Main] Loaded configuration from config.json');
  } catch (e) {
    console.log('[Main] config.json not found or invalid. Creating a template config.json...');
    const templateConfig: Config = {
      slug: 'insert-epub-slug-here',
      baseUrl: 'http://localhost:3000',
      chapterIndex: 0,
      resolution: {
        width: 1280,
        height: 720
      },
      headless: false,
      recordAllChapters: false,
      auth: {
        email: 'admin@example.com',
        password: 'admin'
      }
    };
    await fs.writeFile(configPath, JSON.stringify(templateConfig, null, 2));
    console.log(`[Main] Created template config at: ${configPath}`);
    console.log('[Main] Please modify config.json with your desired epub slug and details, then run again.');
    return;
  }

  if (!config.slug || config.slug === 'insert-epub-slug-here') {
    console.error('[Error] Please specify a valid epub document slug in config.json!');
    return;
  }

  const startTime = Date.now();

  try {
    // 1. Run Recording
    const controller = new RecordController(config);
    const result = await controller.record();

    console.log(`\n[Main] Recording phase completed. Captured ${result.frames.length} frames.`);

    // 2. Compose Video
    const composer = new VideoComposer(config.outputDir);
    const videoPath = await composer.compose(result.frames, result.audioChunks);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== SUCCESS ===`);
    console.log(`Video generated successfully in ${elapsed}s!`);
    console.log(`Saved to: ${videoPath}\n`);

  } catch (err) {
    console.error(`\n=== FAILED ===`);
    console.error('[Error] Compiler failed with exception:', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[Fatal] Unhandled rejection:', err);
  process.exit(1);
});
