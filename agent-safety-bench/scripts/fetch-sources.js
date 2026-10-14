#!/usr/bin/env node
// Downloads the code the bench runs from Fizzl's services at the pinned commits into vendor/: x402 Doctor's lib/ and
// presign-guard's src/, without installing either service (their servers, MCP and payment setup). Runs on
// `npm install`; skips a commit that is already there.

import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { SOURCES, dirOf } from "../src/sources.js";

for (const source of SOURCES) {
  const dir = dirOf(source);
  if (existsSync(new URL("package.json", dir)) && source.paths.every((p) => existsSync(new URL(`${p}/`, dir)))) continue;

  const url = `https://codeload.github.com/${source.repository}/tar.gz/${source.commit}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`could not download ${source.repository} ${source.commit}: HTTP ${res.status} from ${url}`);
    process.exit(1);
  }
  const path = dir.pathname;
  const archive = `${path.replace(/\/$/, "")}.tar.gz`;
  mkdirSync(path, { recursive: true });
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  const top = `${source.repository.split("/")[1]}-${source.commit}`;
  const tar = spawnSync("tar", ["-xzf", archive, "-C", path, "--strip-components=1", ...source.paths.map((p) => `${top}/${p}`), `${top}/package.json`], { stdio: "inherit" });
  rmSync(archive, { force: true });
  if (tar.status !== 0) {
    console.error(`could not unpack the ${source.repository} archive (is tar installed?)`);
    process.exit(1);
  }
  console.log(`${source.repository} ${source.commit.slice(0, 7)} ${source.paths.join(", ")}/ is in ${path}`);
}
