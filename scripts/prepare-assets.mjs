import { createRequire } from "node:module";
import {
  mkdir,
  copyFile,
  readdir,
  readFile,
  realpath,
  writeFile,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "..");
const target = join(root, "apps/web/public/assets");
const manifest = [];
async function packageRoot(name, resolver = require) {
  try {
    return dirname(resolver.resolve(`${name}/package.json`));
  } catch {
    // Some ESM packages expose neither a CommonJS entry nor package.json.
    for (const searchPath of resolver.resolve.paths(name) ?? []) {
      const candidate = join(searchPath, name);
      try {
        await stat(join(candidate, "package.json"));
        return await realpath(candidate);
      } catch {}
    }
    let dir = dirname(resolver.resolve(name));
    while (dir !== dirname(dir)) {
      try {
        const pkg = JSON.parse(
          await readFile(join(dir, "package.json"), "utf8"),
        );
        if (pkg.name === name) return dir;
      } catch {}
      dir = dirname(dir);
    }
    throw new Error(`Cannot resolve ${name}`);
  }
}
async function copy(source, relative) {
  const dest = join(target, relative);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(source, dest);
  const data = await readFile(dest);
  manifest.push({
    path: `/assets/${relative.replaceAll("\\", "/")}`,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
async function copyDirectory(source, relative) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory())
      await copyDirectory(join(source, entry.name), join(relative, entry.name));
    else await copy(join(source, entry.name), join(relative, entry.name));
  }
}
await mkdir(target, { recursive: true });
const tesseract = await packageRoot("tesseract.js");
await copy(join(tesseract, "dist/worker.min.js"), "ocr/worker.min.js");
const core = dirname(
  createRequire(join(tesseract, "package.json")).resolve(
    "tesseract.js-core/package.json",
  ),
);
for (const name of await readdir(core))
  if (/^tesseract-core.*\.(?:wasm|js)$/.test(name))
    await copy(join(core, name), `ocr/core/${name}`);
for (const language of ["pol", "eng"]) {
  const dir = await packageRoot(`@tesseract.js-data/${language}`);
  await copy(
    join(dir, `4.0.0_best_int/${language}.traineddata.gz`),
    `ocr/lang/${language}.traineddata.gz`,
  );
  for (const license of ["LICENSE", "LICENSE.md"]) {
    try {
      await stat(join(dir, license));
      await copy(join(dir, license), `licenses/ocr-${language}-${license}`);
      break;
    } catch {}
  }
}
const pdf = await packageRoot("pdfjs-dist");
await copy(join(pdf, "build/pdf.worker.min.mjs"), "pdf/pdf.worker.min.mjs");
for (const dir of ["cmaps", "standard_fonts", "wasm"])
  await copyDirectory(join(pdf, dir), `pdf/${dir}`);
await copy(join(pdf, "LICENSE"), "licenses/pdfjs-LICENSE");
const font = await packageRoot("@fontsource/noto-sans");
for (const name of await readdir(join(font, "files")))
  if (/noto-sans-(latin|latin-ext)-(400|600|700)-normal\.woff2$/.test(name))
    await copy(join(font, "files", name), `fonts/${name}`);
await copy(join(font, "LICENSE"), "licenses/noto-sans-LICENSE");
const fullFont = join(root, "packages/importers/assets/NotoSans-Regular.ttf");
const fontSource = JSON.parse(
  await readFile(
    join(root, "packages/importers/assets/font-source.json"),
    "utf8",
  ),
);
if (
  createHash("sha256")
    .update(await readFile(fullFont))
    .digest("hex") !== fontSource.sha256
)
  throw new Error("Noto Sans TTF integrity check failed");
await copy(fullFont, "fonts/NotoSans-Regular.ttf");
for (const [name, dir] of [
  ["tesseract", tesseract],
  ["tesseract-core", core],
])
  for (const filename of ["LICENSE", "LICENSE.md"]) {
    try {
      await stat(join(dir, filename));
      await copy(join(dir, filename), `licenses/${name}-${filename}`);
      break;
    } catch {}
  }
// Keep the notices with the redistributable build, including locally served fonts.
// One combined asset avoids hundreds of extra offline-cache requests.
const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const licenseQueue = Object.keys(project.dependencies).map((name) => ({
  name,
  resolver: require,
  optional: false,
}));
const visitedPackages = new Set();
const notices = [];
while (licenseQueue.length) {
  const entry = licenseQueue.shift();
  let dir;
  try {
    dir = await packageRoot(entry.name, entry.resolver);
  } catch (error) {
    if (entry.optional) continue;
    throw error;
  }
  if (visitedPackages.has(dir)) continue;
  visitedPackages.add(dir);
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const texts = [];
  for (const file of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (
      file.isFile() &&
      /^(licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(file.name)
    )
      texts.push(
        `${file.name}\n${await readFile(join(dir, file.name), "utf8")}`,
      );
  }
  notices.push({
    id: `${pkg.name}@${pkg.version}`,
    text: `Package: ${pkg.name}@${pkg.version}\nLicense metadata: ${JSON.stringify(pkg.license ?? pkg.licenses ?? "not specified")}\n${texts.join("\n\n") || "No separate notice file in this package distribution."}`,
  });
  const resolver = createRequire(join(dir, "package.json"));
  for (const name of Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  }))
    licenseQueue.push({
      name,
      resolver,
      optional: Object.hasOwn(pkg.optionalDependencies ?? {}, name),
    });
}
const noticesPath = join(target, "licenses/THIRD-PARTY-LICENSES.txt");
await mkdir(dirname(noticesPath), { recursive: true });
await writeFile(
  noticesPath,
  "Notices from the installed production dependency graph. Individual packages may contain additional notices in their distributions.\n\n" +
    notices
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => entry.text)
      .join("\n\n====================\n\n") +
    "\n",
);
const noticesBytes = await readFile(noticesPath);
manifest.push({
  path: "/assets/licenses/THIRD-PARTY-LICENSES.txt",
  bytes: noticesBytes.length,
  sha256: createHash("sha256").update(noticesBytes).digest("hex"),
});
await writeFile(
  join(target, "manifest.json"),
  JSON.stringify({ version: 1, assets: manifest }, null, 2),
);
console.log(
  `Prepared ${manifest.length} local OCR, PDF and font assets (${(manifest.reduce((n, a) => n + a.bytes, 0) / 1024 / 1024).toFixed(1)} MB). No external runtime assets are required.`,
);
