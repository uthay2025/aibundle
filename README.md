# AI Tools Storefront

This server verifies Razorpay webhooks and creates delivery records for both PDFs:

- `175_AI_Tools_Directory.pdf`
- `Local_AI_Beginners_Guide.pdf`

## Run locally

1. Copy `.env.example` to `.env` and set `RAZORPAY_WEBHOOK_SECRET`.
2. Run `npm start`.
3. Open `http://localhost:3000`.

## Configure Razorpay

In Razorpay Dashboard, create a webhook with this URL:

```
https://your-domain.example/webhook
```

Subscribe to `payment.captured` and copy the dashboard-generated webhook secret to `RAZORPAY_WEBHOOK_SECRET`. Razorpay must be able to reach the URL over public HTTPS; `localhost` will not work in production. The server also accepts only captured INR payments matching `RAZORPAY_EXPECTED_AMOUNT` (₹19 is `1900` paise by default).

On each verified `payment.captured` event, the server makes an idempotent fulfillment record in `data/purchases.json` and generates private links for both PDFs. The links are written to the server log. Connect the marked email-provider hook in `server.js` to automatically email those links to the payer.

Do not commit `.env` or `data/purchases.json`.