//вайбкодинг на ассемблере✌🥀
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN_TTL_MS = 5 * 60 * 1000; // временная ссылка живёт 5 минут

const TIKTOK_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://www.tiktok.com/',
};

let browser = null;
const tokens = new Map(); // token -> { url, expiresAt }

async function getBrowser() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  browser.on('disconnected', () => (browser = null));
  return browser;
}

const normalizeUrl = (raw) => raw && raw.replace(/\\u002F/g, '/');

function playAddrOf(item) {
  const addr = item?.video?.playAddr ?? item?.video?.downloadAddr;
  if (typeof addr === 'string') return normalizeUrl(addr);
  if (addr && Array.isArray(addr.urlList)) return normalizeUrl(addr.urlList[0]);
  return null;
}

// Открываем /foryou и достаём случайное видео из рекомендаций
async function fetchRandomVideoUrl() {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(TIKTOK_HEADERS['User-Agent']);

    const apiPromise = page
      .waitForResponse((r) => r.url().includes('/api/recommend/item_list'), { timeout: 45_000 })
      .catch(() => null);

    await page.goto('https://www.tiktok.com/foryou', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    // Вариант 1: перехват JSON из внутреннего API рекомендаций
    const apiRes = await apiPromise;
    if (apiRes) {
      const data = await apiRes.json().catch(() => null);
      const urls = (data?.itemList || []).map(playAddrOf).filter(Boolean);
      if (urls.length) return urls[Math.floor(Math.random() * urls.length)];
    }

    // Вариант 2: уже отрендеренные <video> в DOM
    await page.waitForSelector('video[src]', { timeout: 20_000 });
    const urls = await page.$$eval('video[src]', (els) => els.map((v) => v.src));
    if (!urls.length) throw new Error('TikTok не отдал видео (возможно, капча)');
    return normalizeUrl(urls[Math.floor(Math.random() * urls.length)]);
  } finally {
    await page.close().catch(() => {});
  }
}

// 1) Выдаёт случайное видео + временную ссылку
app.get('/api/random-video', async (req, res) => {
  try {
    const url = await fetchRandomVideoUrl();
    const token = crypto.randomBytes(16).toString('hex');
    tokens.set(token, { url, expiresAt: Date.now() + TOKEN_TTL_MS });
    res.json({
      watchUrl: `${req.protocol}://${req.get('host')}/watch/${token}`,
      expiresInSec: TOKEN_TTL_MS / 1000,
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// 2) Прокси-смотрелка: отдаёт mp4 напрямую, поддерживает перемотку (Range)
app.get('/watch/:token', async (req, res) => {
  const entry = tokens.get(req.params.token);
  if (!entry) return res.status(404).send('Ссылка не найдена');
  if (entry.expiresAt < Date.now()) {
    tokens.delete(req.params.token);
    return res.status(410).send('Ссылка истекла');
  }

  try {
    const upstream = await fetch(entry.url, {
      headers: {
        Referer: TIKTOK_HEADERS.Referer,
        'User-Agent': TIKTOK_HEADERS['User-Agent'],
        // часть CDN TikTok отдаёт 403 без Range — шлём его принудительно
        Range: req.headers.range || 'bytes=0-',
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).send('CDN TikTok вернул ошибку: ' + upstream.status);
    }

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    res.status(502).send('Ошибка проксирования видео');
  }
});

app.get('/', (_req, res) => res.redirect('/api/random-video'));

// Уборка истёкших токенов
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of tokens) if (v.expiresAt < now) tokens.delete(t);
}, 60_000).unref();

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
