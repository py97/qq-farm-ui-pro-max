/**
 * 推送接口封装（基于 pushoo）
 */

const pushoo = require('pushoo').default;
const { sendEmailMessage } = require('./smtp-mailer');

function assertRequiredText(name, value) {
    const text = String(value || '').trim();
    if (!text) {
        throw new Error(`${name} 不能为空`);
    }
    return text;
}

/**
 * 发送推送
 * @param {object} payload
 * @param {string} payload.channel 必填 推送渠道（pushoo 平台名，如 webhook，或 email）
 * @param {string} [payload.endpoint] webhook 接口地址（channel=webhook 时使用）
 * @param {string} payload.token 必填 推送 token
 * @param {string} payload.title 必填 推送标题
 * @param {string} payload.content 必填 推送内容
 * @param {string} [payload.smtpHost] SMTP 服务器地址（channel=email 时使用）
 * @param {number|string} [payload.smtpPort] SMTP 端口（channel=email 时使用）
 * @param {boolean|string} [payload.smtpSecure] SMTP 是否直连 TLS（channel=email 时使用）
 * @param {string} [payload.smtpUser] SMTP 用户名（channel=email 时使用）
 * @param {string} [payload.smtpPass] SMTP 密码（channel=email 时使用）
 * @param {string} [payload.emailFrom] 发件邮箱（channel=email 时使用）
 * @param {string} [payload.emailTo] 收件邮箱，支持多个（channel=email 时使用）
 * @returns {Promise<{ok: boolean, code: string, msg: string, raw: any}>} 推送结果
 */
async function sendPushooMessage(payload = {}) {
    const channel = assertRequiredText('channel', payload.channel);
    const title = assertRequiredText('title', payload.title);
    const content = assertRequiredText('content', payload.content);

    if (channel === 'email') {
        return await sendEmailMessage({
            title,
            content,
            smtpHost: payload.smtpHost,
            smtpPort: payload.smtpPort,
            smtpSecure: payload.smtpSecure,
            smtpUser: payload.smtpUser,
            smtpPass: payload.smtpPass,
            emailFrom: payload.emailFrom,
            emailTo: payload.emailTo,
        });
    }

    const endpoint = String(payload.endpoint || '').trim();
    const rawToken = String(payload.token || '').trim();
    const token = channel === 'webhook' ? rawToken : assertRequiredText('token', rawToken);

    if (channel === 'webhook' && payload.webhookBody && typeof payload.webhookBody === 'object') {
        const url = assertRequiredText('endpoint', endpoint);
        const headers = { 'content-type': 'application/json' };
        if (token) {
            headers.authorization = `Bearer ${token}`;
            headers['x-token'] = token;
        }
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload.webhookBody),
        });
        let rawBody = '';
        try {
            rawBody = await response.text();
        } catch { }
        return {
            ok: response.ok,
            code: String(response.status || (response.ok ? 'ok' : 'error')),
            msg: response.ok ? 'ok' : `http_${response.status}`,
            raw: {
                status: response.status,
                statusText: response.statusText,
                body: rawBody,
            },
        };
    }

    const options = {};
    if (channel === 'webhook') {
        const url = assertRequiredText('endpoint', endpoint);
        options.webhook = { url, method: 'POST' };
    }

    const request = { title, content };
    if (token) request.token = token;
    if (channel === 'webhook') request.options = options;

    const result = await pushoo(channel, request);

    const raw = (result && typeof result === 'object') ? result : { data: result };
    const hasError = !!(raw && raw.error);
    const code = String(raw.code || raw.errcode || (hasError ? 'error' : 'ok'));
    const message = String(raw.msg || raw.message || (hasError ? (raw.error.message || 'push failed') : 'ok'));
    const ok = !hasError && (code === 'ok' || code === '0' || code === '' || String(raw.status || '').toLowerCase() === 'success');

    return {
        ok,
        code,
        msg: message,
        raw,
    };
}

module.exports = {
    sendPushooMessage,
};
