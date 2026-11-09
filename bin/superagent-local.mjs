#!/usr/bin/env node
import { main } from '../lib/local-cli.js'
main().catch(error => { console.error(error.message); process.exitCode = 1 })
