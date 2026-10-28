'use strict';
// Preloaded with `node -r` in the login test: scripted iLink QR login responses. No network.
// FAKE_REDIRECT_HOST / FAKE_BASEURL override the redirect host and the returned baseurl; FAKE_URLS records requested URLs.
const steps = [
  { qrcode: 'QR-ID', qrcode_img_content: 'https://liteapp.example.com/q/abc?bot_type=3', ret: 0 },
  { status: 'wait' },
  { status: 'scaned_but_redirect', redirect_host: process.env.FAKE_REDIRECT_HOST || 'redirect.weixin.qq.com' },
  { status: 'scaned' },
  { status: 'confirmed', bot_token: 'fake-bot-token', ilink_bot_id: 'fakebot@im.bot', ilink_user_id: 'scanner@im.wechat',
    baseurl: process.env.FAKE_BASEURL || 'https://ilinkai.weixin.qq.com' },
];
const urls = [];
process.on('exit', () => { if (process.env.FAKE_URLS) require('node:fs').writeFileSync(process.env.FAKE_URLS, JSON.stringify(urls)); });
globalThis.fetch = async (url) => {
  urls.push(String(url));
  return { ok: true, status: 200, text: async () => JSON.stringify(steps.shift() || { status: 'wait' }) };
};
