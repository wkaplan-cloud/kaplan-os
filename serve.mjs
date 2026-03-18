import { spawn } from 'child_process'

console.log('🚀 Starting Kaplan OS...\n')
const proc = spawn('node', ['server.js'], { stdio: 'inherit' })
proc.on('exit', code => process.exit(code ?? 0))
