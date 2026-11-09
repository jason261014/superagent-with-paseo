#!/usr/bin/env node
import { main } from '../lib/project-cli.js'
main().catch(error => { console.error(error.message); process.exitCode = 1 })
