import { spawn } from "node:child_process";

export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export async function normalizeAudio(
  bytes: Buffer,
  ffmpegPath: string,
  maxSeconds: number,
): Promise<{ bytes: Buffer; seconds: number }> {
  return new Promise((resolve, reject) => {
    const process = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "pipe,crypto",
        "-i",
        "pipe:0",
        "-vn",
        "-t",
        String(maxSeconds + 1),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let completed = false;
    const timer = setTimeout(() => {
      process.kill();
      finish(new Error("AUDIO_DECODE_TIMEOUT"));
    }, 15000);
    function finish(error?: Error) {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) {
        for (const chunk of chunks) chunk.fill(0);
        reject(error);
        return;
      }
      const pcm = Buffer.concat(chunks);
      const seconds = pcm.length / 32000;
      if (seconds <= 0 || seconds > maxSeconds) {
        pcm.fill(0);
        for (const chunk of chunks) chunk.fill(0);
        reject(new Error("AUDIO_DURATION"));
        return;
      }
      const wav = pcmToWav(pcm);
      pcm.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      resolve({ bytes: wav, seconds });
    }
    process.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (maxSeconds + 2) * 32000) {
        process.kill();
        finish(new Error("AUDIO_DURATION"));
      } else chunks.push(chunk);
    });
    process.stderr.resume(); // Decoder diagnostics can contain untrusted metadata, never log them.
    process.once("error", () => finish(new Error("AUDIO_DECODER_UNAVAILABLE")));
    process.once("close", (code) =>
      finish(code === 0 ? undefined : new Error("AUDIO_INVALID")),
    );
    process.stdin.on("error", () => {});
    process.stdin.end(bytes);
  });
}
