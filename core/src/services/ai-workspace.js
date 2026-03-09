const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { loadProjectEnv } = require('../config/load-env');

loadProjectEnv();

const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '../../..');
const AI_ALLOWED_CWDS_ENV = 'AI_SERVICE_ALLOWED_CWDS';

function createAiWorkspaceError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function normalizeDirectoryPath(inputPath, baseDir = DEFAULT_PROJECT_ROOT) {
    const raw = String(inputPath || '').trim();
    const resolved = raw
        ? (path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw))
        : baseDir;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw createAiWorkspaceError(`目录不存在: ${resolved}`, 'AI_WORKSPACE_MISSING', {
            requestedPath: resolved,
        });
    }
    return fs.realpathSync(resolved);
}

function getAllowedAiProjectRoots(options = {}) {
    const baseDir = path.resolve(String(options.baseDir || DEFAULT_PROJECT_ROOT));
    const rawEnv = options.allowedRootsRaw !== undefined
        ? options.allowedRootsRaw
        : process.env[AI_ALLOWED_CWDS_ENV];
    const roots = [normalizeDirectoryPath(baseDir, baseDir)];
    const extraItems = String(rawEnv || '')
        .split(/[\n,;]/)
        .map(item => item.trim())
        .filter(Boolean);

    for (const item of extraItems) {
        try {
            roots.push(normalizeDirectoryPath(item, baseDir));
        } catch {
            // Ignore non-existent whitelist entries; concrete requests will still fail explicitly.
        }
    }

    return [...new Set(roots)];
}

function describeAllowedAiProjectRoots(options = {}) {
    return getAllowedAiProjectRoots(options).join(', ');
}

function isAiWorkspaceError(error) {
    const code = String(error && error.code || '');
    return code === 'AI_WORKSPACE_MISSING' || code === 'AI_WORKSPACE_FORBIDDEN';
}

function resolveAiProjectRoot(inputPath, options = {}) {
    const baseDir = path.resolve(String(options.baseDir || DEFAULT_PROJECT_ROOT));
    const requestedPath = normalizeDirectoryPath(inputPath, baseDir);
    const allowedRoots = getAllowedAiProjectRoots({
        baseDir,
        allowedRootsRaw: options.allowedRootsRaw,
    });
    if (!allowedRoots.includes(requestedPath)) {
        throw createAiWorkspaceError(
            `目录不在 AI 服务允许范围内: ${requestedPath}。允许目录: ${allowedRoots.join(', ')}`,
            'AI_WORKSPACE_FORBIDDEN',
            {
                requestedPath,
                allowedRoots,
            },
        );
    }
    return requestedPath;
}

module.exports = {
    AI_ALLOWED_CWDS_ENV,
    DEFAULT_PROJECT_ROOT,
    createAiWorkspaceError,
    describeAllowedAiProjectRoots,
    getAllowedAiProjectRoots,
    isAiWorkspaceError,
    resolveAiProjectRoot,
};
