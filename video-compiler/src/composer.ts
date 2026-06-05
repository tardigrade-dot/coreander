import { execSync, exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { FrameEntry } from './types';

export class VideoComposer {
  private outputDir: string;

  constructor(outputDir?: string) {
    this.outputDir = outputDir || path.join(__dirname, '../output');
  }

  async compose(frames: FrameEntry[], audioChunks: string[]): Promise<string> {
    console.log('[Composer] Starting video composition (Fast Offline mode)...');

    if (frames.length === 0) {
      throw new Error('[Composer] No screenshot frames to compile!');
    }

    if (audioChunks.length === 0) {
      throw new Error('[Composer] No audio chunks to compile!');
    }

    // 1. Concat all audio chunks using ffmpeg concat demuxer
    console.log('[Composer] Concatenating audio chunks...');
    const audioConcatListPath = path.join(this.outputDir, 'ffmpeg_audio_input.txt');
    const audioConcatContent = audioChunks
      .map(chunk => `file '${path.relative(this.outputDir, chunk)}'`)
      .join('\n');
    await fs.writeFile(audioConcatListPath, audioConcatContent);

    const audioPath = path.join(this.outputDir, 'audio_concat.wav');
    const audioConcatCmd = `ffmpeg -y -f concat -safe 0 -i "${audioConcatListPath}" -c copy "${audioPath}"`;
    console.log(`[Composer] Executing audio concat command:\n  ${audioConcatCmd}`);
    execSync(audioConcatCmd);

    // 2. Generate ffmpeg concat file contents for video frames
    console.log('[Composer] Building ffmpeg concat file for video...');
    let concatContent = '';

    for (let i = 0; i < frames.length; i++) {
      const current = frames[i];
      // In fast offline mode, current.timestamp contains the exact duration of that sentence's audio
      let duration = current.timestamp;

      // Ensure duration is positive and non-zero
      if (duration <= 0) duration = 0.1;

      concatContent += `file 'frames/${current.file}'\n`;
      concatContent += `duration ${duration.toFixed(3)}\n`;
    }

    // Workaround for ffmpeg concat demuxer quirk: repeat last frame
    concatContent += `file 'frames/${frames[frames.length - 1].file}'\n`;

    const concatPath = path.join(this.outputDir, 'ffmpeg_input.txt');
    await fs.writeFile(concatPath, concatContent);
    console.log(`[Composer] Wrote ffmpeg concat list to: ${concatPath}`);

    // 3. Run ffmpeg command to compile the final video
    const outputPath = path.join(this.outputDir, 'output.mp4');
    
    // Command flags details:
    // -y: overwrite output
    // -f concat: use concat demuxer
    // -safe 0: allow unsafe paths
    // -pix_fmt yuv420p: compatibility for QuickTime/Browsers
    // -r 25: constant frame rate (25fps) for universal device compatibility
    const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${concatPath}" -i "${audioPath}" -vf "scale=1280:720" -c:v libx264 -pix_fmt yuv420p -c:a aac -r 25 -movflags +faststart "${outputPath}"`;
    
    console.log(`[Composer] Executing final video compilation:\n  ${ffmpegCmd}`);

    return new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error) {
          console.error('[Composer] ffmpeg process encountered an error:', error);
          console.error('[Composer] ffmpeg stderr:', stderr);
          reject(error);
        } else {
          console.log('[Composer] ffmpeg process completed successfully.');
          resolve(outputPath);
        }
      });
    });
  }
}
