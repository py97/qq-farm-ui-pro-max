const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_PROJECT_ROOT,
    resolveAiProjectRoot,
} = require('../src/services/ai-workspace');

test('resolveAiProjectRoot rejects non-whitelisted directories by default', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workspace-deny-'));

    try {
        const defaultRoot = resolveAiProjectRoot('', {
            baseDir: DEFAULT_PROJECT_ROOT,
            allowedRootsRaw: '',
        });

        assert.equal(defaultRoot, fs.realpathSync(DEFAULT_PROJECT_ROOT));

        assert.throws(
            () => resolveAiProjectRoot(tempDir, {
                baseDir: DEFAULT_PROJECT_ROOT,
                allowedRootsRaw: '',
            }),
            (error) => {
                assert.equal(error && error.code, 'AI_WORKSPACE_FORBIDDEN');
                assert.ok(Array.isArray(error.allowedRoots));
                assert.ok(error.allowedRoots.includes(fs.realpathSync(DEFAULT_PROJECT_ROOT)));
                return true;
            },
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('resolveAiProjectRoot allows explicitly whitelisted workspace roots', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workspace-allow-'));

    try {
        const resolved = resolveAiProjectRoot(tempDir, {
            baseDir: DEFAULT_PROJECT_ROOT,
            allowedRootsRaw: tempDir,
        });

        assert.equal(resolved, fs.realpathSync(tempDir));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
