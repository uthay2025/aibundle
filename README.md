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

On each verified `payment.captured` event, the server makes an idempotent fulfillment record in `data/purchases.json` and generates one private delivery URL. Opening it and selecting **Unlock my PDFs** consumes that delivery URL, then reveals one download URL for each PDF. Each PDF URL is consumed as soon as it starts downloading.

To automatically share the delivery URL with the buyer, add a Make, n8n, or transactional-email endpoint to `FULFILLMENT_WEBHOOK_URL`. The server sends that endpoint a JSON body containing `paymentId`, `email`, `contact`, and `deliveryUrl`. Without this optional endpoint, the delivery URL is safely written to the server log for manual sending.

Do not commit `.env` or `data/purchases.json`.