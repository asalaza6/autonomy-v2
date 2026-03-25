#!/usr/bin/env node

import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const smokePath = path.join(__dirname, '..', 'tests', 'smoke', 'package-smoke.test.js');

execFileSync(process.execPath, [smokePath], { stdio: 'inherit' });

