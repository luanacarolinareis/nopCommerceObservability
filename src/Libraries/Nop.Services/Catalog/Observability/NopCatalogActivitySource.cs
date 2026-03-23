using System.Diagnostics;

namespace Nop.Services.Catalog.Observability;

/// <summary>
/// Central registry for all OpenTelemetry ActivitySource definitions used in the Catalog domain.
///
/// NOTE: This file deliberately has NO dependency on OpenTelemetry SDK NuGet packages.
/// It uses only System.Diagnostics (built-in .NET) so that the business-layer libraries
/// remain vendor-neutral. The OTel SDK listener is wired in the host project (Nop.Web).
/// </summary>
public static class NopCatalogActivitySource
{
    // ----------------------------------------------------------------------------
    // Source identity: must be registered with the OTel SDK at startup
    // ----------------------------------------------------------------------------
    public const string SourceName = "Nop.Catalog";
    public const string SourceVersion = "1.0.0";

    // Lazily created (disposed only when the process exits)
    private static readonly ActivitySource _source = new(SourceName, SourceVersion);

    /// <summary>Exposes the underlying <see cref="ActivitySource"/> for external consumers (for example, OTel SDK registration).</summary>
    public static ActivitySource Source => _source;

    // ----------------------------------------------------------------------------
    // Semantic attribute keys (following OTel semantic conventions where possible)
    // ----------------------------------------------------------------------------

    // Catalog / product
    public const string ProductIdTag = "catalog.product.id";
    public const string ProductSkuTag = "catalog.product.sku";
    public const string ProductPublishedTag = "catalog.product.published";
    public const string ProductTypeTag = "catalog.product.type";

    // Business-level lifecycle event (possible values: "new_product", "first_publish", "update_published", "unpublish")
    public const string PublishTransitionTag = "catalog.product.publish_transition";

    // Cache
    public const string CacheEntityTypeTag = "cache.entity_type";
    public const string CacheEntityIdTag = "cache.entity_id";
    public const string CacheEventTypeTag = "cache.event_type";
    public const string CacheKeysRemovedTag = "cache.keys_removed_count";

    // Operation
    public const string OperationTypeTag = "catalog.operation";

    // ----------------------------------------------------------------------------
    // Activity-factory helpers (keeping call sites clean)
    // ----------------------------------------------------------------------------

    /// <summary>
    /// Creates a span representing the insertion of a new product into the catalogue.
    /// </summary>
    public static Activity? StartProductInsertActivity(string? sku, bool published)
    {
        var activity = _source.StartActivity("catalog.product.insert", ActivityKind.Internal);
        if (activity is null) return null;

        activity.SetTag(ProductSkuTag, sku);
        activity.SetTag(ProductPublishedTag, published);
        activity.SetTag(OperationTypeTag, "insert");
        activity.SetTag(PublishTransitionTag, published ? "new_product" : "draft_product");

        return activity;
    }

    /// <summary>
    /// Creates a span representing an update to an existing product.
    /// The <paramref name="wasPublishedBefore"/> flag allows detecting publish-state changes.
    /// </summary>
    public static Activity? StartProductUpdateActivity(int productId, string? sku, bool published, bool wasPublishedBefore)
    {
        var activity = _source.StartActivity("catalog.product.update", ActivityKind.Internal);
        if (activity is null) return null;

        activity.SetTag(ProductIdTag, productId);
        activity.SetTag(ProductSkuTag, sku);
        activity.SetTag(ProductPublishedTag, published);
        activity.SetTag(OperationTypeTag, "update");

        // Detect semantic publish-state transition (this is the key business event!)
        var transition = (wasPublishedBefore, published) switch
        {
            (false, true) => "first_publish",       // product goes live for the first time
            (true, false) => "unpublish",           // product removed from storefront
            (true, true) => "update_published",     // content change while already live
            (false, false) => "update_draft",       // editing an unpublished product
        };

        activity.SetTag(PublishTransitionTag, transition);

        return activity;
    }

    /// <summary>
    /// Creates a span representing the cache invalidation triggered by a product entity event.
    /// </summary>
    public static Activity? StartCacheClearActivity(string entityType, int entityId, string eventType)
    {
        var activity = _source.StartActivity("catalog.cache.invalidation", ActivityKind.Internal);
        if (activity is null) return null;

        activity.SetTag(CacheEntityTypeTag, entityType);
        activity.SetTag(CacheEntityIdTag, entityId);
        activity.SetTag(CacheEventTypeTag, eventType);

        return activity;
    }
}
