import { mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const files = [
  { src: "src/renderer/index.html", dest: "dist/renderer/index.html" },
  { src: "src/renderer/styles.css", dest: "dist/renderer/styles.css" },
  { src: "src/assets/app-icon.svg", dest: "dist/assets/app-icon.svg" },
];

for (const file of files) {
  const target = resolve(file.dest);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(file.src), target);
}
