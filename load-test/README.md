# Load Test: Admin Publishes a Product

## What is being tested

The k6 script `publish-product.js` exercises the full instrumented user flow:

```
Admin browser ──► POST /Admin/Product/Create (Published=true)
                      │
                      ├─ [span] admin.product.create   (ActivityKind.Server)
                      │       tag: catalog.product.publish_transition = new_product
                      │
                      ├─ [span] catalog.product.insert
                      │       tag: catalog.product.id
                      │       metric: catalog.product.publish.duration (histogram)
                      │       metric: catalog.products.inserted (counter)
                      │       metric: catalog.products.published (counter)
                      │
                      └─ [span] catalog.cache.invalidation
                              tag: catalog.cache.keys_removed
                              metric: catalog.cache.invalidations (counter)
```

Every VU iteration creates and publishes one real product in the database, making
spans visible in Jaeger and metrics visible in Grafana.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| k6   | ≥ 0.49  | `brew install k6` / `apt install k6` / [k6.io/docs](https://k6.io/docs/get-started/installation/) |

The nopCommerce instance and the observability stack must be running before
starting the test. See [README.md](../README.md) for start-up instructions.

---

## Running the test

```bash
# Default scenario (gradual ramp, ~2 min, up to 10 VUs)
k6 run load-test/publish-product.js

# Spike scenario
k6 run -e SCENARIO=spike load-test/publish-product.js

# Soak scenario (10 minutes at 3 VUs)
k6 run -e SCENARIO=soak load-test/publish-product.js

# Custom target URL / credentials
k6 run \
  -e BASE_URL=http://localhost:5000 \
  -e ADMIN_EMAIL=admin@yourStore.com \
  -e ADMIN_PASSWORD=admin \
  load-test/publish-product.js
```

---

## Scenarios

| Scenario | Shape | Purpose |
|----------|-------|---------|
| `ramp` (default) | 1 → 8 → 10 → 3 → 0 VUs over ~2 min | Validate normal operation and observe span rate growing |
| `spike` | 1 → 30 → 1 VUs over ~1 min | Observe histogram p95 degradation under burst |
| `soak` | 3 VUs × 10 min | Detect memory leaks in ActivitySource / Meter registration |

---

## Thresholds (fail the run if violated)

| Metric | Threshold |
|--------|-----------|
| `http_req_duration` p(95) | < 2 000 ms |
| `http_req_failed` | < 1 % |
| `publish_e2e_duration_ms` p(95) | < 3 000 ms |
| `login_failure_rate` | < 1 % |
| `publish_failure_rate` | < 2 % |

---

## Observing results during the test

### Grafana  
Open **http://localhost:3000** → Dashboards → nopCommerce → **nopCommerce: Catalogue Observability**.  
You should see `catalog.products.published` counter incrementing and the
`catalog.product.publish.duration` histogram panels updating in real time.

### Jaeger  
Open **http://localhost:16686** → Service: `nopcommerce` → Operation: `admin.product.create`.  
Each k6 iteration produces one complete trace with three spans.

### k6 console output  
```text
TOTAL RESULTS 

checks_total.......: 2656    16.595232/s
checks_succeeded...: 100.00% 2656 out of 2656
checks_failed......: 0.00%   0 out of 2656

✓ login page 200
✓ create page 200
✓ product created (redirect to edit/list)
✓ response time < 2000ms

CUSTOM
login_failure_rate.............: 0.00%  0 out of 664
publish_e2e_duration_ms........: avg=520.49ms min=268ms    med=515ms   max=916ms   p(90)=624.4ms  p(95)=676.7ms 
publish_failure_rate...........: 0.00%  0 out of 664
published_products_total.......: 664    4.148808/s

HTTP
http_req_duration..............: avg=63.52ms  min=5.87ms   med=30.75ms max=636.7ms p(90)=227.58ms p(95)=279.32ms
  { expected_response:true }...: avg=63.52ms  min=5.87ms   med=30.75ms max=636.7ms p(90)=227.58ms p(95)=279.32ms
http_req_failed................: 0.00%  0 out of 5293
http_reqs......................: 5293   33.071748/s

EXECUTION
iteration_duration.............: avg=1.25s    min=858.55ms med=1.18s   max=1.86s   p(90)=1.58s    p(95)=1.61s   
iterations.....................: 664    4.148808/s
vus............................: 1      min=1         max=10
vus_max........................: 10     min=10        max=10

NETWORK
data_received..................: 462 MB 2.9 MB/s
data_sent......................: 4.5 MB 28 kB/s
```

### Example successful run

The following is a representative successful local run of the default `ramp` scenario:

```text
publish_e2e_duration_ms........: avg=419.37ms p(95)=538ms
publish_failure_rate...........: 0.00%
published_products_total.......: 717
http_req_duration..............: p(95)=154.25ms
http_req_failed................: 0.00%
iterations.....................: 717
```

How to interpret these results:
- `published_products_total = 717` means the script successfully created and published 717 real products during the run.
- `publish_failure_rate = 0%` means every publish iteration completed successfully.
- `publish_e2e_duration_ms p(95) = 538ms` means 95% of publish operations finished in under about half a second.
- `http_req_failed = 0%` means there were no transport-level HTTP failures.
- `http_req_duration p(95) = 154.25ms` indicates the individual web requests remained responsive under load.

This supports the conclusion that the instrumented publish workflow remained stable under the configured load and stayed well within the thresholds defined for latency and failure rate.

### What to verify after the test

After a successful run, validate the telemetry in the observability tools:

- Prometheus:
  `sum(catalog_products_published_total)` should increase substantially during the run.
- Prometheus:
  `histogram_quantile(0.95, sum by (le) (rate(catalog_product_publish_duration_milliseconds_bucket[5m])))` should produce a real p95 value instead of `NaN`.
- Grafana:
  the published-products and publish-duration panels should show clear activity during the k6 window.
- Jaeger:
  searching for `admin.product.create` should return many traces, each with child spans such as `catalog.product.insert` and `catalog.cache.invalidation`.

---

## Troubleshooting

**`setup()` throws "nopCommerce does not appear to be running"**  
→ The script first checks `GET /login?returnUrl=%2FAdmin%2FProduct%2FCreate` on `BASE_URL`.  
If it gets `404` or connection errors, either the app is not running, the port is different, or `BASE_URL` is wrong. Start the app and verify:

```bash
curl -I "http://localhost:5000/login?returnUrl=%2FAdmin%2FProduct%2FCreate"
```

If your app is running on another port, pass it explicitly:

```bash
k6 run -e BASE_URL=http://localhost:xxxx load-test/publish-product.js
```

**Login keeps failing (`Login was unsuccessful`)**  
→ Check credentials. Default nopCommerce dev store credentials are  
  `admin@yourStore.com` / `admin`. Pass overrides with `-e ADMIN_EMAIL=...`

**Publish requests are redirected back to `/login`**  
→ The script now retries authentication automatically if the admin session expires during `GET` or `POST /Admin/Product/Create`.  
If this still happens repeatedly, verify that the target instance keeps the admin session cookie stable during the run and that the credentials are correct.

**k6 prints `unknown field "gracefulStop"`**  
→ This indicates the script options are malformed for the installed k6 version.  
The project script defines `gracefulStop` inside each scenario, which is the correct layout.

**Anti-forgery token extraction fails**  
→ Ensure nopCommerce is not configured to require HTTPS in development  
  (set `UseHttpsRedirection = false` in `appsettings.Development.json`) or  
  run k6 against the HTTPS port: `-e BASE_URL=https://localhost:5001`

**The create form keeps returning validation errors**  
→ The script submits a minimal payload and relies on the defaults rendered by `/Admin/Product/Create` for fields such as product type, template, and tax category.  
If the nopCommerce instance requires additional fields or custom plugins alter the form, inspect the returned validation message and adapt the payload in [`publish-product.js`](./publish-product.js).

**Products accumulate in the database**  
→ This is expected for a load test. Run  
  `DELETE FROM Product WHERE Name LIKE 'LoadTest-Product-%'`  
  against the database after testing.
