/** Optional regeneration utility. Requires local eSpeak NG and ffmpeg; neither receives network data. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { audioFixtureText } from "./fixtures.js";
import { normalizeAudio } from "./audio.js";
const executable = process.argv[2] || "espeak-ng";
const output = fileURLToPath(
  new URL("./fixtures/polish-note.wav", import.meta.url),
);
const source = execFileSync(
  executable,
  [
    `--path=${dirname(resolve(executable))}`,
    "-v",
    "pl",
    "-s",
    "145",
    "--stdout",
    audioFixtureText,
  ],
  { windowsHide: true, maxBuffer: 5_000_000 },
);
const audio = await normalizeAudio(
  source,
  process.env.FFMPEG_PATH || "ffmpeg",
  60,
);
mkdirSync(fileURLToPath(new URL("./fixtures", import.meta.url)), {
  recursive: true,
});
writeFileSync(output, audio.bytes);
console.log(
  JSON.stringify({
    synthetic: true,
    seconds: audio.seconds,
    bytes: audio.bytes.length,
    output: "apps/api/fixtures/polish-note.wav",
  }),
);
source.fill(0);
audio.bytes.fill(0);
