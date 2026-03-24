# CRITIQUE: nopCommerce Observability Assignment

An honest, third-party-style technical review of the choices made in this
implementation.

---

## What was done well

### 1. Source-side data minimization fits the chosen flow

The selected flow is an admin catalogue write path, not checkout or payment.
That means the strongest privacy control is not masking after the fact, but
emitting only the small set of operational fields needed for correlation:
route, product identifier, SKU, publish state, publish transition, and cache
metadata. Even product name was removed because it was not required for the
demo's debugging goals.

Benefit: privacy guarantees do not depend on a Collector processor, exporter,
or storage backend being configured correctly.

### 2. Vendor-neutral instrumentation in the service layer

`NopCatalogActivitySource` and `NopCatalogMetrics` depend only on
`System.Diagnostics.ActivitySource` and `System.Diagnostics.Metrics.Meter`:
both part of the .NET BCL since .NET 6. The `Nop.Services` class library has
**zero dependency on any OpenTelemetry SDK package**. This mirrors the W3C /
CNCF recommended practice of separating _instrumentation_ from _export_.

Benefit: swapping Jaeger for Tempo, or Prometheus for OTLP metrics, requires
no changes below `Nop.Web`.

### 3. Semantic `publish_transition` tag

The `catalog.product.publish_transition` tag encodes business intent in the
trace (`new_product`, `first_publish`, `unpublish`, `update_published`,
`update_draft`). This is more useful than a boolean `wasPublished` because it
allows Grafana / Jaeger queries like _"how many un-publishes happened today?"_
without post-processing.

### 4. No extra database query

The initial design retrieved `previousPublished` via a DB round-trip inside
`UpdateProductAsync`. This was replaced with an overload that receives the
transition hint from the controller, where the original state is already
available in memory. This keeps the happy-path latency unchanged.

### 5. ActivityKind.Server on controller root spans

Using `ActivityKind.Server` instead of the default `Internal` enables
OpenTelemetry Collector and Jaeger to correctly classify these as inbound
request roots, enabling correct parent-child trace stitching with the
ASP.NET Core automatic instrumentation spans.

---

## What in nopCommerce helped and what hindered

### Helped

- The layered structure is real enough to be useful: admin controllers stay in
  `Nop.Web`, business logic stays in `Nop.Services`, and persistence side
  effects emerge through `Nop.Data` + `Nop.Core.Events`.
- `EntityRepository<TEntity>` publishes typed entity lifecycle events after
  insert/update/delete, which creates a natural bridge from a business write to
  cache and other secondary effects.
- `CacheEventConsumer<TEntity>` centralizes cache invalidation behavior, so one
  concrete consumer (`ProductCacheEventConsumer`) can expose a meaningful
  operational consequence of the publish flow without touching unrelated code.

### Hindered

- The monolith has many implicit boundaries. Important side-effects are often
  discovered only by reading repository and consumer code together, not by
  looking at a single service method.
- `IEventPublisher` is generic and DI-driven, which is flexible but makes the
  event graph less obvious to a reader. Observability boundaries exist, but
  they are not documented as first-class architecture.
- Rich domain objects flow through the service layer. In more sensitive flows,
  this increases the chance of accidental over-instrumentation unless data
  minimization is treated as an explicit design rule.

---

## Known limitations and honest weaknesses

### 1. Sampling strategy: 100% always-on (not production-ready)

The SDK is configured with `AlwaysSampler`. In production this would generate
one trace per admin save-product click, which is acceptable for low-traffic admin
routes, but catastrophic if the same pattern were applied to storefront
endpoints at scale.

**Should have done**: Configure a `ParentBasedSampler` wrapping a
`TraceIdRatioBasedSampler(0.1)` as default, with a per-route override that
forces 100% sampling for admin paths via a custom `Sampler` that checks
`activity.DisplayName`.

### 2. `removalCount` counts operations, not distinct cache keys

`ProductCacheEventConsumer.ClearCacheAsync` increments `removalCount` once per
`Remove*Async` call. If a single logical key is removed by two different paths
within the same cache-clear cycle, it is double-counted. The metric label
`catalog.cache.keys_removed` therefore overstates the true number of distinct
keys evicted.

**Should have done**: Collect the string keys before removal and count
`Distinct()`. This requires changing the `ICacheKeyService` / `IStaticCacheManager`
call sites to return the key strings, which would have been a larger refactor
than the scope of this assignment allows.

### 3. Bulk `InsertProductsAsync` is not instrumented

`ProductService.InsertProductsAsync` (the batch overload used by data importers)
does not emit spans or metrics. A bulk CSV import of 5 000 products would
produce zero observability signal.

**Should have done**: Instrument the bulk overload with a single parent span
enclosing a `foreach` loop that records per-item exceptions, and a single
counter add of `products.Count`.

### 4. No W3C Trace Context propagation test

The implementation relies on OpenTelemetry's automatic `HttpClient`
instrumentation for outbound propagation, but there is no integration test or
load-test assertion that verifies the `traceparent` header is forwarded to
downstream microservices (e.g., a notification service). In a real system, a
broken propagation chain silently drops the parent-child link.

**Should have done**: Add one xUnit integration test that creates an `Activity`,
fires an `HttpClient` request to a stub server, and asserts the stub received a
valid `traceparent` header matching the parent `Activity.Id`.

### 5. Metrics lack exemplars

The `catalog.product.publish.duration` histogram does not attach exemplars
(trace ID + span ID) to each data point. Without exemplars, jumping from a
Grafana spike on the histogram panel to the corresponding Jaeger trace requires
manual time-correlation.

**Should have done**: Use the OpenTelemetry `MetricPoint.TryGetExemplar()` API
(available in OTel .NET 1.9+) to attach the current `Activity.TraceId` to each
histogram recording. This requires Prometheus to be configured in OpenMetrics
format and Grafana's "Exemplar" toggle to be enabled on the panel.

### 6. Grafana dashboard panels use instant queries, not range queries

The dashboard panels for counters use `increase()` over a fixed `[$__rate_interval]`
window. On a freshly started stack with no data, this produces empty panels
rather than a "0" baseline, which can mislead a reviewer into thinking the
instrumentation is broken.

**Should have done**: Use `sum(increase(...[$__rate_interval])) or vector(0)` to
force a zero baseline when there is no data.

### 7. `ObservabilityServiceExtensions` registers a static `ActivitySource`

`NopCatalogActivitySource.Source` and `NopCatalogMetrics.Meter` are static
fields. In unit tests this means the Meter and ActivitySource are registered
once per process and re-used across test classes, which can cause
`InvalidOperationException: Meter with the same name already exists` in
multi-process test runners.

**Should have done**: Register `ActivitySource` and `Meter` as singleton
services in the DI container and inject them, so the IoC container owns
lifetime and tests can resolve fresh instances per `WebApplicationFactory`.

### 8. The most surgical change was still a code change to the service contract

The extra `UpdateProductAsync(Product product, string? publishTransition)`
overload is a deliberate architectural compromise. Strictly speaking, the
service should have been able to infer everything itself. In practice, the
controller already knew the old and new publish states, and forcing the service
to re-query the database just for telemetry would have added cost to every
update.

**Why it was necessary**: it preserved the semantic richness of the
`catalog.product.update` span without adding a useless database round-trip.

**Why it stayed surgical**: the change was a small overload on an existing
interface rather than a broader refactor of controller-service responsibilities.

### 9. Error rate is approximated at the HTTP route level, not the domain-operation level

The dashboard now includes a dedicated **Admin Publish Error Rate (%)** panel,
which satisfies the assignment requirement for an explicit error-rate
visualization. However, the implementation is still an approximation of publish
failures at the HTTP route layer rather than a first-class domain metric
emitted directly by the catalogue service.

More specifically, the panel computes error rate from ASP.NET Core HTTP server
metrics for `http_route="/Admin/Product/Create"` and counts `4xx`/`5xx`
responses as failed publish requests. That is operationally useful and much
better than relying only on k6 console output, but it is not exactly the same
as a custom `catalog.publish.failed` counter emitted at the business-operation
boundary.

**What would improve it further**: add a dedicated application metric for
publish failures inside the service layer so the dashboard can distinguish
transport-level request failures from domain-level publish failures more
precisely.

---

## What would be done differently with more time

| Area | Change |
|------|--------|
| Sampling | `ParentBasedSampler` + route-aware head-sampler |
| Baggage | Propagate `catalog.admin.userId` in W3C Baggage for audit trails |
| Exemplars | Attach trace IDs to all histogram data points |
| Bulk import | Instrument `InsertProductsAsync` with a batch span |
| Dashboard | OR-vector(0) zero baselines; alert rules for p95 > 1 s |
| DI | Inject `ActivitySource` / `Meter` via DI instead of statics |
| Tests | Integration test asserting `traceparent` propagation |

---

## Conclusion

The implementation achieves its primary goal: every admin product publish
produces a complete, structured, vendor-neutral trace with correlated metrics.
The chosen patterns (BCL-only in the service layer, SDK only at composition
root, semantic tags) are idiomatic and extensible. The known limitations are
real trade-offs made to control scope; each is correctable without rearchitecting
the instrumentation layer.
