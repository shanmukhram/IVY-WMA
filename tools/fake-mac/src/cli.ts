#!/usr/bin/env node
import { runCli } from "./main.ts";

process.exitCode = await runCli(process.argv.slice(2));
