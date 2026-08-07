#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');

console.log('\x1b[36m%s\x1b[0m', '🚀 Launching EduNova X Stack...');

// Check if .env exists, if not warn
if (!fs.existsSync(path.join(rootDir, 'server', '.env'))) {
    console.warn('\x1b[33m%s\x1b[0m', '⚠️  Warning: server/.env not found. Did you run the setup script?');
}

const startProcess = (command, args, name, color) => {
    const proc = spawn(command, args, { 
        cwd: rootDir, 
        shell: true,
        stdio: 'inherit'
    });

    proc.on('error', (err) => {
        console.error(`\x1b[31m[${name}] Failed to start: ${err.message}\x1b[0m`);
    });

    return proc;
};

// Use the root package.json "start" script logic but via npm
// This ensures concurrently and other devDependencies work if installed
const main = startProcess('npm', ['start'], 'MainStack', '32');

process.on('SIGINT', () => {
    console.log('\x1b[31m%s\x1b[0m', '🛑 Shutting down EduNova X...');
    main.kill();
    process.exit();
});
