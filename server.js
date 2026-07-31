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

  const token = crypto.randomBytes(32).toString('hex');
  const purchase = {
    paymentId: payment.id,
    orderId: payment.order_id || null,
    email: payment.email || null,
    contact: payment.contact || null,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    createdAt: new Date().toISOString(),
    token
  };

  purchases[payment.id] = purchase;
  writePurchases(purchases);
  return { purchase, isNew: true };
}

function getDownloads(token) {
  return Object.entries(products).map(([productId, product]) => ({
    name: product.downloadName,
    url: `${publicBaseUrl}/downloads/${productId}?token=${token}`
  }));
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
  const downloads = getDownloads(purchase.token);

  if (isNew) {
    console.info(`Fulfillment created for ${payment.id}`, { email: purchase.email, downloads });
    // Send `downloads` to purchase.email here using your chosen transactional email provider.
  }

  return sendJson(response, 200, { received: true });
}

function authorizeDownload(token) {
  if (!token) return false;
  const purchases = readPurchases();
  return Object.values(purchases).some((purchase) => purchase.token === token && purchase.status === 'captured');
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, publicBaseUrl);

  try {
    if (request.method === 'POST' && requestUrl.pathname === '/webhook') return handleWebhook(request, response);

    if (request.method === 'GET' && requestUrl.pathname.startsWith('/downloads/')) {
      const productId = requestUrl.pathname.split('/').pop();
      const product = products[productId];
      if (!product) return sendJson(response, 404, { error: 'Unknown product' });
      if (!authorizeDownload(requestUrl.searchParams.get('token'))) return sendJson(response, 403, { error: 'A verified payment is required' });
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