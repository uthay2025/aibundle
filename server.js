const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

loadEnvFile();

const port = Number(process.env.PORT || 3000);
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
const expectedPaymentAmount = Number(process.env.RAZORPAY_EXPECTED_AMOUNT || 1900);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const fulfillmentWebhookUrl = process.env.FULFILLMENT_WEBHOOK_URL || '';
const rootDirectory = __dirname;
const purchaseFile = path.join(rootDirectory, 'data', 'purchases.json');
const products = {
  '175-ai-tools': {
    filename: '175_AI_Tools_Directory.pdf',
    downloadName: '175-AI-Tools-Directory.pdf'
  },
  'local-ai-beginners': {
    filename: 'Local_AI_Beginners_Guide.pdf',
    downloadName: 'Local-AI-Setup-for-Beginners.pdf'
  }
};

if (!webhookSecret) {
  console.warn('RAZORPAY_WEBHOOK_SECRET is not set. Webhook requests will be rejected.');
}

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function readPurchases() {
  if (!fs.existsSync(purchaseFile)) return {};
  return JSON.parse(fs.readFileSync(purchaseFile, 'utf8'));
}

function writePurchases(purchases) {
  fs.mkdirSync(path.dirname(purchaseFile), { recursive: true });
  const temporaryFile = `${purchaseFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(purchases, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, purchaseFile);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function serveFile(response, filename, contentType, downloadName) {
  const filePath = path.join(rootDirectory, filename);
  if (!fs.existsSync(filePath)) return sendJson(response, 404, { error: 'File unavailable' });

  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': downloadName ? `attachment; filename="${downloadName}"` : undefined,
    'Content-Length': fs.statSync(filePath).size
  });
  fs.createReadStream(filePath).pipe(response);
}

function getRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function verifySignature(rawBody, signature) {
  if (!webhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const received = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return received.length === expectedBuffer.length && crypto.timingSafeEqual(received, expectedBuffer);
}

function createPurchase(payment) {
  const purchases = readPurchases();
  if (purchases[payment.id]) return { purchase: purchases[payment.id], isNew: false };

  const downloads = Object.fromEntries(Object.keys(products).map((productId) => [productId, {
    token: crypto.randomBytes(32).toString('hex'),
    usedAt: null
  }]));
  const purchase = {
    paymentId: payment.id,
    orderId: payment.order_id || null,
    email: payment.email || null,
    contact: payment.contact || null,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    createdAt: new Date().toISOString(),
    deliveryToken: crypto.randomBytes(32).toString('hex'),
    deliveryClaimedAt: null,
    downloads
  };

  purchases[payment.id] = purchase;
  writePurchases(purchases);
  return { purchase, isNew: true };
}

function getDeliveryUrl(purchase) {
  return `${publicBaseUrl}/delivery?token=${purchase.deliveryToken}`;
}

async function notifyFulfillment(purchase) {
  const deliveryUrl = getDeliveryUrl(purchase);
  console.info(`Fulfillment created for ${purchase.paymentId}`, { email: purchase.email, deliveryUrl });

  if (!fulfillmentWebhookUrl) return;

  try {
    const result = await fetch(fulfillmentWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentId: purchase.paymentId,
        email: purchase.email,
        contact: purchase.contact,
        deliveryUrl
      })
    });
    if (!result.ok) console.error(`Fulfillment webhook failed: HTTP ${result.status}`);
  } catch (error) {
    console.error('Fulfillment webhook failed:', error.message);
  }
}

async function handleWebhook(request, response) {
  const rawBody = await getRawBody(request);
  const signature = request.headers['x-razorpay-signature'];
  if (!verifySignature(rawBody, signature)) return sendJson(response, 400, { error: 'Invalid webhook signature' });

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return sendJson(response, 400, { error: 'Invalid JSON payload' });
  }

  if (event.event !== 'payment.captured') return sendJson(response, 200, { received: true, ignored: event.event });

  const payment = event.payload?.payment?.entity;
  if (!payment?.id || payment.status !== 'captured') return sendJson(response, 400, { error: 'Expected a captured payment' });
  if (payment.amount !== expectedPaymentAmount || payment.currency !== 'INR') {
    return sendJson(response, 400, { error: 'Payment amount or currency does not match this product' });
  }

  const { purchase, isNew } = createPurchase(payment);

  if (isNew) await notifyFulfillment(purchase);

  return sendJson(response, 200, { received: true });
}

function findPurchaseByDeliveryToken(token) {
  if (!token) return null;
  const purchases = readPurchases();
  return Object.values(purchases).find((purchase) => purchase.deliveryToken === token && purchase.status === 'captured') || null;
}

function findPurchaseByDownloadToken(productId, token) {
  if (!token) return null;
  const purchases = readPurchases();
  return Object.values(purchases).find((purchase) => purchase.status === 'captured' && purchase.downloads?.[productId]?.token === token) || null;
}

function renderPage(response, title, content, statusCode = 200) {
  response.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#050816;color:#fff;font-family:system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;padding:24px}.card{max-width:580px;background:#111827;border:1px solid #24304a;border-radius:12px;padding:34px;text-align:center}h1{margin-top:0}p{color:#c8d1e0;line-height:1.6}.button{display:inline-block;margin:8px;padding:13px 18px;border:0;border-radius:6px;background:#00ff88;color:#07150f;font-weight:800;text-decoration:none;cursor:pointer}small{display:block;margin-top:18px;color:#9faabd}</style></head><body><main class="card">${content}</main></body></html>`);
}

function claimDelivery(token) {
  const purchases = readPurchases();
  const entry = Object.entries(purchases).find(([, purchase]) => purchase.deliveryToken === token && purchase.status === 'captured');
  if (!entry) return null;
  const [paymentId, purchase] = entry;
  if (purchase.deliveryClaimedAt) return { alreadyClaimed: true };
  purchase.deliveryClaimedAt = new Date().toISOString();
  purchases[paymentId] = purchase;
  writePurchases(purchases);
  return { purchase };
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, publicBaseUrl);

  try {
    if (request.method === 'POST' && requestUrl.pathname === '/webhook') return handleWebhook(request, response);

    if (request.method === 'GET' && requestUrl.pathname === '/delivery') {
      const purchase = findPurchaseByDeliveryToken(requestUrl.searchParams.get('token'));
      if (!purchase || purchase.deliveryClaimedAt) return renderPage(response, 'Link unavailable', '<h1>Link unavailable</h1><p>This delivery link has already been used or is invalid.</p>', 410);
      const token = requestUrl.searchParams.get('token');
      return renderPage(response, 'Your PDF bundle is ready', `<h1>Your PDF bundle is ready</h1><p>Use this one-time link to unlock your two downloads. Each PDF download can be used once.</p><form method="post" action="/delivery/claim?token=${encodeURIComponent(token)}"><button class="button" type="submit">Unlock my PDFs</button></form><small>Verified payment required</small>`);
    }

    if (request.method === 'POST' && requestUrl.pathname === '/delivery/claim') {
      const result = claimDelivery(requestUrl.searchParams.get('token'));
      if (!result || result.alreadyClaimed) return renderPage(response, 'Link unavailable', '<h1>Link unavailable</h1><p>This delivery link has already been used or is invalid.</p>', 410);
      const links = Object.entries(products).map(([productId, product]) => `<a class="button" href="/downloads/${productId}?token=${result.purchase.downloads[productId].token}">${product.downloadName}</a>`).join('');
      return renderPage(response, 'Download your PDFs', `<h1>Download your PDFs</h1><p>Each download button works once. Save the files after downloading.</p>${links}`);
    }

    if (request.method === 'GET' && requestUrl.pathname.startsWith('/downloads/')) {
      const productId = requestUrl.pathname.split('/').pop();
      const product = products[productId];
      if (!product) return sendJson(response, 404, { error: 'Unknown product' });
      const purchase = findPurchaseByDownloadToken(productId, requestUrl.searchParams.get('token'));
      if (!purchase || purchase.downloads[productId].usedAt) return sendJson(response, 403, { error: 'This one-time download link is unavailable' });
      const purchases = readPurchases();
      purchase.downloads[productId].usedAt = new Date().toISOString();
      purchases[purchase.paymentId] = purchase;
      writePurchases(purchases);
      return serveFile(response, product.filename, 'application/pdf', product.downloadName);
    }

    if (request.method === 'GET' && requestUrl.pathname === '/') return serveFile(response, 'index.html', 'text/html; charset=utf-8');
    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: 'Internal server error' });
  }
});

server.listen(port, () => console.log(`Storefront running at ${publicBaseUrl}`));