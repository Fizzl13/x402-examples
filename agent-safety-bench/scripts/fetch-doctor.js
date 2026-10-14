#!/usr/bin/env node
// Downloads x402 Doctor's lib/ at the pinned commit into vendor/, so the bench runs Doctor's own preflight code
// without installing the whole service (its server, MCP and chain SDKs). Runs on `npm install`; does nothing when the
// pinned commit is already there.

import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DOCTOR, DOCTOR_DIR } from "../src/doctor-source.js";

if (existsSync(new URL("lib/preflight.js", DOCTOR_DIR))) process.exit(0);

const url = `https://codeload.github.com/${DOCTOR.repository}/tar.gz/${DOCTOR.commit}`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`could not download x402 Doctor ${DOCTOR.commit}: HTTP ${res.status} from ${url}`);
  process.exit(1);
}
const dir = DOCTOR_DIR.pathname;
const archive = `${dir.replace(/\/$/, "")}.tar.gz`;
mkdirSync(dir, { recursive: true });
writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
const top = `${DOCTOR.repository.split("/")[1]}-${DOCTOR.commit}`;
const tar = spawnSync("tar", ["-xzf", archive, "-C", dir, "--strip-components=1", `${top}/lib`, `${top}/package.json`], { stdio: "inherit" });
rmSync(archive, { force: true });
if (tar.status !== 0) {
  console.error("could not unpack the x402 Doctor archive (is tar installed?)");
  process.exit(1);
}
console.log(`x402 Doctor ${DOCTOR.commit.slice(0, 7)} lib/ is in ${dir}`);
