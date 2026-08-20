const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const APP_ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
const DEFAULT_PARTNER_ID = process.env.SHOPEE_PARTNER_ID || '';
const DEFAULT_PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY || '';
const AUTH_HOST = process.env.SHOPEE_AUTH_HOST || 'https://partner.shopeemobile.com';
const BR_API_HOST = process.env.SHOPEE_BR_API_HOST || 'https://openplatform.shopee.com.br';
const GLOBAL_API_HOST = process.env.SHOPEE_GLOBAL_API_HOST || 'https://partner.shopeemobile.com';
const CALLBACK_PATH = process.env.SHOPEE_CALLBACK_PATH || '/api/shopee/callback';
const CALLBACK_URL = `${APP_ORIGIN}${CALLBACK_PATH}`;
const ROOT = path.resolve(__dirname);

const sessions = new Map();
const oauthStates = new Map();

function loadEnvFile() {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Variável obrigatória ausente: ${name}`);
    process.exitCode = 1;
    throw new Error(`Configure ${name} no arquivo .env antes de iniciar o servidor.`);
  }
  return value;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function hmacSha256(value, partnerKey) {
  return crypto.createHmac('sha256', partnerKey).update(value, 'utf8').digest('hex');
}

function signPublicRequest(apiPath, timestamp, credentials) {
  return hmacSha256(`${credentials.partnerId}${apiPath}${timestamp}`, credentials.partnerKey);
}

function signShopRequest(apiPath, timestamp, accessToken, shopId, credentials) {
  return hmacSha256(`${credentials.partnerId}${apiPath}${timestamp}${accessToken}${shopId}`, credentials.partnerKey);
}

function normalizeApiUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Informe a URL da API disponibilizada pela Shopee.');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:') throw new Error('A URL da API deve usar HTTPS.');
  const allowedHosts = new Set([
    'openplatform.shopee.com.br',
    'openplatform.shopee.com',
    'partner.shopeemobile.com',
    'open.shopee.com.br',
    'open.shopee.com'
  ]);
  if (!allowedHosts.has(parsed.hostname)) throw new Error('Use uma URL oficial da Shopee.');
  const apiMarker = parsed.pathname.indexOf('/api/v2/');
  if (apiMarker >= 0) parsed.pathname = parsed.pathname.slice(0, apiMarker);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function validateAffiliateCredentials(input = {}, fallback = {}) {
  const partnerId = String(input.partnerId || fallback.partnerId || DEFAULT_PARTNER_ID).trim();
  const partnerKey = String(input.partnerKey || fallback.partnerKey || DEFAULT_PARTNER_KEY);
  if (!/^\d+$/.test(partnerId)) throw new Error('O AppID/Partner ID deve conter apenas números.');
  if (!partnerKey) throw new Error('Informe a senha/Partner Key fornecida pela Shopee.');
  return {
    apiUrl: normalizeApiUrl(input.apiUrl || fallback.apiUrl || BR_API_HOST),
    partnerId,
    partnerKey,
    region: input.region || fallback.region || 'br',
  };
}

function parseCookies(request) {
  const header = request.headers.cookie || '';
  return Object.fromEntries(header.split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

function getSession(request, create = true) {
  const cookies = parseCookies(request);
  let sid = cookies.shopee_sid;
  let session = sid ? sessions.get(sid) : null;
  if (!session && create) {
    sid = crypto.randomBytes(24).toString('hex');
    session = { createdAt: Date.now(), updatedAt: Date.now() };
    sessions.set(sid, session);
  }
  return { sid, session };
}

function sendJson(response, status, payload, sid) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (sid) {
    headers['Set-Cookie'] = `shopee_sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
  }
  response.writeHead(status, headers);
  response.end(body);
}

function redirect(response, location, sid) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (sid) {
    headers['Set-Cookie'] = `shopee_sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
  }
  response.writeHead(302, headers);
  response.end();
}

function sendError(response, status, message, sid, details = {}) {
  sendJson(response, status, { ok: false, error: message, ...details }, sid);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('Corpo da requisição excede o limite permitido.');
  }
  if (!body) return {};
  return JSON.parse(body);
}

async function shopeeRequest(host, apiPath, credentials, { method = 'GET', query = {}, body = null } = {}) {
  const timestamp = nowSeconds();
  const url = new URL(apiPath, host);
  const headers = { Accept: 'application/json' };
  let requestBody;

  if (apiPath === '/api/v2/auth/token/get' || apiPath === '/api/v2/auth/access_token/get') {
    const sign = signPublicRequest(apiPath, timestamp, credentials);
    url.searchParams.set('partner_id', String(credentials.partnerId));
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', sign);
    requestBody = JSON.stringify({ ...body, partner_id: Number(credentials.partnerId) });
    headers['Content-Type'] = 'application/json';
  } else {
    const accessToken = String(query.access_token || '');
    const shopId = String(query.shop_id || '');
    const sign = signShopRequest(apiPath, timestamp, accessToken, shopId, credentials);
    url.searchParams.set('partner_id', String(credentials.partnerId));
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('shop_id', shopId);
    url.searchParams.set('sign', sign);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    requestBody = undefined;
  }

  const result = await fetch(url, { method, headers, body: requestBody });
  const text = await result.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!result.ok) {
    const detail = data.message || data.error || `HTTP ${result.status}`;
    const error = new Error(`Shopee respondeu ${result.status}: ${detail}`);
    error.status = result.status;
    error.payload = data;
    throw error;
  }
  if (data.error) {
    const error = new Error(data.message || data.error);
    error.status = 502;
    error.payload = data;
    throw error;
  }
  return data;
}

async function exchangeAuthorizationCode(code, shopId, credentials) {
  return shopeeRequest(AUTH_HOST, '/api/v2/auth/token/get', credentials, {
    method: 'POST',
    body: { code, shop_id: Number(shopId) },
  });
}

async function refreshAccessToken(session) {
  const result = await shopeeRequest(AUTH_HOST, '/api/v2/auth/access_token/get', session.credentials, {
    method: 'POST',
    body: { refresh_token: session.refreshToken, shop_id: Number(session.shopId) },
  });
  if (!result.access_token) throw new Error(result.message || 'A Shopee não retornou um novo access_token.');
  session.accessToken = result.access_token;
  session.refreshToken = result.refresh_token || session.refreshToken;
  session.expiresAt = Date.now() + Number(result.expire_in || 14400) * 1000;
  session.updatedAt = Date.now();
}

async function ensureAccessToken(session) {
  if (!session.accessToken || !session.refreshToken || Date.now() > session.expiresAt - 60_000) {
    if (!session.refreshToken) throw new Error('A loja Shopee ainda não foi autorizada.');
    await refreshAccessToken(session);
  }
}

function parseDateTimeToTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value).replace(/\//g, '-'));
  return Number.isNaN(timestamp) ? null : Math.floor(timestamp / 1000);
}

function moneyToNumber(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined || value === '') return 0;
  const normalized = String(value).replace(/[^0-9,.-]/g, '').replace(/\./g, '').replace(',', '.');
  return Number(normalized) || 0;
}

function normalizeConversionRecord(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemQty = items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  const affiliateCommission = items.reduce((sum, item) => sum + moneyToNumber(item.item_brand_commission_to_affiliate), 0);
  const totalCommission = affiliateCommission || moneyToNumber(order.order_brand_commission);
  const productNames = items.map((item) => item.item_name).filter(Boolean).join(', ');
  return {
    orderId: order.order_sn || 'N/A',
    purchaseTime: parseDateTimeToTimestamp(order.place_order_time),
    clickTime: null,
    subId: order.campaign_partner || 'Shopee Afiliados',
    channel: order.channel || 'Shopee',
    itemQty: itemQty || 1,
    totalCommission,
    orderStatus: order.order_status || 'N/A',
    verifiedStatus: order.verified_status || 'N/A',
    productName: productNames || 'Produto não informado',
    orderValue: items.reduce((sum, item) => sum + moneyToNumber(item.purchase_value), 0),
  };
}

async function fetchConversionReport(session, region, days) {
  await ensureAccessToken(session);
  const credentials = session.credentials;
  const apiPath = '/api/v2/ams/get_conversion_report';
  const end = nowSeconds();
  const start = end - Math.min(Math.max(Number(days) || 30, 1), 90) * 86400;
  const pageSize = 100;
  const all = [];

  for (let page = 1; page <= 100; page += 1) {
    const result = await shopeeRequest(credentials.apiUrl, apiPath, credentials, {
      query: {
        access_token: session.accessToken,
        shop_id: session.shopId,
        page_no: page,
        page_size: pageSize,
        conversion_completed_time_start: start,
        conversion_completed_time_end: end,
      },
    });
    const rows = result.response?.list || [];
    all.push(...rows.map(normalizeConversionRecord));
    if (!result.response?.has_more || rows.length === 0) break;
  }
  return all;
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, APP_ORIGIN);
  const { sid, session } = getSession(request, true);

  try {
    if (request.method === 'POST' && requestUrl.pathname === '/api/shopee/auth-url') {
      const body = await readJson(request);
      const credentials = validateAffiliateCredentials(body, session.credentials || {});
      session.credentials = credentials;
      session.updatedAt = Date.now();
      const state = crypto.randomBytes(24).toString('hex');
      oauthStates.set(state, { sid, credentials, expiresAt: Date.now() + 10 * 60 * 1000 });
      const authHost = credentials.apiUrl.includes('shopee.com.br') ? 'https://open.shopee.com.br' : 'https://open.shopee.com';
      const authUrl = new URL(process.env.SHOPEE_AUTH_URL || `${authHost}/auth`);
      authUrl.searchParams.set('partner_id', String(credentials.partnerId));
      authUrl.searchParams.set('auth_type', 'seller');
      authUrl.searchParams.set('redirect_uri', CALLBACK_URL);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('state', state);
      return sendJson(response, 200, { ok: true, url: authUrl.toString() }, sid);
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/shopee/callback') {
      const stateInfo = oauthStates.get(requestUrl.searchParams.get('state'));
      const code = requestUrl.searchParams.get('code');
      const shopId = requestUrl.searchParams.get('shop_id');
      if (!stateInfo || stateInfo.expiresAt < Date.now() || stateInfo.sid !== sid || !code || !shopId) {
        return redirect(response, '/?shopee=error', sid);
      }
      oauthStates.delete(requestUrl.searchParams.get('state'));
      const credentials = session.credentials || stateInfo.credentials;
      if (!credentials) throw new Error('As credenciais do afiliado não estão disponíveis nesta sessão.');
      const token = await exchangeAuthorizationCode(code, shopId, credentials);
      if (!token.access_token) throw new Error(token.message || 'A Shopee não retornou access_token.');
      session.credentials = credentials;
      session.shopId = Number(shopId);
      session.accessToken = token.access_token;
      session.refreshToken = token.refresh_token;
      session.expiresAt = Date.now() + Number(token.expire_in || 14400) * 1000;
      session.updatedAt = Date.now();
      return redirect(response, '/?shopee=connected', sid);
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/shopee/status') {
      return sendJson(response, 200, {
        ok: true,
        connected: Boolean(session.accessToken && session.shopId),
        accountId: session.shopId || null,
        apiUrl: session.credentials?.apiUrl || null,
        partnerId: session.credentials?.partnerId ? `${session.credentials.partnerId.slice(0, 3)}***` : null,
        expiresAt: session.expiresAt || null,
      }, sid);
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/shopee/sync') {
      const body = await readJson(request);
      if (body.apiUrl || body.partnerId || body.partnerKey) {
        session.credentials = validateAffiliateCredentials(body, session.credentials || {});
      }
      if (!session.shopId || !session.accessToken) return sendError(response, 401, 'Autorize uma conta de afiliado Shopee antes de sincronizar.', sid);
      const nodes = await fetchConversionReport(session, body.region || session.credentials?.region || 'br', body.days || 30);
      return sendJson(response, 200, { ok: true, nodes, count: nodes.length, accountId: session.shopId }, sid);
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/shopee/disconnect') {
      delete sessions.get(sid).accessToken;
      delete sessions.get(sid).refreshToken;
      delete sessions.get(sid).shopId;
      delete sessions.get(sid).expiresAt;
      delete sessions.get(sid).credentials;
      return sendJson(response, 200, { ok: true }, sid);
    }

    if (request.method === 'GET') {
      const filePath = requestUrl.pathname === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, requestUrl.pathname);
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return response.end('Não encontrado');
      }
      const ext = path.extname(filePath);
      const contentType = ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
      response.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' });
      return response.end(fs.readFileSync(filePath));
    }

    return sendError(response, 404, 'Rota não encontrada.', sid);
  } catch (error) {
    console.error('Shopee API error:', error.message, error.payload || '');
    return sendError(response, error.status || 500, error.message || 'Erro interno do servidor.', sid, {
      request_id: error.payload?.request_id || null,
    });
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error);
    sendError(response, 500, 'Erro inesperado no servidor.');
  });
});

server.listen(PORT, () => {
  console.log(`Shopee Analytics disponível em ${APP_ORIGIN}`);
  console.log(`Callback OAuth: ${CALLBACK_URL}`);
});
