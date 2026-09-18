import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/qr-scanner/qr-scanner-worker.min.js");
const destination = resolve(root, "public/qr-scanner-worker.min.js");

try {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
} catch (error) {
  if (error?.code === "ENOENT") {
    // Dependencies are not present during a fresh source checkout until npm install runs.
    process.exit(0);
  }
  throw error;
}
