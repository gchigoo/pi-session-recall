#!/usr/bin/env node
import { runCli } from "../src/adapters/cli/main.js";

const code = await runCli(process.argv);
process.exit(code);
