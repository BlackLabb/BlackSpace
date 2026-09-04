// blackspace-api Cloudflare Worker
// Proxies price and investment-news requests while keeping API keys server-side.

const ALLOWED_ORIGINS = [
  'https://blacklabb.github.io',
  'https://blackspace-d3ab9.web.app',
  'https://blackspace-d3ab9.firebaseapp.com',
  'https://blackspace.markchanchun.workers.dev',
  'http://localhost',
  'http://127.0.0.1',
];

const COMPANY_ALIASES = {
  NVDA: ['NVIDIA', 'NVIDIA CORPORATION'],
  GOOGL: ['ALPHABET', 'GOOGLE'],
  AAPL: ['APPLE', 'APPLE INC'],
  MSFT: ['MICROSOFT', 'MICROSOFT CORPORATION'],
  AMZN: ['AMAZON', 'AMAZON.COM'],
  TSM: ['TAIWAN SEMICONDUCTOR', 'TSMC'],
  AVGO: ['BROADCOM', 'BROADCOM INC'],
  META: ['META', 'META PLATFORMS', 'FACEBOOK'],
  TSLA: ['TESLA', 'TESLA INC'],
  WMT: ['WALMART', 'WALMART INC'],
};

const cache = new Map();
const inFlight = new Map();
const PRICE_CACHE_TTL = 60 * 1000;
const NEWS_CACHE_TTL = 10 * 60 * 1000;
const NEWS_EDGE_CACHE_TTL = 30 * 60;
const NEWS_SOURCE_VERSION = 'finnhub-v1';
const STOCK_SCORE_MODEL_VERSION = 'institutional-v1';
const STOCK_AI_CACHE_TTL = 24 * 60 * 60 * 1000;
const STOCK_AI_EDGE_CACHE_TTL = 24 * 60 * 60;
const SEC_CACHE_TTL = 24 * 60 * 60 * 1000;
const SEC_SECTION_MAX_CHARS = 16000;
const GLM_ENDPOINT = 'https://api.z.ai/api/paas/v4/chat/completions';
const GLM_MODEL = 'glm-5.3';
const GLM_THINKING = { type: 'enabled' };
const GLM_REASONING_EFFORT = 'max';
const GLM_STOCK_JSON_MAX_TOKENS = 8192;
const FULL_TEXT_MAX_ITEMS = 10;
const FULL_TEXT_MAX_CHARS = 6000;
const ARTICLE_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent': 'Mozilla/5.0 (compatible; BlackSpaceNews/1.0; +https://blackspace.markchanchun.workers.dev)',
};
const SEC_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'BlackSpace/1.0 contact: blackspace.markchanchun.workers.dev',
};
const SEC_READER_BASE = 'https://r.jina.ai/http://';

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o));
  const localFileOrigin = origin === 'null';
  return {
    'Access-Control-Allow-Origin': (!origin || localFileOrigin) ? '*' : (allowed ? origin : ALLOWED_ORIGINS[0]),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status, headers, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers, ...extraHeaders },
  });
}

function validTicker(symbol) {
  return /^[A-Z0-9.\-]{1,15}$/.test(symbol);
}

function escRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textHasTerm(text, term) {
  return new RegExp(`(^|[^A-Z0-9])${escRegExp(term)}([^A-Z0-9]|$)`, 'i').test(text);
}

function companyFocused(item, symbol) {
  const entityText = Array.isArray(item.entities)
    ? item.entities.map(e => `${e.symbol || ''} ${e.name || ''}`).join(' ')
    : '';
  const text = `${item.title || ''} ${item.summary || ''} ${item.description || ''} ${item.snippet || ''} ${entityText}`.toUpperCase();
  return [symbol, ...(COMPANY_ALIASES[symbol] || [])].some(term => textHasTerm(text, term));
}

function sentimentScore(item, symbols) {
  if (Array.isArray(item.entities)) {
    const scores = item.entities
      .filter(e => symbols.includes(String(e.symbol || '').toUpperCase()))
      .map(e => Number(e.sentiment_score))
      .filter(Number.isFinite);
    if (scores.length) return scores.reduce((a, b) => a + b, 0) / scores.length;
  }
  const matches = Array.isArray(item.ticker_sentiment)
    ? item.ticker_sentiment.filter(t => symbols.includes(String(t.ticker || '').toUpperCase()))
    : [];
  if (matches.length) {
    const scores = matches.map(t => Number(t.ticker_sentiment_score)).filter(Number.isFinite);
    if (scores.length) return scores.reduce((a, b) => a + b, 0) / scores.length;
  }
  const overall = Number(item.overall_sentiment_score);
  return Number.isFinite(overall) ? overall : 0;
}

function relevanceScore(item, symbols) {
  if (Array.isArray(item.entities)) {
    const matches = item.entities.filter(e => symbols.includes(String(e.symbol || '').toUpperCase()));
    if (matches.length) return 1;
  }
  const matches = Array.isArray(item.ticker_sentiment)
    ? item.ticker_sentiment.filter(t => symbols.includes(String(t.ticker || '').toUpperCase()))
    : [];
  const scores = matches.map(t => Number(t.relevance_score)).filter(Number.isFinite);
  return scores.length ? Math.max(...scores) : 0;
}

function normalizeNewsItem(item, symbols) {
  const matchedTickers = symbols.filter(symbol => companyFocused(item, symbol));
  return {
    title: item.title || '',
    url: item.url || '#',
    time: item.published_at || item.time_published || item.time || '',
    source: item.source || item.source_domain || 'RSS Feed',
    summary: item.summary || item.description || item.snippet || '',
    sentiment: sentimentScore(item, symbols),
    relevance: relevanceScore(item, symbols),
    tickers: matchedTickers,
  };
}

function formatDateParam(date) {
  return date.toISOString().slice(0, 10);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function extractArticleText(html) {
  const cleaned = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  const articleMatch = cleaned.match(/<article\b[\s\S]*?<\/article>/i);
  const source = articleMatch ? articleMatch[0] : cleaned;
  return decodeHtml(source)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FULL_TEXT_MAX_CHARS);
}

async function fetchArticleText(item) {
  const stat = { url: item.url, ok: false, status: 0, chars: 0, source: 'summary' };
  try {
    const articleUrl = new URL(item.url);
    if (!['http:', 'https:'].includes(articleUrl.protocol)) {
      stat.error = 'invalid url';
      return { item: { ...item, contentSource: 'summary', fullTextStatus: stat }, stat };
    }
    const resp = await fetch(articleUrl.toString(), {
      headers: ARTICLE_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(7000),
      cf: { cacheTtl: 1800, cacheEverything: true },
    });
    stat.status = resp.status;
    if (!resp.ok) {
      stat.error = `http ${resp.status}`;
      return { item: { ...item, contentSource: 'summary', fullTextStatus: stat }, stat };
    }
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      stat.error = `unsupported content-type ${contentType}`;
      return { item: { ...item, contentSource: 'summary', fullTextStatus: stat }, stat };
    }
    const text = extractArticleText(await resp.text());
    stat.chars = text.length;
    if (text.length < 500) {
      stat.error = 'article text too short';
      return { item: { ...item, contentSource: 'summary', fullTextStatus: stat }, stat };
    }
    stat.ok = true;
    stat.source = 'fulltext';
    return { item: { ...item, fullText: text, contentSource: 'fulltext', fullTextStatus: stat }, stat };
  } catch (err) {
    stat.error = err.message || 'fetch failed';
    return { item: { ...item, contentSource: 'summary', fullTextStatus: stat }, stat };
  }
}

async function enrichWithFullText(items) {
  const head = items.slice(0, FULL_TEXT_MAX_ITEMS);
  const tail = items.slice(FULL_TEXT_MAX_ITEMS).map(item => ({ ...item, contentSource: 'summary' }));
  const results = await Promise.all(head.map(fetchArticleText));
  return {
    feed: [...results.map(result => result.item), ...tail],
    stats: results.map(result => result.stat),
  };
}

async function fetchFinnhubNewsForSymbol(symbol, env, debugStats = []) {
  const stat = { symbol, source: 'Finnhub Company News', ok: false, status: 0, itemCount: 0 };
  const apiKey = env.FINNHUB_KEY;
  if (!apiKey) {
    stat.error = 'FINNHUB_KEY missing';
    debugStats.push(stat);
    return [];
  }
  const to = new Date();
  const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
  const apiUrl = new URL('https://finnhub.io/api/v1/company-news');
  apiUrl.searchParams.set('symbol', symbol);
  apiUrl.searchParams.set('from', formatDateParam(from));
  apiUrl.searchParams.set('to', formatDateParam(to));
  apiUrl.searchParams.set('token', apiKey);

  try {
    const resp = await fetch(apiUrl.toString(), { cf: { cacheTtl: 1800, cacheEverything: true } });
    stat.status = resp.status;
    if (!resp.ok) {
      debugStats.push(stat);
      return [];
    }
    const data = await resp.json();
    const items = Array.isArray(data) ? data.map(item => ({
      title: item.headline || '',
      summary: item.summary || item.headline || '',
      url: item.url || '#',
      time: item.datetime ? new Date(Number(item.datetime) * 1000).toISOString() : new Date().toISOString(),
      source: item.source || 'Finnhub',
      sentiment: 0,
      relevance: 1,
      tickers: [symbol],
    })).filter(item => item.title && item.url) : [];
    stat.ok = true;
    stat.itemCount = items.length;
    debugStats.push(stat);
    return items;
  } catch (err) {
    stat.error = err.message || 'fetch failed';
    debugStats.push(stat);
    return [];
  }
}

function fallbackSentiment(item) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  const positives = ['beat', 'beats', 'surge', 'surges', 'rise', 'rises', 'rally', 'upgrade', 'raises', 'growth', 'strong', 'record', 'bullish', 'profit', 'gain', 'gains'];
  const negatives = ['miss', 'falls', 'fall', 'drop', 'drops', 'downgrade', 'weak', 'lawsuit', 'probe', 'investigation', 'bearish', 'loss', 'decline', 'cuts'];
  const pos = positives.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
  const neg = negatives.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
  return Math.max(-0.8, Math.min(0.8, (pos - neg) * 0.18));
}

function normalizeSentimentValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

function normalizeImpact(row, sentiment) {
  const allowedHorizons = ['short', 'medium', 'long', 'neutral'];
  const allowedDirections = ['positive', 'negative', 'neutral'];
  const direction = allowedDirections.includes(row?.direction) ? row.direction : (sentiment > 0.12 ? 'positive' : sentiment < -0.12 ? 'negative' : 'neutral');
  const horizon = allowedHorizons.includes(row?.horizon) ? row.horizon : (direction === 'neutral' ? 'neutral' : 'short');
  const label = String(row?.label || '').trim() || (
    direction === 'positive' ? (horizon === 'long' ? '長期正面' : horizon === 'medium' ? '中期正面' : '短期正面') :
    direction === 'negative' ? (horizon === 'long' ? '長期負面' : horizon === 'medium' ? '中期負面' : '短期負面') :
    '中性'
  );
  const confidence = Number(row?.confidence);
  return {
    direction,
    horizon,
    label,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    reason: String(row?.reason || '').trim(),
  };
}

function fallbackPriceImpact(item) {
  const sentiment = fallbackSentiment(item);
  return normalizeImpact(null, sentiment);
}

async function analyzeSentimentWithGlm(items, env) {
  const apiKey = env.GLM_API_KEY;
  if (!apiKey || !items.length) {
    return items.map(item => ({ ...item, sentiment: fallbackSentiment(item), priceImpact: fallbackPriceImpact(item), sentimentProvider: 'rules' }));
  }
  const payload = items.slice(0, 20).map((item, index) => ({
    index,
    title: item.title,
    summary: item.summary,
    content: item.fullText || item.summary,
    contentSource: item.contentSource || 'summary',
    tickers: item.tickers,
  }));
  try {
    const resp = await fetch(GLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        response_format: { type: 'json_object' },
        thinking: GLM_THINKING,
        reasoning_effort: GLM_REASONING_EFFORT,
        messages: [
          { role: 'system', content: 'Return only JSON. Analyze investment news for the named ticker. Use content as the primary evidence when contentSource is fulltext; otherwise use title and summary. For each item, return sentiment from -1 to 1 and priceImpact. priceImpact must classify expected stock impact by horizon and direction: horizon is one of short, medium, long, neutral; direction is one of positive, negative, neutral; label must be Traditional Chinese and one of 短期正面, 中期正面, 長期正面, 短期負面, 中期負面, 長期負面, 中性. Confidence is 0 to 1. Output {"items":[{"index":0,"sentiment":0.2,"priceImpact":{"horizon":"short","direction":"positive","label":"短期正面","confidence":0.7,"reason":"brief reason"}}]}. No prose.' },
          { role: 'user', content: JSON.stringify({ items: payload }) },
        ],
      }),
    });
    if (!resp.ok) throw new Error('GLM upstream error');
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const scored = new Map((parsed.items || []).map(row => [Number(row.index), row]));
    return items.map((item, index) => ({
      ...item,
      sentiment: scored.has(index) ? normalizeSentimentValue(scored.get(index).sentiment) : fallbackSentiment(item),
      priceImpact: scored.has(index) ? normalizeImpact(scored.get(index).priceImpact, normalizeSentimentValue(scored.get(index).sentiment)) : fallbackPriceImpact(item),
      sentimentProvider: scored.has(index) ? 'glm' : 'rules',
      fullText: undefined,
    }));
  } catch (_) {
    return items.map(item => ({ ...item, fullText: undefined, sentiment: fallbackSentiment(item), priceImpact: fallbackPriceImpact(item), sentimentProvider: 'rules' }));
  }
}

function fallbackNewsDigest(items, tickers, lang = 'zh') {
  const topItems = items.slice(0, FULL_TEXT_MAX_ITEMS);
  const positive = topItems.filter(item => fallbackSentiment(item) > 0.12).length;
  const negative = topItems.filter(item => fallbackSentiment(item) < -0.12).length;
  const tone = positive > negative ? 'positive' : negative > positive ? 'negative' : 'neutral';
  const isZh = lang === 'zh';
  return {
    title: isZh ? `${tickers.join(', ')} AI 分析` : `${tickers.join(', ')} AI Analysis`,
    overall: topItems.length
      ? (isZh ? `根據最新 ${topItems.length} 篇公司相關新聞，整體新聞情緒偏向 ${tone === 'positive' ? '正面' : tone === 'negative' ? '負面' : '中性'}。` : `Based on the latest ${topItems.length} company-related articles, the news flow is ${tone}.`)
      : (isZh ? '暫時沒有可供分析的新聞。' : 'No articles are available for analysis.'),
    stockImpact: tone === 'positive'
      ? (isZh ? '短期股價環境較有支持，但仍需要配合價格走勢和公司公告確認。' : 'The near-term setup looks supportive, but confirmation from price action and company filings is still needed.')
      : tone === 'negative'
        ? (isZh ? '短期股價可能承壓，需要分辨事件是公司本身問題還是市場雜訊。' : 'The near-term setup may face pressure; verify whether the issues are company-specific or broad market noise.')
        : (isZh ? '新聞訊號較混合，股價影響可能有限，需等待更清晰催化因素。' : 'The news flow is mixed, so stock impact is likely limited until clearer catalysts appear.'),
    risks: isZh ? 'AI 分析可能包含錯誤，投資前請核實原始新聞來源。' : 'This AI analysis may contain errors. Verify the original sources before making investment decisions.',
    keyPoints: topItems.slice(0, 3).map(item => item.title).filter(Boolean),
    tone,
    itemsAnalyzed: topItems.length,
    provider: 'rules',
  };
}

async function analyzeNewsDigestWithGlm(items, env, tickers, lang = 'zh') {
  const apiKey = env.GLM_API_KEY;
  const topItems = items.slice(0, FULL_TEXT_MAX_ITEMS);
  if (!apiKey || !topItems.length) return fallbackNewsDigest(topItems, tickers, lang);
  const languageName = lang === 'en' ? 'English' : 'Traditional Chinese';
  const outputTitle = lang === 'en' ? 'AI Analysis' : 'AI 分析';
  const payload = topItems.map((item, index) => ({
    index,
    title: item.title,
    summary: item.summary,
    content: item.fullText || item.summary,
    contentSource: item.contentSource || 'summary',
    tickers: item.tickers,
  }));
  try {
    const resp = await fetch(GLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        response_format: { type: 'json_object' },
        thinking: GLM_THINKING,
        reasoning_effort: GLM_REASONING_EFFORT,
        messages: [
          { role: 'system', content: `Return only JSON in ${languageName}. You are analyzing the first 10 full-text investment news items for the requested stock tickers. Focus on company-specific implications, not generic market commentary. Output {"title":"${outputTitle}","overall":"2-3 sentences","stockImpact":"2-3 sentences about likely stock impact","risks":"1-2 sentences","keyPoints":["point 1","point 2","point 3"],"tone":"positive|negative|neutral"}. Do not give financial advice.` },
          { role: 'user', content: JSON.stringify({ tickers, items: payload }) },
        ],
      }),
    });
    if (!resp.ok) throw new Error('GLM digest upstream error');
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const tone = ['positive', 'negative', 'neutral'].includes(parsed.tone) ? parsed.tone : 'neutral';
    return {
      title: String(parsed.title || (lang === 'en' ? 'AI Analysis' : 'AI 分析')).trim(),
      overall: String(parsed.overall || '').trim(),
      stockImpact: String(parsed.stockImpact || '').trim(),
      risks: String(parsed.risks || '').trim(),
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(point => String(point).trim()).filter(Boolean).slice(0, 4) : [],
      tone,
      itemsAnalyzed: topItems.length,
      provider: 'glm',
    };
  } catch (_) {
    return fallbackNewsDigest(topItems, tickers, lang);
  }
}

function sortNews(feed, sort) {
  if (sort === 'sentiment') return feed.sort((a, b) => b.sentiment - a.sentiment);
  if (sort === 'relevance') return feed.sort((a, b) => b.relevance - a.relevance);
  return feed.sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

function keyFingerprint(apiKey) {
  if (!apiKey) return null;
  const key = String(apiKey);
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function newsCacheRequest(cacheKey) {
  return new Request(`https://blackspace-worker-cache.local/${encodeURIComponent(cacheKey)}`);
}

async function readCachedNews(cacheKey, corsHeaders, stale = false) {
  const cached = await caches.default.match(newsCacheRequest(cacheKey));
  if (!cached) return null;
  const data = await cached.json();
  return json(data, 200, corsHeaders, {
    'X-Cache': stale ? 'STALE' : 'EDGE',
    ...(stale ? { 'Warning': '110 - News source unavailable; serving cached news' } : {}),
  });
}

async function writeCachedNews(cacheKey, data) {
  const response = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${NEWS_EDGE_CACHE_TTL}`,
    },
  });
  await caches.default.put(newsCacheRequest(cacheKey), response);
}

async function writeCachedStockAnalysis(cacheKey, data) {
  const response = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${STOCK_AI_EDGE_CACHE_TTL}` },
  });
  await caches.default.put(newsCacheRequest(cacheKey), response);
}

async function handlePrice(url, env, corsHeaders) {
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!symbol) return json({ error: 'Missing symbol parameter' }, 400, corsHeaders);
  if (!validTicker(symbol)) return json({ error: 'Invalid symbol' }, 400, corsHeaders);

  const cacheKey = `price:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL) {
    return json(cached.data, 200, corsHeaders, { 'X-Cache': 'HIT' });
  }

  const apiKey = env.FINNHUB_KEY;
  if (!apiKey) return json({ error: 'Server not configured' }, 500, corsHeaders);

  const finnhubUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const resp = await fetch(finnhubUrl, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!resp.ok) return json({ error: 'Upstream error', status: resp.status }, 502, corsHeaders);

  const data = await resp.json();
  cache.set(cacheKey, { ts: Date.now(), data });
  return json(data, 200, corsHeaders, { 'X-Cache': 'MISS' });
}

async function handleFinnhubRoute(url, env, corsHeaders, endpoint, ttl = 60) {
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!symbol) return json({ error: 'Missing symbol parameter' }, 400, corsHeaders);
  if (!validTicker(symbol)) return json({ error: 'Invalid symbol' }, 400, corsHeaders);

  const apiKey = env.FINNHUB_KEY;
  if (!apiKey) return json({ error: 'Server not configured' }, 500, corsHeaders);

  const cacheKey = `${endpoint}:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ttl * 1000) {
    return json(cached.data, 200, corsHeaders, { 'X-Cache': 'HIT' });
  }

  const apiUrl = new URL(`https://finnhub.io/api/v1/${endpoint}`);
  apiUrl.searchParams.set('symbol', symbol);
  apiUrl.searchParams.set('token', apiKey);

  const resp = await fetch(apiUrl.toString(), { cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!resp.ok) return json({ error: 'Upstream error', status: resp.status }, 502, corsHeaders);

  const data = await resp.json();
  cache.set(cacheKey, { ts: Date.now(), data });
  return json(data, 200, corsHeaders, { 'X-Cache': 'MISS' });
}

async function fetchFinnhubData(symbol, env, endpoint, ttl = 60, extraParams = {}) {
  const apiKey = env.FINNHUB_KEY;
  if (!apiKey) throw new Error('FINNHUB_KEY missing');
  const cacheKey = `${endpoint}:${symbol}:${JSON.stringify(extraParams)}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ttl * 1000) return cached.data;

  const apiUrl = new URL(`https://finnhub.io/api/v1/${endpoint}`);
  apiUrl.searchParams.set('symbol', symbol);
  Object.entries(extraParams).forEach(([key, value]) => apiUrl.searchParams.set(key, value));
  apiUrl.searchParams.set('token', apiKey);

  const resp = await fetch(apiUrl.toString(), { cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!resp.ok) throw new Error(`${endpoint} upstream error ${resp.status}`);
  const data = await resp.json();
  cache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

function secReaderUrl(value) {
  const url = new URL(value);
  return `${SEC_READER_BASE}${url.host}${url.pathname}${url.search}`;
}

function unwrapSecReaderText(text) {
  const value = String(text || '');
  const marker = 'Markdown Content:';
  const index = value.indexOf(marker);
  return (index >= 0 ? value.slice(index + marker.length) : value).trim();
}

async function fetchSecJson(url) {
  let directStatus = 'network';
  try {
    const direct = await fetch(url, {
      headers: SEC_HEADERS,
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 86400, '400-599': 0 } },
    });
    directStatus = direct.status;
    if (direct.ok) return await direct.json();
  } catch (_) {}

  const fallback = await fetch(secReaderUrl(url), {
    headers: { 'Accept': 'text/plain' },
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 86400, '400-599': 0 } },
  });
  if (!fallback.ok) {
    const err = new Error(`SEC upstream error ${directStatus}; fallback error ${fallback.status}`);
    err.status = 502;
    throw err;
  }
  try {
    return JSON.parse(unwrapSecReaderText(await fallback.text()));
  } catch (_) {
    const err = new Error('SEC fallback returned invalid JSON');
    err.status = 502;
    throw err;
  }
}

async function fetchSecText(url) {
  let directStatus = 'network';
  try {
    const direct = await fetch(url, {
      headers: SEC_HEADERS,
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 86400, '400-599': 0 } },
    });
    directStatus = direct.status;
    if (direct.ok) return await direct.text();
  } catch (_) {}

  const fallback = await fetch(secReaderUrl(url), {
    headers: { 'Accept': 'text/plain' },
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 86400, '400-599': 0 } },
  });
  if (!fallback.ok) {
    const err = new Error(`SEC document error ${directStatus}; fallback error ${fallback.status}`);
    err.status = 502;
    throw err;
  }
  return unwrapSecReaderText(await fallback.text());
}

async function getSecTickerMap() {
  const cacheKey = 'sec:ticker-map';
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEC_CACHE_TTL) return cached.data;

  const raw = await fetchSecJson('https://www.sec.gov/files/company_tickers.json');
  const byTicker = {};
  Object.values(raw || {}).forEach(row => {
    const ticker = String(row.ticker || '').toUpperCase();
    if (!ticker) return;
    byTicker[ticker] = {
      cik: String(row.cik_str || '').padStart(10, '0'),
      ticker,
      title: row.title || '',
    };
  });
  cache.set(cacheKey, { ts: Date.now(), data: byTicker });
  return byTicker;
}

function secLatestUnit(units, preferredUnits = ['USD']) {
  for (const unit of preferredUnits) {
    const rows = Array.isArray(units?.[unit]) ? units[unit] : [];
    if (rows.length) return { unit, rows };
  }
  const firstKey = Object.keys(units || {})[0];
  const rows = firstKey ? units[firstKey] : [];
  return { unit: firstKey || '', rows: Array.isArray(rows) ? rows : [] };
}

function secLatestFact(usGaap, concepts, preferredUnits = ['USD'], annualOnly = true) {
  const candidates = [];
  for (const concept of concepts) {
    const node = usGaap?.[concept];
    if (!node?.units) continue;
    const { unit, rows } = secLatestUnit(node.units, preferredUnits);
    const filtered = rows
      .filter(r => Number.isFinite(Number(r.val)))
      .filter(r => !annualOnly || String(r.fp || '').toUpperCase() === 'FY' || /^10-K/.test(String(r.form || '').toUpperCase()))
      .sort((a, b) => {
        const filed = String(b.filed || '').localeCompare(String(a.filed || ''));
        if (filed) return filed;
        return String(b.end || '').localeCompare(String(a.end || ''));
      });
    const row = filtered[0] || rows.filter(r => Number.isFinite(Number(r.val))).sort((a, b) => String(b.end || '').localeCompare(String(a.end || '')))[0];
    if (!row) continue;
    candidates.push({
      concept,
      label: node.label || concept,
      description: node.description || '',
      unit,
      value: Number(row.val),
      end: row.end || '',
      filed: row.filed || '',
      fy: row.fy || null,
      fp: row.fp || '',
      form: row.form || '',
    });
  }
  return candidates.sort((a, b) => {
    const end = String(b.end || '').localeCompare(String(a.end || ''));
    if (end) return end;
    return String(b.filed || '').localeCompare(String(a.filed || ''));
  })[0] || null;
}

function secPeriodYear(row) {
  return Number(String(row?.end || '').slice(0, 4)) || Number(row?.fy) || null;
}

function secDurationDays(row) {
  const startMs = Date.parse(row?.start || '');
  const endMs = Date.parse(row?.end || '');
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.round((endMs - startMs) / 86400000) : null;
}

function secAnnualSeriesFact(usGaap, concepts, preferredUnits = ['USD'], limit = 10) {
  const candidates = [];
  for (const concept of concepts) {
    const node = usGaap?.[concept];
    if (!node?.units) continue;
    const { unit, rows } = secLatestUnit(node.units, preferredUnits);
    const annualRows = rows
      .filter(r => Number.isFinite(Number(r.val)))
      .filter(r => String(r.fp || '').toUpperCase() === 'FY' || /^10-K/.test(String(r.form || '').toUpperCase()))
      .map(r => {
        const periodYear = secPeriodYear(r);
        const durationDays = secDurationDays(r);
        return {
          concept,
          unit,
          value: Number(r.val),
          end: r.end || '',
          filed: r.filed || '',
          fy: periodYear,
          secFy: Number(r.fy) || null,
          fp: r.fp || '',
          form: r.form || '',
          durationDays,
        };
      })
      .filter(r => r.fy)
      .filter(r => r.durationDays == null || (r.durationDays >= 300 && r.durationDays <= 400));
    if (!annualRows.length) continue;

    const byPeriod = new Map();
    annualRows.forEach(row => {
      const key = String(row.fy);
      const current = byPeriod.get(key);
      if (!current || String(row.filed || '').localeCompare(String(current.filed || '')) > 0) {
        byPeriod.set(key, row);
      }
    });

    const series = [...byPeriod.values()].sort((a, b) => {
      const end = String(a.end || '').localeCompare(String(b.end || ''));
      if (end) return end;
      return a.fy - b.fy;
    });
    candidates.push(series);
  }
  const best = candidates.sort((a, b) => {
    const latest = String(b[b.length - 1]?.end || '').localeCompare(String(a[a.length - 1]?.end || ''));
    if (latest) return latest;
    return b.length - a.length;
  })[0] || [];
  return Number.isFinite(limit) ? best.slice(-limit) : best;
}

function secQuarterlySeriesFact(usGaap, concepts, preferredUnits = ['USD'], limit = 12, annualSeries = []) {
  const candidates = [];
  for (const concept of concepts) {
    const node = usGaap?.[concept];
    if (!node?.units) continue;
    const { unit, rows } = secLatestUnit(node.units, preferredUnits);
    const ytdRows = rows
      .filter(r => Number.isFinite(Number(r.val)))
      .filter(r => /^10-Q/.test(String(r.form || '').toUpperCase()) || /^Q[1-4]$/i.test(String(r.fp || '')))
      .map(r => {
        const durationDays = secDurationDays(r);
        const fiscalYear = Number(r.fy) || null;
        const fp = String(r.fp || '').toUpperCase();
        return {
          concept,
          unit,
          value: Number(r.val),
          end: r.end || '',
          filed: r.filed || '',
          fy: fiscalYear,
          fp,
          form: r.form || '',
          durationDays,
          period: `${fiscalYear || ''} ${fp}`.trim(),
        };
      })
      .filter(r => r.fy && /^Q[1-3]$/.test(r.fp))
      .filter(r => {
        if (r.durationDays == null) return false;
        if (r.fp === 'Q1') return r.durationDays >= 70 && r.durationDays <= 120;
        if (r.fp === 'Q2') return r.durationDays >= 150 && r.durationDays <= 220;
        if (r.fp === 'Q3') return r.durationDays >= 240 && r.durationDays <= 310;
        return false;
      });
    if (!ytdRows.length && !annualSeries.length) continue;

    const byYtdPeriod = new Map();
    ytdRows.forEach(row => {
      const key = row.period || `${row.fy}-${row.fp}`;
      const current = byYtdPeriod.get(key);
      const laterEnd = String(row.end || '').localeCompare(String(current?.end || ''));
      const earlierFiled = String(row.filed || '').localeCompare(String(current?.filed || ''));
      if (!current || laterEnd > 0 || (laterEnd === 0 && earlierFiled < 0)) {
        byYtdPeriod.set(key, row);
      }
    });

    const byFiscalYear = new Map();
    [...byYtdPeriod.values()].forEach(row => {
      const group = byFiscalYear.get(row.fy) || {};
      group[row.fp] = row;
      byFiscalYear.set(row.fy, group);
    });
    (annualSeries || []).forEach(row => {
      const group = byFiscalYear.get(row.fy) || {};
      group.FY = row;
      byFiscalYear.set(row.fy, group);
    });

    const series = [];
    [...byFiscalYear.entries()].forEach(([fy, group]) => {
      const q1 = group.Q1;
      const q2 = group.Q2;
      const q3 = group.Q3;
      const annual = group.FY;
      if (q1) series.push({ ...q1, value: q1.value, period: `${fy} Q1` });
      if (q2 && q1) series.push({ ...q2, value: q2.value - q1.value, period: `${fy} Q2` });
      if (q3 && q2) series.push({ ...q3, value: q3.value - q2.value, period: `${fy} Q3` });
      if (annual && q3) {
        series.push({
          concept,
          unit: annual.unit || q3.unit || unit,
          value: annual.value - q3.value,
          end: annual.end || q3.end || '',
          filed: annual.filed || q3.filed || '',
          fy,
          fp: 'Q4',
          form: annual.form || '',
          period: `${fy} Q4`,
          derived: true,
        });
      }
    });

    const sorted = series.sort((a, b) => {
      const fy = Number(a.fy) - Number(b.fy);
      if (fy) return fy;
      return String(a.fp || '').localeCompare(String(b.fp || ''));
    }).sort((a, b) => {
      const end = String(a.end || '').localeCompare(String(b.end || ''));
      if (end) return end;
      return String(a.fp || '').localeCompare(String(b.fp || ''));
    });
    candidates.push(sorted);
  }
  const best = candidates.sort((a, b) => {
    const latest = String(b[b.length - 1]?.end || '').localeCompare(String(a[a.length - 1]?.end || ''));
    if (latest) return latest;
    return b.length - a.length;
  })[0] || [];
  return Number.isFinite(limit) ? best.slice(-limit) : best;
}

function secSeriesMap(series, key = 'fy') {
  return new Map((series || []).map(row => [row[key] || row.fy || Number(String(row.end || '').slice(0, 4)), row]));
}

function filterAnnualWindow(series, years = 9) {
  const rows = (series || []).filter(row => Number(row.fy));
  if (!rows.length) return [];
  const latestFy = Math.max(...rows.map(row => Number(row.fy)));
  return rows.filter(row => Number(row.fy) >= latestFy - years + 1);
}

function filterQuarterlyWindow(series, quarters = 9) {
  const rows = (series || []).filter(row => row.end);
  if (!rows.length) return [];
  return rows
    .sort((a, b) => String(a.end || '').localeCompare(String(b.end || '')))
    .slice(-quarters);
}

function normalizeSecFacts(companyfacts) {
  const usGaap = companyfacts?.facts?.['us-gaap'] || {};
  const revenue = secLatestFact(usGaap, [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
  ]);
  const netIncome = secLatestFact(usGaap, ['NetIncomeLoss', 'ProfitLoss']);
  const assets = secLatestFact(usGaap, ['Assets']);
  const liabilities = secLatestFact(usGaap, ['Liabilities']);
  const equity = secLatestFact(usGaap, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']);
  const cash = secLatestFact(usGaap, [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ]);
  const operatingCashFlow = secLatestFact(usGaap, ['NetCashProvidedByUsedInOperatingActivities']);
  const capex = secLatestFact(usGaap, [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
  ]);
  const shares = secLatestFact(usGaap, [
    'EntityCommonStockSharesOutstanding',
    'CommonStocksIncludingAdditionalPaidInCapitalSharesOutstanding',
  ], ['shares']);

  const revenueSeries = secAnnualSeriesFact(usGaap, [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
  ]);
  const netIncomeSeries = secAnnualSeriesFact(usGaap, ['NetIncomeLoss', 'ProfitLoss']);
  const assetsSeries = secAnnualSeriesFact(usGaap, ['Assets']);
  const liabilitiesSeries = secAnnualSeriesFact(usGaap, ['Liabilities']);
  const operatingCashFlowSeries = secAnnualSeriesFact(usGaap, ['NetCashProvidedByUsedInOperatingActivities']);
  const capexSeries = secAnnualSeriesFact(usGaap, [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
  ]);
  const annualRevenue = filterAnnualWindow(revenueSeries);
  const annualNetIncome = filterAnnualWindow(netIncomeSeries);
  const annualAssets = filterAnnualWindow(assetsSeries);
  const annualLiabilities = filterAnnualWindow(liabilitiesSeries);
  const annualOperatingCashFlow = filterAnnualWindow(operatingCashFlowSeries);
  const annualCapex = filterAnnualWindow(capexSeries);
  const capexByYear = secSeriesMap(annualCapex);
  const freeCashFlowSeries = annualOperatingCashFlow
    .map(row => {
      const capexRow = capexByYear.get(row.fy);
      if (!capexRow) return null;
      return {
        concept: 'FreeCashFlowDerived',
        unit: row.unit,
        value: row.value - Math.abs(capexRow.value),
        end: row.end,
        filed: row.filed,
        fy: row.fy,
        fp: row.fp,
        form: row.form,
      };
    })
    .filter(Boolean);

  const quarterlyRevenueSeries = secQuarterlySeriesFact(usGaap, [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
  ], ['USD'], 12, revenueSeries);
  const quarterlyNetIncomeSeries = secQuarterlySeriesFact(usGaap, ['NetIncomeLoss', 'ProfitLoss'], ['USD'], 12, netIncomeSeries);
  const quarterlyOperatingCashFlowSeries = secQuarterlySeriesFact(usGaap, ['NetCashProvidedByUsedInOperatingActivities'], ['USD'], 12, operatingCashFlowSeries);
  const quarterlyCapexSeries = secQuarterlySeriesFact(usGaap, [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
  ], ['USD'], 12, capexSeries);
  const quarterlyRevenue = filterQuarterlyWindow(quarterlyRevenueSeries);
  const quarterlyNetIncome = filterQuarterlyWindow(quarterlyNetIncomeSeries);
  const quarterlyOperatingCashFlow = filterQuarterlyWindow(quarterlyOperatingCashFlowSeries);
  const quarterlyCapex = filterQuarterlyWindow(quarterlyCapexSeries);
  const quarterlyCapexByPeriod = secSeriesMap(quarterlyCapex, 'period');
  const quarterlyFreeCashFlowSeries = quarterlyOperatingCashFlow
    .map(row => {
      const capexRow = quarterlyCapexByPeriod.get(row.period);
      if (!capexRow) return null;
      return {
        concept: 'FreeCashFlowDerived',
        unit: row.unit,
        value: row.value - Math.abs(capexRow.value),
        end: row.end,
        filed: row.filed,
        fy: row.fy,
        fp: row.fp,
        form: row.form,
        period: row.period,
      };
    })
    .filter(Boolean);

  const fcf = operatingCashFlow && capex
    ? {
        concept: 'FreeCashFlowDerived',
        label: 'Free Cash Flow (derived)',
        unit: operatingCashFlow.unit,
        value: operatingCashFlow.value - Math.abs(capex.value),
        end: operatingCashFlow.end,
        filed: operatingCashFlow.filed,
        fy: operatingCashFlow.fy,
        fp: operatingCashFlow.fp,
        form: operatingCashFlow.form,
      }
    : null;

  return {
    cik: companyfacts.cik,
    entityName: companyfacts.entityName,
    facts: {
      revenue,
      netIncome,
      assets,
      liabilities,
      equity,
      cash,
      operatingCashFlow,
      capex,
      freeCashFlow: fcf,
      shares,
    },
    trends: {
      revenue: annualRevenue,
      netIncome: annualNetIncome,
      operatingCashFlow: annualOperatingCashFlow,
      freeCashFlow: filterAnnualWindow(freeCashFlowSeries),
      assets: annualAssets,
      liabilities: annualLiabilities,
    },
    quarterlyTrends: {
      revenue: quarterlyRevenue,
      netIncome: quarterlyNetIncome,
      operatingCashFlow: quarterlyOperatingCashFlow,
      freeCashFlow: filterQuarterlyWindow(quarterlyFreeCashFlowSeries),
    },
    source: 'SEC EDGAR companyfacts',
    limitations: [
      'US SEC filers only.',
      'Fields are normalized from common US-GAAP concepts and may be missing for some companies.',
      'Values are latest available annual facts where possible.',
    ],
  };
}

function finnhubReportedItem(report, statement, concepts) {
  const rows = Array.isArray(report?.[statement]) ? report[statement] : [];
  for (const concept of concepts) {
    const match = rows.find(row => String(row?.concept || '').replace(/^us-gaap_/, '') === concept);
    if (match && Number.isFinite(Number(match.value))) return match;
  }
  return null;
}

function normalizeFinnhubReported(symbol, annualRaw, quarterlyRaw) {
  const concepts = {
    revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
    netIncome: ['NetIncomeLoss', 'ProfitLoss'],
    assets: ['Assets'],
    liabilities: ['Liabilities'],
    equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
    capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  };
  const statement = {
    revenue: 'ic', netIncome: 'ic', assets: 'bs', liabilities: 'bs', equity: 'bs', cash: 'bs',
    operatingCashFlow: 'cf', capex: 'cf',
  };
  const annualReports = (Array.isArray(annualRaw?.data) ? annualRaw.data : [])
    .filter(row => row?.report && row?.endDate)
    .sort((a, b) => String(a.endDate).localeCompare(String(b.endDate)));
  const quarterlyReports = (Array.isArray(quarterlyRaw?.data) ? quarterlyRaw.data : [])
    .filter(row => row?.report && row?.endDate)
    .sort((a, b) => String(a.endDate).localeCompare(String(b.endDate)));

  const toFact = (filing, key) => {
    const item = finnhubReportedItem(filing?.report, statement[key], concepts[key]);
    if (!item) return null;
    return {
      concept: String(item.concept || '').replace(/^us-gaap_/, ''),
      label: item.label || key,
      unit: item.unit || 'USD',
      value: Number(item.value),
      end: filing.endDate,
      filed: filing.filedDate || '',
      fy: Number(filing.year) || Number(String(filing.endDate).slice(0, 4)),
      fp: filing.quarter ? `Q${filing.quarter}` : 'FY',
      form: filing.form || '',
      period: filing.endDate,
    };
  };
  const series = (reports, key) => reports.map(row => toFact(row, key)).filter(Boolean);
  const deriveFcf = reports => reports.map(row => {
    const ocf = toFact(row, 'operatingCashFlow');
    const capex = toFact(row, 'capex');
    return ocf && capex ? { ...ocf, concept: 'FreeCashFlowDerived', label: 'Free Cash Flow (derived)', value: ocf.value - Math.abs(capex.value) } : null;
  }).filter(Boolean);
  const latest = annualReports[annualReports.length - 1] || quarterlyReports[quarterlyReports.length - 1];
  const latestFact = key => toFact(latest, key);
  const operatingCashFlow = latestFact('operatingCashFlow');
  const capex = latestFact('capex');

  return {
    cik: annualRaw?.cik || quarterlyRaw?.cik || '',
    entityName: annualRaw?.symbol || quarterlyRaw?.symbol || symbol,
    facts: {
      revenue: latestFact('revenue'),
      netIncome: latestFact('netIncome'),
      assets: latestFact('assets'),
      liabilities: latestFact('liabilities'),
      equity: latestFact('equity'),
      cash: latestFact('cash'),
      operatingCashFlow,
      capex,
      freeCashFlow: operatingCashFlow && capex
        ? { ...operatingCashFlow, concept: 'FreeCashFlowDerived', label: 'Free Cash Flow (derived)', value: operatingCashFlow.value - Math.abs(capex.value) }
        : null,
      shares: null,
    },
    trends: {
      revenue: filterAnnualWindow(series(annualReports, 'revenue')),
      netIncome: filterAnnualWindow(series(annualReports, 'netIncome')),
      operatingCashFlow: filterAnnualWindow(series(annualReports, 'operatingCashFlow')),
      freeCashFlow: filterAnnualWindow(deriveFcf(annualReports)),
      assets: filterAnnualWindow(series(annualReports, 'assets')),
      liabilities: filterAnnualWindow(series(annualReports, 'liabilities')),
    },
    quarterlyTrends: {
      revenue: filterQuarterlyWindow(series(quarterlyReports, 'revenue')),
      netIncome: filterQuarterlyWindow(series(quarterlyReports, 'netIncome')),
      operatingCashFlow: filterQuarterlyWindow(series(quarterlyReports, 'operatingCashFlow')),
      freeCashFlow: filterQuarterlyWindow(deriveFcf(quarterlyReports)),
    },
    source: 'Finnhub reported financials (SEC fallback)',
    limitations: ['Used only when SEC EDGAR sources are unavailable.', 'Reported concepts may be missing for some companies.'],
  };
}

async function getReportedFinancialFallback(symbol, env) {
  const [annual, quarterly] = await Promise.all([
    fetchFinnhubData(symbol, env, 'stock/financials-reported', 86400, { freq: 'annual' }),
    fetchFinnhubData(symbol, env, 'stock/financials-reported', 86400, { freq: 'quarterly' }),
  ]);
  const data = normalizeFinnhubReported(symbol, annual, quarterly);
  if (!data.trends.revenue.length && !data.facts.assets) throw new Error('Finnhub reported financials returned no usable data');
  return { symbol, ticker: symbol, title: data.entityName || symbol, ...data };
}

async function handleSecCompanyFacts(url, env, corsHeaders) {
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!symbol) return json({ error: 'Missing symbol parameter' }, 400, corsHeaders);
  if (!validTicker(symbol)) return json({ error: 'Invalid symbol' }, 400, corsHeaders);

  const cacheKey = `sec:companyfacts:v9:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEC_CACHE_TTL) {
    return json(cached.data, 200, corsHeaders, { 'X-Cache': 'HIT' });
  }

  let data;
  try {
    const tickerMap = await getSecTickerMap();
    const match = tickerMap[symbol];
    if (!match?.cik) throw new Error('SEC CIK not found for symbol');
    const raw = await fetchSecJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${match.cik}.json`);
    data = {
      symbol,
      ticker: match.ticker,
      cik: match.cik,
      title: match.title,
      ...normalizeSecFacts(raw),
    };
  } catch (secError) {
    try {
      data = await getReportedFinancialFallback(symbol, env);
      data.upstreamWarning = secError.message;
    } catch (fallbackError) {
      return json({ error: 'Financial data upstream error', message: `${secError.message}; ${fallbackError.message}`, symbol }, 502, corsHeaders);
    }
  }
  cache.set(cacheKey, { ts: Date.now(), data });
  return json(data, 200, corsHeaders, { 'X-Cache': 'MISS' });
}

async function getSecCompanyFactsData(symbol, env) {
  const cacheKey = `sec:companyfacts:v9:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEC_CACHE_TTL) return cached.data;

  let data;
  try {
    const tickerMap = await getSecTickerMap();
    const match = tickerMap[symbol];
    if (!match?.cik) throw new Error('SEC CIK not found for symbol');
    const raw = await fetchSecJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${match.cik}.json`);
    data = { symbol, ticker: match.ticker, cik: match.cik, title: match.title, ...normalizeSecFacts(raw) };
  } catch (secError) {
    data = await getReportedFinancialFallback(symbol, env);
    data.upstreamWarning = secError.message;
  }
  cache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

function stripSecDocument(html) {
  return decodeHtml(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<ix:[^>]+>/gi, ' ')
    .replace(/<\/ix:[^>]+>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  ).trim();
}

function itemPattern(item) {
  const escaped = item.replace('.', '\\.').replace(/\s+/g, '\\s*');
  return new RegExp(`\\bitem\\s*${escaped}\\s*[\\.:\\-]?\\s*`, 'ig');
}

function extractSecSection(text, startItem, nextItems) {
  const starts = [...text.matchAll(itemPattern(startItem))].map(match => match.index || 0);
  let best = '';
  for (const start of starts) {
    const rest = text.slice(start);
    let end = rest.length;
    for (const nextItem of nextItems) {
      const nextMatch = itemPattern(nextItem).exec(rest.slice(20));
      if (nextMatch) end = Math.min(end, 20 + (nextMatch.index || 0));
    }
    const section = rest.slice(0, end).trim();
    if (section.length > best.length) best = section;
  }
  return best.slice(0, SEC_SECTION_MAX_CHARS);
}

function summarizeFallback(section, count = 5) {
  return String(section || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 80)
    .slice(0, count);
}

async function getSecFilingSections(symbol) {
  const tickerMap = await getSecTickerMap();
  const match = tickerMap[symbol];
  if (!match?.cik) {
    const err = new Error('SEC CIK not found for symbol');
    err.status = 404;
    throw err;
  }

  const submissions = await fetchSecJson(`https://data.sec.gov/submissions/CIK${match.cik}.json`);
  const recent = submissions?.filings?.recent || {};
  const forms = recent.form || [];
  const idx = forms.findIndex(form => String(form || '').toUpperCase() === '10-K');
  if (idx < 0) {
    const err = new Error('Latest 10-K not found in SEC submissions');
    err.status = 404;
    throw err;
  }

  const accession = String(recent.accessionNumber?.[idx] || '').replace(/-/g, '');
  const primaryDocument = recent.primaryDocument?.[idx];
  const filingDate = recent.filingDate?.[idx] || '';
  if (!accession || !primaryDocument) {
    const err = new Error('SEC 10-K primary document not found');
    err.status = 404;
    throw err;
  }

  const docUrl = `https://www.sec.gov/Archives/edgar/data/${Number(match.cik)}/${accession}/${primaryDocument}`;
  const text = stripSecDocument(await fetchSecText(docUrl));
  const business = extractSecSection(text, '1.', ['1A.', '1B.', '1C.', '2.']);
  const riskFactors = extractSecSection(text, '1A.', ['1B.', '1C.', '2.']);
  return {
    symbol,
    ticker: match.ticker,
    cik: match.cik,
    title: match.title,
    filing: {
      form: '10-K',
      filingDate,
      accessionNumber: recent.accessionNumber?.[idx] || '',
      primaryDocument,
      url: docUrl,
    },
    sections: {
      business,
      riskFactors,
    },
    fallback: {
      businessPoints: summarizeFallback(business, 4),
      riskPoints: summarizeFallback(riskFactors, 6),
    },
    source: 'SEC EDGAR latest 10-K',
    limitations: [
      'US SEC filers only.',
      'Section extraction is heuristic and may need company-specific tuning.',
      'Use the source filing link for verification.',
    ],
  };
}

async function analyzeSecSectionsWithGlm(sections, env, lang = 'zh') {
  const apiKey = env.GLM_API_KEY;
  const business = sections?.sections?.business || '';
  const riskFactors = sections?.sections?.riskFactors || '';
  if (!apiKey || (!business && !riskFactors)) {
    return {
      provider: 'rules',
      businessOverview: sections?.fallback?.businessPoints?.join(' ') || '',
      businessPoints: sections?.fallback?.businessPoints || [],
      riskFactors: sections?.fallback?.riskPoints || [],
      summaryNote: 'Fallback summary generated without AI.',
    };
  }
  const languageName = lang === 'en' ? 'English' : 'Traditional Chinese';
  try {
    const resp = await fetch(GLM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GLM_MODEL,
        response_format: { type: 'json_object' },
        thinking: GLM_THINKING,
        reasoning_effort: GLM_REASONING_EFFORT,
        messages: [
          { role: 'system', content: `Return only JSON in ${languageName}. Use only the supplied SEC 10-K text. Do not invent missing facts. Output {"businessOverview":"3-5 sentences","businessPoints":["point"],"riskFactors":["risk"],"riskSummary":"2-3 sentences","sourceCaveat":"one sentence"}. This is educational analysis, not financial advice.` },
          { role: 'user', content: JSON.stringify({
            symbol: sections.symbol,
            company: sections.title,
            filing: sections.filing,
            business: business.slice(0, SEC_SECTION_MAX_CHARS),
            riskFactors: riskFactors.slice(0, SEC_SECTION_MAX_CHARS),
          }) },
        ],
      }),
    });
    if (!resp.ok) throw new Error('GLM SEC summary upstream error');
    const data = await resp.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    return {
      provider: 'glm',
      businessOverview: String(parsed.businessOverview || '').trim(),
      businessPoints: Array.isArray(parsed.businessPoints) ? parsed.businessPoints.map(v => String(v).trim()).filter(Boolean).slice(0, 8) : [],
      riskFactors: Array.isArray(parsed.riskFactors) ? parsed.riskFactors.map(v => String(v).trim()).filter(Boolean).slice(0, 10) : [],
      riskSummary: String(parsed.riskSummary || '').trim(),
      sourceCaveat: String(parsed.sourceCaveat || '').trim(),
    };
  } catch (_) {
    return {
      provider: 'rules',
      businessOverview: sections?.fallback?.businessPoints?.join(' ') || '',
      businessPoints: sections?.fallback?.businessPoints || [],
      riskFactors: sections?.fallback?.riskPoints || [],
      summaryNote: 'AI summary unavailable; fallback extracted from SEC filing text.',
    };
  }
}

async function handleSecFilingSections(url, env, corsHeaders) {
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!symbol) return json({ error: 'Missing symbol parameter' }, 400, corsHeaders);
  if (!validTicker(symbol)) return json({ error: 'Invalid symbol' }, 400, corsHeaders);
  const lang = (url.searchParams.get('lang') || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
  const includeAi = url.searchParams.get('ai') !== '0';

  const cacheKey = `sec:filing-sections:v2:${includeAi ? `ai-${lang}` : 'raw'}:${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEC_CACHE_TTL) {
    return json(cached.data, 200, corsHeaders, { 'X-Cache': 'HIT' });
  }

  try {
    const sections = await getSecFilingSections(symbol);
    const aiSummary = includeAi ? await analyzeSecSectionsWithGlm(sections, env, lang) : null;
    const data = {
      ...sections,
      aiSummary,
      glmConfigured: Boolean(env.GLM_API_KEY),
    };
    cache.set(cacheKey, { ts: Date.now(), data });
    return json(data, 200, corsHeaders, { 'X-Cache': 'MISS' });
  } catch (err) {
    return json({ error: err.message || 'SEC filing sections failed', status: err.status || 502, symbol }, err.status || 502, corsHeaders);
  }
}

async function handleNews(url, env, corsHeaders) {
  const tickers = (url.searchParams.get('tickers') || url.searchParams.get('ticker') || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .filter(validTicker)
    .slice(0, 10);
  const sort = (url.searchParams.get('sort') || 'latest').toLowerCase();
  const lang = (url.searchParams.get('lang') || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 20);

  if (!tickers.length) return json({ error: 'Missing tickers parameter' }, 400, corsHeaders);

  const debug = url.searchParams.get('debug') === '1';
  const forceRefresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
  const useFullText = url.searchParams.get('fulltext') === '1' || url.searchParams.get('fulltext') === 'true';
  const useAiAnalysis = url.searchParams.get('ai') === '1' || url.searchParams.get('ai') === 'true';

  const cacheKey = `news:${NEWS_SOURCE_VERSION}:${useFullText ? 'fulltext' : 'summary'}:${useAiAnalysis ? `ai-${lang}` : 'noai'}:${tickers.join(',')}:${sort}:${limit}`;
  const edgeCached = (debug || forceRefresh) ? null : await readCachedNews(cacheKey, corsHeaders);
  if (edgeCached) return edgeCached;
  const cached = cache.get(cacheKey);
  if (!debug && !forceRefresh && cached && Date.now() - cached.ts < NEWS_CACHE_TTL) {
    return json(cached.data, 200, corsHeaders, { 'X-Cache': 'HIT' });
  }
  if (!debug && !forceRefresh && inFlight.has(cacheKey)) {
    const data = await inFlight.get(cacheKey);
    return json(data, 200, corsHeaders, { 'X-Cache': 'COALESCED' });
  }

  const requestPromise = (async () => {
    const sourceDebug = [];
    let fullTextDebug = [];
    const rawFeed = (await Promise.all(tickers.map(symbol => fetchFinnhubNewsForSymbol(symbol, env, sourceDebug)))).flat();
    const seen = new Set();
    const feed = rawFeed.filter(item => {
      const key = `${item.url}|${item.title}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return item.tickers.length > 0 && item.title && item.summary && item.tickers.some(symbol => companyFocused(item, symbol));
    });

    sortNews(feed, sort === 'sentiment' ? 'latest' : sort);
    const analysisFeed = useFullText ? await enrichWithFullText(feed) : { feed: feed.map(item => ({ ...item, contentSource: 'summary' })), stats: [] };
    fullTextDebug = analysisFeed.stats;

    const scoredFeed = await analyzeSentimentWithGlm(analysisFeed.feed, env);
    const aiAnalysis = useAiAnalysis ? await analyzeNewsDigestWithGlm(analysisFeed.feed, env, tickers, lang) : null;

    sortNews(scoredFeed, sort);
    const limitedFeed = scoredFeed.slice(0, limit);

    const data = {
      provider: 'finnhub_glm',
      sentimentInput: useFullText ? 'fulltext-with-summary-fallback' : 'summary',
      requestedTickers: tickers,
      count: limitedFeed.length,
      feed: limitedFeed,
      aiAnalysis,
      updatedAt: new Date().toISOString(),
    };
    if (debug) {
      data.debug = {
        rawFeedCount: rawFeed.length,
        filteredFeedCount: feed.length,
        glmConfigured: Boolean(env.GLM_API_KEY),
        sourceVersion: NEWS_SOURCE_VERSION,
        sources: ['Finnhub Company News'],
        fullTextEnabled: useFullText,
        fullTextMaxItems: FULL_TEXT_MAX_ITEMS,
        fullTextDebug,
        sourceDebug,
      };
    }

    if (!debug) {
      cache.set(cacheKey, { ts: Date.now(), data });
      await writeCachedNews(cacheKey, data);
    }
    return data;
  })();

  if (!debug && !forceRefresh) inFlight.set(cacheKey, requestPromise);
  try {
    const data = await requestPromise;
    return json(data, 200, corsHeaders, { 'X-Cache': 'MISS' });
  } catch (err) {
    const stale = await readCachedNews(cacheKey, corsHeaders, true);
    if (stale) return stale;
    return json({ error: err.message || 'Finnhub/GLM news fetch failed', status: err.status || 502 }, err.status || 502, corsHeaders);
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function handleNewsAnalysis(url, env, corsHeaders) {
  const tickers = (url.searchParams.get('tickers') || url.searchParams.get('ticker') || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .filter(validTicker)
    .slice(0, 10);
  const sort = (url.searchParams.get('sort') || 'latest').toLowerCase();
  const lang = (url.searchParams.get('lang') || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';

  if (!tickers.length) return json({ error: 'Missing tickers parameter' }, 400, corsHeaders);

  const debug = url.searchParams.get('debug') === '1';
  const forceRefresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
  const cacheKey = `news-analysis:${NEWS_SOURCE_VERSION}:${lang}:${tickers.join(',')}:${sort}`;
  const edgeCached = (debug || forceRefresh) ? null : await readCachedNews(cacheKey, corsHeaders);
  if (edgeCached) return edgeCached;
  const cached = cache.get(cacheKey);
  if (!debug && !forceRefresh && cached && Date.now() - cached.ts < NEWS_CACHE_TTL) {
    return json(cached.data, 200, corsHeaders, { 'X-Cache': 'HIT' });
  }

  try {
    const sourceDebug = [];
    const rawFeed = (await Promise.all(tickers.map(symbol => fetchFinnhubNewsForSymbol(symbol, env, sourceDebug)))).flat();
    const seen = new Set();
    const feed = rawFeed.filter(item => {
      const key = `${item.url}|${item.title}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return item.tickers.length > 0 && item.title && item.summary && item.tickers.some(symbol => companyFocused(item, symbol));
    });
    sortNews(feed, sort === 'sentiment' ? 'latest' : sort);
    const analysisFeed = await enrichWithFullText(feed);
    const aiAnalysis = await analyzeNewsDigestWithGlm(analysisFeed.feed, env, tickers, lang);
    const data = {
      provider: 'finnhub_glm',
      requestedTickers: tickers,
      aiAnalysis,
      updatedAt: new Date().toISOString(),
    };
    if (debug) {
      data.debug = {
        rawFeedCount: rawFeed.length,
        filteredFeedCount: feed.length,
        glmConfigured: Boolean(env.GLM_API_KEY),
        sourceVersion: NEWS_SOURCE_VERSION,
        fullTextMaxItems: FULL_TEXT_MAX_ITEMS,
        fullTextDebug: analysisFeed.stats,
        sourceDebug,
      };
    }
    if (!debug) {
      cache.set(cacheKey, { ts: Date.now(), data });
      await writeCachedNews(cacheKey, data);
    }
    return json(data, 200, corsHeaders, { 'X-Cache': 'MISS' });
  } catch (err) {
    const stale = await readCachedNews(cacheKey, corsHeaders, true);
    if (stale) return stale;
    return json({ error: err.message || 'GLM news analysis failed', status: err.status || 502 }, err.status || 502, corsHeaders);
  }
}

function compactAnalysisFact(fact) {
  if (!fact) return null;
  return {
    value: fact.value,
    fy: fact.fy,
    end: fact.end,
    form: fact.form,
    concept: fact.concept,
  };
}

function clampScore(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeResearchScore(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lines = raw.lines && typeof raw.lines === 'object' ? raw.lines : {};
  const score = {
    total: clampScore(raw.total, 0),
    label: String(raw.label || '').trim(),
    lines: [
      ['Price/Fair Value', clampScore(lines.priceFairValue ?? lines.valuation ?? raw.priceFairValue ?? raw.valuation, 0)],
      ['Economic Moat', clampScore(lines.economicMoat ?? lines.moat ?? raw.economicMoat ?? raw.moat, 0)],
      ['Uncertainty', clampScore(lines.uncertainty ?? raw.uncertainty, 0)],
      ['Financial Health', clampScore(lines.financialHealth ?? lines.quality ?? raw.financialHealth ?? raw.quality, 0)],
      ['Capital Allocation', clampScore(lines.capitalAllocation ?? raw.capitalAllocation, 0)],
    ],
    source: 'Institutional framework',
  };
  if (!score.label) {
    score.label = score.total >= 75 ? 'Strong watchlist' : score.total >= 58 ? 'Balanced watchlist' : 'High caution';
  }
  return score;
}

function normalizeStagedEntry(raw, currentPrice, technicalLevels) {
  const price = Number(currentPrice);
  if (!raw || typeof raw !== 'object' || !Number.isFinite(price) || price <= 0) return null;
  const normalizePlan = (rows, expectedLength, expectedAllocation) => {
    if (!Array.isArray(rows) || rows.length !== expectedLength) return null;
    const normalized = rows.map(row => {
      const low = Number(row?.low);
      const high = Number(row?.high);
      if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low || high > price * 1.1 || low < price * 0.35) return null;
      return {
        allocation: expectedAllocation,
        low: Math.round(low * 100) / 100,
        high: Math.round(high * 100) / 100,
        reason: String(row?.reason || '').trim().slice(0, 180),
      };
    });
    return normalized.every(Boolean) ? normalized : null;
  };
  const halfPlan = normalizePlan(raw.halfPlan, 2, 50);
  const quarterPlan = normalizePlan(raw.quarterPlan, 4, 25);
  if (!halfPlan || !quarterPlan) return null;
  const nearLevel = (rows, level) => !Number.isFinite(level) || rows.some(row => {
    if (level >= row.low && level <= row.high) return true;
    return Math.min(Math.abs(level - row.low), Math.abs(level - row.high)) / level <= 0.025;
  });
  const ma50 = nullableNumber(technicalLevels?.ma50);
  const ma200 = nullableNumber(technicalLevels?.ma200);
  if (!nearLevel(halfPlan, ma50) || !nearLevel(halfPlan, ma200) || !nearLevel(quarterPlan, ma50) || !nearLevel(quarterPlan, ma200)) return null;
  return {
    riskLevel: ['low', 'medium', 'high'].includes(raw.riskLevel) ? raw.riskLevel : 'medium',
    basis: String(raw.basis || '').trim().slice(0, 300),
    halfPlan,
    quarterPlan,
  };
}

function average(values) {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

async function fetchDailyTechnicalLevels(symbol, env) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - (430 * 24 * 60 * 60);
  let candles = await fetchFinnhubData(symbol, env, 'stock/candle', 3600, { resolution: 'D', from, to }).catch(() => null);
  let source = 'Finnhub daily candles';
  if (candles?.s !== 'ok' || !Array.isArray(candles?.c) || candles.c.length < 200) {
    const startDate = new Date(from * 1000).toISOString().slice(0, 10);
    const endDate = new Date(to * 1000).toISOString().slice(0, 10);
    const nasdaqUrl = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=stocks&fromdate=${startDate}&todate=${endDate}&limit=300`;
    const response = await fetch(nasdaqUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; BlackSpace/1.0)' },
      cf: { cacheEverything: true, cacheTtl: 3600 },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const rows = Array.isArray(payload?.data?.tradesTable?.rows) ? payload.data.tradesTable.rows.slice().reverse() : [];
    const number = value => Number(String(value || '').replace(/[$,]/g, ''));
    candles = {
      s: rows.length >= 200 ? 'ok' : 'no_data',
      c: rows.map(row => number(row.close)),
      h: rows.map(row => number(row.high)),
      l: rows.map(row => number(row.low)),
    };
    source = 'Nasdaq daily historical prices';
  }
  const closes = Array.isArray(candles?.c) ? candles.c.map(Number).filter(Number.isFinite) : [];
  const highs = Array.isArray(candles?.h) ? candles.h.map(Number).filter(Number.isFinite) : [];
  const lows = Array.isArray(candles?.l) ? candles.l.map(Number).filter(Number.isFinite) : [];
  if (candles?.s !== 'ok' || closes.length < 200 || !highs.length || !lows.length) return null;
  const recentHigh = days => Math.max(...highs.slice(-Math.min(days, highs.length)));
  const recentLow = days => Math.min(...lows.slice(-Math.min(days, lows.length)));
  const rounded = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  return {
    lastClose: rounded(closes[closes.length - 1]),
    ma50: rounded(average(closes.slice(-50))),
    ma200: closes.length >= 200 ? rounded(average(closes.slice(-200))) : null,
    support20: rounded(recentLow(20)),
    support60: rounded(recentLow(60)),
    resistance20: rounded(recentHigh(20)),
    resistance60: rounded(recentHigh(60)),
    sessions: closes.length,
    source,
  };
}

function firstFinite(source, keys) {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function percentageToRatio(value) {
  return Number.isFinite(value) && Math.abs(value) > 1.5 ? value / 100 : value;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function linearScore(value, low, high, invert = false) {
  if (!Number.isFinite(value)) return null;
  const ratio = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return Math.round((invert ? 1 - ratio : ratio) * 100);
}

function peerPercentile(value, peers, key, lowerIsBetter = false) {
  if (!Number.isFinite(value)) return null;
  const values = peers.map(peer => Number(peer?.[key])).filter(Number.isFinite).sort((a, b) => a - b);
  if (values.length < 3) return null;
  const below = values.filter(item => item < value).length;
  const equal = values.filter(item => item === value).length;
  const percentile = (below + equal * 0.5) / values.length;
  return Math.round((lowerIsBetter ? 1 - percentile : percentile) * 100);
}

function weightedComponent(items) {
  const available = items.filter(item => Number.isFinite(item.score));
  if (!available.length) return { score: 50, coverage: 0 };
  const weight = available.reduce((sum, item) => sum + item.weight, 0);
  return {
    score: Math.round(available.reduce((sum, item) => sum + item.score * item.weight, 0) / weight),
    coverage: Math.round(weight * 100),
  };
}

function annualCagr(series) {
  const rows = (series || []).filter(row => Number.isFinite(Number(row?.value))).slice(-6);
  if (rows.length < 2) return null;
  const first = Number(rows[0].value);
  const last = Number(rows[rows.length - 1].value);
  const years = Math.max(1, Number(rows[rows.length - 1].fy) - Number(rows[0].fy) || rows.length - 1);
  return first > 0 && last > 0 ? Math.pow(last / first, 1 / years) - 1 : null;
}

function positiveYearRatio(series) {
  const rows = (series || []).slice(-5).map(row => Number(row?.value)).filter(Number.isFinite);
  return rows.length ? rows.filter(value => value > 0).length / rows.length : null;
}

function calculateInstitutionalScore(input) {
  const metrics = input.metrics || {};
  const peers = Array.isArray(input.peers) ? input.peers : [];
  const facts = input.secFacts || {};
  const revenue = nullableNumber(facts.revenue?.value);
  const netIncome = nullableNumber(facts.netIncome?.value);
  const ocf = nullableNumber(facts.operatingCashFlow?.value);
  const fcf = nullableNumber(facts.freeCashFlow?.value);
  const assets = nullableNumber(facts.assets?.value);
  const liabilities = nullableNumber(facts.liabilities?.value);
  const marketCap = nullableNumber(metrics.marketCapitalization);
  const marketCapUsd = marketCap === null ? null : marketCap * 1000000;
  const pe = nullableNumber(metrics.peTTM);
  const forwardPe = nullableNumber(metrics.forwardPERatio);
  const pb = nullableNumber(metrics.pbAnnual);
  const ps = nullableNumber(metrics.psTTM);
  const roe = percentageToRatio(nullableNumber(metrics.roeTTM));
  const grossMargin = percentageToRatio(nullableNumber(metrics.grossMarginTTM));
  const netMargin = percentageToRatio(nullableNumber(metrics.netProfitMarginTTM));
  const debtEquity = nullableNumber(metrics.debtEquity);
  const currentRatio = nullableNumber(metrics.currentRatio);
  const beta = nullableNumber(metrics.beta);
  const revenueCagr = annualCagr(facts.revenueTrend);
  const positiveNetIncomeYears = positiveYearRatio(facts.netIncomeTrend);
  const fcfYield = Number.isFinite(fcf) && marketCapUsd > 0 ? fcf / marketCapUsd : null;
  const fcfMargin = Number.isFinite(fcf) && revenue > 0 ? fcf / revenue : null;
  const cashConversion = Number.isFinite(ocf) && netIncome > 0 ? ocf / netIncome : null;
  const assetCoverage = assets > 0 && Number.isFinite(liabilities) ? assets / Math.max(liabilities, 1) : null;

  const valuation = weightedComponent([
    { score: peerPercentile(pe, peers, 'peTTM', true), weight: 0.30 },
    { score: peerPercentile(forwardPe, peers, 'forwardPERatio', true), weight: 0.20 },
    { score: peerPercentile(pb, peers, 'pbAnnual', true), weight: 0.15 },
    { score: peerPercentile(ps, peers, 'psTTM', true), weight: 0.10 },
    { score: linearScore(fcfYield, 0, 0.10), weight: 0.25 },
  ]);
  const moat = weightedComponent([
    { score: peerPercentile(grossMargin, peers, 'grossMarginTTM'), weight: 0.30 },
    { score: peerPercentile(netMargin, peers, 'netProfitMarginTTM'), weight: 0.25 },
    { score: peerPercentile(roe, peers, 'roeTTM'), weight: 0.25 },
    { score: linearScore(revenueCagr, -0.05, 0.30), weight: 0.20 },
  ]);
  const uncertainty = weightedComponent([
    { score: linearScore(beta, 0.6, 2.0, true), weight: 0.45 },
    { score: Number.isFinite(positiveNetIncomeYears) ? Math.round(positiveNetIncomeYears * 100) : null, weight: 0.30 },
    { score: linearScore(revenueCagr, -0.10, 0.20), weight: 0.25 },
  ]);
  const financialHealth = weightedComponent([
    { score: linearScore(debtEquity, 0, 3, true), weight: 0.25 },
    { score: linearScore(currentRatio, 0.5, 2.5), weight: 0.20 },
    { score: linearScore(cashConversion, 0.5, 1.5), weight: 0.25 },
    { score: linearScore(fcfMargin, -0.05, 0.20), weight: 0.15 },
    { score: linearScore(assetCoverage, 0.8, 2.5), weight: 0.15 },
  ]);
  const capitalAllocation = weightedComponent([
    { score: linearScore(roe, 0, 0.30), weight: 0.35 },
    { score: linearScore(fcfMargin, 0, 0.25), weight: 0.30 },
    { score: linearScore(revenueCagr, -0.05, 0.25), weight: 0.20 },
    { score: linearScore(cashConversion, 0.5, 1.5), weight: 0.15 },
  ]);
  const total = Math.round(valuation.score * 0.35 + moat.score * 0.25 + uncertainty.score * 0.15 + financialHealth.score * 0.15 + capitalAllocation.score * 0.10);
  const confidence = Math.round(valuation.coverage * 0.35 + moat.coverage * 0.25 + uncertainty.coverage * 0.15 + financialHealth.coverage * 0.15 + capitalAllocation.coverage * 0.10);
  return {
    total,
    label: total >= 75 ? 'Strong watchlist' : total >= 58 ? 'Balanced watchlist' : 'High caution',
    lines: [
      ['Price/Fair Value', valuation.score],
      ['Economic Moat', moat.score],
      ['Uncertainty', uncertainty.score],
      ['Financial Health', financialHealth.score],
      ['Capital Allocation', capitalAllocation.score],
    ],
    confidence,
    methodologyVersion: STOCK_SCORE_MODEL_VERSION,
    source: 'Deterministic institutional-style model',
  };
}

function extractGlmMessageContent(data) {
  const content = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!content) return '';
  return content.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
}

function parseGlmJson(data) {
  const content = extractGlmMessageContent(data);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function hasStockNarrative(analysis) {
  if (!analysis || typeof analysis !== 'object') return false;
  const textFields = ['thesis', 'financialRead', 'valuationRead', 'riskRead', 'watchItems'];
  if (textFields.some(key => String(analysis[key] || '').trim())) return true;
  return Array.isArray(analysis.keyPoints) && analysis.keyPoints.some(point => String(point || '').trim());
}

function buildStockAnalysisFromParsed(parsed, input) {
  return {
    provider: 'glm',
    model: GLM_MODEL,
    thesis: String(parsed.thesis || '').trim(),
    financialRead: String(parsed.financialRead || '').trim(),
    valuationRead: String(parsed.valuationRead || '').trim(),
    riskRead: String(parsed.riskRead || '').trim(),
    watchItems: String(parsed.watchItems || '').trim(),
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(point => String(point).trim()).filter(Boolean).slice(0, 4) : [],
    tone: ['positive', 'negative', 'neutral'].includes(parsed.tone) ? parsed.tone : 'neutral',
    researchScore: normalizeResearchScore(parsed.researchScore),
    stagedEntry: normalizeStagedEntry(parsed.stagedEntry, input?.quote?.c, input?.technicalLevels),
  };
}

async function analyzeStockWithGlm(input, env, lang = 'zh') {
  const apiKey = env.GLM_API_KEY;
  if (!apiKey) {
    const error = new Error('GLM_API_KEY missing');
    error.status = 503;
    throw error;
  }
  const languageName = lang === 'en' ? 'English' : 'Traditional Chinese';
  const narrativeLanguageRule = lang === 'en'
    ? 'All narrative fields must be written in natural English.'
    : 'All narrative fields must be written in Traditional Chinese. Do not output English sentences in thesis, financialRead, valuationRead, riskRead, watchItems, or keyPoints. Keep only unavoidable ticker symbols, company names, and financial metric abbreviations in English.';
  const systemPrompt = `Return only JSON in ${languageName}. ${narrativeLanguageRule} You are producing a concise company-wide stock research conclusion, an AI judged research score, and scenario-based staged entry price ranges from supplied market data, SEC facts, valuation metrics, peers, and news snippets. Do not invent missing facts. Do not claim to predict the future price and do not provide financial advice.

Use a Morningstar-inspired framework only. Do not claim this is an official Morningstar rating, star rating, fair value estimate, moat rating, or analyst report. Morningstar's public framework centers on current price versus fair value, uncertainty around fair value, economic moat, financial strength/health, and capital allocation. We do not have Morningstar's proprietary fair value model, so estimate each dimension cautiously from supplied fundamentals, valuation multiples, peer comparison, cash flow, leverage, profitability, risk factors, and news.

Score conservatively from 0 to 100:
- Price/Fair Value 35%: approximate whether current valuation appears attractive versus fundamentals and peers. Use P/E, forward P/E, P/B, P/S, FCF yield, market cap context, price position, and cash-flow support. Penalize very expensive valuation unless moat and financial evidence clearly justify it.
- Economic Moat 25%: infer durability of competitive advantage from profitability, margins, returns, cash generation, industry position, scale, switching costs/network effects/intangibles where supported by facts/news. Penalize weak or unproven moat.
- Uncertainty 15%: lower score when fair-value confidence is weak because of cyclicality, high volatility, customer/product concentration, regulatory/geopolitical risks, fragile forecasts, missing data, or heavy valuation dependence on future growth.
- Financial Health 15%: use debt/leverage, cash flow quality, balance sheet strength, profitability consistency, liquidity proxies, and FCF.
- Capital Allocation 10%: infer management capital discipline from cash generation, reinvestment needs, margins, dilution/buybacks/dividends if available, and whether spending appears value creating. If evidence is missing, score neutral-low.

The total score should be the weighted result of these dimensions with a conservative adjustment for missing data and high uncertainty. Labels: Strong watchlist for 75+, Balanced watchlist for 58-74, High caution below 58.

For stagedEntry, produce two independent scenario-based entry plans using current price, valuation versus peers, beta, financial trend, score, recent risks, and supplied daily technicalLevels. Both plans must include ranges near the supplied ma50 and ma200 when those values are present; also consider support20, support60, resistance20, and resistance60. A reason may mention MA50, MA200, support, or resistance only when the corresponding numeric level is supplied and the row's range contains it or is within 2.5% of it. Quote the exact supplied technical value in that reason. Do not invent or approximate a missing technical level. Use numeric USD prices only. Each range must have low <= high, remain between 35% and 110% of current price, and deeper steps must not be above earlier steps. halfPlan must contain exactly 2 rows at 50% each; quarterPlan exactly 4 rows at 25% each. Give a short evidence-based reason for every row and a concise basis explaining the overall approach. These are conditional reference ranges, not price predictions or guarantees.

Output {"researchScore":{"total":0-100,"label":"Strong watchlist|Balanced watchlist|High caution","lines":{"priceFairValue":0-100,"economicMoat":0-100,"uncertainty":0-100,"financialHealth":0-100,"capitalAllocation":0-100}},"stagedEntry":{"riskLevel":"low|medium|high","basis":"${lang === 'en' ? 'English basis' : '繁體中文整體依據'}","halfPlan":[{"allocation":50,"low":0,"high":0,"reason":"${lang === 'en' ? 'English reason' : '繁體中文原因'}"},{"allocation":50,"low":0,"high":0,"reason":"${lang === 'en' ? 'English reason' : '繁體中文原因'}"}],"quarterPlan":[{"allocation":25,"low":0,"high":0,"reason":"${lang === 'en' ? 'English reason' : '繁體中文原因'}"},{"allocation":25,"low":0,"high":0,"reason":"${lang === 'en' ? 'English reason' : '繁體中文原因'}"},{"allocation":25,"low":0,"high":0,"reason":"${lang === 'en' ? 'English reason' : '繁體中文原因'}"},{"allocation":25,"low":0,"high":0,"reason":"${lang === 'en' ? 'English reason' : '繁體中文原因'}"}]},"thesis":"${lang === 'en' ? '2-3 English sentences' : '2-3 句繁體中文'}","financialRead":"${lang === 'en' ? '1-2 English sentences' : '1-2 句繁體中文'}","valuationRead":"${lang === 'en' ? '1-2 English sentences' : '1-2 句繁體中文'}","riskRead":"${lang === 'en' ? '1-2 English sentences' : '1-2 句繁體中文'}","watchItems":"${lang === 'en' ? '1 English sentence' : '1 句繁體中文'}","keyPoints":["${lang === 'en' ? 'English point 1' : '繁體中文重點 1'}","${lang === 'en' ? 'English point 2' : '繁體中文重點 2'}","${lang === 'en' ? 'English point 3' : '繁體中文重點 3'}"],"tone":"positive|negative|neutral"}.`;
  const attempts = [
    { reasoning_effort: GLM_REASONING_EFFORT, label: 'max' },
    { reasoning_effort: 'low', label: 'low' },
  ];
  let lastFinishReason = '';
  try {
    for (const attempt of attempts) {
      const body = {
        model: GLM_MODEL,
        response_format: { type: 'json_object' },
        max_tokens: GLM_STOCK_JSON_MAX_TOKENS,
        thinking: GLM_THINKING,
        reasoning_effort: attempt.reasoning_effort,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(input) },
        ],
      };
      const resp = await fetch(GLM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error('GLM stock analysis upstream error');
      const data = await resp.json();
      lastFinishReason = data?.choices?.[0]?.finish_reason || '';
      const parsed = parseGlmJson(data);
      if (!parsed) continue;
      const analysis = buildStockAnalysisFromParsed(parsed, input);
      if (hasStockNarrative(analysis)) return analysis;
    }
    const error = new Error(lastFinishReason === 'length'
      ? 'GLM stock analysis returned empty content (output token limit reached)'
      : 'GLM stock analysis returned empty narrative content');
    error.status = 502;
    throw error;
  } catch (err) {
    const error = new Error(err.message || 'GLM stock analysis failed');
    error.status = err.status || 502;
    throw error;
  }
}

function isValidStockAnalysisPayload(data) {
  return hasStockNarrative(data?.analysis);
}

async function handleStockAiAnalysis(url, env, corsHeaders) {
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!symbol) return json({ error: 'Missing symbol parameter' }, 400, corsHeaders);
  if (!validTicker(symbol)) return json({ error: 'Invalid symbol' }, 400, corsHeaders);
  const lang = (url.searchParams.get('lang') || 'zh').toLowerCase() === 'en' ? 'en' : 'zh';
  const forceRefresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
  const cacheKey = `stock-ai-analysis:v9:${STOCK_SCORE_MODEL_VERSION}:${NEWS_SOURCE_VERSION}:${lang}:${symbol}`;
  const edgeCached = forceRefresh ? null : await readCachedNews(cacheKey, corsHeaders);
  if (edgeCached) return edgeCached;
  const cached = cache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.ts < STOCK_AI_CACHE_TTL && isValidStockAnalysisPayload(cached.data)) {
    return json(cached.data, 200, corsHeaders, { 'X-Cache': 'HIT' });
  }
  if (cached) cache.delete(cacheKey);

  try {
    const [profile, quote, metricPayload, secFacts, peersRaw, newsRaw, technicalLevels] = await Promise.all([
      fetchFinnhubData(symbol, env, 'stock/profile2', 3600).catch(() => ({})),
      fetchFinnhubData(symbol, env, 'quote', 60).catch(() => ({})),
      fetchFinnhubData(symbol, env, 'stock/metric', 3600, { metric: 'all' }).catch(() => ({})),
      getSecCompanyFactsData(symbol, env).catch(() => null),
      fetchFinnhubData(symbol, env, 'stock/peers', 3600).catch(() => []),
      fetchFinnhubNewsForSymbol(symbol, env, []).catch(() => []),
      fetchDailyTechnicalLevels(symbol, env).catch(() => null),
    ]);
    const metrics = metricPayload?.metric || metricPayload || {};
    const peerList = Array.isArray(peersRaw) ? peersRaw.slice(0, 8) : [];
    const peerMetrics = (await Promise.all(peerList
      .filter(peerSymbol => peerSymbol && peerSymbol !== symbol)
      .slice(0, 6)
      .map(async peerSymbol => {
        const payload = await fetchFinnhubData(peerSymbol, env, 'stock/metric', 3600, { metric: 'all' }).catch(() => null);
        const peer = payload?.metric || payload;
        if (!peer) return null;
        return {
          symbol: peerSymbol,
          peTTM: firstFinite(peer, ['peTTM', 'peNormalizedAnnual', 'peInclExtraTTM']),
          forwardPERatio: firstFinite(peer, ['forwardPERatio', 'forwardPE']),
          pbAnnual: firstFinite(peer, ['pbAnnual', 'pbQuarterly']),
          psTTM: firstFinite(peer, ['psTTM', 'psAnnual']),
          roeTTM: percentageToRatio(firstFinite(peer, ['roeTTM', 'roeRfy'])),
          grossMarginTTM: percentageToRatio(firstFinite(peer, ['grossMarginTTM', 'grossMarginAnnual'])),
          netProfitMarginTTM: percentageToRatio(firstFinite(peer, ['netProfitMarginTTM', 'netProfitMarginAnnual'])),
        };
      }))).filter(Boolean);
    const news = Array.isArray(newsRaw) ? newsRaw.slice(0, 6).map(item => ({
      title: item.title,
      summary: item.summary,
      source: item.source,
      time: item.time,
    })) : [];
    const input = {
      symbol,
      profile: {
        name: profile?.name,
        exchange: profile?.exchange,
        industry: profile?.finnhubIndustry,
        country: profile?.country,
      },
      quote,
      metrics: {
        marketCapitalization: metrics.marketCapitalization,
        peTTM: metrics.peTTM || metrics.peNormalizedAnnual,
        forwardPERatio: metrics.forwardPERatio || metrics.forwardPE,
        pbAnnual: metrics.pbAnnual || metrics.pbQuarterly,
        psTTM: metrics.psTTM || metrics.psAnnual,
        roeTTM: metrics.roeTTM || metrics.roeRfy,
        grossMarginTTM: metrics.grossMarginTTM || metrics.grossMarginAnnual,
        netProfitMarginTTM: metrics.netProfitMarginTTM || metrics.netProfitMarginAnnual,
        beta: metrics.beta,
        debtEquity: firstFinite(metrics, ['totalDebt/totalEquityAnnual', 'totalDebt/totalEquityQuarterly']),
        currentRatio: firstFinite(metrics, ['currentRatioAnnual', 'currentRatioQuarterly']),
      },
      secFacts: secFacts ? {
        revenue: compactAnalysisFact(secFacts.facts?.revenue),
        netIncome: compactAnalysisFact(secFacts.facts?.netIncome),
        operatingCashFlow: compactAnalysisFact(secFacts.facts?.operatingCashFlow),
        freeCashFlow: compactAnalysisFact(secFacts.facts?.freeCashFlow),
        revenueTrend: (secFacts.trends?.revenue || []).slice(-6),
        netIncomeTrend: (secFacts.trends?.netIncome || []).slice(-6),
      } : null,
      peers: peerMetrics,
      news,
      technicalLevels,
    };
    input.institutionalScore = calculateInstitutionalScore(input);
    const analysis = await analyzeStockWithGlm(input, env, lang);
    analysis.researchScore = input.institutionalScore;
    const data = {
      provider: 'glm_stock_research',
      model: analysis.model,
      symbol,
      analysis,
      technicalLevels,
      updatedAt: new Date().toISOString(),
      glmConfigured: Boolean(env.GLM_API_KEY),
    };
    if (!isValidStockAnalysisPayload(data)) {
      const error = new Error('GLM stock analysis returned empty narrative content');
      error.status = 502;
      throw error;
    }
    cache.set(cacheKey, { ts: Date.now(), data });
    await writeCachedStockAnalysis(cacheKey, data);
    return json(data, 200, corsHeaders, { 'X-Cache': 'MISS' });
  } catch (err) {
    return json({ error: err.message || 'Stock AI analysis failed', status: err.status || 502, symbol }, err.status || 502, corsHeaders);
  }
}

const FUND_FLOW_UNIVERSE = {
  XLI: 'Industrials', XLV: 'Health Care', XLP: 'Consumer Staples', XLY: 'Consumer Discretionary',
  XLC: 'Communication Services', XLF: 'Financials', XLB: 'Materials', XLRE: 'Real Estate',
  XLU: 'Utilities', XLE: 'Energy', MAGS: 'Mega Cap Tech', XLK: 'Technology', SMH: 'Semiconductors',
};

function normalizePriceSeries(timestamps, closes, source) {
  if (!Array.isArray(closes)) return null;
  const points = [];
  for (let i = 0; i < closes.length; i += 1) {
    const close = Number(closes[i]);
    const ts = Array.isArray(timestamps) ? Number(timestamps[i]) : NaN;
    if (Number.isFinite(close) && close > 0 && Number.isFinite(ts)) points.push({ ts, close });
  }
  if (points.length < 6) return null;
  return { points, source };
}

function hasRecentSessionGap(points, maxCalendarDays = 3) {
  if (!Array.isArray(points) || points.length < 2) return true;
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  return (last.ts - prev.ts) > maxCalendarDays * 86400;
}

async function fetchFinnhubPriceSeries(symbol, env) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - (90 * 24 * 60 * 60);
  const finnhub = await fetchFinnhubData(symbol, env, 'stock/candle', 900, { resolution: 'D', from, to: now }).catch(() => null);
  if (!finnhub || finnhub.s !== 'ok') return null;
  return normalizePriceSeries(finnhub.t, finnhub.c, 'Finnhub historical closes');
}

async function fetchYahooPriceSeries(symbol) {
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo&events=history`;
  try {
    const response = await fetch(yahooUrl, { headers: { Accept: 'application/json', 'User-Agent': 'BlackSpace/1.0' }, cf: { cacheEverything: true, cacheTtl: 900 } });
    if (!response.ok) return null;
    const payload = await response.json();
    const result = payload?.chart?.result?.[0];
    return normalizePriceSeries(
      result?.timestamp,
      result?.indicators?.quote?.[0]?.close,
      'Yahoo Finance historical closes',
    );
  } catch (_) {
    return null;
  }
}

async function fetchPriceCloses(symbol, env) {
  const finnhubSeries = await fetchFinnhubPriceSeries(symbol, env);
  const yahooSeries = await fetchYahooPriceSeries(symbol);
  const finnhubOk = finnhubSeries && !hasRecentSessionGap(finnhubSeries.points);
  const yahooOk = yahooSeries && !hasRecentSessionGap(yahooSeries.points);
  if (finnhubOk) return finnhubSeries;
  if (yahooOk) return yahooSeries;
  if (finnhubSeries) return finnhubSeries;
  if (yahooSeries) return yahooSeries;
  throw new Error('No valid Yahoo Finance or Finnhub historical closes');
}

async function fetchFinnhubQuote(symbol, env) {
  return fetchFinnhubData(symbol, env, 'quote', 60).catch(() => null);
}

function quoteOneDayPct(quote) {
  if (!quote || !Number.isFinite(quote.pc) || quote.pc <= 0) return null;
  if (Number.isFinite(quote.dp)) return quote.dp;
  if (!Number.isFinite(quote.c)) return null;
  return ((quote.c / quote.pc) - 1) * 100;
}

function dailyChangeSign(changePct) {
  return changePct > 0 ? 1 : changePct < 0 ? -1 : 0;
}

function buildDailyChanges(points) {
  const dailyChanges = [];
  for (let i = 1; i < points.length; i += 1) {
    const close = points[i].close;
    const previous = points[i - 1].close;
    if (!Number.isFinite(close) || !Number.isFinite(previous) || previous <= 0) continue;
    const changePct = ((close / previous) - 1) * 100;
    dailyChanges.push({ changePct, sign: dailyChangeSign(changePct) });
  }
  return dailyChanges;
}

function applyQuoteToLastDailyChange(dailyChanges, points, quote) {
  const oneDayPct = quoteOneDayPct(quote);
  if (!Number.isFinite(oneDayPct)) return oneDayPct;
  const entry = { changePct: oneDayPct, sign: dailyChangeSign(oneDayPct) };
  if (dailyChanges.length && hasRecentSessionGap(points)) {
    dailyChanges[dailyChanges.length - 1] = entry;
  } else if (!dailyChanges.length) {
    dailyChanges.push(entry);
  }
  return oneDayPct;
}

function roundPriceChange(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

async function buildPriceTrendRow(symbol, env) {
  const quote = await fetchFinnhubQuote(symbol, env);
  let candles = await fetchFinnhubPriceSeries(symbol, env);
  if (!candles) {
    try { candles = await fetchPriceCloses(symbol, env); } catch (_) {}
  }
  if (!candles?.points?.length) {
    const oneDayPct = quoteOneDayPct(quote);
    if (!Number.isFinite(oneDayPct)) throw new Error('No historical close data');
    const sign = dailyChangeSign(oneDayPct);
    return {
      symbol,
      sector: FUND_FLOW_UNIVERSE[symbol],
      oneDayPct: roundPriceChange(oneDayPct),
      fiveDayPct: null,
      streakDays: sign === 0 ? 0 : 1,
      streakDirection: sign > 0 ? 'up' : sign < 0 ? 'down' : 'neutral',
      source: 'Finnhub quote',
    };
  }

  const { points, source: historySource } = candles;
  const dailyChanges = buildDailyChanges(points);
  if (dailyChanges.length < 5 || points.length < 6) throw new Error('Insufficient historical close data');

  const quoteOneDay = applyQuoteToLastDailyChange(dailyChanges, points, quote);
  const oneDayPct = Number.isFinite(quoteOneDay)
    ? quoteOneDay
    : dailyChanges[dailyChanges.length - 1].changePct;

  const latestClose = points[points.length - 1].close;
  const fiveDayBase = points[points.length - 6].close;
  const fiveDayPct = ((latestClose / fiveDayBase) - 1) * 100;
  const streakSign = dailyChanges[dailyChanges.length - 1].sign;
  let streakDays = 0;
  for (let i = dailyChanges.length - 1; i >= 0 && dailyChanges[i].sign === streakSign && streakSign !== 0; i -= 1) streakDays += 1;

  const source = Number.isFinite(quoteOneDay)
    ? `Finnhub quote + ${historySource}`
    : historySource;

  return {
    symbol,
    sector: FUND_FLOW_UNIVERSE[symbol],
    oneDayPct: roundPriceChange(oneDayPct),
    fiveDayPct: roundPriceChange(fiveDayPct),
    streakDays,
    streakDirection: streakSign > 0 ? 'up' : streakSign < 0 ? 'down' : 'neutral',
    source,
  };
}

async function handleFundFlow(url, env, corsHeaders) {
  const requested = (url.searchParams.get('symbols') || Object.keys(FUND_FLOW_UNIVERSE).join(','))
    .split(',').map(value => value.trim().toUpperCase()).filter(symbol => FUND_FLOW_UNIVERSE[symbol]);
  const symbols = [...new Set(requested)].slice(0, 13);
  const results = [];
  for (const symbol of symbols) {
    try { results.push(await buildPriceTrendRow(symbol, env)); }
    catch (error) { results.push({ symbol, sector: FUND_FLOW_UNIVERSE[symbol], error: error.message }); }
  }
  results.sort((a, b) => {
    const signed = row => row.streakDirection === 'up' ? row.streakDays || 0 : row.streakDirection === 'down' ? -(row.streakDays || 0) : 0;
    return signed(b) - signed(a);
  });
  return json({ model: 'finnhub-quote-v3', dataType: 'historical-close-price-changes', items: results }, 200, corsHeaders);
}

async function handleFundFlowAnalysis(request, env, corsHeaders) {
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items.slice(0, 13) : [];
  const locale = String(body.locale || body.lang || 'zh').toLowerCase();
  const lang = locale === 'en' || locale.startsWith('en-') ? 'en' : 'zh';
  const apiKey = env.GLM_API_KEY;
  if (!apiKey) return json({ error: 'GLM_API_KEY is not configured', model: GLM_MODEL }, 503, corsHeaders);
  const language = lang === 'en'
    ? 'English only. Do not output Chinese sentences.'
    : 'Traditional Chinese only (繁體中文／正體中文). Do not output English sentences; keep only ticker symbols and unavoidable metric abbreviations in Latin characters.';
  const response = await fetch(GLM_ENDPOINT, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GLM_MODEL, response_format: { type: 'json_object' }, thinking: GLM_THINKING, reasoning_effort: GLM_REASONING_EFFORT,
      messages: [
        { role: 'system', content: `Return only JSON in ${language}. Use only the supplied historical-close fields symbol, sector, oneDayPct, fiveDayPct, streakDays, and streakDirection. These are actual percentage changes calculated from historical closing prices. Discuss price trend and momentum only. Do not mention fund flows, money flows, turnover, volume, AUM, creations, redemptions, news, fundamentals, targets, guarantees, or buy/sell instructions. Produce a concise but detailed structured analysis with six sections: overall price-trend regime; strongest upward groups; weakest or downward groups; consistency and possible turning points using one-day change, five-day change, and streaks; risks and caveats; and a conditional observation plan. Each section should be practical, explain only what the supplied price metrics show, use conditional language, and avoid definitive recommendations. Output {"analysis":{"overall":"...","stronger":"...","weaker":"...","consistency":"...","risk":"...","plan":"..."}} with all six fields filled.` },
        { role: 'user', content: JSON.stringify({ items, limitation: 'Use only the supplied historical closing-price changes and streaks.' }) },
      ],
    }),
  });
  if (!response.ok) return json({ error: 'GLM upstream error', model: GLM_MODEL }, 502, corsHeaders);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim());
  const keys = ['overall', 'stronger', 'weaker', 'consistency', 'risk', 'plan'];
  const analysis = Object.fromEntries(keys.map(key => [key, typeof parsed?.analysis?.[key] === 'string' ? parsed.analysis[key].trim().slice(0, 700) : '']));
  const hasCjk = text => /[\u3400-\u9fff]/.test(text);
  const localeMatches = keys.every(key => lang === 'zh' ? hasCjk(analysis[key]) : !hasCjk(analysis[key]));
  if (!localeMatches) return json({ error: 'GLM returned analysis in the wrong locale', model: GLM_MODEL, locale: lang }, 502, corsHeaders);
  return json({ model: GLM_MODEL, provider: 'GLM', dataType: 'historical-close-price-analysis', analysis, bullets: keys.map(key => analysis[key]).filter(Boolean) }, 200, corsHeaders);
}

async function handleChart(url, env, corsHeaders) {
  const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!validTicker(symbol)) return json({ error: 'Invalid symbol' }, 400, corsHeaders);
  try {
    const candles = await fetchFinnhubPriceSeries(symbol, env) || await fetchPriceCloses(symbol, env);
    return json({
      symbol,
      timestamps: candles.points.map(point => point.ts),
      closes: candles.points.map(point => point.close),
      source: candles.source,
    }, 200, corsHeaders);
  } catch (error) {
    return json({ error: error.message || 'Chart unavailable', symbol }, 502, corsHeaders);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = cors(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/news') return await handleNews(url, env, corsHeaders);
      if (url.pathname === '/news-analysis') return await handleNewsAnalysis(url, env, corsHeaders);
      if (url.pathname === '/fund-flow' && request.method === 'GET') return await handleFundFlow(url, env, corsHeaders);
      if (url.pathname === '/fund-flow-analysis' && request.method === 'POST') return await handleFundFlowAnalysis(request, env, corsHeaders);
      if (url.pathname === '/chart' && request.method === 'GET') return await handleChart(url, env, corsHeaders);
      if (url.pathname === '/stock-ai-analysis') return await handleStockAiAnalysis(url, env, corsHeaders);
      if (url.pathname === '/quote') return await handleFinnhubRoute(url, env, corsHeaders, 'quote', 60);
      if (url.pathname === '/profile2') return await handleFinnhubRoute(url, env, corsHeaders, 'stock/profile2', 3600);
      if (url.pathname === '/metric') return await handleFinnhubRoute(url, env, corsHeaders, 'stock/metric', 3600);
      if (url.pathname === '/peers') return await handleFinnhubRoute(url, env, corsHeaders, 'stock/peers', 3600);
      if (url.pathname === '/sec-companyfacts') return await handleSecCompanyFacts(url, env, corsHeaders);
      if (url.pathname === '/sec-filing-sections') return await handleSecFilingSections(url, env, corsHeaders);
      return await handlePrice(url, env, corsHeaders);
    } catch (err) {
      return json({ error: 'Fetch failed', message: err.message }, 500, corsHeaders);
    }
  },
};

