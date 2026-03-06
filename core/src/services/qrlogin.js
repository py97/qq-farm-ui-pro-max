const { Buffer } = require('node:buffer');
/**
 * QR Code Login Module
 */
const axios = require('axios');

const ChromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class QRLoginSession {
    static async requestQRCode() {
        try {
            const response = await axios.post('http://qqcode.skeo.net/api/qr/create', {}, {
                headers: {
                    'User-Agent': ChromeUA,
                    'Content-Type': 'application/json',
                }
            });

            const data = response.data;
            if (!data.ok) throw new Error(data.error || '获取二维码失败');

            const qrData = data.data;
            return {
                qrsig: qrData.code,
                qrcode: qrData.image || '',
                url: qrData.url
            };
        } catch (error) {
            console.error('Request QRCode Error:', error.message);
            throw error;
        }
    }

    static async checkStatus(qrsig) {
        try {
            const response = await axios.post('http://qqcode.skeo.net/api/qr/check', { code: qrsig }, {
                headers: {
                    'User-Agent': ChromeUA,
                    'Content-Type': 'application/json',
                }
            });

            const data = response.data;
            if (!data.ok) throw new Error(data.error || '检查扫码状态失败');

            const qrData = data.data;
            let ret = '0';
            let msg = '未知状态';
            let jumpUrl = '';

            if (qrData.status === 'OK' && qrData.code) {
                ret = '0';
                msg = '登录成功';
                jumpUrl = qrData.code;
            } else if (qrData.status === 'Used') {
                ret = '65';
                msg = '二维码已过期';
            } else if (qrData.status === 'Wait') {
                ret = '66';
                msg = '等待扫码';
            } else {
                ret = '1';
                msg = qrData.error || '扫码不成功';
            }

            return { ret, msg, jumpUrl };
        } catch (error) {
            console.error('Check Status Error:', error.message);
            throw error;
        }
    }
}

class MiniProgramLoginSession {
    static async requestLoginCode() {
        try {
            const response = await axios.post('http://qqcode.skeo.net/api/qr/create', {}, {
                headers: {
                    'User-Agent': ChromeUA,
                    'Content-Type': 'application/json',
                }
            });

            const data = response.data;
            if (!data.ok) throw new Error(data.error || '获取登录码失败');
            const qrData = data.data;

            return {
                code: qrData.code,
                url: qrData.url,
                image: qrData.image,
            };
        } catch (error) {
            console.error('MP Request Login Code Error:', error.message);
            throw error;
        }
    }

    static async queryStatus(code) {
        try {
            const response = await axios.post('http://qqcode.skeo.net/api/qr/check', { code }, {
                headers: {
                    'User-Agent': ChromeUA,
                    'Content-Type': 'application/json',
                }
            });

            if (response.status !== 200) return { status: 'Error' };
            const data = response.data;
            if (!data.ok) return { status: 'Error', msg: data.error || '未知错误' };
            const qrData = data.data;

            if (qrData.status === 'OK' && qrData.code) {
                return {
                    status: 'OK',
                    ticket: qrData.code,
                    uin: qrData.uin || '',
                    nickname: qrData.nickname || ''
                };
            } else if (qrData.status === 'Used') {
                return { status: 'Used' };
            } else if (qrData.status === 'Wait' || qrData.status === 'Check') {
                return { status: qrData.status };
            } else {
                return { status: 'Error', msg: qrData.error || '未知错误' };
            }
        } catch (error) {
            console.error('MP Query Status Error:', error.message);
            throw error;
        }
    }

    static async getAuthCode(ticket, appid = '1112386029') {
        // 第三方接口直接返回最终的 code，无需用 ticket 进行兑换转换，只需透传返回
        return ticket || '';
    }
}

module.exports = { QRLoginSession, MiniProgramLoginSession };
