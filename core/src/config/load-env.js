const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

let envLoaded = false;
let envLoadResult = { loadedFiles: [], appliedKeys: 0 };

function stripInlineComment(value) {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            continue;
        }
        if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            continue;
        }
        if (char === '#' && !inSingleQuote && !inDoubleQuote) {
            if (i === 0 || /\s/.test(value[i - 1])) {
                return value.slice(0, i).trimEnd();
            }
        }
    }
    return value.trim();
}

function normalizeEnvValue(rawValue) {
    const value = stripInlineComment(String(rawValue || '').trim());
    if (!value) return '';
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        const inner = value.slice(1, -1);
        if (quote === '"') {
            return inner
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t')
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
        }
        return inner.replace(/\\'/g, "'");
    }
    return value;
}

function parseEnvFile(content) {
    const parsed = {};
    const lines = String(content || '').split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
        const eqIndex = normalized.indexOf('=');
        if (eqIndex <= 0) continue;
        const key = normalized.slice(0, eqIndex).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        parsed[key] = normalizeEnvValue(normalized.slice(eqIndex + 1));
    }
    return parsed;
}

function collectCandidateFiles() {
    const repoRoot = path.resolve(__dirname, '../../..');
    const coreRoot = path.resolve(__dirname, '../..');
    const cwd = process.cwd();
    const cwdParent = path.resolve(cwd, '..');
    const candidates = [
        path.join(repoRoot, '.env'),
        path.join(repoRoot, '.env.local'),
        path.join(coreRoot, '.env'),
        path.join(coreRoot, '.env.local'),
        path.join(cwd, '.env'),
        path.join(cwd, '.env.local'),
        path.join(cwdParent, '.env'),
        path.join(cwdParent, '.env.local'),
    ];
    return [...new Set(candidates)];
}

function loadProjectEnv() {
    if (envLoaded) return envLoadResult;

    const loadedFiles = [];
    let appliedKeys = 0;

    for (const filePath of collectCandidateFiles()) {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
        const parsed = parseEnvFile(fs.readFileSync(filePath, 'utf8'));
        let appliedFromFile = false;
        for (const [key, value] of Object.entries(parsed)) {
            if (process.env[key] !== undefined) continue;
            process.env[key] = value;
            appliedKeys += 1;
            appliedFromFile = true;
        }
        if (appliedFromFile) {
            loadedFiles.push(filePath);
        }
    }

    envLoaded = true;
    envLoadResult = { loadedFiles, appliedKeys };
    return envLoadResult;
}

module.exports = {
    loadProjectEnv,
};
